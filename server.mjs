import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const port = Number(process.env.PORT || 3000);
const openaiApiKey = (process.env.OPENAI_API_KEY || '').trim();
const deepSeekApiKey = (process.env.DEEPSEEK_API_KEY || '').trim();
const creatorCodesJSON = process.env.CREATOR_CODES_JSON || '';
const creatorCodeFailureWindowMs = 10 * 60 * 1000;
const creatorCodeMaximumFailuresPerWindow = 15;
const creatorCodeFailureWindows = new Map();
const playerDailyAITokenLimit = configuredPositiveInteger(
  process.env.PLAYER_DAILY_AI_TOKEN_LIMIT,
  500_000,
  10_000,
  100_000_000,
);
const playerUsageLedgerPath = (process.env.PLAYER_USAGE_LEDGER_PATH || '').trim()
  || '/tmp/my-path-player-usage-v1.json';
const playerQuotaSigningSecret = (process.env.PLAYER_QUOTA_SIGNING_SECRET || '').trim()
  || createHash('sha256')
    .update(`my-path-quota-v1\0${openaiApiKey}\0${deepSeekApiKey}`)
    .digest('hex');
let sharedPlayerUsageLedger;

const creatorCodeRewardTypes = new Set([
  'ai_tokens',
  'cash',
  'custom_life_access',
  'dlc',
  'all_dlcs',
  'stat',
]);
const creatorCodeStatIDs = new Set([
  'health',
  'happiness',
  'intelligence',
  'charm',
  'fitness',
  'reputation',
]);

const modelRoutes = new Map([
  ['gpt-4o-mini', {
    kind: 'openai',
    provider: 'OpenAI',
    apiKey: openaiApiKey,
    missingKeyName: 'OPENAI_API_KEY',
    upstreamModel: 'gpt-4o-mini',
    chatURL: 'https://api.openai.com/v1/chat/completions',
    healthURL: 'https://api.openai.com/v1/models',
  }],
  ['deepseek-v4-pro', {
    kind: 'deepseek',
    provider: 'DeepSeek',
    apiKey: deepSeekApiKey,
    missingKeyName: 'DEEPSEEK_API_KEY',
    upstreamModel: 'deepseek-v4-pro',
    chatURL: 'https://api.deepseek.com/chat/completions',
    healthURL: 'https://api.deepseek.com/models',
  }],
]);

function normalizeModelName(rawModel) {
  const model = typeof rawModel === 'string' ? rawModel.trim() : '';
  return model === 'deepseek/deepseek-v4-pro' ? 'deepseek-v4-pro' : model;
}

function routeForModel(rawModel) {
  return modelRoutes.get(normalizeModelName(rawModel));
}

function deepSeekPricingMultiplier(at = new Date()) {
  const utcHour = at.getUTCHours();
  const isPeak = (utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10);
  return isPeak ? 2 : 1;
}

function attachPricingMetadata(payload, route, at = new Date()) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  payload.provider = route.provider;
  payload.requested_model = route.upstreamModel;

  if (route.kind !== 'deepseek' || !payload.usage || typeof payload.usage !== 'object') {
    return payload;
  }

  const multiplier = deepSeekPricingMultiplier(at);
  payload.usage = {
    ...payload.usage,
    wallet_token_multiplier: multiplier,
    pricing_period: multiplier === 2 ? 'peak' : 'regular',
  };
  return payload;
}

function configuredPositiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function playerQuotaUTCDateKey(at = new Date()) {
  return at.toISOString().slice(0, 10);
}

function playerQuotaResetDate(at = new Date()) {
  const reset = new Date(at);
  reset.setUTCHours(24, 0, 0, 0);
  return reset;
}

function normalizePlayerIdentifier(rawIdentifier) {
  const identifier = typeof rawIdentifier === 'string'
    ? rawIdentifier.trim().toLowerCase()
    : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identifier)
    ? identifier
    : '';
}

