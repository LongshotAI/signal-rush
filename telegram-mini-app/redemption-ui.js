/**
 * redemption-ui.js — VMCO Sub-key Redemption Panel
 *
 * Shows player's earned micros + a "Get API Key" button that calls /vmco/claim.
 * The player receives a VMCO sub-key (vmco-sk-XXXX) they own and can paste
 * into their own agent (Hermes, OpenClaw, Claude Code, etc.).
 *
 * Key facts shown to player:
 *  - 10,000 micros = 1 VMCO credit = $0.01
 *  - The sub-key is THEIRS — Signal Rush never touches their API calls
 *  - They can top up anytime they earn more micros
 *  - They can revoke the key if they lose access
 */

const MICROS_PER_CREDIT = 10_000;

export class RedemptionUI {
  constructor(containerSelector = '#game-container') {
    this.container = document.querySelector(containerSelector);
    this.economyClient = null;
    this.playerId = null;
    this.rewardsMicros = 0;     // earned micros from gameplay
    this.visible = false;
    this.el = null;
    this._refreshTimer = null;
  }

  init(economyClient, playerId, initialRewards = 0, initData = null) {
    this.economyClient = economyClient;
    this.playerId = playerId;
    this.rewardsMicros = initialRewards;
    this.initData = initData;
    this._build();
    this._refreshRewards();
    // Auto-refresh balance every 10s while visible
    this._refreshTimer = setInterval(() => {
      if (this.visible) this._refreshRewards();
    }, 10_000);
  }

