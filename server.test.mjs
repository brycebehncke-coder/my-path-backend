import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PlayerUsageLedger,
  actualChatWalletTokens,
  attachPricingMetadata,
  estimatedChatWalletTokens,
  normalizeCreatorCode,
  parseCreatorCodeCatalog,
  resolveCreatorCode,
  deepSeekPricingMultiplier,
  deepSeekResponseNeedsRetry,
  forwardedChatBody,
  mergedUsage,
  normalizeModelName,
  normalizePlayerIdentifier,
  playerQuotaHash,
  playerQuotaReceipt,
  routeForModel,
  verifiedPlayerQuotaReceipt,
} from './server.mjs';

test('normalizes creator codes without exposing formatting differences', () => {
  assert.equal(normalizeCreatorCode(' bryce-launch 2026 '), 'BRYCELAUNCH2026');
  assert.equal(normalizeCreatorCode('Bryce_Launch-2026'), 'BRYCELAUNCH2026');
});

test('parses flexible creator rewards and resolves only the matching code', () => {
  const catalog = parseCreatorCodeCatalog(JSON.stringify({
    'BRYCE-LAUNCH-2026': {
      id: 'launch-2026',
      title: 'Launch Gift',
      message: 'Thanks for playing.',
      minimum_build: 168,
      expires_at: '2027-01-01T00:00:00Z',
      rewards: [
        { type: 'ai_tokens', amount: 200_000 },
        { type: 'custom_life_access', hours: 24 },
        { type: 'dlc', id: 'walker_apocalypse' },
        { type: 'stat', id: 'happiness', amount: 10 },
      ],
    },
  }));

  assert.equal(catalog.size, 1);
  const valid = resolveCreatorCode(
    catalog,
    'bryce launch 2026',
    168,
    new Date('2026-08-01T12:00:00Z'),
  );
  assert.equal(valid.status, 200);
  assert.equal(valid.redemption.id, 'launch-2026');
  assert.equal(valid.redemption.rewards[0].amount, 200_000);
  assert.equal(valid.redemption.rewards[2].id, 'walker_apocalypse');

  assert.equal(resolveCreatorCode(catalog, 'not-real', 168).status, 404);
  assert.equal(resolveCreatorCode(catalog, 'BRYCE-LAUNCH-2026', 167).status, 409);
  assert.equal(
    resolveCreatorCode(catalog, 'BRYCE-LAUNCH-2026', 168, new Date('2027-01-01T00:00:00Z')).status,
    410,
  );
});

test('rejects malformed creator reward definitions instead of granting partial rewards', () => {
  assert.throws(
    () => parseCreatorCodeCatalog(JSON.stringify({
      'BROKEN-CODE': {
        rewards: [{ type: 'stat', id: 'made_up_stat', amount: 100 }],
      },
    })),
    /unsupported id/,
  );
});

test('marks only the announced DeepSeek UTC windows as double-price periods', () => {
  assert.equal(deepSeekPricingMultiplier(new Date('2026-07-21T00:59:59Z')), 1);
  assert.equal(deepSeekPricingMultiplier(new Date('2026-07-21T01:00:00Z')), 2);
  assert.equal(deepSeekPricingMultiplier(new Date('2026-07-21T03:59:59Z')), 2);
  assert.equal(deepSeekPricingMultiplier(new Date('2026-07-21T04:00:00Z')), 1);
  assert.equal(deepSeekPricingMultiplier(new Date('2026-07-21T06:00:00Z')), 2);
  assert.equal(deepSeekPricingMultiplier(new Date('2026-07-21T09:59:59Z')), 2);
  assert.equal(deepSeekPricingMultiplier(new Date('2026-07-21T10:00:00Z')), 1);
});

