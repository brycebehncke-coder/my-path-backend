import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  AppAttestRequestError,
  PlayIntegrityRequestError,
  PlayerUsageLedger,
  PortraitRequestCoordinator,
  actualChatWalletTokens,
  appAttestClientData,
  appAttestIsRequired,
  attachPricingMetadata,
  estimatedChatWalletTokens,
  normalizeCreatorCode,
  parseCreatorCodeCatalog,
  resolveCreatorCode,
  deepSeekJSONInstructionForBody,
  deepSeekPricingMultiplier,
  deepSeekResponseNeedsRetry,
  editCloudflarePortrait,
  generateCloudflarePortrait,
  forwardedChatBody,
  gpt5MiniBirthResponseNeedsRetry,
  gpt5MiniBirthRetryBody,
  gpt5MiniCustomBirthResponseNeedsRetry,
  gpt5MiniCustomBirthRetryBody,
  gpt5MiniAnnualAgeResponseNeedsRetry,
  gpt5MiniAnnualAgeRetryBody,
  issueAppAttestChallenges,
  isGPT5MiniAnnualAgeRequest,
  isGPT5MiniBirthNarrationRequest,
  isGPT5MiniCustomBirthDossierRequest,
  mergedUsage,
  normalizeAIContentReport,
  openAICreditBalanceIsExhausted,
  openAICreditFallbackBody,
  normalizePortraitSubject,
  normalizeModelName,
  normalizePlayerIdentifier,
  playerQuotaHash,
  playerQuotaReceipt,
  playIntegrityRequestHash,
  portraitEditPrompt,
  portraitGenerationPrompt,
  portraitGenerationRequestBody,
  portraitLifeStage,
  portraitEstimatedCostUSD,
  portraitRequestKey,
  recordAIContentReport,
  routeForModel,
  validatePlayIntegrityVerdict,
  verifiedAppAttestChallengeToken,
  verifiedPlayerQuotaReceipt,
  verifyAppAttestRequest,
  verifyGenuineAppRequest,
  verifyPlayIntegrityRequest,
} from './server.mjs';

function deferredPortraitProvider() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function portraitProviderResponse(status = 200, message = '') {
  return new Response(JSON.stringify(message
    ? { success: false, errors: [{ message }] }
    : { success: true, result: { image: Buffer.alloc(120, 1).toString('base64') } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const flushPortraitPromises = () => new Promise((resolve) => setImmediate(resolve));

test('custom life schema settles identity and cast before writing the story without changing its fields', () => {
  const field = { type: 'string' };
  const shape = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const schema = shape({ s: field, people: { type: 'array', items: shape({ visual: field, n: field, r: field }) },
    place: shape({ c: field }), cast: { type: 'array', items: field }, p: shape({ visual: field, a: field, n: field }) });
  const request = { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Custom life' }],
    response_format: { type: 'json_schema', json_schema: { name: 'gpt5_open_custom_takeover_launch_v5', strict: true, schema } } };
  const before = JSON.stringify(request);
  const result = forwardedChatBody(request, routeForModel('gpt-5-mini')).response_format.json_schema.schema;
  assert.deepEqual(Object.keys(result.properties), ['p', 'place', 'cast', 'people', 's']);
  assert.equal(Object.keys(result.properties.p.properties)[0], 'n');
  assert.equal(Object.keys(result.properties.people.items.properties)[0], 'n');
  assert.deepEqual(result.properties.s, schema.properties.s);
  assert.deepEqual(new Set(result.required), new Set(schema.required));
  assert.equal(JSON.stringify(request), before);
});

test('time jump schema resolves the whole interval before generating its new scene', () => {
  const properties = { new_instance: { type: 'string' }, scene_memory: { type: 'string' },
    elapsed_seconds: { type: 'integer', const: 604800 }, resolution: { type: 'string' },
    health_delta: { type: 'integer', minimum: -100 }, custom_extra: { type: 'boolean' } };
  const request = { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Age one week' }],
    response_format: { type: 'json_schema', json_schema: { name: 'novel_battlefield_campaign_age_v3', strict: true,
      schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } } };
  const result = forwardedChatBody(request, routeForModel('gpt-5-mini')).response_format.json_schema.schema;
  assert.deepEqual(Object.keys(result.properties), ['elapsed_seconds', 'resolution', 'new_instance', 'health_delta', 'scene_memory', 'custom_extra']);
  assert.deepEqual(result.properties, properties);
  assert.deepEqual(new Set(result.required), new Set(Object.keys(properties)));
});

test('action story is written before extracting injury evidence and effects', () => {
  const properties = { effects: { type: 'object' }, hiddenFacts: { type: 'array' }, answer: { type: 'string' } };
  const request = { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'I sprain my ankle' }],
    response_format: { type: 'json_schema', json_schema: { name: 'novel_action', strict: true,
      schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } } };
  const result = forwardedChatBody(request, routeForModel('gpt-5-mini')).response_format.json_schema.schema;
  assert.deepEqual(Object.keys(result.properties), ['answer', 'effects', 'hiddenFacts']);
  assert.deepEqual(result.properties, properties);
});

test('portrait generation preserves identity and never rewrites a rejected request', async (t) => {
  const subject = normalizePortraitSubject({ profile_id: 'fallback', age: 5, species: 'elf' });
  for (const [status, message] of [
    [401, 'Authentication failed: content rejected'],
    [403, 'Forbidden: prompt rejected'],
    [429, 'Rate limit exceeded: prompt rejected'],
    [408, 'Request timed out'],
    [500, 'Content rejected by unavailable service'],
    [504, 'Gateway timeout'],
    [400, 'Invalid width'],
    [400, 'Prompt rejected: invalid API key'],
    [200, 'Authentication error'],
    [200, 'Rate limit exceeded: prompt rejected'],
    [200, 'Prompt rejected: operation timed out'],
  ]) {
    await t.test(`${status} ${message}`, async (t) => {
      const provider = t.mock.method(globalThis, 'fetch', async () => portraitProviderResponse(status, message));
      await assert.rejects(generateCloudflarePortrait(subject));
      assert.equal(provider.mock.callCount(), 1);
    });
  }
  await t.test('network errors are not prompt rejections', async (t) => {
    const provider = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
    await assert.rejects(generateCloudflarePortrait(subject), /fetch failed/);
    assert.equal(provider.mock.callCount(), 1);
  });
  await t.test('moderation rejection is not retried with a different identity', async (t) => {
    const provider = t.mock.method(globalThis, 'fetch', async () =>
      portraitProviderResponse(400, 'The prompt was rejected by the content safety filter.'));
    await assert.rejects(generateCloudflarePortrait(subject), { code: 'portrait_content_rejected', retryable: false });
    assert.equal(provider.mock.callCount(), 1);
  });
  await t.test('Cloudflare output-flagged responses also stop immediately', async (t) => {
    const provider = t.mock.method(globalThis, 'fetch', async () =>
      portraitProviderResponse(400, 'AiError: Your output has been flagged. Please choose another prompt / input image combination.'));
    await assert.rejects(generateCloudflarePortrait(subject), { code: 'portrait_content_rejected', retryable: false });
    assert.equal(provider.mock.callCount(), 1);
  });
  await t.test('a successful response without an image is not retried', async (t) => {
    const provider = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
    await assert.rejects(generateCloudflarePortrait(subject), /no image/);
    assert.equal(provider.mock.callCount(), 1);
  });
  await t.test('an HTTP error with an image content type is still a failure', async (t) => {
    const provider = t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.alloc(120), {
      status: 401,
      headers: { 'Content-Type': 'image/jpeg' },
    }));
    await assert.rejects(generateCloudflarePortrait(subject));
    assert.equal(provider.mock.callCount(), 1);
  });
});