function playerQuotaHash(identifier) {
  return createHash('sha256')
    .update(`my-path-player-v1\0${identifier}`)
    .digest('hex');
}

function playerQuotaReceipt(payload, secret = playerQuotaSigningSecret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifiedPlayerQuotaReceipt(rawReceipt, expectedPlayerHash, expectedDay, secret = playerQuotaSigningSecret) {
  if (typeof rawReceipt !== 'string' || rawReceipt.length > 4_096) return null;
  const parts = rawReceipt.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expectedSignature = createHmac('sha256', secret).update(parts[0]).digest('base64url');
  const providedBuffer = Buffer.from(parts[1]);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (providedBuffer.length !== expectedBuffer.length
      || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const used = Number(payload?.u);
    if (payload?.v !== 1
        || payload?.p !== expectedPlayerHash
        || payload?.d !== expectedDay
        || !Number.isSafeInteger(used)
        || used < 0) {
      return null;
    }
    return {
      used,
      deletedAt: typeof payload.x === 'string' ? payload.x : null,
    };
  } catch {
    return null;
  }
}

class PlayerUsageLedger {
  constructor({ filePath = null, dailyLimit = playerDailyAITokenLimit } = {}) {
    this.filePath = filePath;
    this.dailyLimit = dailyLimit;
    this.players = new Map();
    this.reservations = new Map();
    this.load();
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    if (parsed?.version !== 1 || !parsed.players || typeof parsed.players !== 'object') {
      throw new Error('Player usage ledger has an unsupported format.');
    }
    for (const [hash, rawRecord] of Object.entries(parsed.players)) {
      if (!/^[0-9a-f]{64}$/.test(hash) || !rawRecord || typeof rawRecord !== 'object') continue;
      const days = {};
      for (const [day, rawUsed] of Object.entries(rawRecord.days || {})) {
        const used = Number(rawUsed);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isSafeInteger(used) && used >= 0) {
          days[day] = used;
        }
      }
      this.players.set(hash, {
        createdAt: typeof rawRecord.createdAt === 'string' ? rawRecord.createdAt : new Date(0).toISOString(),
        lastSeenAt: typeof rawRecord.lastSeenAt === 'string' ? rawRecord.lastSeenAt : new Date(0).toISOString(),
        deletedAt: typeof rawRecord.deletedAt === 'string' ? rawRecord.deletedAt : null,
        days,
      });
    }
  }

  persist() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const players = Object.fromEntries(this.players);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ version: 1, players }), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }

  ensurePlayer(playerHash, at = new Date()) {
    let record = this.players.get(playerHash);
    if (!record) {
      record = {
        createdAt: at.toISOString(),
        lastSeenAt: at.toISOString(),
        deletedAt: null,
        days: {},
      };
      this.players.set(playerHash, record);
    }
    record.lastSeenAt = at.toISOString();
    this.pruneOldDays(record, at);
    return record;
  }

  pruneOldDays(record, at = new Date()) {
    const cutoff = at.getTime() - (8 * 24 * 60 * 60 * 1000);
    for (const day of Object.keys(record.days)) {
      const timestamp = Date.parse(`${day}T00:00:00Z`);
      if (Number.isFinite(timestamp) && timestamp < cutoff) delete record.days[day];
    }
  }

  mergeReceiptUsage(playerHash, day, receiptState, at = new Date()) {
    const record = this.ensurePlayer(playerHash, at);
    const receiptUsed = Math.max(0, Number(receiptState?.used) || 0);
    record.days[day] = Math.max(Number(record.days[day]) || 0, receiptUsed);
    if (receiptState?.deletedAt && !record.deletedAt) record.deletedAt = receiptState.deletedAt;
    return record;
  }

  snapshot(playerHash, day, at = new Date()) {
    const record = this.ensurePlayer(playerHash, at);
    const used = Math.max(0, Number(record.days[day]) || 0);
    const reservationKey = `${playerHash}:${day}`;
    const reserved = Math.max(0, this.reservations.get(reservationKey) || 0);
    return {
      used,
      reserved,
      remaining: Math.max(0, this.dailyLimit - used - reserved),
      limit: this.dailyLimit,
      deletedAt: record.deletedAt,
    };
  }

  reserve(playerHash, day, requestedTokens, receiptState = null, at = new Date()) {
    this.mergeReceiptUsage(playerHash, day, receiptState, at);
    const requested = Math.max(1, Math.trunc(Number(requestedTokens) || 1));
    const before = this.snapshot(playerHash, day, at);
    if (requested > before.remaining) {
      this.persist();
      return { allowed: false, snapshot: before };
    }
    const reservationKey = `${playerHash}:${day}`;
    this.reservations.set(reservationKey, before.reserved + requested);
    this.persist();
    return {
      allowed: true,
      reservation: { playerHash, day, requested, reservationKey },
      snapshot: this.snapshot(playerHash, day, at),
    };
  }

  reconcile(reservation, actualTokens, at = new Date()) {
    const existingReserved = Math.max(0, this.reservations.get(reservation.reservationKey) || 0);
    const nextReserved = Math.max(0, existingReserved - reservation.requested);
    if (nextReserved > 0) this.reservations.set(reservation.reservationKey, nextReserved);
    else this.reservations.delete(reservation.reservationKey);

    const record = this.ensurePlayer(reservation.playerHash, at);
    const actual = Math.max(0, Math.trunc(Number(actualTokens) || 0));
    record.days[reservation.day] = Math.max(0, Number(record.days[reservation.day]) || 0) + actual;
    this.persist();
    return this.snapshot(reservation.playerHash, reservation.day, at);
  }

  release(reservation, at = new Date()) {
    return this.reconcile(reservation, 0, at);
  }

  markDeleted(playerHash, day, receiptState = null, at = new Date()) {
    const record = this.mergeReceiptUsage(playerHash, day, receiptState, at);
    record.deletedAt = record.deletedAt || at.toISOString();
    this.persist();
    return this.snapshot(playerHash, day, at);
  }
}

