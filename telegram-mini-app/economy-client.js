/**
 * economy-client.js — Signal Rush Economy API Client
 *
 * Connects the Telegram Mini App to the economy service.
 * All methods return { ok: true, ... } or { ok: false, error: "..." }.
 * Gracefully degrades when service is unavailable (offline mode).
 */

const DEFAULT_BASE_URL = '';

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

  /**
   * Fetch active campaigns with approved creatives.
   * GET /api/game/campaigns
   * Used by the game client to render sponsor branding and interstitial ads.
   */
  async fetchActiveCampaigns() {
    return this._fetch('/api/game/campaigns');
  }

  /**
   * Fetch campaign logo/creative content as JSON.
   * GET /api/campaigns/:id/logo
   * Returns: { ok: true, content: { ascii: [...] } | { text: "..." }, brand_name: "..." }
   */
  async getCampaignLogo(campaignId) {
    return this._fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/logo`);
  }

  /**
   * Log an ad impression.
   * POST /ads/impression
   */
  async logAdImpression({ campaignId, playerId, placementType = 'hud_frame' }) {
    return this._fetch('/ads/impression', {
      method: 'POST',
      body: {
        campaign_id: campaignId,
        player_id: playerId,
        placement_type: placementType,
      },
    });
  }

  /**
   * Get player's ad-funded reward balance.
   * GET /players/:id/rewards
   */
  async getRewards(playerId) {
    return this._fetch(`/players/${encodeURIComponent(playerId)}/rewards`);
  }

  /**
   * Get global rewards pool stats.
   * GET /rewards/pool-stats
   */
  async getRewardsPoolStats() {
    return this._fetch('/rewards/pool-stats');
  }

  /**
   * Claim ad-funded rewards (send to VMCO.ai sub-key).
   * POST /rewards/claim
   */
  async claimRewards({ playerId, vmcoSubKeyId, amountMicros, idempotencyKey = null }) {
    return this._fetch('/rewards/claim', {
      method: 'POST',
      body: { player_id: playerId, vmco_sub_key_id: vmcoSubKeyId, amount_micros: amountMicros, session_token: this.sessionToken, idempotency_key: idempotencyKey },
    });
  }

  /**
   * Submit session stats for ad-funded reward earning.
   * POST /internal/earn-reward
   * This replaces the old credit-ingest flow — the only redeemable
   * value comes from the 20% ad revenue pool.
   */
  async submitEarnReward({ playerId, score, combo, level, tickCount, difficultyTier }) {
    return this._fetch('/internal/earn-reward', {
      method: 'POST',
      body: {
        player_id: playerId,
        score,
        combo,
        level,
        tick_count: tickCount,
        difficulty_tier: difficultyTier,
      },
    });
  }

  /**
   * Claim earned micros as a VMCO sub-key.
   * First claim creates the sub-key; subsequent claims top up budget.
   * POST /vmco/claim
   * Amount must be a multiple of 10,000 micros (1 VMCO credit = $0.01).
   *
   * Automatically re-authenticates if the session token expired (401/403).
   * Pass `initData` from Telegram.WebApp.initData() for auto-retry.
   */
  async vmcoClaim({ playerId, amountMicros, initData = null }) {
    let result = await this._fetch('/vmco/claim', {
      method: 'POST',
      body: {
        player_id: playerId,
        amount_micros: amountMicros,
        session_token: this.sessionToken,
      },
    });

    // Auto-recover from expired session token
    if (!result.ok && (result.status === 401 || result.status === 403) && initData) {
      const auth = await this.auth(initData);
      if (auth.ok) {
        result = await this._fetch('/vmco/claim', {
          method: 'POST',
          body: {
            player_id: playerId,
            amount_micros: amountMicros,
            session_token: this.sessionToken,
          },
        });
      }
    }

    return result;
  }

  /**
   * Get the player's existing sub-key.
   * Returns the vmco-sk-XXXX key value + budget info.
   * GET /vmco/sub-key/:player_id
   *
   * Automatically re-authenticates if the session token expired.
   */
  async vmcoGetSubKey({ playerId, initData = null }) {
    let result = await this._fetch(`/vmco/sub-key/${encodeURIComponent(playerId)}`);

    if (!result.ok && (result.status === 401 || result.status === 403) && initData) {
      const auth = await this.auth(initData);
      if (auth.ok) {
        result = await this._fetch(`/vmco/sub-key/${encodeURIComponent(playerId)}`);
      }
    }

    return result;
  }

  /**
   * Revoke / kill the player's sub-key.
   * DELETE /vmco/sub-key/:player_id
   */
  async vmcoRevokeSubKey({ playerId }) {
    return this._fetch(`/vmco/sub-key/${encodeURIComponent(playerId)}?session_token=${encodeURIComponent(this.sessionToken)}`, {
      method: 'DELETE',
    });
  }
}