test('portrait generation and editing bound fetch and response reading even when abort is ignored', async (t) => {
  const subject = normalizePortraitSubject({ profile_id: 'deadline', age: 5, species: 'elf' });
  for (const operation of ['generation', 'edit']) {
    for (const phase of ['fetch', 'json body', 'image body']) {
      await t.test(`${operation}: stalled ${phase}`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const stalled = deferredPortraitProvider();
        const provider = t.mock.method(globalThis, 'fetch', () => {
          if (phase === 'fetch') return stalled.promise;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers({ 'Content-Type': phase === 'image body' ? 'image/jpeg' : 'application/json' }),
            text: () => stalled.promise,
            arrayBuffer: () => stalled.promise,
          });
        });
        const request = operation === 'generation'
          ? generateCloudflarePortrait(subject)
          : editCloudflarePortrait(subject, 'short hair', Buffer.alloc(120));
        const outcome = assert.rejects(request, { name: 'TimeoutError' });
        await flushPortraitPromises();
        const signal = provider.mock.calls[0].arguments[1].signal;
        t.mock.timers.tick(44_999);
        assert.equal(signal.aborted, false);
        t.mock.timers.tick(1);
        await outcome;
        assert.equal(signal.aborted, true);
        stalled.resolve(phase === 'fetch'
          ? portraitProviderResponse(400, 'Prompt rejected by safety filter')
          : phase === 'image body'
            ? Buffer.alloc(120)
            : JSON.stringify({ success: false, errors: [{ message: 'Prompt rejected by safety filter' }] }));
        await flushPortraitPromises();
        assert.equal(provider.mock.callCount(), 1, 'late completion must not start a fallback');
      });
    }
  }
});

test('a delayed provider quota failure stays nonretryable and is not masked as a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferredPortraitProvider();
  const provider = t.mock.method(globalThis, 'fetch', () => first.promise);
  const subject = normalizePortraitSubject({ profile_id: 'shared-deadline', age: 5, species: 'elf' });
  const outcome = assert.rejects(generateCloudflarePortrait(subject), {
    code: 'portrait_provider_quota_exhausted', retryable: false, statusCode: 503,
  });
  t.mock.timers.tick(30_000);
  first.resolve(portraitProviderResponse(429, 'you have used up your daily free allocation of 10,000 neurons'));
  await flushPortraitPromises();
  await outcome;
  t.mock.timers.tick(60_000);
  await flushPortraitPromises();
  assert.equal(provider.mock.callCount(), 1);
});

test('portrait keys include every normalized subject field, operation, change, player, and reference bytes', () => {
  const body = {
    profile_id: 'key-subject', age: 28, revision: 1, name: '  Alex\nExample ', gender: 'woman',
    role: 'parent', species: 'person', location: 'Paris', era: 'modern', occupation: 'teacher',
    subject_description: 'A close family', appearance_description: 'Short hair',
    visual_identity: 'Brown eyes', family_identity: 'Freckles', style: 'STYLIZED',
  };
  const subject = normalizePortraitSubject(body);
  const reference = Buffer.alloc(120, 1);
  const key = portraitRequestKey('player-one', subject, 'edit', 'short hair', reference);
  assert.equal(key.length, 64);
  assert.equal(key, portraitRequestKey('player-one', normalizePortraitSubject({
    ...body, name: 'Alex Example', age: '28', style: 'stylized', life_stage: 'elderly',
  }), 'edit', 'short hair', Buffer.from(reference)));
  for (const [field, value] of Object.entries({
    profile_id: 'other-profile', age: 29, revision: 2, name: 'Other name', gender: 'man',
    role: 'friend', species: 'elf', location: 'London', era: 'future', occupation: 'artist',
    subject_description: 'Other history', appearance_description: 'Long hair',
    visual_identity: 'Green eyes', family_identity: 'Other inherited traits', style: 'realistic',
    condition_description: 'Malnourished and exhausted', scene_description: 'Waiting in a hospital ward',
  })) {
    assert.notEqual(key, portraitRequestKey('player-one', normalizePortraitSubject({ ...body, [field]: value }),
      'edit', 'short hair', reference), field);
  }
  assert.notEqual(key, portraitRequestKey('player-two', subject, 'edit', 'short hair', reference));
  assert.notEqual(key, portraitRequestKey('player-one', subject, 'generation', 'short hair', reference));
  assert.notEqual(key, portraitRequestKey('player-one', subject, 'edit', 'blue hair', reference));
  assert.notEqual(key, portraitRequestKey('player-one', subject, 'edit', 'short hair', Buffer.alloc(120, 2)));
  const longIdentity = 'x'.repeat(200);
  assert.notEqual(
    portraitRequestKey('player-one', normalizePortraitSubject({ ...body, visual_identity: `${longIdentity}a` }), 'generation'),
    portraitRequestKey('player-one', normalizePortraitSubject({ ...body, visual_identity: `${longIdentity}b` }), 'generation'),
    'identity must not be reduced to the truncated provider prompt',
  );
});

test('portrait coordinator coalesces owners, never charges duplicates, and expires successes after completion', async () => {
  let now = 0;
  let quota = 0;
  let operations = 0;
  const coordinator = new PortraitRequestCoordinator(() => now);
  const provider = deferredPortraitProvider();
  const createResponse = () => { operations += 1; return provider.promise; };
  const consumeQuota = () => { quota += 1; return true; };
  const owner = coordinator.run('one', createResponse, consumeQuota);
  const waiter = coordinator.run('one', createResponse, consumeQuota);
  await flushPortraitPromises();
  assert.equal(operations, 1);
  assert.equal(quota, 1);
  now = 30_000;
  provider.resolve({ ok: true, image_base64: 'same-image', estimated_cost_usd: 0.000287 });
  assert.equal((await owner).estimated_cost_usd, 0.000287);
  assert.equal((await waiter).estimated_cost_usd, 0);
  assert.equal(coordinator.inFlight.size, 0);
  now = 149_999;
  const replay = await coordinator.run('one', createResponse, consumeQuota);
  assert.equal(replay.image_base64, 'same-image');
  assert.equal(replay.estimated_cost_usd, 0);
  assert.equal(quota, 1);
  now = 150_000;
  assert.equal((await coordinator.run('one', createResponse, consumeQuota)).estimated_cost_usd, 0.000287);
  assert.equal(operations, 2);
  assert.equal(quota, 2);
});

test('portrait coordinator bounds cached and in-flight entries without evicting pending owners', async () => {
  const coordinator = new PortraitRequestCoordinator(() => 0);
  let quota = 0;
  const consumeQuota = () => { quota += 1; return true; };
  const response = { ok: true, estimated_cost_usd: 1 };
  for (let index = 0; index < 33; index += 1) {
    await coordinator.run(`cached-${index}`, async () => response, consumeQuota);
  }
  assert.equal(coordinator.completed.size, 32);
  assert.equal(coordinator.completed.has('cached-0'), false);
  const provider = deferredPortraitProvider();
  const owners = Array.from({ length: 32 }, (_, index) => coordinator.run(`pending-${index}`, () => provider.promise, consumeQuota));
  const waiter = coordinator.run('pending-0', () => assert.fail('duplicate provider call'), consumeQuota);
  await assert.rejects(coordinator.run('overflow', () => provider.promise, consumeQuota), { code: 'portrait_capacity' });
  assert.equal(quota, 65);
  assert.equal((await coordinator.run('cached-32', () => assert.fail('cached provider call'), consumeQuota)).estimated_cost_usd, 0);
  provider.resolve(response);
  assert.equal((await waiter).estimated_cost_usd, 0);
  assert.equal((await Promise.all(owners)).length, 32);
  assert.equal(coordinator.inFlight.size, 0);
  assert.equal(coordinator.completed.size, 32);
});

test('portrait coordinator clears failures for every waiter and does not cache quota failures', async () => {
  const coordinator = new PortraitRequestCoordinator();
  const provider = deferredPortraitProvider();
  let quota = 0;
  const consumeQuota = () => { quota += 1; return true; };
  const owner = coordinator.run('failed', () => provider.promise, consumeQuota);
  const waiter = coordinator.run('failed', () => assert.fail('duplicate provider call'), consumeQuota);
  const outcomes = Promise.all([assert.rejects(owner, /failed provider/), assert.rejects(waiter, /failed provider/)]);
  provider.reject(new Error('failed provider'));
  await outcomes;
  assert.equal(coordinator.inFlight.size, 0);
  assert.equal(coordinator.completed.size, 0);
  const success = await coordinator.run('failed', async () => ({ estimated_cost_usd: 1 }), consumeQuota);
  assert.equal(success.estimated_cost_usd, 1);
  assert.equal(quota, 2);
  await assert.rejects(coordinator.run('limited', () => assert.fail('over quota provider call'), () => false), { code: 'portrait_daily_limit' });
  assert.equal(coordinator.completed.has('limited'), false);
  assert.equal(coordinator.inFlight.has('limited'), false);
});

