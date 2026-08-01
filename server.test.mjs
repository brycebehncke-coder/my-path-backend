import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AppAttestRequestError,
  PlayerUsageLedger,
  actualChatWalletTokens,
  appAttestClientData,
  appAttestIsRequired,
  attachPricingMetadata,
  estimatedChatWalletTokens,
  normalizeCreatorCode,
  parseCreatorCodeCatalog,
  resolveCreatorCode,
  deepSeekPricingMultiplier,
  deepSeekResponseNeedsRetry,
  forwardedChatBody,
  issueAppAttestChallenges,
  mergedUsage,
  normalizeModelName,
  normalizePlayerIdentifier,
  playerQuotaHash,
  playerQuotaReceipt,
  routeForModel,
  verifiedAppAttestChallengeToken,
  verifiedPlayerQuotaReceipt,
  verifyAppAttestRequest,
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

test('App Attest challenges are signed, short lived, and bound to one player and purpose', () => {
  const at = new Date('2026-08-01T12:00:00Z');
  const playerHash = playerQuotaHash('attest-player');
  const challenge = issueAppAttestChallenges(playerHash, 'assertion', 3, at)[0];

  const verified = verifiedAppAttestChallengeToken(
    challenge.challenge_token,
    playerHash,
    'assertion',
    at,
  );
  assert.equal(verified.c, challenge.challenge);
  assert.equal(verified.u, 'assertion');
  assert.equal(
    verifiedAppAttestChallengeToken(
      challenge.challenge_token,
      playerQuotaHash('different-player'),
      'assertion',
      at,
    ),
    null,
  );
  assert.equal(
    verifiedAppAttestChallengeToken(challenge.challenge_token, playerHash, 'attestation', at),
    null,
  );
  assert.equal(
    verifiedAppAttestChallengeToken(
      challenge.challenge_token,
      playerHash,
      'assertion',
      new Date(challenge.expires_at_ms + 1),
    ),
    null,
  );
  assert.equal(
    verifiedAppAttestChallengeToken(`${challenge.challenge_token}x`, playerHash, 'assertion', at),
    null,
  );
});

test('App Attest request binding changes with the method, path, or exact body bytes', () => {
  const body = Buffer.from('{"answer":42}');
  const baseline = appAttestClientData('challenge-value', 'POST', '/v1/example', body);
  assert.notDeepEqual(
    baseline,
    appAttestClientData('challenge-value', 'PUT', '/v1/example', body),
  );
  assert.notDeepEqual(
    baseline,
    appAttestClientData('challenge-value', 'POST', '/v1/other', body),
  );
  assert.notDeepEqual(
    baseline,
    appAttestClientData('challenge-value', 'POST', '/v1/example', Buffer.from('{ "answer": 42 }')),
  );
});

test('App Attest enforcement supports rollout builds and a strict production switch', () => {
  const oldRequest = { headers: { 'x-my-path-client-build': '171' } };
  const newRequest = { headers: { 'x-my-path-client-build': '172' } };
  assert.equal(appAttestIsRequired(oldRequest, 'new-builds'), false);
  assert.equal(appAttestIsRequired(newRequest, 'new-builds'), true);
  assert.equal(appAttestIsRequired(oldRequest, 'required'), true);
  assert.equal(appAttestIsRequired(newRequest, 'off'), false);
});

test('persists App Attest public keys and never resets an assertion counter on registration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'my-path-app-attest-'));
  const filePath = join(directory, 'usage.json');
  const keyId = `${'A'.repeat(43)}=`;
  const playerHash = playerQuotaHash('persisted-attest-player');
  const publicKey = '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----';
  const at = new Date('2026-08-01T12:00:00Z');

  try {
    const first = new PlayerUsageLedger({ filePath });
    first.registerAppAttestKey({
      keyId,
      playerHash,
      publicKey,
      environment: 'production',
    }, at);
    first.advanceAppAttestSignCount(keyId, 0, 7, at);
    first.registerAppAttestKey({
      keyId,
      playerHash,
      publicKey,
      environment: 'production',
    }, at);
    assert.equal(first.appAttestKey(keyId).signCount, 7);

    const reloaded = new PlayerUsageLedger({ filePath });
    assert.equal(reloaded.appAttestKey(keyId).signCount, 7);
    assert.equal(reloaded.appAttestKey(keyId).playerHash, playerHash);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts a valid bound assertion once and rejects a replayed counter', () => {
  const at = new Date('2026-08-01T12:00:00Z');
  const identifier = '866f9714-c058-4d2d-bf34-93f57086e437';
  const identity = { identifier, hash: playerQuotaHash(identifier), isLegacy: false };
  const keyId = `${'B'.repeat(43)}=`;
  const rawBody = Buffer.from('{"model":"gpt-4o-mini"}');
  const challenge = issueAppAttestChallenges(identity.hash, 'assertion', 1, at)[0];
  const ledger = new PlayerUsageLedger();
  ledger.registerAppAttestKey({
    keyId,
    playerHash: identity.hash,
    publicKey: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
    environment: 'production',
  }, at);
  const req = {
    method: 'POST',
    headers: {
      'x-my-path-client-build': '172',
      'x-my-path-app-attest-key-id': keyId,
      'x-my-path-app-attest-assertion': Buffer.from('signed-proof').toString('base64'),
      'x-my-path-app-attest-challenge-token': challenge.challenge_token,
    },
  };
  let verifierCalls = 0;
  const assertionVerifier = (input) => {
    verifierCalls += 1;
    assert.deepEqual(
      input.payload,
      appAttestClientData(challenge.challenge, 'POST', '/v1/chat/completions', rawBody),
    );
    return { signCount: 1 };
  };

  const result = verifyAppAttestRequest({
    req,
    pathname: '/v1/chat/completions',
    rawBody,
    identity,
    ledger,
    at,
    assertionVerifier,
    enforcement: 'new-builds',
  });
  assert.deepEqual(result, { verified: true, keyId, signCount: 1 });
  assert.equal(ledger.appAttestKey(keyId).signCount, 1);

  assert.throws(
    () => verifyAppAttestRequest({
      req,
      pathname: '/v1/chat/completions',
      rawBody,
      identity,
      ledger,
      at,
      assertionVerifier,
      enforcement: 'new-builds',
    }),
    /counter did not advance/i,
  );
  assert.equal(verifierCalls, 2);
});

test('new protected builds get a clear App Attest error when proof headers are absent', () => {
  const req = { method: 'POST', headers: { 'x-my-path-client-build': '172' } };
  const identity = {
    identifier: '866f9714-c058-4d2d-bf34-93f57086e437',
    hash: playerQuotaHash('866f9714-c058-4d2d-bf34-93f57086e437'),
    isLegacy: false,
  };
  assert.throws(
    () => verifyAppAttestRequest({
      req,
      pathname: '/v1/chat/completions',
      rawBody: Buffer.from('{}'),
      identity,
      ledger: new PlayerUsageLedger(),
      enforcement: 'new-builds',
    }),
    (error) => error instanceof AppAttestRequestError && error.code === 'app_attest_required',
  );
});