  destroy() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
  }

  _build() {
    if (!this.container) return;

    this.el = document.createElement('div');
    this.el.id = 'redemption-panel';
    Object.assign(this.el.style, {
      position: 'fixed',
      bottom: '0',
      left: '0',
      right: '0',
      background: 'rgba(10,10,26,0.95)',
      borderTop: '1px solid rgba(0,255,136,0.2)',
      padding: '12px 16px',
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
      fontSize: '13px',
      color: '#ffffff',
      display: 'none',
      zIndex: '100',
      maxHeight: '70vh',
      overflowY: 'auto',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
    });

    this.el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="color:#00ff88;font-weight:bold">🎯 <span id="reward-balance">0</span> µ earned</span>
          <span style="color:rgba(0,255,136,0.6);font-size:11px">=<span id="reward-credits">0</span> VMCO credits</span>
          <button id="redeem-close" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:18px;cursor:pointer;padding:0 4px;">✕</button>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.4)">10,000 µ = 1 credit = $0.01 • Claim as your own API key</div>
      </div>

      <!-- Claim Section -->
      <div id="vmco-claim-area" style="margin-bottom:10px;padding:10px;background:rgba(0,255,136,0.06);border-radius:6px;border:1px solid rgba(0,255,136,0.15);display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="vmco-claim-amount" style="flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:8px;border-radius:6px;font-family:inherit;font-size:12px;">
            <option value="10000">1 credit (10,000 µ) — $0.01</option>
            <option value="50000">5 credits (50,000 µ) — $0.05</option>
            <option value="100000">10 credits (100,000 µ) — $0.10</option>
            <option value="all">All available (rounds down)</option>
          </select>
          <button id="vmco-claim-btn" style="background:rgba(0,255,136,0.15);border:1px solid rgba(0,255,136,0.4);color:#00ff88;padding:8px 14px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:bold;white-space:nowrap;transition:background 0.2s;">🔑 Get API Key</button>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.45)" id="vmco-claim-note">Creates a VMCO sub-key you own. Paste into your AI agent.</div>
        <div id="vmco-claim-result" style="display:none;font-size:12px;margin-top:4px;"></div>
      </div>

      <!-- Active Key Display (shown after claim) -->
      <div id="vmco-key-area" style="display:none;margin-bottom:10px;padding:10px;background:rgba(0,150,255,0.08);border-radius:6px;border:1px solid rgba(0,150,255,0.25);flex-direction:column;gap:8px;">
        <div style="font-size:11px;color:rgba(0,200,255,0.8);font-weight:bold;">YOUR VMCO API KEY</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <code id="vmco-key-display" style="flex:1;background:rgba(0,0,0,0.4);color:#00ccff;padding:8px;border-radius:4px;font-size:11px;word-break:break-all;user-select:all;cursor:text;">vmco-sk-XXXX...</code>
          <button id="vmco-copy-btn" style="background:rgba(0,150,255,0.2);border:1px solid rgba(0,150,255,0.4);color:#00ccff;padding:6px 10px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;white-space:nowrap;">📋 Copy</button>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:rgba(255,255,255,0.5);">
          <span>Budget: <strong id="vmco-key-budget" style="color:#00ff88;">0</strong> credits</span>
          <span>= $<span id="vmco-key-dollars">0.00</span></span>
        </div>
        <div style="font-size:10px;color:rgba(255,255,255,0.35)">
          Use in your agent:<br/>
          <code style="color:rgba(255,255,255,0.5)">Authorization: Bearer vmco-s...</code><br/>
          Endpoint: <code style="color:rgba(255,255,255,0.5)">https://api.vmco.ai/v1/chat/completions</code>
        </div>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <button id="vmco-revoke-btn" style="background:rgba(255,50,50,0.1);border:1px solid rgba(255,50,50,0.3);color:#ff5555;padding:4px 8px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:10px;">🗑 Revoke Key</button>
        </div>
      </div>
    `;

    this.container.parentElement.appendChild(this.el);

    // Event wiring
    this.el.querySelector('#redeem-close').addEventListener('click', () => this.hide());
    this.el.querySelector('#vmco-claim-btn').addEventListener('click', () => this._claimVmco());
    this.el.querySelector('#vmco-copy-btn').addEventListener('click', () => this._copyKey());
    this.el.querySelector('#vmco-revoke-btn').addEventListener('click', () => this._revokeKey());
  }

  show() {
    if (this.el) {
      this.el.style.display = 'block';
      this.visible = true;
      this._refreshRewards();
    }
  }

  hide() {
    if (this.el) {
      this.el.style.display = 'none';
      this.visible = false;
    }
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  updateRewards(newMicros) {
    this.rewardsMicros = newMicros;
    this._renderRewards();
  }

  _renderRewards() {
    const el = this.el?.querySelector('#reward-balance');
    if (el) el.textContent = this.rewardsMicros.toLocaleString();
    const credEl = this.el?.querySelector('#reward-credits');
    if (credEl) credEl.textContent = Math.floor(this.rewardsMicros / MICROS_PER_CREDIT);
  }

  async _refreshRewards() {
    if (!this.economyClient || !this.playerId) return;
    try {
      const result = await this.economyClient.getRewards(this.playerId);
      if (result.ok) {
        const available = result.available_micros || 0;
        if (available !== this.rewardsMicros) {
          this.rewardsMicros = available;
          this._renderRewards();
        }
      }
    } catch {}

    // Also check if player already has a sub-key
    this._refreshSubKey();
  }

  async _refreshSubKey() {
    if (!this.economyClient || !this.playerId) return;
    try {
      const result = await this.economyClient.vmcoGetSubKey({ playerId: this.playerId });
      if (result.ok && result.has_sub_key) {
        this._showSubKey(result.sub_key, result.budget_credits);
      } else {
        this._hideSubKey();
      }
    } catch {}
  }

  _showSubKey(keyValue, budgetCredits) {
    const keyArea = this.el?.querySelector('#vmco-key-area');
    const keyDisplay = this.el?.querySelector('#vmco-key-display');
    const budgetEl = this.el?.querySelector('#vmco-key-budget');
    const dollarsEl = this.el?.querySelector('#vmco-key-dollars');
    const claimNote = this.el?.querySelector('#vmco-claim-note');

    if (keyDisplay) keyDisplay.textContent = keyValue;
    if (budgetEl) budgetEl.textContent = budgetCredits;
    if (dollarsEl) dollarsEl.textContent = (budgetCredits * 0.01).toFixed(2);
    if (keyArea) { keyArea.style.display = 'flex'; }
    if (claimNote) claimNote.textContent = '✅ Key active! Earn more micros to top up, or use the key below in your agent.';
  }

  _hideSubKey() {
    const keyArea = this.el?.querySelector('#vmco-key-area');
    if (keyArea) keyArea.style.display = 'none';
  }

  async _claimVmco() {
    if (!this.economyClient || !this.playerId) return;
    if (this.rewardsMicros < MICROS_PER_CREDIT) {
      this._showClaimResult(`Need at least ${MICROS_PER_CREDIT.toLocaleString()} micros to claim (you have ${this.rewardsMicros.toLocaleString()})`, '#ffdd44');
      return;
    }

    const select = this.el.querySelector('#vmco-claim-amount');
    const selectedValue = select?.value;
    let amountMicros;
    if (selectedValue === 'all') {
      // Round down to nearest multiple of MICROS_PER_CREDIT
      amountMicros = Math.floor(this.rewardsMicros / MICROS_PER_CREDIT) * MICROS_PER_CREDIT;
    } else {
      amountMicros = parseInt(selectedValue, 10) || MICROS_PER_CREDIT;
    }

    if (amountMicros > this.rewardsMicros) {
      this._showClaimResult(`Not enough micros. You have ${this.rewardsMicros.toLocaleString()} µ.`, '#ff3355');
      return;
    }

    const btn = this.el.querySelector('#vmco-claim-btn');
    btn.disabled = true;
    btn.textContent = 'Issuing key...';

    try {
      const result = await this.economyClient.vmcoClaim({
        playerId: this.playerId,
        amountMicros,
        initData: this.initData,
      });

      if (result.ok) {
        const isNew = result.is_new;
        const credits = result.budget_credits || Math.floor(amountMicros / MICROS_PER_CREDIT);
        this._showClaimResult(
          `✅ ${isNew ? 'New key created!' : 'Key topped up!'} +${credits} credits added.${result.idempotent ? ' Check the key below.' : ''}`,
          '#00ff88'
        );
        // Refresh rewards (decremented) and show the key
        await this._refreshRewards();
        if (result.sub_key) {
          this._showSubKey(result.sub_key, result.budget_credits);
        }
      } else {
        const err = result.error || 'Claim failed';
        // Helpful hints for specific errors
        let hint = '';
        if (err.includes('multiple of')) hint = ' Must be a multiple of 10,000 micros.';
        else if (err.includes('session token')) hint = ' Please reopen the mini-app.';
        else if (err.includes('rate limited')) hint = ' Wait 60s between claims.';
        else if (err.includes('insufficient')) hint = ' Earn more micros by playing.';
        else if (err.includes('temporarily low')) hint = ' Master account needs top-up. Try again later.';
        this._showClaimResult(`❌ ${err}.${hint}`, '#ff3355');
      }
    } catch (err) {
      this._showClaimResult(`❌ Error: ${err.message}. Try again.`, '#ff3355');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔑 Get API Key';
    }
  }

  async _copyKey() {
    const keyDisplay = this.el?.querySelector('#vmco-key-display');
    const keyValue = keyDisplay?.textContent;
    if (!keyValue) return;
    try {
      await navigator.clipboard.writeText(keyValue);
      const btn = this.el.querySelector('#vmco-copy-btn');
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 2000);
    } catch {
      // Fallback: select the text
      const range = document.createRange();
      range.selectNode(keyDisplay);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  async _revokeKey() {
    if (!confirm('Revoke your VMCO API key? It will stop working immediately in all agents. You can re-create it by claiming again.')) return;

    const btn = this.el.querySelector('#vmco-revoke-btn');
    btn.disabled = true;
    btn.textContent = 'Revoking...';

    try {
      const result = await this.economyClient.vmcoRevokeSubKey({ playerId: this.playerId });
      if (result.ok) {
        this._hideSubKey();
        this._showClaimResult('Key revoked. You can claim a new one anytime by earning more micros.', '#00ff88');
      } else {
        this._showClaimResult(`❌ ${result.error || 'Revoke failed'}`, '#ff3355');
      }
    } catch (err) {
      this._showClaimResult(`❌ Error: ${err.message}`, '#ff3355');
    } finally {
      btn.disabled = false;
      btn.textContent = '🗑 Revoke Key';
    }
  }

  _showClaimResult(msg, color = 'rgba(255,255,255,0.6)') {
    const el = this.el?.querySelector('#vmco-claim-result');
    if (el) {
      el.textContent = msg;
      el.style.color = color;
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 6000);
    }
  }
}

export { MICROS_PER_CREDIT };