test('portrait routes authenticate, normalize, deduplicate, and charge quota only for new operations', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'my-path-portrait-routes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = {
    PORT: '0',
    CLOUDFLARE_ACCOUNT_ID: 'mock-account',
    CLOUDFLARE_API_TOKEN: 'mock-token',
    PORTRAIT_REQUEST_MAX_PER_PLAYER_PER_DAY: '5',
    APP_ATTEST_ENFORCEMENT: 'new-builds',
    APP_ATTEST_REQUIRED_BUILD: '172',
    PLAYER_USAGE_LEDGER_PATH: join(directory, 'usage.json'),
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  let isolatedServer;
  try {
    Object.assign(process.env, environment);
    ({ server: isolatedServer } = await import('./server.mjs?portrait-route-tests'));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(isolatedServer.listening, false);
  let nextProvider = () => portraitProviderResponse();
  const provider = t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.match(url, /^https:\/\/api.cloudflare.com\/client\/v4\/accounts\/mock-account\/ai\/run\//);
    assert.equal(options.headers.Authorization, 'Bearer mock-token');
    return nextProvider(options);
  });
  t.mock.method(console, 'error', () => {});
  const handle = isolatedServer.listeners('request')[0];
  const invoke = async (body, { operation = 'generate', player = 1, headers = {} } = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.url = `/v1/portraits/${operation}`;
    req.headers = {
      host: 'localhost',
      'x-my-path-player-id': `00000000-0000-4000-8000-${String(player).padStart(12, '0')}`,
      'x-my-path-client-build': '1',
      ...headers,
    };
    const result = {};
    await handle(req, {
      writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders; },
      end(body) { result.body = JSON.parse(body); },
    });
    assert.equal(result.headers['Cache-Control'], 'no-store');
    return result;
  };
  const body = { profile_id: 'route-subject', age: 28, name: ' Alex  Example ', style: 'STYLIZED' };

  await t.test('checks authentication before joining or replaying, and isolates players', async () => {
    const callsBefore = provider.mock.callCount();
    const blockedHeaders = { 'x-my-path-client-build': '172' };
    assert.equal((await invoke(body, { headers: blockedHeaders })).status, 401);
    assert.equal(provider.mock.callCount(), callsBefore);
    const pending = deferredPortraitProvider();
    nextProvider = () => pending.promise;
    const owner = invoke(body);
    await flushPortraitPromises();
    const waiter = invoke({ ...body, name: 'Alex Example', age: '28', style: 'stylized' });
    await flushPortraitPromises();
    assert.equal((await invoke(body, { headers: blockedHeaders })).status, 401);
    assert.equal(provider.mock.callCount(), callsBefore + 1);
    pending.resolve(portraitProviderResponse());
    const [owned, shared] = await Promise.all([owner, waiter]);
    assert.equal(owned.status, 200);
    assert.equal(shared.status, 200);
    assert.equal(owned.body.estimated_cost_usd, portraitEstimatedCostUSD('generation'));
    assert.equal(shared.body.estimated_cost_usd, 0);
    assert.equal(owned.body.image_base64, shared.body.image_base64);
    assert.equal((await invoke(body, { headers: blockedHeaders })).status, 401);
    assert.equal((await invoke(body)).body.estimated_cost_usd, 0);
    nextProvider = () => portraitProviderResponse();
    assert.equal((await invoke(body, { player: 2 })).body.estimated_cost_usd, portraitEstimatedCostUSD('generation'));
    assert.equal(provider.mock.callCount(), callsBefore + 2);
  });

  await t.test('edits coalesce normalized changes and decoded reference bytes, not distinct edits', async () => {
    const callsBefore = provider.mock.callCount();
    const reference = Buffer.alloc(121, 251);
    const editBody = { ...body, reference_image_base64: reference.toString('base64'), requested_change: ' short\n hair ' };
    const pending = deferredPortraitProvider();
    nextProvider = () => pending.promise;
    const owner = invoke(editBody, { operation: 'edit', player: 3 });
    await flushPortraitPromises();
    const waiter = invoke({ ...editBody, requested_change: 'short hair', reference_image_base64: reference.toString('base64url') }, { operation: 'edit', player: 3 });
    await flushPortraitPromises();
    assert.equal(provider.mock.callCount(), callsBefore + 1);
    pending.resolve(portraitProviderResponse());
    assert.equal((await owner).body.estimated_cost_usd, portraitEstimatedCostUSD('edit'));
    assert.equal((await waiter).body.estimated_cost_usd, 0);
    const replay = await invoke({ ...editBody, reference_image_base64: `data:image/jpeg;base64,${reference.toString('base64')}` }, { operation: 'edit', player: 3 });
    assert.equal(replay.body.estimated_cost_usd, 0);
    nextProvider = () => portraitProviderResponse();
    for (const change of [{ requested_change: 'blue hair' }, { reference_image_base64: Buffer.alloc(121, 2).toString('base64') }]) {
      assert.equal((await invoke({ ...editBody, ...change }, { operation: 'edit', player: 3 })).body.estimated_cost_usd, portraitEstimatedCostUSD('edit'));
    }
    assert.equal((await invoke(body, { player: 3 })).body.estimated_cost_usd, portraitEstimatedCostUSD('generation'));
    assert.equal(provider.mock.callCount(), callsBefore + 4);
  });

  await t.test('duplicates replay at the daily limit, and invalid edits use no quota', async () => {
    const callsBefore = provider.mock.callCount();
    nextProvider = () => portraitProviderResponse();
    assert.equal((await invoke({ ...body, requested_change: '' }, { operation: 'edit', player: 4 })).status, 400);
    assert.equal((await invoke({ ...body, requested_change: 'short hair', reference_image_base64: 'invalid' }, { operation: 'edit', player: 4 })).status, 400);
    for (let revision = 0; revision < 5; revision += 1) {
      assert.equal((await invoke({ ...body, revision }, { player: 4 })).status, 200);
      assert.equal((await invoke({ ...body, revision }, { player: 4 })).body.estimated_cost_usd, 0);
    }
    const limited = await invoke({ ...body, revision: 5 }, { player: 4 });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'portrait_daily_limit');
    assert.equal((await invoke({ ...body, revision: 4 }, { player: 4 })).body.estimated_cost_usd, 0);
    assert.equal(provider.mock.callCount(), callsBefore + 5);
  });

  await t.test('coalesced failures and timeouts are removed so a new owner can retry', async (t) => {
    for (const timeout of [false, true]) {
      await t.test(timeout ? 'timeout' : 'provider rejection', async (t) => {
        if (timeout) t.mock.timers.enable({ apis: ['setTimeout'] });
        const callsBefore = provider.mock.callCount();
        const pending = deferredPortraitProvider();
        nextProvider = () => pending.promise;
        const player = timeout ? 6 : 5;
        const owner = invoke(body, { player });
        await flushPortraitPromises();
        const waiter = invoke(body, { player });
        await flushPortraitPromises();
        assert.equal(provider.mock.callCount(), callsBefore + 1);
        if (timeout) t.mock.timers.tick(45_000);
        else pending.resolve(portraitProviderResponse(401, 'Unauthorized'));
        const failedOwner = await owner;
        assert.equal(failedOwner.status, timeout ? 502 : 503);
        assert.equal((await waiter).status, timeout ? 502 : 503);
        if (!timeout) {
          assert.equal(failedOwner.body.error.retryable, false);
          assert.equal(failedOwner.body.error.code, 'portrait_provider_authorization_failed');
        }
        pending.resolve(portraitProviderResponse());
        await flushPortraitPromises();
        nextProvider = () => portraitProviderResponse();
        const retried = await invoke(body, { player });
        assert.equal(retried.status, 200);
        assert.equal(retried.body.estimated_cost_usd, portraitEstimatedCostUSD('generation'));
        assert.equal(provider.mock.callCount(), callsBefore + 2);
      });
    }
  });
});

test('portrait stages are derived from the authoritative age', () => {
  assert.equal(portraitLifeStage(0), 'baby');
  assert.equal(portraitLifeStage(1), 'toddler');
  assert.equal(portraitLifeStage(3), 'toddler');
  assert.equal(portraitLifeStage(4), 'child');
  assert.equal(portraitLifeStage(13), 'teen');
  assert.equal(portraitLifeStage(18), 'adult');
  assert.equal(portraitLifeStage(65), 'elderly');
});

