import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const port = Number(process.env.PORT || 3000);
const openaiApiKey = (process.env.OPENAI_API_KEY || '').trim();
const deepSeekApiKey = (process.env.DEEPSEEK_API_KEY || '').trim();

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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
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
  if (second.ok && second.payload && typeof second.payload === 'object') {
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
        endpoints: ['/v1/health/ai', '/v1/health/openai', '/v1/chat/completions'],
        models: [...modelRoutes.keys()],
      });
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

      const result = await proxyChatCompletion(body, route);
      if (result.ok) {
        attachPricingMetadata(result.payload, route);
      }
      return sendJson(res, result.status, result.payload);
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
  attachPricingMetadata,
  deepSeekPricingMultiplier,
  deepSeekResponseNeedsRetry,
  forwardedChatBody,
  mergedUsage,
  modelRoutes,
  normalizeModelName,
  routeForModel,
  server,
};