test('attaches peak pricing only to successful DeepSeek usage payloads', () => {
  const deepSeekPayload = { usage: { total_tokens: 1_000 } };
  attachPricingMetadata(
    deepSeekPayload,
    routeForModel('deepseek-v4-pro'),
    new Date('2026-07-21T06:30:00Z'),
  );
  assert.equal(deepSeekPayload.provider, 'DeepSeek');
  assert.equal(deepSeekPayload.requested_model, 'deepseek-v4-pro');
  assert.equal(deepSeekPayload.usage.wallet_token_multiplier, 2);
  assert.equal(deepSeekPayload.usage.pricing_period, 'peak');

  const openAIPayload = { usage: { total_tokens: 1_000 } };
  attachPricingMetadata(
    openAIPayload,
    routeForModel('gpt-4o-mini'),
    new Date('2026-07-21T06:30:00Z'),
  );
  assert.equal(openAIPayload.provider, 'OpenAI');
  assert.equal(openAIPayload.requested_model, 'gpt-4o-mini');
  assert.equal('wallet_token_multiplier' in openAIPayload.usage, false);
});

test('normalizes the former OpenRouter model id to direct DeepSeek', () => {
  assert.equal(normalizeModelName('deepseek/deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(normalizeModelName('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(routeForModel('deepseek/deepseek-v4-pro')?.provider, 'DeepSeek');
});

test('adapts strict schema requests for the direct DeepSeek API', () => {
  const route = routeForModel('deepseek-v4-pro');
  const body = {
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: 'Simulate the next event.' },
      { role: 'user', content: 'Continue.' },
    ],
    prompt_cache_key: 'life-123',
    reasoning: { effort: 'high' },
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'yearly_event',
        strict: true,
        schema: {
          type: 'object',
          properties: { narration: { type: 'string' } },
          required: ['narration'],
          additionalProperties: false,
        },
      },
    },
  };

  const forwarded = forwardedChatBody(body, route);

  assert.equal(forwarded.model, 'deepseek-v4-pro');
  assert.deepEqual(forwarded.thinking, { type: 'disabled' });
  assert.deepEqual(forwarded.response_format, { type: 'json_object' });
  assert.equal('prompt_cache_key' in forwarded, false);
  assert.equal('reasoning' in forwarded, false);
  assert.match(forwarded.messages[0].content, /valid JSON object named yearly_event/);
  assert.match(forwarded.messages[0].content, /"narration"/);
});

test('leaves the existing GPT request format intact', () => {
  const body = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello.' }],
    prompt_cache_key: 'life-123',
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'reply', strict: true, schema: { type: 'object' } },
    },
  };

  const forwarded = forwardedChatBody(body, routeForModel('gpt-4o-mini'));

  assert.equal(forwarded.model, 'gpt-4o-mini');
  assert.equal(forwarded.prompt_cache_key, 'life-123');
  assert.equal(forwarded.response_format.type, 'json_schema');
  assert.equal('thinking' in forwarded, false);
});