test('portrait generation body uses age-sensitive Flux Klein fields', () => {
  const subject = normalizePortraitSubject({
    profile_id: 'profile-rest-contract',
    age: 28,
    species: 'person',
  });
  const body = portraitGenerationRequestBody(subject);
  assert.deepEqual(Object.keys(body).sort(), ['guidance', 'height', 'prompt', 'seed', 'width']);
  assert.equal(body.width, 512);
  assert.equal(body.height, 512);
  assert.equal(body.guidance, 8.5);
  assert.equal(Number.isInteger(body.seed), true);
});

test('portrait generation prompts stay within the Cloudflare 2048-character contract', () => {
  const subject = normalizePortraitSubject({
    profile_id: 'maximum-sized-portrait-subject',
    name: 'N'.repeat(100),
    gender: 'G'.repeat(60),
    age: 29,
    role: 'R'.repeat(80),
    species: 'S'.repeat(100),
    location: 'L'.repeat(160),
    era: 'E'.repeat(80),
    appearance_description: 'A'.repeat(320),
    subject_description: 'D'.repeat(500),
    visual_identity: 'V'.repeat(360),
    family_identity: 'F'.repeat(360),
    occupation: 'O'.repeat(140),
  });
  const prompt = portraitGenerationPrompt(subject);
  assert.ok(prompt.length <= 2_000, `prompt was ${prompt.length} characters`);
  assert.match(prompt, /exact chronological age: 29 years old/i);
  assert.match(prompt, /authoritative individual identity:/i);
  assert.match(prompt, /binding biological family inheritance:/i);
  assert.match(prompt, /species-age lock/i);
  assert.match(prompt, /real animals keep normal breed anatomy/i);
  assert.match(prompt, /no words, labels, logos/i);
});

test('portrait prompts preserve young and middle-aged parent appearances', () => {
  const youngParent = normalizePortraitSubject({
    profile_id: 'young-parent',
    age: 29,
    species: 'person',
  });
  const youngPrompt = portraitGenerationPrompt(youngParent);
  assert.match(youngPrompt, /unmistakably young adult/i);
  assert.match(youngPrompt, /no gray hair, deep wrinkles, age spots, sagging, jowls, or elderly features/i);

  const middleAgedParent = normalizePortraitSubject({
    profile_id: 'middle-aged-parent',
    age: 47,
    species: 'person',
  });
  const middlePrompt = portraitGenerationPrompt(middleAgedParent);
  assert.match(middlePrompt, /middle-aged adult/i);
  assert.match(middlePrompt, /do not make them look elderly/i);

  const editedPrompt = portraitEditPrompt(youngParent, 'trim their hair');
  assert.match(editedPrompt, /unmistakably young adult/i);
  assert.match(editedPrompt, /no gray hair, deep wrinkles, age spots, sagging, jowls, or elderly features/i);
});

test('portrait prompts lock newborn age before all potentially conflicting facts', () => {
  const newborn = normalizePortraitSubject({
    profile_id: 'newborn-age-lock',
    name: 'Mina',
    gender: 'female',
    age: 0,
    role: 'retired mother',
    species: 'human',
    occupation: 'grandmother',
    subject_description: 'Her elderly mother stands beside the crib.',
    visual_identity: 'an old woman with gray hair and wrinkles',
  });
  const prompt = portraitGenerationPrompt(newborn);
  assert.match(prompt, /^AGE 0 NEWBORN LOCK:/);
  assert.match(prompt, /under one month old/i);
  assert.match(prompt, /sparse fine baby hair/i);
  assert.match(prompt, /cannot sit, stand/i);
  assert.match(prompt, /highest-priority visual fact/i);
  assert.match(prompt, /never substitute or add a parent, caretaker, relative/i);
  assert.doesNotMatch(prompt, /elderly mother stands beside the crib/i);
});