function getPlayerUsageLedger() {
  if (!sharedPlayerUsageLedger) {
    sharedPlayerUsageLedger = new PlayerUsageLedger({
      filePath: playerUsageLedgerPath,
      dailyLimit: playerDailyAITokenLimit,
    });
  }
  return sharedPlayerUsageLedger;
}

function playerQuotaIdentity(req) {
  const supplied = normalizePlayerIdentifier(req.headers['x-my-path-player-id']);
  const stableIdentifier = supplied || `legacy-ip:${creatorCodeClientAddress(req)}`;
  return {
    hash: playerQuotaHash(stableIdentifier),
    isLegacy: !supplied,
  };
}

function estimatedChatWalletTokens(body, route, at = new Date()) {
  const serializedMessages = JSON.stringify(body?.messages || []);
  // One token cannot encode more source bytes than are present. Reserving by
  // UTF-8 byte length keeps a single request from crossing the daily ceiling,
  // while reconciliation still charges only the provider's reported usage.
  const promptEstimate = Math.max(1, Buffer.byteLength(serializedMessages, 'utf8'));
  const requestedCompletion = configuredPositiveInteger(
    body?.max_completion_tokens ?? body?.max_tokens,
    1_000,
    1,
    100_000,
  );
  const possibleAttempts = route.kind === 'deepseek' ? 2 : 1;
  const pricingMultiplier = route.kind === 'deepseek' ? deepSeekPricingMultiplier(at) : 1;
  return (promptEstimate + requestedCompletion) * possibleAttempts * pricingMultiplier;
}