test('retries only empty or malformed DeepSeek JSON and combines usage', () => {
  const jsonBody = { response_format: { type: 'json_object' } };
  assert.equal(deepSeekResponseNeedsRetry({ choices: [{ message: { content: '' } }] }, jsonBody), true);
  assert.equal(deepSeekResponseNeedsRetry({ choices: [{ message: { content: 'not json' } }] }, jsonBody), true);
  assert.equal(deepSeekResponseNeedsRetry({ choices: [{ message: { content: '{"ok":true}' } }] }, jsonBody), false);

  assert.deepEqual(
    mergedUsage(
      { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
    ),
    { prompt_tokens: 220, completion_tokens: 30, total_tokens: 250 },
  );
});

test('accepts only canonical player UUIDs and signs receipts for that player and UTC day', () => {
  const identifier = '866f9714-c058-4d2d-bf34-93f57086e437';
  const hash = playerQuotaHash(identifier);
  const secret = 'test-only-quota-secret';
  const receipt = playerQuotaReceipt({
    v: 1,
    p: hash,
    d: '2026-08-01',
    u: 12_345,
    x: null,
  }, secret);

  assert.equal(normalizePlayerIdentifier(identifier.toUpperCase()), identifier);
  assert.equal(normalizePlayerIdentifier('not-a-player-id'), '');
  assert.deepEqual(
    verifiedPlayerQuotaReceipt(receipt, hash, '2026-08-01', secret),
    { used: 12_345, deletedAt: null },
  );
  assert.equal(verifiedPlayerQuotaReceipt(`${receipt}x`, hash, '2026-08-01', secret), null);
  assert.equal(verifiedPlayerQuotaReceipt(receipt, playerQuotaHash('other'), '2026-08-01', secret), null);
  assert.equal(verifiedPlayerQuotaReceipt(receipt, hash, '2026-08-02', secret), null);
});

test('enforces exactly 500,000 charged AI Tokens per player per UTC day', () => {
  const ledger = new PlayerUsageLedger({ dailyLimit: 500_000 });
  const playerHash = playerQuotaHash('quota-test-player');
  const day = '2026-08-01';
  const at = new Date('2026-08-01T12:00:00Z');

  const first = ledger.reserve(playerHash, day, 300_000, null, at);
  assert.equal(first.allowed, true);
  assert.equal(ledger.reconcile(first.reservation, 300_000, at).used, 300_000);

  const second = ledger.reserve(playerHash, day, 200_000, null, at);
  assert.equal(second.allowed, true);
  const full = ledger.reconcile(second.reservation, 200_000, at);
  assert.equal(full.used, 500_000);
  assert.equal(full.remaining, 0);

  const denied = ledger.reserve(playerHash, day, 1, null, at);
  assert.equal(denied.allowed, false);
  assert.equal(denied.snapshot.used, 500_000);
});

test('never lets an older signed receipt lower known daily usage', () => {
  const ledger = new PlayerUsageLedger({ dailyLimit: 500_000 });
  const playerHash = playerQuotaHash('receipt-merge-player');
  const day = '2026-08-01';
  const at = new Date('2026-08-01T12:00:00Z');
  const reservation = ledger.reserve(playerHash, day, 250_000, null, at);
  ledger.reconcile(reservation.reservation, 250_000, at);

  const snapshot = ledger.reserve(
    playerHash,
    day,
    1,
    { used: 100_000, deletedAt: null },
    at,
  );
  assert.equal(snapshot.allowed, true);
  assert.equal(ledger.release(snapshot.reservation, at).used, 250_000);
});

test('persists the deleted-account tombstone without storing a raw player id', () => {
  const directory = mkdtempSync(join(tmpdir(), 'my-path-player-quota-'));
  const filePath = join(directory, 'usage.json');
  const playerHash = playerQuotaHash('deleted-player');
  const day = '2026-08-01';
  const at = new Date('2026-08-01T12:00:00Z');

  try {
    const first = new PlayerUsageLedger({ filePath, dailyLimit: 500_000 });
    const deleted = first.markDeleted(playerHash, day, { used: 42_000 }, at);
    assert.equal(deleted.used, 42_000);
    assert.equal(deleted.deletedAt, at.toISOString());

    const reloaded = new PlayerUsageLedger({ filePath, dailyLimit: 500_000 });
    const snapshot = reloaded.snapshot(playerHash, day, at);
    assert.equal(snapshot.used, 42_000);
    assert.equal(snapshot.deletedAt, at.toISOString());
    assert.equal(readFileSync(filePath, 'utf8').includes('deleted-player'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reserves conservatively but reconciles against actual provider usage', () => {
  const body = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Tell one short story.' }],
    max_tokens: 750,
  };
  const serializedBytes = Buffer.byteLength(JSON.stringify(body.messages), 'utf8');
  assert.equal(
    estimatedChatWalletTokens(body, routeForModel('gpt-4o-mini')),
    serializedBytes + 750,
  );

  const deepSeekUsage = { usage: { prompt_tokens: 800, completion_tokens: 200 } };
  assert.equal(
    actualChatWalletTokens(
      deepSeekUsage,
      routeForModel('deepseek-v4-pro'),
      new Date('2026-08-01T06:30:00Z'),
    ),
    2_000,
  );
});