test('portrait prompts never prescribe happy and healthy expressions regardless of context', () => {
  const subject = normalizePortraitSubject({
    profile_id: 'positive-expression-profile',
    age: 34,
    species: 'person',
  });
  const generatedPrompt = portraitGenerationPrompt(subject);
  assert.match(generatedPrompt, /No automatic smile/i);
  assert.match(generatedPrompt, /this subject's circumstances/i);
  assert.doesNotMatch(generatedPrompt, /slightly happy|healthy middle adult/i);

  const editedPrompt = portraitEditPrompt(subject, 'make their hair shorter');
  assert.match(editedPrompt, /even if the reference looks happy or healthy/i);
  assert.doesNotMatch(editedPrompt, /slightly happy|Do not make the subject sad/i);
});

test('prisoner and sick relationship portraits retain their actual condition in both image paths', () => {
  for (const role of ['player', 'father']) {
    const subject = normalizePortraitSubject({ profile_id: 'camp-prisoner', role, age: 29, species: 'human',
      location: 'A concentration camp, occupied Poland', era: '1944',
      subject_description: 'A camp prisoner enduring forced labor and inadequate rations.',
      condition_description: 'Malnourished, exhausted, frightened. A fever and a healing cut.',
      scene_description: 'Waiting for roll call in worn camp clothing.' });
    for (const prompt of [portraitGenerationPrompt(subject), portraitEditPrompt(subject, 'update the portrait')]) {
      assert.match(prompt, /Malnourished, exhausted, frightened/);
      assert.match(prompt, /healing cut/);
      assert.match(prompt, /unmistakably young adult/);
      assert.match(prompt, /respectfully, without graphic wounds/);
      assert.doesNotMatch(prompt, /slightly happy|healthy middle adult/);
    }
    assert.ok(portraitGenerationPrompt(subject).length <= 2_000);
  }
});

test('player portraits show the current scene instead of a studio background', () => {
  const subject = normalizePortraitSubject({ profile_id: 'dday-soldier', role: 'player',
    name: 'James Miller', age: 21, species: 'human', location: 'Omaha Beach, Normandy, France',
    era: 'June 1944', scene_description: 'An American infantryman lands under fire, wearing his helmet and field uniform.' });
  const prompt = portraitGenerationPrompt(subject);
  assert.match(prompt, /Omaha Beach/);
  assert.match(prompt, /infantryman lands under fire/);
  assert.doesNotMatch(prompt, /against a quiet neutral background/);
  assert.match(portraitEditPrompt(subject, 'update age'), /Update background/);
});

test('portrait style is explicit and changes the generation contract', () => {
  const realistic = normalizePortraitSubject({
    profile_id: 'realistic-style-profile',
    age: 22,
    species: 'human',
    style: 'realistic',
  });
  const stylized = normalizePortraitSubject({
    profile_id: 'stylized-style-profile',
    age: 22,
    species: 'human',
    style: 'stylized',
  });
  assert.equal(realistic.style, 'realistic');
  assert.equal(stylized.style, 'stylized');
  assert.match(portraitGenerationPrompt(realistic), /highly realistic lifelike portrait/i);
  assert.match(portraitGenerationPrompt(stylized), /semi-realistic digital life-simulator portrait/i);
  assert.match(portraitGenerationPrompt(stylized), /softly illustrated rather than photographed/i);
  assert.match(portraitGenerationPrompt(stylized), /gently simplified textures/i);
  assert.match(portraitGenerationPrompt(stylized), /preserve the named character's recognizable design and species/i);
  assert.doesNotMatch(portraitGenerationPrompt(stylized), /imitation of a named game or character/i);
  assert.doesNotMatch(portraitGenerationPrompt(stylized), /highly realistic lifelike portrait/i);
  assert.match(portraitEditPrompt(stylized, 'add a hat'), /keep the exact polished semi-realistic digital life-simulator portrait style/i);
});

test('portrait prompts preserve the exact character and biological family identity', () => {
  const subject = normalizePortraitSubject({
    profile_id: 'family-identity-profile',
    name: 'Nadia Okafor',
    gender: 'female',
    age: 12,
    role: 'daughter',
    species: 'human',
    occupation: 'student',
    visual_identity: 'warm deep-brown skin, dark coiled hair, brown eyes, rounded cheeks',
    family_identity: 'Nigerian family with deep-brown complexions, dark coiled hair, brown eyes, and shared rounded facial features',
  });
  const prompt = portraitGenerationPrompt(subject);
  assert.match(prompt, /exact subject name: Nadia Okafor/i);
  assert.match(prompt, /authoritative individual identity: warm deep-brown skin/i);
  assert.match(prompt, /biological family inheritance: Nigerian family/i);
  assert.match(prompt, /occupation: student/i);
  assert.match(prompt, /never change the stated complexion, ancestry/i);
});

test('fictional portraits preserve distinct species and do not use human aging for nonhumans', () => {
  for (const [name, species, visual] of [
    ['Shrek', 'ogre', 'Green skin, round tubular ears, broad nose, brown vest.'],
    ['Donkey', 'donkey', 'Gray fur, long ears and an equine muzzle.'],
    ['Dobby', 'house-elf', 'Large green eyes and large batlike ears.'],
    ['R2-D2', 'astromech droid', 'White cylindrical body, blue-and-silver domed head.'],
  ]) {
    const subject = normalizePortraitSubject({profile_id: name.replace(/[^a-z0-9]/gi, '-'), name, species, age: 100, visual_identity: visual});
    const prompt = portraitGenerationPrompt(subject);
    assert.match(prompt, /species-age lock/i);
    assert.ok(prompt.includes(name));
    assert.ok(prompt.includes(species));
    assert.ok(prompt.includes(visual));
    assert.doesNotMatch(prompt, /show natural older-adult features|years old \((child|adult|elderly)\)/i);
  }
});

test('portrait subjects preserve unusual custom-life species without accepting prompt-sized fields', () => {
  const subject = normalizePortraitSubject({
    profile_id: 'profile-123',
    name: 'Mara',
    gender: 'female',
    age: 9,
    life_stage: 'elderly',
    role: 'player',
    species: 'sea dragon',
    location: 'a floating kingdom',
    era: 'the far future',
    subject_description: 'A curious explorer with translucent fins.',
    appearance_description: 'green eyes and silver markings',
    revision: 2,
  });
  assert.equal(subject.lifeStage, 'child');
  assert.equal(subject.species, 'sea dragon');
  assert.equal(subject.revision, 2);
  assert.match(portraitGenerationPrompt(subject), /sea dragon/);
  const prompt = portraitGenerationPrompt(subject);
  assert.match(prompt, /one identifiable main subject in head-and-upper-body framing/i);
  assert.match(prompt, /highly realistic lifelike portrait/i);
  assert.match(prompt, /exact chronological age: 9 years old/i);
  assert.match(prompt, /natural textures and lighting/i);
  assert.match(prompt, /exact species or breed/i);
  assert.match(prompt, /real animals keep normal breed anatomy/i);
  assert.match(prompt, /never humanize an animal unless explicitly requested/i);
  assert.match(prompt, /not a human actor/i);
  assert.throws(
    () => normalizePortraitSubject({ profile_id: '../unsafe', age: 20 }),
    /profile_id/i,
  );
});

test('young nonhuman characters retain their species instead of becoming human children', () => {
  const subject = normalizePortraitSubject({
    profile_id: 'young-fantasy-profile',
    name: 'Gor Ashfang',
    gender: 'male',
    age: 10,
    role: 'player',
    species: 'orc',
    style: 'stylized',
    visual_identity: 'moss-green skin, amber eyes, and short black hair',
    family_identity: 'moss-green skin and amber eyes run in the Ashfang family',
  });
  const prompt = portraitGenerationPrompt(subject);
  assert.match(prompt, /exactly 10 as a orc/i);
  assert.match(prompt, /moss-green skin, amber eyes/i);
  assert.match(prompt, /binding biological family inheritance/i);
  assert.match(prompt, /softly illustrated rather than photographed/i);
  assert.match(prompt, /orc/i);
  assert.doesNotMatch(prompt, /10 years old \(child\)|fantasy child/i);
});

test('portrait list-price estimates distinguish generation from editing', () => {
  assert.equal(portraitEstimatedCostUSD('generation'), 0.000287);
  assert.equal(portraitEstimatedCostUSD('edit'), 0.000346);
});

test('portrait editing applies only the requested appearance change to image zero', () => {
  const subject = normalizePortraitSubject({
    profile_id: 'profile-456',
    age: 24,
    species: 'person',
    revision: 1,
  });
  const prompt = portraitEditPrompt(subject, 'give her short blue hair');
  assert.match(prompt, /image 0/i);
  assert.match(prompt, /short blue hair/i);
  assert.match(prompt, /same character/i);
  assert.match(prompt, /exact chronological age of 24 years old/i);
  assert.match(prompt, /twenties must look like a young adult/i);
  assert.match(prompt, /exact species or breed/i);
  assert.match(prompt, /normal animal anatomy/i);
  assert.match(prompt, /never add human facial structure/i);
  assert.match(prompt, /app applies subtle pixelation/i);
  assert.match(prompt, /highly realistic lifelike AgeUp portrait style/i);
  assert.doesNotMatch(prompt, /mildly pixelated low-resolution art style/i);
  assert.throws(() => portraitEditPrompt(subject, '   '), /appearance change/i);
});

test('AI content reports contain no story text or identifying story details', () => {
  const normalized = normalizeAIContentReport({
    source: 'life_description',
    model: 'gpt-4o-mini',
    category: 'offensive_or_inappropriate',
  });
  assert.deepEqual(normalized, {
    source: 'life_description',
    model: 'gpt-4o-mini',
    category: 'offensive_or_inappropriate',
  });

  for (const forbidden of [
    { content: 'private story text' },
    { content_sha256: 'A'.repeat(43) },
    { event_id: '866f9714-c058-4d2d-bf34-93f57086e437' },
    { language: 'english' },
  ]) {
    assert.throws(
      () => normalizeAIContentReport({ ...normalized, ...forbidden }),
      /must not include/i,
    );
  }
});

test('AI content reports are counted only as anonymous daily aggregates', () => {
  const report = normalizeAIContentReport({
    source: 'popup_description',
    model: 'deepseek-v4-pro',
    category: 'offensive_or_inappropriate',
  });
  const at = new Date('2038-04-17T12:00:00Z');
  const first = recordAIContentReport(report, at);
  const second = recordAIContentReport(report, at);
  assert.match(first.report_id, /^[0-9a-f]{24}$/);
  assert.equal(first.aggregate_count, 1);
  assert.equal(second.aggregate_count, 2);
  assert.equal(Object.hasOwn(second, 'player_hash'), false);
  assert.equal(Object.hasOwn(second, 'content'), false);
});

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

  const gpt5MiniPayload = { usage: { total_tokens: 1_000 } };
  attachPricingMetadata(
    gpt5MiniPayload,
    routeForModel('gpt-5-mini'),
    new Date('2026-07-21T06:30:00Z'),
  );
  assert.equal(gpt5MiniPayload.provider, 'OpenAI');
  assert.equal(gpt5MiniPayload.requested_model, 'gpt-5-mini');
  assert.equal('wallet_token_multiplier' in gpt5MiniPayload.usage, false);

  const gpt56LunaPayload = { usage: { total_tokens: 1_000 } };
  attachPricingMetadata(
    gpt56LunaPayload,
    routeForModel('gpt-5.6-luna'),
    new Date('2026-07-21T06:30:00Z'),
  );
  assert.equal(gpt56LunaPayload.provider, 'OpenAI');
  assert.equal(gpt56LunaPayload.requested_model, 'gpt-5.6-luna');
  assert.equal('wallet_token_multiplier' in gpt56LunaPayload.usage, false);
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

test('does not duplicate the embedded Custom Life schema for DeepSeek', () => {
  const request = {
    model: 'deepseek-v4-pro',
    messages: [
      {
        role: 'system',
        content: 'The complete compact Custom Life shape is already defined here.',
      },
      { role: 'user', content: 'I want to be born in Troy in 1980.' },
    ],
    prompt_cache_key: 'my-path-open-custom-birth-v3',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'gpt5_open_custom_birth_launch_v2',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            duplicated_schema_marker: { type: 'string' },
          },
          required: ['duplicated_schema_marker'],
          additionalProperties: false,
        },
      },
    },
  };

  const instruction = deepSeekJSONInstructionForBody(request);
  const forwarded = forwardedChatBody(request, routeForModel('deepseek-v4-pro'));

  assert.match(instruction, /system message already defines the required object shape/i);
  assert.doesNotMatch(instruction, /duplicated_schema_marker/);
  assert.deepEqual(forwarded.response_format, { type: 'json_object' });
  assert.match(forwarded.messages[0].content, /complete compact Custom Life shape/);
  assert.doesNotMatch(forwarded.messages[0].content, /duplicated_schema_marker/);
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

