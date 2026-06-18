// economy/tests/ppq-client-test.js
// Signal Rush — ppq.ai Client Tests
//
// Tests the ppq.ai HTTP client using a local mock server.
// No real API calls. Tests all error paths, timeouts, and response shapes.

const http = require('http');
const ppq = require('../ppq-client');

// ─── Test Helpers ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let server = null;
let serverPort = 0;
let serverRequests = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`PASS ${msg}`);
  } else {
    failed++;
    console.log(`FAIL ${msg}`);
  }
}

function assertThrows(fn, testName) {
  return fn().then(() => {
    failed++;
    console.log(`FAIL ${testName}: expected throw but resolved`);
  }).catch(() => {
    passed++;
    console.log(`PASS ${testName}`);
  });
}

// ─── Mock Server ───────────────────────────────────────────────────

function startMockServer(handler) {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        serverRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, body, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(resolve);
      server = null;
    } else {
      resolve();
    }
  });
}

// ─── Tests ─────────────────────────────────────────────────────────

async function runTests() {
  process.env.PPQ_API_KEY = 'test-key-123';

  // ── Test Group 1: Auth ──────────────────────────────────────────
  console.log('── Auth ──');

  // 1.1: Missing API key
  {
    const saved = process.env.PPQ_API_KEY;
    delete process.env.PPQ_API_KEY;
    try {
      ppq._getAuthHeader();
      assert(false, 'auth: throws when PPQ_API_KEY missing');
    } catch (e) {
      assert(e.message.includes('PPQ_API_KEY'), 'auth: throws when PPQ_API_KEY missing');
    }
    process.env.PPQ_API_KEY = saved;
  }

  // 1.2: Auth header format
  {
    const headers = ppq._getAuthHeader();
    assert(headers.Authorization === 'Bearer test-key-123', 'auth: Bearer token format correct');
  }

  // ── Test Group 2: listModels ────────────────────────────────────
  console.log('');
  console.log('── listModels ──');

  // 2.1: Successful model list
  await startMockServer((req, body, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-4o-mini', object: 'model', owned_by: 'OpenAI', context_length: 128000 },
          { id: 'claude-sonnet-4.6', object: 'model', owned_by: 'Anthropic', context_length: 1000000 },
        ],
      }));
    }
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    const models = await ppq.listModels();
    assert(models.length === 2, 'listModels: returns 2 models');
    assert(models[0].id === 'gpt-4o-mini', 'listModels: first model correct');
    assert(models[1].owned_by === 'Anthropic', 'listModels: second model correct');
  }
  await stopMockServer();

  // 2.2: Empty model list
  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    const models = await ppq.listModels();
    assert(models.length === 0, 'listModels: empty list returns []');
  }
  await stopMockServer();

  // 2.3: API error (401)
  await startMockServer((req, body, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid API key' }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    try {
      await ppq.listModels();
      assert(false, 'listModels: 401 throws');
    } catch (e) {
      assert(e.status === 401, 'listModels: 401 throws with status');
      assert(e.message.includes('Invalid API key'), 'listModels: 401 error message');
    }
  }
  await stopMockServer();

  // 2.4: API error (402 insufficient balance)
  await startMockServer((req, body, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Insufficient balance', message: 'Please top up your account' }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    try {
      await ppq.listModels();
      assert(false, 'listModels: 402 throws');
    } catch (e) {
      assert(e.status === 402, 'listModels: 402 throws with status');
    }
  }
  await stopMockServer();

  // ── Test Group 3: getModel ──────────────────────────────────────
  console.log('');
  console.log('── getModel ──');

  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'gpt-4o-mini', object: 'model', owned_by: 'OpenAI' },
        { id: 'claude-haiku-4.5', object: 'model', owned_by: 'Anthropic' },
      ],
    }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    const model = await ppq.getModel('gpt-4o-mini');
    assert(model !== null, 'getModel: finds existing model');
    assert(model.owned_by === 'OpenAI', 'getModel: correct model data');

    const missing = await ppq.getModel('nonexistent');
    assert(missing === null, 'getModel: returns null for missing');
  }
  await stopMockServer();

  // ── Test Group 4: isModelAvailable ──────────────────────────────
  console.log('');
  console.log('── isModelAvailable ──');

  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'gpt-4o-mini', object: 'model' }],
    }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    const available = await ppq.isModelAvailable('gpt-4o-mini');
    assert(available === true, 'isModelAvailable: returns true for existing');

    const missing = await ppq.isModelAvailable('nonexistent');
    assert(missing === false, 'isModelAvailable: returns false for missing');
  }
  await stopMockServer();

  // ── Test Group 5: chatCompletion ────────────────────────────────
  console.log('');
  console.log('── chatCompletion ──');

  // 5.1: Successful completion
  await startMockServer((req, body, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test123',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello! How can I help you?' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }));
    }
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    const result = await ppq.chatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert(result.content === 'Hello! How can I help you?', 'chat: content extracted');
    assert(result.model === 'gpt-4o-mini', 'chat: model returned');
    assert(result.usage.total_tokens === 30, 'chat: usage returned');
    assert(result.raw.id === 'chatcmpl-test123', 'chat: raw response preserved');
  }
  await stopMockServer();

  // 5.2: Missing model
  {
    try {
      await ppq.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
      assert(false, 'chat: throws without model');
    } catch (e) {
      assert(e.message.includes('model is required'), 'chat: throws without model');
    }
  }

  // 5.3: Missing messages
  {
    try {
      await ppq.chatCompletion({ model: 'gpt-4o-mini' });
      assert(false, 'chat: throws without messages');
    } catch (e) {
      assert(e.message.includes('messages array is required'), 'chat: throws without messages');
    }
  }

  // 5.4: Empty messages array
  {
    try {
      await ppq.chatCompletion({ model: 'gpt-4o-mini', messages: [] });
      assert(false, 'chat: throws with empty messages');
    } catch (e) {
      assert(e.message.includes('messages array is required'), 'chat: throws with empty messages');
    }
  }

  // 5.5: API returns error
  await startMockServer((req, body, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    try {
      await ppq.chatCompletion({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
      assert(false, 'chat: 500 throws');
    } catch (e) {
      assert(e.status === 500, 'chat: 500 throws with status');
    }
  }
  await stopMockServer();

  // 5.6: Idempotency key header sent
  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-idem',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    serverRequests = [];
    await ppq.chatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      idempotencyKey: 'my-idem-key-456',
    });
    const lastReq = serverRequests[serverRequests.length - 1];
    assert(lastReq.headers['x-idempotency-key'] === 'my-idem-key-456', 'chat: idempotency key header sent');
  }
  await stopMockServer();

  // 5.7: Default parameters
  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-defaults',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    serverRequests = [];
    await ppq.chatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const lastReq = serverRequests[serverRequests.length - 1];
    const sentBody = JSON.parse(lastReq.body);
    assert(sentBody.max_tokens === 512, 'chat: default max_tokens is 512');
    assert(sentBody.temperature === 0.7, 'chat: default temperature is 0.7');
  }
  await stopMockServer();

  // 5.8: Custom parameters
  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-custom',
      object: 'chat.completion',
      model: 'claude-sonnet-4.6',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Custom' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    serverRequests = [];
    await ppq.chatCompletion({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
      temperature: 0.5,
    });
    const lastReq = serverRequests[serverRequests.length - 1];
    const sentBody = JSON.parse(lastReq.body);
    assert(sentBody.max_tokens === 1024, 'chat: custom max_tokens sent');
    assert(sentBody.temperature === 0.5, 'chat: custom temperature sent');
  }
  await stopMockServer();

  // ── Test Group 6: simpleChat ────────────────────────────────────
  console.log('');
  console.log('── simpleChat ──');

  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-simple',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Simple response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    const text = await ppq.simpleChat('gpt-4o-mini', 'Say something');
    assert(text === 'Simple response', 'simpleChat: returns text content');
  }
  await stopMockServer();

  // ── Test Group 7: healthCheck ───────────────────────────────────
  console.log('');
  console.log('── healthCheck ──');

  // 7.1: Healthy
  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    const health = await ppq.healthCheck();
    assert(health.ok === true, 'health: ok when API responds');
    assert(health.status === 200, 'health: status 200');
  }
  await stopMockServer();

  // 7.2: Unhealthy (401)
  await startMockServer((req, body, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    const health = await ppq.healthCheck();
    assert(health.ok === false, 'health: not ok on 401');
    assert(health.status === 401, 'health: status 401');
    assert(health.error.includes('Unauthorized'), 'health: error message');
  }
  await stopMockServer();

  // 7.3: Unhealthy (connection refused)
  {
    process.env.PPQ_API_URL = 'http://127.0.0.1:1'; // port 1 — nothing listening
    const health = await ppq.healthCheck();
    assert(health.ok === false, 'health: not ok on connection refused');
    assert(health.status === 0, 'health: status 0 for connection error');
  }

  // ── Test Group 8: Timeout ───────────────────────────────────────
  console.log('');
  console.log('── Timeout ──');

  await startMockServer((req, body, res) => {
    // Never respond — let it timeout
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    try {
      await ppq._request({
        method: 'GET',
        path: '/v1/models',
        headers: ppq._getAuthHeader(),
        timeoutMs: 100, // 100ms timeout
      });
      assert(false, 'timeout: should throw');
    } catch (e) {
      assert(e.status === 408, 'timeout: status 408');
      assert(e.message.includes('timed out'), 'timeout: error message');
    }
  }
  await stopMockServer();

  // ── Test Group 9: Request body format ───────────────────────────
  console.log('');
  console.log('── Request Format ──');

  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-format',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    serverRequests = [];
    await ppq.chatCompletion({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ],
    });
    const lastReq = serverRequests[serverRequests.length - 1];
    assert(lastReq.method === 'POST', 'format: POST method');
    assert(lastReq.url === '/v1/chat/completions', 'format: correct path');
    assert(lastReq.headers['content-type'] === 'application/json', 'format: JSON content-type');
    assert(lastReq.headers.authorization === 'Bearer test-key-123', 'format: auth header');

    const sentBody = JSON.parse(lastReq.body);
    assert(sentBody.model === 'gpt-4o-mini', 'format: model in body');
    assert(sentBody.messages.length === 2, 'format: messages array in body');
    assert(sentBody.messages[0].role === 'system', 'format: first message role');
    assert(sentBody.messages[1].content === 'Hello', 'format: second message content');
  }
  await stopMockServer();

  // ── Test Group 10: Empty response handling ──────────────────────
  console.log('');
  console.log('── Edge Cases ──');

  // 10.1: Response with no choices
  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-empty',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    const result = await ppq.chatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert(result.content === '', 'edge: empty choices returns empty string');
  }
  await stopMockServer();

  // 10.2: Response with no usage
  await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-nousage',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
    }));
  });

  {
    process.env.PPQ_API_URL = `http://127.0.0.1:${serverPort}`;
    const result = await ppq.chatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert(result.content === 'Hi', 'edge: no usage still returns content');
    assert(JSON.stringify(result.usage) === '{}', 'edge: no usage returns empty object');
  }
  await stopMockServer();

  // ── Summary ─────────────────────────────────────────────────────

  console.log('');
  console.log(`ppq-client tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