function actualChatWalletTokens(payload, route = null, at = new Date()) {
  const usage = payload?.usage;
  const prompt = Math.max(0, Number(usage?.prompt_tokens) || 0);
  const completion = Math.max(0, Number(usage?.completion_tokens) || 0);
  const total = Math.max(0, Number(usage?.total_tokens) || (prompt + completion));
  const reportedMultiplier = configuredPositiveInteger(usage?.wallet_token_multiplier, 1, 1, 2);
  const routeMultiplier = route?.kind === 'deepseek' ? deepSeekPricingMultiplier(at) : 1;
  const multiplier = Math.max(reportedMultiplier, routeMultiplier);
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(total) * multiplier);
}

function quotaHeaders(playerHash, day, snapshot, at = new Date()) {
  const receipt = playerQuotaReceipt({
    v: 1,
    p: playerHash,
    d: day,
    u: snapshot.used,
    x: snapshot.deletedAt,
  });
  return {
    'Cache-Control': 'no-store',
    'X-My-Path-Daily-Token-Limit': String(snapshot.limit),
    'X-My-Path-Daily-Tokens-Used': String(snapshot.used),
    'X-My-Path-Daily-Tokens-Remaining': String(snapshot.remaining),
    'X-My-Path-Quota-Reset': playerQuotaResetDate(at).toISOString(),
    'X-My-Path-Quota-Receipt': receipt,
  };
}

function normalizeCreatorCode(rawCode) {
  return String(rawCode || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 80);
}

function creatorCodeSafeText(value, maximumLength) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maximumLength)
    : '';
}

function creatorCodeInteger(value, minimum, maximum, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function normalizeCreatorCodeReward(rawReward, codeName, index) {
  if (!rawReward || typeof rawReward !== 'object' || Array.isArray(rawReward)) {
    throw new Error(`${codeName} reward ${index + 1} must be an object.`);
  }
  const type = creatorCodeSafeText(rawReward.type, 40).toLowerCase();
  if (!creatorCodeRewardTypes.has(type)) {
    throw new Error(`${codeName} reward ${index + 1} has unsupported type ${type || '(missing)'}.`);
  }

  const reward = { type };
  const label = creatorCodeSafeText(rawReward.label, 100);
  if (label) {
    reward.label = label;
  }

  switch (type) {
    case 'ai_tokens':
      reward.amount = creatorCodeInteger(rawReward.amount, 1, 50_000_000);
      if (!reward.amount) throw new Error(`${codeName} AI token reward needs a positive amount.`);
      break;
    case 'cash':
      reward.amount = creatorCodeInteger(rawReward.amount, 1, 2_000_000_000);
      if (!reward.amount) throw new Error(`${codeName} cash reward needs a positive amount.`);
      break;
    case 'custom_life_access':
      reward.hours = creatorCodeInteger(rawReward.hours, 1, 8_760);
      if (!reward.hours) throw new Error(`${codeName} Custom Life reward needs positive hours.`);
      break;
    case 'dlc': {
      const id = creatorCodeSafeText(rawReward.id, 80).toLowerCase();
      if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`${codeName} DLC reward needs a valid id.`);
      reward.id = id;
      break;
    }
    case 'stat': {
      const id = creatorCodeSafeText(rawReward.id, 40).toLowerCase();
      if (!creatorCodeStatIDs.has(id)) throw new Error(`${codeName} stat reward has unsupported id ${id || '(missing)'}.`);
      reward.id = id;
      reward.amount = creatorCodeInteger(rawReward.amount, -100, 100, 0);
      if (!reward.amount) throw new Error(`${codeName} stat reward needs a non-zero amount.`);
      break;
    }
    case 'all_dlcs':
      break;
    default:
      throw new Error(`${codeName} reward type is unsupported.`);
  }
  return reward;
}