test('routes GPT-5 mini directly to OpenAI with its compatible low-latency fields', () => {
  const body = {
    model: 'gpt-5-mini',
    messages: [{ role: 'user', content: 'Simulate the next year.' }],
    max_tokens: 750,
    prompt_cache_key: 'life-123',
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'reply', strict: true, schema: { type: 'object' } },
    },
  };

  const route = routeForModel('gpt-5-mini');
  const forwarded = forwardedChatBody(body, route);

  assert.equal(route.provider, 'OpenAI');
  assert.equal(forwarded.model, 'gpt-5-mini');
  assert.equal(forwarded.max_completion_tokens, 750);
  assert.equal('max_tokens' in forwarded, false);
  assert.equal(forwarded.reasoning_effort, 'minimal');
  assert.equal(forwarded.prompt_cache_key, 'life-123');
  assert.equal(forwarded.response_format.type, 'json_schema');
});

test('routes GPT-5.6 Luna directly to OpenAI without forwarding unsupported minimal effort', () => {
  const body = {
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content: 'Simulate the next year.' }],
    max_tokens: 750,
    reasoning_effort: 'minimal',
    prompt_cache_key: 'life-123',
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'reply', strict: true, schema: { type: 'object' } },
    },
  };

  const route = routeForModel('gpt-5.6-luna');
  const forwarded = forwardedChatBody(body, route);

  assert.equal(route.provider, 'OpenAI');
  assert.equal(forwarded.model, 'gpt-5.6-luna');
  assert.equal(forwarded.max_completion_tokens, 750);
  assert.equal('max_tokens' in forwarded, false);
  assert.equal(forwarded.reasoning_effort, 'none');
  assert.equal(forwarded.prompt_cache_key, 'life-123');
  assert.equal(forwarded.response_format.type, 'json_schema');

  const explicitLow = forwardedChatBody({ ...body, reasoning_effort: 'low' }, route);
  assert.equal(explicitLow.reasoning_effort, 'low');
  assert.notEqual(explicitLow.reasoning_effort, 'minimal');
});

test('typed life montage requests use low OpenAI reasoning verbosity without rewriting the prompt or caller budget', () => {
  const messages = [
    { role: 'system', content: 'Write a typed life montage in 120-210 words, following only the requested action.' },
    { role: 'user', content: 'I spend the next three years training to become a teacher.' },
  ];
  for (const model of ['gpt-5-mini', 'gpt-5.6-luna']) {
    for (const budget of [{ max_tokens: 750 }, { max_completion_tokens: 900 }, { max_tokens: 750, max_completion_tokens: 800 }]) {
      const request = { model, messages, prompt_cache_key: 'my-path-typed-life-montage-v2', verbosity: 'high', ...budget };
      const original = structuredClone(request);
      const forwarded = forwardedChatBody(request, routeForModel(model));
      assert.equal(forwarded.verbosity, 'low');
      assert.equal(forwarded.max_completion_tokens, budget.max_completion_tokens ?? budget.max_tokens);
      assert.equal('max_tokens' in forwarded, false);
      assert.equal(forwarded.prompt_cache_key, request.prompt_cache_key);
      assert.deepEqual(forwarded.messages, messages);
      assert.doesNotMatch(JSON.stringify(forwarded.messages), /Begin directly inside the fresh event|visible Age passage|growing taller/);
      assert.equal(isGPT5MiniAnnualAgeRequest(forwarded), false);
      assert.deepEqual(request, original);
    }
    assert.equal(forwardedChatBody({ model, messages, prompt_cache_key: 'another-key', verbosity: 'high' }, routeForModel(model)).verbosity, 'high');
  }
  for (const model of ['gpt-4o-mini', 'deepseek-v4-pro']) {
    const forwarded = forwardedChatBody({ model, messages, max_tokens: 750, prompt_cache_key: 'my-path-typed-life-montage-v2' }, routeForModel(model));
    assert.equal(forwarded.verbosity, undefined);
    assert.equal(forwarded.max_tokens, 750);
    assert.deepEqual(forwarded.messages, messages);
  }
});

test('retries only empty or malformed DeepSeek JSON and combines usage', () => {
  const jsonBody = { response_format: { type: 'json_object' } };
  const proseBody = {};
  assert.equal(deepSeekResponseNeedsRetry({ choices: [{ message: { content: '' } }] }, proseBody), false);
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

test('recognizes only GPT-5 mini birth narration requests for empty-output recovery', () => {
  const birthMessages = [
    {
      role: 'system',
      content: 'Simulate the opening of a creative life simulator. The player is born as a baby.',
    },
    { role: 'user', content: 'Player: Avery Morgan.' },
  ];
  const narrationSchema = {
    type: 'json_schema',
    json_schema: {
      name: 'gpt5_birth_narration',
      schema: {
        type: 'object',
        properties: { narration: { type: 'string' } },
      },
    },
  };

  assert.equal(isGPT5MiniBirthNarrationRequest({ messages: birthMessages }), true);
  assert.equal(isGPT5MiniBirthNarrationRequest({
    messages: birthMessages,
    response_format: narrationSchema,
  }), true);
  for (const name of [
    'gpt5_standard_birth_launch_v2',
    'gpt5_standard_birth_launch_v3',
    'gpt5_standard_birth_launch_v4',
    'gpt5_standard_birth_launch_v5',
  ]) {
    assert.equal(isGPT5MiniBirthNarrationRequest({
      model: 'gpt-5-mini',
      response_format: {
        type: 'json_schema',
        json_schema: { name, schema: { type: 'object' } },
      },
    }), true);
  }
  assert.equal(isGPT5MiniBirthNarrationRequest({
    messages: [
      {
        role: 'system',
        content: 'Write a vivid birth opening in four to six short paragraphs.',
      },
    ],
    response_format: narrationSchema,
  }), true);
  assert.equal(isGPT5MiniBirthNarrationRequest({
    messages: birthMessages,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'gpt5_birth_narration',
        schema: {
          properties: {
            narration: { type: 'string' },
            parents: { type: 'array' },
          },
        },
      },
    },
  }), false);
  assert.equal(isGPT5MiniBirthNarrationRequest({
    messages: [{ role: 'system', content: 'Simulate the next year.' }],
  }), false);
});

test('recognizes the compact GPT-5 custom birth launch schema', () => {
  const request = {
    model: 'gpt-5-mini',
    messages: [{ role: 'system', content: 'Simulate a custom life.' }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'gpt5_custom_birth_launch_v2', schema: { type: 'object' } },
    },
  };
  for (const name of [
    'gpt5_custom_birth_launch_v2',
    'gpt5_custom_birth_launch_v3',
    'gpt5_custom_birth_launch_v4',
    'gpt5_custom_birth_launch_v5',
    'gpt5_custom_birth_launch_v6',
    'gpt5_open_custom_birth_launch_v2',
    'gpt5_open_custom_takeover_launch_v5',
  ]) {
    assert.equal(isGPT5MiniCustomBirthDossierRequest({
      ...request,
      response_format: {
        type: 'json_schema',
        json_schema: { name, schema: { type: 'object' } },
      },
    }), true);
  }
  assert.equal(
    forwardedChatBody(request, routeForModel('gpt-5-mini')).verbosity,
    'low',
  );
  assert.equal(isGPT5MiniBirthNarrationRequest(request), false);
  assert.equal(isGPT5MiniCustomBirthDossierRequest({
    model: 'gpt-5-mini',
    prompt_cache_key: 'my-path-open-custom-takeover-v1',
    response_format: { type: 'json_object' },
  }), true);
  assert.equal(isGPT5MiniCustomBirthDossierRequest({
    model: 'gpt-5-mini',
    prompt_cache_key: 'my-path-open-custom-takeover-v2',
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'gpt5_custom_takeover_launch_v2', schema: { type: 'object' } },
    },
  }), true);
  for (const promptCacheKey of [
    'my-path-open-custom-birth-v2',
    'my-path-open-custom-birth-v3',
    'my-path-gpt5-custom-birth-open-v3',
    'my-path-open-custom-takeover-v4',
    'my-path-open-custom-takeover-v6',
  ]) {
    const openRequest = {
      model: 'gpt-5-mini',
      prompt_cache_key: promptCacheKey,
      response_format: { type: 'json_object' },
    };
    assert.equal(isGPT5MiniCustomBirthDossierRequest(openRequest), true);
    assert.equal(
      forwardedChatBody(openRequest, routeForModel('gpt-5-mini')).verbosity,
      'low',
    );
  }
});

