/**
 * economy-client.js — Signal Rush Economy API Client
 *
 * Connects the Telegram Mini App to the economy service.
 * All methods return { ok: true, ... } or { ok: false, error: "..." }.
 * Gracefully degrades when service is unavailable (offline mode).
 */

const DEFAULT_BASE_URL = 'http://localhost:8720';

export class EconomyClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, sessionToken = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.sessionToken = sessionToken;
  }

  setSessionToken(token) {
    this.sessionToken = token;
  }

  async _fetch(path, { method = 'GET', body = null } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.sessionToken) {
      headers['Authorization'] = `Bearer ${this.sessionToken}`;
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, error: data.error || `HTTP ${res.status}`, status: res.status };
      }
      return { ok: true, ...data };
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return { ok: false, error: 'service unavailable', offline: true };
      }
      return { ok: false, error: err.message, offline: true };
    }
  }

  /**
   * Authenticate with Telegram initData.
   * POST /telegram/auth
   */
  async auth(initData) {
    if (!initData || typeof initData !== 'string') {
      return { ok: false, error: 'initData is required' };
    }
    const result = await this._fetch('/telegram/auth', {
      method: 'POST',
      body: { initData },
    });
    if (result.ok && result.session_token) {
      this.sessionToken = result.session_token;
    }
    return result;
  }

  /**
   * Get player info by Telegram ID.
   * GET /telegram/player/:telegram_id
   */
  async getPlayer(telegramId) {
    return this._fetch(`/telegram/player/${encodeURIComponent(telegramId)}`);
  }

  /**
   * Get player balance.
   * GET /credits/balances?player_id=...
   */
  async getBalance(playerId) {
    const result = await this._fetch(`/credits/balances?player_id=${encodeURIComponent(playerId)}`);
    // Normalize response: server may return { balance } or { balances: [...] }
    if (result.ok) {
      if (result.balance == null && result.balances?.length > 0) {
        result.balance = result.balances[0].balance || result.balances[0].amount || 0;
      }
    }
    return result;
  }

  /**
   * Submit a verified receipt (score proof).
   * POST /internal/verify-receipt
   */
  async submitReceipt({ seed, mode, inputs, claimedScore, claimedLevel }) {
    return this._fetch('/internal/verify-receipt', {
      method: 'POST',
      body: {
        seed,
        mode,
        inputs,
        claimed_score: claimedScore,
        claimed_level: claimedLevel,
      },
    });
  }

  /**
   * Submit credits (session ingest).
   * POST /internal/ingest
   */
  async submitCredits({ playerId, sessionId, creditsDelta, events = [] }) {
    return this._fetch('/internal/ingest', {
      method: 'POST',
      body: {
        player_id: playerId,
        session_id: sessionId,
        credits_delta: creditsDelta,
        events,
      },
    });
  }

  /**
   * Award credits (admin/internal).
   * POST /credits/award
   */
  async awardCredits({ playerId, amount, reason }) {
    return this._fetch('/credits/award', {
      method: 'POST',
      body: { player_id: playerId, amount, reason },
    });
  }

  /**
   * Spend credits.
   * POST /credits/spend
   */
  async spendCredits({ playerId, amount, reason }) {
    return this._fetch('/credits/spend', {
      method: 'POST',
      body: { player_id: playerId, amount, reason },
    });
  }

  /**
   * Redeem credits for AI API call.
   * POST /credits/redeem
   */
  async redeemCredits({ playerId, credits, model, prompt }) {
    return this._fetch('/credits/redeem', {
      method: 'POST',
      body: { player_id: playerId, credits, model, prompt },
    });
  }

  /**
   * Health check.
   * GET /health
   */
  async healthCheck() {
    return this._fetch('/health');
  }
}
