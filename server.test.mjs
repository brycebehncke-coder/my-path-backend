import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AppAttestRequestError,
  PlayIntegrityRequestError,
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
  recordAIContentReport,
  routeForModel,
  validatePlayIntegrityVerdict,
  verifiedAppAttestChallengeToken,
  verifiedPlayerQuotaReceipt,
  verifyAppAttestRequest,
  verifyGenuineAppRequest,
  verifyPlayIntegrityRequest,
} from './server.mjs';

test('portrait stages are derived from the authoritative age', () => {
  assert.equal(portraitLifeStage(0), 'baby');
  assert.equal(portraitLifeStage(3), 'baby');
  assert.equal(portraitLifeStage(4), 'child');
  assert.equal(portraitLifeStage(13), 'teen');
  assert.equal(portraitLifeStage(18), 'adult');
  assert.equal(portraitLifeStage(65), 'elderly');
});

test('portrait generation body uses only fields accepted by the Cloudflare REST model', () => {
  const subject = normalizePortraitSubject({
    profile_id: 'profile-rest-contract',
    age: 28,
    species: 'person',
  });
  const body = portraitGenerationRequestBody(subject);
  assert.deepEqual(Object.keys(body).sort(), ['prompt', 'steps']);
  assert.equal(body.steps, 4);
  assert.equal('seed' in body, false);
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
  assert.match(prompt, /people in their twenties look young/i);
  assert.match(prompt, /quadrupeds stay quadrupedal/i);
  assert.match(prompt, /no words, labels, logos/i);
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
  assert.match(prompt, /do not change ancestry or complexion/i);
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
  assert.match(prompt, /exactly one subject/i);
  assert.match(prompt, /polished simplified life-simulation portrait/i);
  assert.match(prompt, /exact chronological age: 9 years old/i);
  assert.match(prompt, /not a photograph/i);
  assert.match(prompt, /exact species or breed/i);
  assert.match(prompt, /real animals keep normal breed anatomy/i);
  assert.match(prompt, /never give animals human faces/i);
  assert.match(prompt, /anthropomorphism unless explicitly requested/i);
  assert.match(prompt, /not a photograph, pixel art/i);
  assert.throws(
    () => normalizePortraitSubject({ profile_id: '../unsafe', age: 20 }),
    /profile_id/i,
  );
});

test('portrait list-price estimates distinguish generation from editing', () => {
  assert.equal(portraitEstimatedCostUSD('generation'), 0.0006336);
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
  assert.match(prompt, /simplified life-simulation art direction/i);
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