test('falls back only for an explicit exhausted OpenAI credit balance', () => {
  const openAIRoute = routeForModel('gpt-5-mini');
  assert.equal(openAICreditBalanceIsExhausted({
    ok: false,
    payload: {
      error: {
        type: 'insufficient_quota',
        code: 'credit_balance_exhausted',
      },
    },
  }, openAIRoute), true);
  assert.equal(openAICreditBalanceIsExhausted({
    ok: false,
    payload: {
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
      },
    },
  }, openAIRoute), false);
  assert.equal(openAICreditBalanceIsExhausted({
    ok: false,
    payload: {
      error: {
        type: 'insufficient_quota',
        code: 'credit_balance_exhausted',
      },
    },
  }, routeForModel('deepseek-v4-pro')), false);
});

test('gives the Custom Life credit fallback enough room to finish once', () => {
  const fallbackRoute = routeForModel('deepseek-v4-pro');
  const customRequest = {
    model: 'gpt-5-mini',
    max_tokens: 1_200,
    prompt_cache_key: 'my-path-open-custom-birth-v3',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'gpt5_open_custom_birth_launch_v2',
        schema: { type: 'object' },
      },
    },
  };
  const ordinaryRequest = {
    model: 'gpt-5-mini',
    max_tokens: 600,
    prompt_cache_key: 'ordinary-request',
  };

  const customFallback = openAICreditFallbackBody(customRequest, fallbackRoute);
  const ordinaryFallback = openAICreditFallbackBody(ordinaryRequest, fallbackRoute);

  assert.equal(customFallback.model, 'deepseek-v4-pro');
  assert.equal(customFallback.max_tokens, 1_800);
  assert.equal('max_completion_tokens' in customFallback, false);
  assert.equal(ordinaryFallback.model, 'deepseek-v4-pro');
  assert.equal(ordinaryFallback.max_tokens, 600);
});

test('retries an empty length-limited GPT-5 custom dossier with a larger budget', () => {
  const request = {
    model: 'gpt-5-mini',
    messages: [{ role: 'system', content: 'Simulate a custom life.' }],
    max_tokens: 1600,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'gpt5_custom_birth_launch_v5', schema: { type: 'object' } },
    },
  };
  const route = routeForModel('gpt-5-mini');
  const forwarded = forwardedChatBody(request, route);
  const exhausted = {
    choices: [{ finish_reason: 'length', message: { content: '' } }],
  };

  assert.equal(gpt5MiniCustomBirthResponseNeedsRetry(exhausted, forwarded), true);
  const retry = gpt5MiniCustomBirthRetryBody(forwarded, route);
  assert.equal(retry.max_completion_tokens, 2400);
  assert.equal(retry.verbosity, 'low');
  assert.match(retry.messages[0].content, /complete custom-life JSON dossier/);
});

test('retries empty length-limited GPT-5 births with model-compatible effort and full budget', () => {
  const request = {
    messages: [
      {
        role: 'system',
        content: 'Simulate the opening of a creative life simulator. The player is born as a baby.',
      },
      { role: 'user', content: 'Player: Avery Morgan.' },
    ],
    max_tokens: 500,
  };
  const miniRoute = routeForModel('gpt-5-mini');
  const body = forwardedChatBody({ ...request, model: 'gpt-5-mini' }, miniRoute);

  assert.equal(body.verbosity, 'low');
  assert.match(body.messages[0].content, /complete visible birth opening/);
  assert.match(body.messages[0].content, /paragraph rhythm/);
  assert.doesNotMatch(body.messages[0].content, /one complete paragraph/);

  assert.equal(gpt5MiniBirthResponseNeedsRetry({
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
  }, body), true);
  assert.equal(gpt5MiniBirthResponseNeedsRetry({
    choices: [{ message: { content: 'You are born safely.' }, finish_reason: 'stop' }],
  }, body), false);
  assert.equal(gpt5MiniBirthResponseNeedsRetry({
    choices: [{ message: { content: '' }, finish_reason: 'stop' }],
  }, body), false);

  const retry = gpt5MiniBirthRetryBody(body, miniRoute);
  assert.equal(retry.max_completion_tokens, 900);
  assert.equal(retry.reasoning_effort, 'minimal');
  assert.equal(retry.verbosity, 'low');
  assert.match(retry.messages[0].content, /complete visible birth opening/);
  assert.match(retry.messages[0].content, /paragraph rhythm/);
  assert.doesNotMatch(retry.messages[0].content, /one complete paragraph/);

  const lunaRoute = routeForModel('gpt-5.6-luna');
  const lunaBody = forwardedChatBody({
    ...request,
    model: 'gpt-5.6-luna',
    reasoning_effort: 'minimal',
  }, lunaRoute);
  assert.equal(lunaBody.reasoning_effort, 'none');
  assert.equal(lunaBody.verbosity, 'low');
  assert.match(lunaBody.messages[0].content, /complete visible birth opening/);
  assert.equal(gpt5MiniBirthResponseNeedsRetry({
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
  }, lunaBody), true);

  const lunaRetry = gpt5MiniBirthRetryBody(lunaBody, lunaRoute);
  assert.equal(lunaRetry.max_completion_tokens, 900);
  assert.equal(lunaRetry.reasoning_effort, 'none');
  assert.equal(lunaRetry.verbosity, 'low');
  assert.notEqual(lunaRetry.reasoning_effort, 'minimal');
  assert.match(lunaRetry.messages[0].content, /complete visible birth opening/);
});

test('keeps GPT-5 mini annual Age cache keys and recovers an empty visible passage', () => {
  const request = {
    model: 'gpt-5-mini',
    messages: [
      {
        role: 'system',
        content: 'TASK: Write only the new visible passage after an Age press.\nCache contract: gpt5-mini-annual-age-cache-v2.',
      },
      {
        role: 'user',
        content: 'Player: Avery Morgan; age 4 advancing to age 5.',
      },
    ],
    max_tokens: 700,
    prompt_cache_key: 'my-path-gpt5-fast-cache-v2',
  };
  const route = routeForModel('gpt-5-mini');
  const body = forwardedChatBody(request, route);

  assert.equal(isGPT5MiniAnnualAgeRequest(body), true);
  assert.equal(body.prompt_cache_key, 'my-path-gpt5-fast-cache-v2');
  assert.equal(body.max_completion_tokens, 700);
  assert.equal(body.reasoning_effort, 'minimal');
  assert.equal(body.verbosity, 'low');
  assert.equal(gpt5MiniAnnualAgeResponseNeedsRetry({
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
  }, body), true);
  assert.equal(gpt5MiniAnnualAgeResponseNeedsRetry({
    choices: [{ message: { content: 'You race across the playground and reach the ball first.' }, finish_reason: 'stop' }],
  }, body), false);

  const retry = gpt5MiniAnnualAgeRetryBody(body, route);
  assert.equal(retry.max_completion_tokens, 700);
  assert.equal(retry.reasoning_effort, 'minimal');
  assert.equal(retry.verbosity, 'low');
  assert.match(retry.messages[0].content, /complete non-empty visible Age passage/);
  assert.match(retry.messages[0].content, /do not narrate the time jump/);
  assert.equal(gpt5MiniAnnualAgeRetryBody({
    ...body,
    max_completion_tokens: 500,
  }, route).max_completion_tokens, 500);
  assert.equal(isGPT5MiniAnnualAgeRequest({
    ...body,
    prompt_cache_key: 'some-other-request',
  }), false);
  assert.equal(isGPT5MiniAnnualAgeRequest({
    ...body,
    messages: [{
      role: 'system',
      content: 'TASK: Write only the new visible passage after an Age press.\nCache contract: gpt5-mini-annual-age-cache-v1.',
    }],
  }), true);
});