function parseCreatorCodeDate(value, fieldName, codeName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${codeName} has an invalid ${fieldName}.`);
  }
  return date;
}

function parseCreatorCodeCatalog(rawJSON = '') {
  const trimmed = String(rawJSON || '').trim();
  if (!trimmed) {
    return new Map();
  }

  const parsed = JSON.parse(trimmed);
  const entries = Array.isArray(parsed)
    ? parsed.map((definition) => [definition?.code, definition])
    : Object.entries(parsed || {});
  const catalog = new Map();

  for (const [rawCode, rawDefinition] of entries) {
    const code = normalizeCreatorCode(rawCode);
    if (code.length < 6) {
      throw new Error('Every creator code must contain at least 6 letters or numbers.');
    }
    if (!rawDefinition || typeof rawDefinition !== 'object' || Array.isArray(rawDefinition)) {
      throw new Error(`${code} must contain a reward definition object.`);
    }
    if (catalog.has(code)) {
      throw new Error(`Duplicate creator code after normalization: ${code}.`);
    }

    const rawRewards = rawDefinition.rewards;
    if (!Array.isArray(rawRewards) || rawRewards.length === 0 || rawRewards.length > 12) {
      throw new Error(`${code} must contain between 1 and 12 rewards.`);
    }
    const startsAt = parseCreatorCodeDate(rawDefinition.starts_at, 'starts_at', code);
    const expiresAt = parseCreatorCodeDate(rawDefinition.expires_at, 'expires_at', code);
    if (startsAt && expiresAt && startsAt >= expiresAt) {
      throw new Error(`${code} expires_at must be later than starts_at.`);
    }

    catalog.set(code, {
      id: creatorCodeSafeText(rawDefinition.id, 100) || code.toLowerCase(),
      title: creatorCodeSafeText(rawDefinition.title, 80) || 'Creator Reward',
      message: creatorCodeSafeText(rawDefinition.message, 240),
      repeatable: rawDefinition.repeatable === true,
      minimumBuild: creatorCodeInteger(rawDefinition.minimum_build, 1, 1_000_000, 1),
      startsAt,
      expiresAt,
      rewards: rawRewards.map((reward, index) => normalizeCreatorCodeReward(reward, code, index)),
    });
  }
  return catalog;
}

function resolveCreatorCode(catalog, rawCode, clientBuild = 1, at = new Date()) {
  const normalizedCode = normalizeCreatorCode(rawCode);
  const definition = catalog.get(normalizedCode);
  if (!definition) {
    return { status: 404, error: 'That code is not valid.' };
  }
  if (definition.startsAt && at < definition.startsAt) {
    return { status: 404, error: 'That code is not active yet.' };
  }
  if (definition.expiresAt && at >= definition.expiresAt) {
    return { status: 410, error: 'That code has expired.' };
  }
  if (clientBuild < definition.minimumBuild) {
    return { status: 409, error: 'Update My Path before using this code.' };
  }
  return {
    status: 200,
    redemption: {
      id: definition.id,
      title: definition.title,
      message: definition.message,
      repeatable: definition.repeatable,
      rewards: definition.rewards,
    },
  };
}

function creatorCodeClientAddress(req) {
  const forwarded = creatorCodeSafeText(req.headers['x-forwarded-for'], 200).split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function creatorCodeRequestIsRateLimited(address, at = Date.now()) {
  const existing = creatorCodeFailureWindows.get(address);
  if (!existing || at - existing.startedAt >= creatorCodeFailureWindowMs) {
    if (existing) creatorCodeFailureWindows.delete(address);
    return false;
  }
  return existing.failures >= creatorCodeMaximumFailuresPerWindow;
}

function recordCreatorCodeFailure(address, at = Date.now()) {
  const existing = creatorCodeFailureWindows.get(address);
  if (!existing || at - existing.startedAt >= creatorCodeFailureWindowMs) {
    creatorCodeFailureWindows.set(address, { startedAt: at, failures: 1 });
  } else {
    existing.failures += 1;
  }
  if (creatorCodeFailureWindows.size > 10_000) {
    for (const [key, window] of creatorCodeFailureWindows) {
      if (at - window.startedAt >= creatorCodeFailureWindowMs) creatorCodeFailureWindows.delete(key);
    }
  }
}

function sendJson(res, statusCode, payload, additionalHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...additionalHeaders,
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw new Error('Missing JSON body');
  }

  return JSON.parse(raw);
}

function validateChatCompletionBody(body) {
  if (!body || typeof body !== 'object') {
    return 'Body must be a JSON object.';
  }
  if (typeof body.model !== 'string' || !body.model.trim()) {
    return 'Missing model.';
  }
  if (!routeForModel(body.model)) {
    return `Unsupported model. Choose one of: ${[...modelRoutes.keys()].join(', ')}.`;
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'Missing messages array.';
  }
  return null;
}

function providerHeaders(route) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${route.apiKey}`,
  };
}

