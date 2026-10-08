import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { server, forwardedChatBody, routeForModel, verifyGenuineAppRequest } from './server.mjs';

test('discovery and account routes exist and reject unsigned requests before database access', async t => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', 'x-my-path-client-build': '301',
    'x-my-path-player-id': '4f52c613-e10b-4e58-b0e8-b8fbe2506347' };
  for (const path of ['/v1/accounts/configuration', '/v1/accounts/start', '/v1/accounts/finish',
    '/v1/accounts/me', '/v1/accounts/username', '/v1/accounts/sign-out', '/v1/accounts/delete',
    '/v1/custom-lives/register', '/v1/custom-lives/discoveries', '/v1/custom-lives/stats']) {
    const response = await fetch(origin + path, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 401, path);
    assert.match((await response.json()).error.code, /app_attest/);
  }
  for (const body of ['[]', 'null', '{broken']) {
    const response = await fetch(origin + '/v1/custom-lives/discoveries', { method: 'POST', headers, body });
    assert.equal(response.status, 400);
  }
  const callback = await fetch(origin + '/v1/accounts/google/callback?state=invalid&code=invalid', { redirect: 'manual' });
  assert.equal(callback.status, 400);
  assert.match((await callback.json()).error.message, /Sign-in could not complete/);
  const health = await fetch(origin + '/');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).revision, 'ageup-discoveries-shared-d1-v1');
});

test('Android debug headers cannot bypass account security when NODE_ENV is unset', async () => {
  const old = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    await assert.rejects(verifyGenuineAppRequest({
      req: { method: 'POST', headers: { 'x-my-path-platform': 'android-debug' } },
      pathname: '/v1/custom-lives/register', rawBody: Buffer.from('{}'), identity: { isLegacy: false },
    }), { code: 'play_integrity_debug_rejected' });
  } finally {
    if (old === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = old;
  }
});

test('OpenAI and DeepSeek receive the public-title contract but no private tracking metadata', () => {
  for (const model of ['gpt-4o-mini', 'gpt-5-mini', 'gpt-6-luna', 'deepseek-v4-pro']) {
    const input = { model, _ageup_custom_life: 'I want to be a flying crocodile on Mars',
      _ageup_request_id: '4f52c613-e10b-4e58-b0e8-b8fbe2506347',
      messages: [{ role: 'system', content: 'Simulate a custom life.' }, { role: 'user', content: 'Start.' }],
      response_format: { type: 'json_schema', json_schema: { name: 'custom_life', strict: true,
        schema: { type: 'object', additionalProperties: false, properties: { story: { type: 'string' } }, required: ['story'] } } } };
    const original = JSON.stringify(input);
    const forwarded = forwardedChatBody(input, routeForModel(model));
    assert.equal(forwarded._ageup_custom_life, undefined, model);
    assert.equal(forwarded._ageup_request_id, undefined, model);
    assert.match(JSON.stringify(forwarded.messages), /public_title/, model);
    assert.equal(JSON.stringify(input), original, 'The caller request must not be mutated');
    if (model !== 'deepseek-v4-pro') {
      assert.ok(forwarded.response_format.json_schema.schema.required.includes('public_title'), model);
    }
    const ordinary = forwardedChatBody({ model, messages: [{ role: 'user', content: 'Continue.' }] }, routeForModel(model));
    assert.doesNotMatch(JSON.stringify(ordinary), /public_title/);
  }
});
