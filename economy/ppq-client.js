// economy/ppq-client.js
// Signal Rush — ppq.ai HTTP Client
//
// Thin wrapper around the ppq.ai API (OpenAI-compatible).
// All API keys stored in environment variables — never in code.
//
// API docs: https://docs.ppq.ai
// Base URL: https://api.ppq.ai
// Auth: Bearer token via PPQ_API_KEY env var
//
// Endpoints used:
//   GET  /v1/models          — list available models
//   POST /v1/chat/completions — chat completion (the main one)

const https = require('https');
const http = require('http');

const DEFAULT_BASE_URL = 'https://api.ppq.ai';
const DEFAULT_TIMEOUT_MS = 30000;

// ─── HTTP Helper ───────────────────────────────────────────────────

function request({ method, path, body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const baseUrl = process.env.PPQ_API_URL || DEFAULT_BASE_URL;
    const url = new URL(baseUrl + path);

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      timeout: timeoutMs,
    };

    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } else {
          const err = new Error(
            parsed?.error || parsed?.message || `ppq.ai HTTP ${res.statusCode}`
          );
          err.status = res.statusCode;
          err.body = parsed;
          reject(err);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const err = new Error('ppq.ai request timed out');
      err.status = 408;
      reject(err);
    });

    req.on('error', (err) => {
      err.status = err.status || 0;
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ─── Auth Helper ───────────────────────────────────────────────────

function getAuthHeader() {
  const key = process.env.PPQ_API_KEY;
  if (!key) {
    throw new Error('PPQ_API_KEY environment variable is not set');
  }
  return { Authorization: `Bearer ${key}` };
}

// ─── API Functions ─────────────────────────────────────────────────

/**
 * List available models from ppq.ai.
 * @returns {Promise<{id, object, owned_by, context_length, pricing}[]>}
 */
async function listModels() {
  const res = await request({
    method: 'GET',
    path: '/v1/models',
    headers: getAuthHeader(),
  });
  return res.data?.data || [];
}

/**
 * Get a specific model by ID.
 * @param {string} modelId
 * @returns {Promise<object|null>}
 */
async function getModel(modelId) {
  const models = await listModels();
  return models.find(m => m.id === modelId) || null;
}

/**
 * Check if a model is available.
 * @param {string} modelId
 * @returns {Promise<boolean>}
 */
async function isModelAvailable(modelId) {
  const model = await getModel(modelId);
  return model !== null;
}

/**
 * Call ppq.ai chat completions endpoint.
 * OpenAI-compatible format.
 *
 * @param {object} params
 * @param {string} params.model - Model ID (e.g., 'gpt-4o-mini')
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {number} [params.max_tokens=512]
 * @param {number} [params.temperature=0.7]
 * @param {string} [params.idempotencyKey] - Sent as X-Idempotency-Key header
 * @returns {Promise<{content: string, model: string, usage: object, raw: object}>}
 */
async function chatCompletion({
  model,
  messages,
  max_tokens = 512,
  temperature = 0.7,
  idempotencyKey = null,
} = {}) {
  if (!model) throw new Error('chatCompletion: model is required');
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('chatCompletion: messages array is required');
  }

  const headers = getAuthHeader();
  if (idempotencyKey) {
    headers['X-Idempotency-Key'] = idempotencyKey;
  }

  const body = {
    model,
    messages,
    max_tokens,
    temperature,
  };

  const res = await request({
    method: 'POST',
    path: '/v1/chat/completions',
    body,
    headers,
  });

  // Extract the response in a clean format
  const choice = res.data?.choices?.[0];
  const content = choice?.message?.content || '';

  return {
    content,
    model: res.data?.model || model,
    usage: res.data?.usage || {},
    raw: res.data,
  };
}

/**
 * Simple convenience method: single-prompt chat.
 * Wraps chatCompletion with a single user message.
 *
 * @param {string} model
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<string>} The AI response text
 */
async function simpleChat(model, prompt, opts = {}) {
  const result = await chatCompletion({
    model,
    messages: [{ role: 'user', content: prompt }],
    ...opts,
  });
  return result.content;
}

/**
 * Check ppq.ai API health / connectivity.
 * Makes a lightweight call to verify the API key works.
 *
 * @returns {Promise<{ok: boolean, status: number, error?: string}>}
 */
async function healthCheck() {
  try {
    await listModels();
    return { ok: true, status: 200 };
  } catch (err) {
    return { ok: false, status: err.status || 0, error: err.message };
  }
}

module.exports = {
  listModels,
  getModel,
  isModelAvailable,
  chatCompletion,
  simpleChat,
  healthCheck,
  // Internal helpers exported for testing
  _request: request,
  _getAuthHeader: getAuthHeader,
};