test('sums cached prompt details when a provider recovery request is needed', () => {
  const usage = mergedUsage(
    {
      prompt_tokens: 2_400,
      completion_tokens: 300,
      total_tokens: 2_700,
      prompt_tokens_details: { cached_tokens: 2_048, cache_write_tokens: 0 },
    },
    {
      prompt_tokens: 2_500,
      completion_tokens: 220,
      total_tokens: 2_720,
      prompt_tokens_details: { cached_tokens: 2_048, cache_write_tokens: 0 },
    },
  );

  assert.equal(usage.prompt_tokens, 4_900);
  assert.equal(usage.completion_tokens, 520);
  assert.equal(usage.total_tokens, 5_420);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 4_096);
  assert.equal(usage.prompt_tokens_details.cache_write_tokens, 0);
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
  assert.equal(
    estimatedChatWalletTokens(
      { ...body, model: 'deepseek-v4-pro' },
      routeForModel('deepseek-v4-pro'),
      new Date('2026-08-01T12:00:00Z'),
    ),
    serializedBytes + 750,
  );
  assert.equal(
    estimatedChatWalletTokens(
      { ...body, model: 'deepseek-v4-pro', response_format: { type: 'json_object' } },
      routeForModel('deepseek-v4-pro'),
      new Date('2026-08-01T12:00:00Z'),
    ),
    (serializedBytes + 750) * 2,
  );
  assert.equal(
    estimatedChatWalletTokens(
      {
        ...body,
        model: 'gpt-5.6-luna',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'gpt5_birth_narration',
            schema: { properties: { narration: { type: 'string' } } },
          },
        },
      },
      routeForModel('gpt-5.6-luna'),
    ),
    (serializedBytes + 750) * 2,
  );
  const annualAgeMessages = [{
    role: 'system',
    content: 'TASK: Write only the new visible passage after an Age press.\nCache contract: gpt5-mini-annual-age-cache-v2.',
  }];
  const annualAgeBytes = Buffer.byteLength(JSON.stringify(annualAgeMessages), 'utf8');
  assert.equal(
    estimatedChatWalletTokens(
      {
        model: 'gpt-5-mini',
        messages: annualAgeMessages,
        max_tokens: 500,
        prompt_cache_key: 'my-path-gpt5-fast-cache-v2',
      },
      routeForModel('gpt-5-mini'),
    ),
    (annualAgeBytes + 500) * 2,
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

test('Play Integrity request binding matches the Android client byte format', () => {
  const rawBody = Buffer.from('{"answer":42}');
  assert.equal(
    playIntegrityRequestHash('POST', '/v1/chat/completions', rawBody),
    'SrwOtJMCosuoFqVhhwxLxMaAk7hbCKwMJgqsq_HAhO0',
  );
  assert.notEqual(
    playIntegrityRequestHash('POST', '/v1/chat/completions', Buffer.from('{ "answer": 42 }')),
    'SrwOtJMCosuoFqVhhwxLxMaAk7hbCKwMJgqsq_HAhO0',
  );
});

function validPlayIntegrityVerdict(requestHash, at = new Date('2026-08-03T12:00:00Z')) {
  return {
    requestDetails: {
      requestPackageName: 'com.brycebehncke.ageup',
      requestHash,
      timestampMillis: String(at.getTime()),
    },
    accountDetails: { appLicensingVerdict: 'LICENSED' },
    appIntegrity: {
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      packageName: 'com.brycebehncke.ageup',
      certificateSha256Digest: ['release-certificate'],
      versionCode: '7',
    },
    deviceIntegrity: {
      deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
    },
  };
}

test('accepts a fresh, licensed, recognized Play Integrity verdict', () => {
  const at = new Date('2026-08-03T12:00:00Z');
  const requestHash = 'bound-request-hash';
  assert.deepEqual(
    validatePlayIntegrityVerdict({
      verdict: validPlayIntegrityVerdict(requestHash, at),
      expectedRequestHash: requestHash,
      at,
      acceptedCertificateDigests: new Set(['release-certificate']),
    }),
    { verified: true, platform: 'android', versionCode: 7 },
  );
});

test('rejects altered, stale, unlicensed, unrecognized, or untrusted Android requests', () => {
  const at = new Date('2026-08-03T12:00:00Z');
  const requestHash = 'bound-request-hash';
  const parameters = {
    expectedRequestHash: requestHash,
    at,
    tokenTTLMilliseconds: 120_000,
    acceptedCertificateDigests: new Set(['release-certificate']),
  };

  const altered = validPlayIntegrityVerdict('different-request', at);
  assert.throws(
    () => validatePlayIntegrityVerdict({ ...parameters, verdict: altered }),
    (error) => error instanceof PlayIntegrityRequestError
      && error.code === 'play_integrity_request_mismatch',
  );

  const stale = validPlayIntegrityVerdict(requestHash, new Date(at.getTime() - 120_001));
  assert.throws(
    () => validatePlayIntegrityVerdict({ ...parameters, verdict: stale }),
    (error) => error instanceof PlayIntegrityRequestError
      && error.code === 'play_integrity_token_stale',
  );

  const unlicensed = validPlayIntegrityVerdict(requestHash, at);
  unlicensed.accountDetails.appLicensingVerdict = 'UNLICENSED';
  assert.throws(
    () => validatePlayIntegrityVerdict({ ...parameters, verdict: unlicensed }),
    (error) => error instanceof PlayIntegrityRequestError
      && error.code === 'play_integrity_license_required',
  );

  const unrecognized = validPlayIntegrityVerdict(requestHash, at);
  unrecognized.appIntegrity.appRecognitionVerdict = 'UNRECOGNIZED_VERSION';
  assert.throws(
    () => validatePlayIntegrityVerdict({ ...parameters, verdict: unrecognized }),
    (error) => error instanceof PlayIntegrityRequestError
      && error.code === 'play_integrity_app_unrecognized',
  );

  const untrusted = validPlayIntegrityVerdict(requestHash, at);
  untrusted.deviceIntegrity.deviceRecognitionVerdict = [];
  assert.throws(
    () => validatePlayIntegrityVerdict({ ...parameters, verdict: untrusted }),
    (error) => error instanceof PlayIntegrityRequestError
      && error.code === 'play_integrity_device_untrusted',
  );

  const wrongCertificate = validPlayIntegrityVerdict(requestHash, at);
  assert.throws(
    () => validatePlayIntegrityVerdict({
      ...parameters,
      verdict: wrongCertificate,
      acceptedCertificateDigests: new Set(['different-certificate']),
    }),
    (error) => error instanceof PlayIntegrityRequestError
      && error.code === 'play_integrity_certificate_mismatch',
  );
});

test('decodes Android proof only after checking the exact request hash', async () => {
  const at = new Date('2026-08-03T12:00:00Z');
  const rawBody = Buffer.from('{"model":"gpt-4o-mini"}');
  const requestHash = playIntegrityRequestHash('POST', '/v1/chat/completions', rawBody);
  const req = {
    method: 'POST',
    headers: {
      'x-my-path-platform': 'android',
      'x-my-path-play-integrity-token': 'decoded-by-google',
      'x-my-path-play-integrity-request-hash': requestHash,
    },
  };
  const identity = {
    identifier: '866f9714-c058-4d2d-bf34-93f57086e437',
    hash: playerQuotaHash('866f9714-c058-4d2d-bf34-93f57086e437'),
    isLegacy: false,
  };
  let decoderCalls = 0;
  const tokenDecoder = async ({ token, packageName }) => {
    decoderCalls += 1;
    assert.equal(token, 'decoded-by-google');
    assert.equal(packageName, 'com.brycebehncke.ageup');
    return validPlayIntegrityVerdict(requestHash, at);
  };

  assert.deepEqual(
    await verifyPlayIntegrityRequest({
      req,
      pathname: '/v1/chat/completions',
      rawBody,
      identity,
      at,
      tokenDecoder,
    }),
    { verified: true, platform: 'android', versionCode: 7 },
  );
  assert.equal(decoderCalls, 1);

  await assert.rejects(
    verifyPlayIntegrityRequest({
      req,
      pathname: '/v1/chat/completions',
      rawBody: Buffer.from('{"model":"deepseek-v4-pro"}'),
      identity,
      at,
      tokenDecoder,
    }),
    (error) => error instanceof PlayIntegrityRequestError
      && error.code === 'play_integrity_request_mismatch',
  );
  assert.equal(decoderCalls, 1);
});

test('never accepts the Android debug bypass on a production backend', async () => {
  const originalNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(
      verifyGenuineAppRequest({
        req: {
          method: 'POST',
          headers: { 'x-my-path-platform': 'android-debug' },
        },
        pathname: '/v1/chat/completions',
        rawBody: Buffer.from('{}'),
        identity: { isLegacy: false },
      }),
      (error) => error instanceof PlayIntegrityRequestError
        && error.code === 'play_integrity_debug_rejected',
    );
  } finally {
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
  }
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
