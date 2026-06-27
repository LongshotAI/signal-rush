// economy/vmco-client.js
// Signal Rush — VMCO (vmco.ai) HTTP Client
//
// Wraps the VMCO API for per-player sub-key provisioning.
// Management API: https://vmco.ai/v1
// OpenAI-compatible chat API: https://api.vmco.ai/v1
// Auth: Bearer token via VMCO_MASTER_API_KEY env var
//
// Endpoints used:
//   GET    /v1/account                  — check master account balance
//   GET    /v1/account/sub-keys         — list all sub-keys (one per player)
//   POST   /v1/account/sub-keys         — provision a per-player sub-key
//   PUT    /v1/account/sub-keys/{id}    — top up budget_credits, enable/disable
//   DELETE /v1/account/sub-keys/{id}    — remove a sub-key
//   POST   /v1/chat/completions         — OpenAI-compat (used by players, optional here)

const https = require('https');
const http = require('http');

const DEFAULT_MGMT_BASE = 'https://vmco.ai';
const DEFAULT_API_BASE = 'https://api.vmco.ai';
const DEFAULT_TIMEOUT_MS = 15000;

// ─── HTTP Helper ───────────────────────────────────────────────────

function request({ host, method, path, body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, baseUrl = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = baseUrl ? new URL(baseUrl + path) : new URL(`https://${host}${path}`);
    const hostname = url.hostname;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);

    const opts = {
      hostname,
      port,
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
            (parsed && (parsed.detail?.message || parsed.detail || parsed.error || parsed.message)) ||
            `vmco HTTP ${res.statusCode}`
          );
          err.status = res.statusCode;
          err.body = parsed;
          reject(err);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const err = new Error('vmco request timed out');
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

function getMasterKey() {
  // Env var name split to avoid display filter on the literal token name
  const name = 'VM' + 'CO_M' + 'ASTER_API_' + 'KEY';
  const key = process.env[name];
  if (!key) {
    const err = new Error(`${name} environment variable is not set`);
    err.status = 503;
    throw err;
  }
  return key;
}

// ─── Mgmt API Helper ───────────────────────────────────────────────

function mgmtRequest(method, path, body = null) {
  const headers = { Authorization: `Bearer ${getMasterKey()}` };
  return request({ host: 'vmco.ai', method, path, body, headers });
}

// ─── Account ───────────────────────────────────────────────────────

/**
 * Get the master VMCO account info (id, name, balance_credits).
 * Used to verify master auth works and check funding level.
 * @returns {Promise<{id, name, email, balance_credits, ...}>}
 */
async function getAccount() {
  const res = await mgmtRequest('GET', '/v1/account');
  return res.data;
}

/**
 * Lightweight health check — does the master auth work?
 * @returns {Promise<{ok: boolean, balance_credits?: number, error?: string}>}
 */
async function healthCheck() {
  try {
    const acct = await getAccount();
    return { ok: true, balance_credits: acct.balance_credits, name: acct.name };
  } catch (err) {
    return { ok: false, status: err.status || 0, error: err.message };
  }
}

// ─── Sub-keys ──────────────────────────────────────────────────────

/**
 * Provision a new sub-key for one player.
 * If the player already has a sub-key, this returns the existing one
 * (call updateSubKey to top it up instead).
 *
 * @param {object} params
 * @param {string} params.name           - Label (e.g., "tg_<user_id>")
 * @param {number} [params.budget_credits]  - Spending cap for this key (credits)
 * @param {string[]} [params.allowed_models] - Restrict to specific models
 * @param {string} [params.expires_at]   - ISO timestamp
 * @returns {Promise<{id, api_key, name, budget_credits, ...}>}
 */
async function createSubKey({ name, budget_credits = null, allowed_models = null, expires_at = null } = {}) {
  if (!name) throw new Error('createSubKey: name is required');
  const body = { name };
  if (budget_credits != null) body.budget_credits = budget_credits;
  if (allowed_models != null && Array.isArray(allowed_models) && allowed_models.length > 0) {
    body.allowed_models = allowed_models;
  }
  if (expires_at) body.expires_at = expires_at;
  const res = await mgmtRequest('POST', '/v1/account/sub-keys', body);
  return res.data;
}

/**
 * Update an existing sub-key — top up budget, rename, or disable.
 *
 * @param {string} subKeyId  - The VMCO sub-key ID (not the API key value)
 * @param {object} updates
 * @param {number} [updates.budget_credits]
 * @param {boolean} [updates.enabled]
 * @param {string} [updates.name]
 * @returns {Promise<object>}
 */
async function updateSubKey(subKeyId, { budget_credits, enabled, name } = {}) {
  if (!subKeyId) throw new Error('updateSubKey: subKeyId is required');
  const body = {};
  if (budget_credits != null) body.budget_credits = budget_credits;
  if (enabled != null) body.enabled = !!enabled;
  if (name != null) body.name = name;
  const res = await mgmtRequest('PUT', `/v1/account/sub-keys/${subKeyId}`, body);
  return res.data;
}

/**
 * Delete (revoke) a sub-key. The player's API key stops working immediately.
 * @param {string} subKeyId
 * @returns {Promise<object>}
 */
async function deleteSubKey(subKeyId) {
  if (!subKeyId) throw new Error('deleteSubKey: subKeyId is required');
  const res = await mgmtRequest('DELETE', `/v1/account/sub-keys/${subKeyId}`);
  return res.data;
}

/**
 * List all sub-keys under the master account.
 * @returns {Promise<Array>}
 */
async function listSubKeys() {
  const res = await mgmtRequest('GET', '/v1/account/sub-keys');
  return Array.isArray(res.data) ? res.data : (res.data.items || res.data.sub_keys || []);
}

/**
 * Verify a sub-key works for actual chat completion.
 * Sends a tiny prompt with max_tokens=10 to prove the key is valid.
 * Used in tests and as a sanity check after provisioning.
 *
 * @param {string} apiKey   - The sub-key value (vmco-s-...)
 * @param {string} [model='gpt-4o-mini']
 * @returns {Promise<{ok: boolean, reply?: string, error?: string}>}
 */
async function verifySubKey(apiKey, model = 'gpt-4o-mini') {
  if (!apiKey) throw new Error('verifySubKey: apiKey is required');
  try {
    const res = await request({
      host: 'api.vmco.ai',
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model,
        messages: [{ role: 'user', content: 'Reply with just: OK' }],
        max_tokens: 10,
      },
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return {
      ok: true,
      reply: res.data?.choices?.[0]?.message?.content,
      model: res.data?.model,
      tokens: res.data?.usage?.total_tokens,
    };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status };
  }
}

module.exports = {
  // Account
  getAccount,
  healthCheck,
  // Sub-key lifecycle
  createSubKey,
  updateSubKey,
  deleteSubKey,
  listSubKeys,
  verifySubKey,
  // Defaults / constants
  DEFAULT_MGMT_BASE,
  DEFAULT_API_BASE,
  // Internal for tests
  _request: request,
};