function appendSystemInstruction(messages, instruction) {
  const cloned = messages.map((message) => ({ ...message }));
  const systemIndex = cloned.findIndex(
    (message) => message.role === 'system' && typeof message.content === 'string',
  );
  if (systemIndex >= 0) {
    cloned[systemIndex].content = `${cloned[systemIndex].content}\n\n${instruction}`;
  } else {
    cloned.unshift({ role: 'system', content: instruction });
  }
  return cloned;
}

function deepSeekJSONInstruction(responseFormat) {
  if (!responseFormat || typeof responseFormat !== 'object') {
    return '';
  }
  if (responseFormat.type === 'json_schema') {
    const schema = responseFormat.json_schema?.schema;
    const schemaName = responseFormat.json_schema?.name || 'gameplay_response';
    if (schema && typeof schema === 'object') {
      return `Return only one valid JSON object named ${schemaName}. Match this exact JSON Schema, including every required field and no additional fields: ${JSON.stringify(schema)}`;
    }
  }
  if (responseFormat.type === 'json_object') {
    return 'Return only one complete, valid JSON object with no markdown or surrounding commentary.';
  }
  return '';
}

function forwardedChatBody(body, route) {
  const forwarded = {
    ...body,
    model: route.upstreamModel,
  };
  delete forwarded.provider;

  if (route.kind === 'deepseek') {
    delete forwarded.prompt_cache_key;
    delete forwarded.reasoning;
    delete forwarded.reasoning_effort;
    forwarded.thinking = { type: 'disabled' };

    const jsonInstruction = deepSeekJSONInstruction(body.response_format);
    if (jsonInstruction) {
      forwarded.messages = appendSystemInstruction(body.messages, jsonInstruction);
      forwarded.response_format = { type: 'json_object' };
    }
  }

  return forwarded;
}

async function performChatCompletion(body, route) {
  const response = await fetch(route.chatURL, {
    method: 'POST',
    headers: providerHeaders(route),
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: { message: text || `${route.provider} returned a non-JSON response.` } };
  }

  return {
    ok: response.ok,
    status: response.status,
    payload: parsed,
  };
}

function deepSeekResponseNeedsRetry(payload, forwardedBody) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    return true;
  }
  if (forwardedBody.response_format?.type !== 'json_object') {
    return false;
  }
  try {
    const parsed = JSON.parse(content);
    return !parsed || typeof parsed !== 'object' || Array.isArray(parsed);
  } catch {
    return true;
  }
}

function mergedUsage(firstUsage, secondUsage) {
  if (!firstUsage && !secondUsage) {
    return undefined;
  }
  const merged = { ...(firstUsage || {}), ...(secondUsage || {}) };
  const fields = [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
    'cost',
  ];
  for (const field of fields) {
    const first = Number(firstUsage?.[field] || 0);
    const second = Number(secondUsage?.[field] || 0);
    if (first || second) {
      merged[field] = first + second;
    }
  }
  return merged;
}

