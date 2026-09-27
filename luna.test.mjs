import test from 'node:test';
import assert from 'node:assert/strict';
import { routeForModel, forwardedChatBody, attachPricingMetadata, proxyChatCompletion } from './server.mjs';

test('GPT-6 Luna preserves chat contracts, budgets, cache keys and uses no reasoning', () => {
  const route = routeForModel('gpt-6-luna');
  assert.equal(route.provider, 'OpenAI');
  assert.equal(route.healthURL, 'https://api.openai.com/v1/models/gpt-6-luna');
  for (const max_tokens of [500, 750, 1000, 2400]) {
    for (const reasoning_effort of [undefined, 'minimal', 'medium']) {
      const request = { model: 'gpt-6-luna', max_tokens, reasoning_effort,
        messages: [{ role: 'user', content: 'I help my sister.' }],
        prompt_cache_key: 'luna-contract', stream: false,
        response_format: { type: 'json_object' } };
      const result = forwardedChatBody(request, route);
      assert.equal(result.model, 'gpt-6-luna');
      assert.equal(result.max_completion_tokens, max_tokens);
      assert.equal(result.reasoning_effort, 'none');
      assert.equal(result.max_tokens, undefined);
      assert.deepEqual(result.messages, request.messages);
      assert.deepEqual(result.response_format, request.response_format);
      assert.equal(result.prompt_cache_key, request.prompt_cache_key);
    }
  }
  const payload = { model: 'gpt-6-luna', usage: { total_tokens: 123 } };
  attachPricingMetadata(payload, route);
  assert.equal(payload.requested_model, 'gpt-6-luna');
  assert.equal(payload.usage.total_tokens, 123);
  assert.equal(payload.usage.wallet_token_multiplier, undefined);
});

test('GPT-6 Luna proxy returns actual provider prose and usage', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.reasoning_effort, 'none');
    return new Response(JSON.stringify({ model: 'gpt-6-luna', choices: [
      { message: { content: 'You help your sister plant a garden.' }, finish_reason: 'stop' }
    ], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }), { status: 200 });
  };
  try {
    const result = await proxyChatCompletion({ model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'I help my sister plant a garden.' }], max_tokens: 500 },
      { ...routeForModel('gpt-6-luna'), apiKey: 'offline-test' });
    assert.equal(calls, 1);
    assert.ok(JSON.stringify(result).includes('You help your sister plant a garden.'));
    assert.ok(JSON.stringify(result).includes('"total_tokens":40'));
  } finally { globalThis.fetch = original; }
});
