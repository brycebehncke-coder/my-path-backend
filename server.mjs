import { createServer } from 'node:http';

const port = Number(process.env.PORT || 3000);
const openaiApiKey = (process.env.OPENAI_API_KEY || '').trim();

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
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'Missing messages array.';
  }
  return null;
}

async function proxyChatCompletion(body) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: { message: text || 'OpenAI returned a non-JSON response.' } };
  }

  return {
    ok: response.ok,
    status: response.status,
    payload: parsed,
  };
}

async function checkOpenAIHealth() {
  const response = await fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${openaiApiKey}`,
    },
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
        service: 'My Path backend',
        endpoints: ['/v1/health/openai', '/v1/chat/completions'],
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/health/openai') {
      if (!openaiApiKey) {
        return sendJson(res, 500, {
          ok: false,
          error: 'Missing OPENAI_API_KEY in backend environment.',
        });
      }

      const result = await checkOpenAIHealth();
      if (!result.ok) {
        return sendJson(res, result.status, {
          ok: false,
          error: 'Backend could not reach OpenAI.',
          details: result.payload,
        });
      }

      return sendJson(res, 200, {
        ok: true,
        message: 'Backend can reach OpenAI.',
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (!openaiApiKey) {
        return sendJson(res, 500, {
          error: {
            message: 'Missing OPENAI_API_KEY in backend environment.',
          },
        });
      }

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

      const result = await proxyChatCompletion(body);
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

server.listen(port, '0.0.0.0', () => {
  console.log(`My Path backend listening on http://0.0.0.0:${port}`);
});

process.on('SIGINT', () => {
  server.close(() => {
    process.exit(0);
  });
});
