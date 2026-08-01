import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachPricingMetadata,
  normalizeCreatorCode,
  parseCreatorCodeCatalog,
  resolveCreatorCode,
  deepSeekPricingMultiplier,
  deepSeekResponseNeedsRetry,
  forwardedChatBody,
  mergedUsage,
  normalizeModelName,
  routeForModel,
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