async function proxyChatCompletion(body, route) {
  const forwarded = forwardedChatBody(body, route);
  const first = await performChatCompletion(forwarded, route);
  if (route.kind !== 'deepseek' || !first.ok || !deepSeekResponseNeedsRetry(first.payload, forwarded)) {
    return first;
  }

  const retryInstruction = forwarded.response_format?.type === 'json_object'
    ? 'The prior generation was empty or invalid. Return the complete valid JSON object now.'
    : 'The prior generation was empty. Return a complete non-empty answer now.';
  const retryBody = {
    ...forwarded,
    messages: appendSystemInstruction(forwarded.messages, retryInstruction),
  };
  const second = await performChatCompletion(retryBody, route);
  if (second.payload && typeof second.payload === 'object') {
    second.payload.usage = mergedUsage(first.payload?.usage, second.payload.usage);
  }
  return second;
}

async function checkProviderHealth(route) {
  const response = await fetch(route.healthURL, {
    method: 'GET',
    headers: providerHeaders(route),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    payload: parsed,
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, {
        ok: true,
        service: 'AgeUp backend',
        endpoints: [
          '/v1/health/ai',
          '/v1/health/openai',
          '/v1/chat/completions',
          '/v1/creator-codes/redeem',
          '/v1/player-safety/account-deleted',
        ],
        models: [...modelRoutes.keys()],
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/player-safety/account-deleted') {
      const at = new Date();
      const day = playerQuotaUTCDateKey(at);
      const identity = playerQuotaIdentity(req);
      const receiptState = verifiedPlayerQuotaReceipt(
        req.headers['x-my-path-quota-receipt'],
        identity.hash,
        day,
      );
      const snapshot = getPlayerUsageLedger().markDeleted(identity.hash, day, receiptState, at);
      return sendJson(res, 200, {
        ok: true,
        retained_safety_record: true,
        message: 'Account data can be deleted without resetting the daily AI safety limit.',
      }, quotaHeaders(identity.hash, day, snapshot, at));
    }

    if (req.method === 'POST' && url.pathname === '/v1/creator-codes/redeem') {
      const address = creatorCodeClientAddress(req);
      const noStoreHeaders = { 'Cache-Control': 'no-store' };
      if (creatorCodeRequestIsRateLimited(address)) {
        return sendJson(res, 429, {
          error: { message: 'Too many incorrect code attempts. Try again later.' },
        }, noStoreHeaders);
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        recordCreatorCodeFailure(address);
        return sendJson(res, 400, {
          error: { message: error instanceof Error ? error.message : 'Invalid JSON body.' },
        }, noStoreHeaders);
      }

      let catalog;
      try {
        catalog = parseCreatorCodeCatalog(creatorCodesJSON);
      } catch (error) {
        console.error('Invalid CREATOR_CODES_JSON:', error);
        return sendJson(res, 503, {
          error: { message: 'Creator codes are temporarily unavailable.' },
        }, noStoreHeaders);
      }
      if (catalog.size === 0) {
        return sendJson(res, 503, {
          error: { message: 'Creator codes are not available yet.' },
        }, noStoreHeaders);
      }

      const clientBuild = creatorCodeInteger(body?.client_build, 1, 1_000_000, 1);
      const result = resolveCreatorCode(catalog, body?.code, clientBuild);
      if (result.status !== 200) {
        recordCreatorCodeFailure(address);
        return sendJson(res, result.status, {
          error: { message: result.error },
        }, noStoreHeaders);
      }
      return sendJson(res, 200, {
        ok: true,
        ...result.redemption,
      }, noStoreHeaders);
    }

    if (req.method === 'GET' && (url.pathname === '/v1/health/ai' || url.pathname === '/v1/health/openai')) {
      const requestedModel = url.pathname === '/v1/health/openai'
        ? 'gpt-4o-mini'
        : normalizeModelName(url.searchParams.get('model') || 'gpt-4o-mini');
      const route = routeForModel(requestedModel);

      if (!route) {
        return sendJson(res, 400, {
          ok: false,
          error: `Unsupported model. Choose one of: ${[...modelRoutes.keys()].join(', ')}.`,
        });
      }

      if (!route.apiKey) {
        return sendJson(res, 503, {
          ok: false,
          error: `Missing ${route.missingKeyName} in backend environment.`,
        });
      }

      const result = await checkProviderHealth(route);
      if (!result.ok) {
        return sendJson(res, result.status, {
          ok: false,
          error: `Backend could not authenticate with ${route.provider}.`,
          details: result.payload,
        });
      }

      return sendJson(res, 200, {
        ok: true,
        model: requestedModel,
        provider: route.provider,
        message: `Backend can reach ${route.provider}.`,
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return sendJson(res, 400, {
          error: {
            message: error instanceof Error ? error.message : 'Invalid JSON body.',
          },
        });
      }

      const validationError = validateChatCompletionBody(body);
      if (validationError) {
        return sendJson(res, 400, {
          error: {
            message: validationError,
          },
        });
      }

      const route = routeForModel(body.model);
      if (!route.apiKey) {
        return sendJson(res, 503, {
          error: {
            message: `Missing ${route.missingKeyName} in backend environment.`,
          },
        });
      }

      const quotaAt = new Date();
      const quotaDay = playerQuotaUTCDateKey(quotaAt);
      const quotaIdentity = playerQuotaIdentity(req);
      const receiptState = verifiedPlayerQuotaReceipt(
        req.headers['x-my-path-quota-receipt'],
        quotaIdentity.hash,
        quotaDay,
      );
      const estimatedTokens = estimatedChatWalletTokens(body, route, quotaAt);
      const ledger = getPlayerUsageLedger();
      const quotaReservation = ledger.reserve(
        quotaIdentity.hash,
        quotaDay,
        estimatedTokens,
        receiptState,
        quotaAt,
      );
      if (!quotaReservation.allowed) {
        return sendJson(res, 429, {
          error: {
            code: 'daily_ai_token_limit',
            message: `Daily AI limit reached. Each player can use up to ${playerDailyAITokenLimit.toLocaleString('en-US')} AI Tokens per UTC day. Try again after ${playerQuotaResetDate(quotaAt).toISOString()}.`,
          },
        }, quotaHeaders(quotaIdentity.hash, quotaDay, quotaReservation.snapshot, quotaAt));
      }

      let result;
      try {
        result = await proxyChatCompletion(body, route);
      } catch (error) {
        ledger.release(quotaReservation.reservation, new Date());
        throw error;
      }

      if (result.payload?.usage) {
        attachPricingMetadata(result.payload, route, quotaAt);
      }
      const actualTokens = actualChatWalletTokens(result.payload, route, quotaAt);
      const quotaSnapshot = ledger.reconcile(
        quotaReservation.reservation,
        actualTokens,
        new Date(),
      );
      return sendJson(
        res,
        result.status,
        result.payload,
        quotaHeaders(quotaIdentity.hash, quotaDay, quotaSnapshot, quotaAt),
      );
    }

    return sendJson(res, 404, {
      error: {
        message: 'Not found.',
      },
    });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      error: {
        message: error instanceof Error ? error.message : 'Unexpected server error.',
      },
    });
  }
});

const isMainModule = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`AgeUp backend listening on http://0.0.0.0:${port}`);
  });

  process.on('SIGINT', () => {
    server.close(() => {
      process.exit(0);
    });
  });
}

export {
  PlayerUsageLedger,
  actualChatWalletTokens,
  attachPricingMetadata,
  creatorCodeInteger,
  creatorCodeRequestIsRateLimited,
  deepSeekPricingMultiplier,
  deepSeekResponseNeedsRetry,
  forwardedChatBody,
  mergedUsage,
  modelRoutes,
  normalizePlayerIdentifier,
  normalizeCreatorCode,
  normalizeModelName,
  parseCreatorCodeCatalog,
  playerQuotaHash,
  playerQuotaReceipt,
  playerQuotaUTCDateKey,
  recordCreatorCodeFailure,
  resolveCreatorCode,
  routeForModel,
  server,
  verifiedPlayerQuotaReceipt,
  estimatedChatWalletTokens,
};
