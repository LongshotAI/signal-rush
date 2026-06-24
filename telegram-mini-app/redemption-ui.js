/**
 * redemption-ui.js — Credit Balance Display + Redemption Panel
 *
 * Shows credit balance in a collapsible panel with redemption flow.
 * Works in both Telegram Mini App mode and standalone browser mode.
 */

export class RedemptionUI {
  constructor(containerSelector = '#game-container') {
    this.container = document.querySelector(containerSelector);
    this.economyClient = null;
    this.playerId = null;
    this.balance = 0;
    this.rewardsMicros = 0;     // ad-funded reward pool earnings
    this.ppqAccount = '';       // player's ppq.ai email/username
    this.visible = false;
    this.el = null;
  }

  init(economyClient, playerId, initialBalance = 0) {
    this.economyClient = economyClient;
    this.playerId = playerId;
    this.balance = initialBalance;
    this._build();
    this._refreshRewards();
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
      maxHeight: '60vh',
      overflowY: 'auto',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
    });

    this.el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="color:#00ff88;font-weight:bold">💰 <span id="credit-balance">0</span> Credits</span>
          <span style="color:rgba(0,255,136,0.6);font-size:12px">🎯 <span id="reward-balance">0</span> µ from ads</span>
          <button id="redeem-close" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:18px;cursor:pointer;padding:0 4px;">✕</button>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.35)">Sponsors fund your AI credits. Play well to earn more.</div>
      </div>

      <div id="rewards-claim-area" style="margin-bottom:10px;padding:8px;background:rgba(0,255,136,0.06);border-radius:6px;border:1px solid rgba(0,255,136,0.15);display:flex;flex-direction:column;gap:6px;">
        <div style="font-size:11px;color:rgba(255,255,255,0.6)">🎯 <strong>Sponsor Reward Claim</strong> — send to your ppq.ai account</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <input id="rewards-ppq-account" type="text" placeholder="ppq.ai email/username" value="${this.ppqAccount}" style="flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:6px 8px;border-radius:6px;font-family:inherit;font-size:12px;" />
          <button id="rewards-claim-btn" style="background:rgba(0,255,136,0.15);border:1px solid rgba(0,255,136,0.3);color:#00ff88;padding:6px 12px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;white-space:nowrap;">Claim All</button>
        </div>
        <div id="rewards-claim-result" style="display:none;font-size:11px;color:rgba(255,255,255,0.6);margin-top:2px;"></div>
      </div>

      <div id="redeem-form" style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;gap:8px;">
          <select id="redeem-model" style="flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:6px 10px;border-radius:6px;font-family:inherit;font-size:12px;">
            <option value="gpt-4o-mini">GPT-4o Mini (10 credits)</option>
            <option value="gpt-4o">GPT-4o (50 credits)</option>
            <option value="claude-3-haiku">Claude 3 Haiku (15 credits)</option>
          </select>
          <input id="redeem-credits" type="number" min="1" value="10" style="width:80px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:6px 10px;border-radius:6px;font-family:inherit;font-size:12px;" />
        </div>
        <textarea id="redeem-prompt" placeholder="Ask AI anything..." rows="3" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:8px 10px;border-radius:6px;font-family:inherit;font-size:12px;resize:none;outline:none;"></textarea>
        <button id="redeem-submit" style="background:rgba(0,255,136,0.15);border:1px solid rgba(0,255,136,0.3);color:#00ff88;padding:8px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:bold;transition:background 0.2s;">
          ⚡ Redeem & Send
        </button>
      </div>
      <div id="redeem-result" style="display:none;margin-top:8px;padding:8px;background:rgba(255,255,255,0.03);border-radius:6px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;"></div>
    `;

    this.container.parentElement.appendChild(this.el);

    // Wire events
    this.el.querySelector('#redeem-close').addEventListener('click', () => this.hide());
    this.el.querySelector('#redeem-submit').addEventListener('click', () => this._submitRedemption());
    this.el.querySelector('#rewards-claim-btn').addEventListener('click', () => this._claimRewards());
  }

  show() {
    if (this.el) {
      this.el.style.display = 'block';
      this.visible = true;
      this._refreshBalance();
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
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  updateBalance(newBalance) {
    this.balance = newBalance;
    const el = this.el?.querySelector('#credit-balance');
    if (el) el.textContent = newBalance;
  }

  async _refreshBalance() {
    if (!this.economyClient || !this.playerId) return;
    const result = await this.economyClient.getBalance(this.playerId);
    if (result.ok && result.balance != null) {
      this.updateBalance(result.balance);
    }
  }

  async _refreshRewards() {
    if (!this.economyClient || !this.playerId) return;
    const result = await this.economyClient.getRewards(this.playerId);
    if (result.ok) {
      this.rewardsMicros = result.available_micros || 0;
      const el = this.el?.querySelector('#reward-balance');
      if (el) el.textContent = this.rewardsMicros;
      // Show/hide claim area based on available rewards
      const claimArea = this.el?.querySelector('#rewards-claim-area');
      if (claimArea) {
        claimArea.style.display = this.rewardsMicros >= 1000 ? 'flex' : 'none';
      }
    }
  }

  async _claimRewards() {
    if (!this.economyClient || !this.playerId) return;
    if (this.rewardsMicros < 1000) {
      this._showClaimResult(`Minimum claim: 1,000 micros (you have ${this.rewardsMicros})`, '#ffdd44');
      return;
    }

    const ppqInput = this.el?.querySelector('#rewards-ppq-account');
    const ppqAccount = ppqInput?.value?.trim();
    if (!ppqAccount) {
      this._showClaimResult('Please enter your ppq.ai email or username', '#ff3355');
      return;
    }

    const btn = this.el.querySelector('#rewards-claim-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Claiming...';

    try {
      const result = await this.economyClient.claimRewards({
        playerId: this.playerId,
        ppqAccount,
        amountMicros: this.rewardsMicros,
      });
      if (result.ok) {
        this._showClaimResult(`✅ ${this.rewardsMicros} micros claimed! Sent to ${ppqAccount}`, '#00ff88');
        this.rewardsMicros = 0;
        const el = this.el?.querySelector('#reward-balance');
        if (el) el.textContent = '0';
        // Hide claim area
        const claimArea = this.el?.querySelector('#rewards-claim-area');
        if (claimArea) claimArea.style.display = 'none';
      } else {
        this._showClaimResult(`❌ ${result.error || 'Claim failed'}`, '#ff3355');
      }
    } catch (err) {
      this._showClaimResult(`❌ Error: ${err.message}`, '#ff3355');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Claim All';
    }
  }

  _showClaimResult(msg, color = 'rgba(255,255,255,0.6)') {
    const el = this.el?.querySelector('#rewards-claim-result');
    if (el) {
      el.textContent = msg;
      el.style.color = color;
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 8000);
    }
  }

  async _submitRedemption() {
    if (!this.economyClient || !this.playerId) {
      this._showResult('⚠️ Not connected to economy service');
      return;
    }

    const credits = parseInt(this.el.querySelector('#redeem-credits').value) || 0;
    const model = this.el.querySelector('#redeem-model').value;
    const prompt = this.el.querySelector('#redeem-prompt').value.trim();

    if (!credits || credits <= 0) {
      this._showResult('⚠️ Enter a valid credit amount');
      return;
    }
    if (!prompt) {
      this._showResult('⚠️ Enter a prompt');
      return;
    }
    if (credits > this.balance) {
      this._showResult(`⚠️ Insufficient balance. You have ${this.balance} credits.`);
      return;
    }

    const btn = this.el.querySelector('#redeem-submit');
    btn.disabled = true;
    btn.textContent = '⏳ Sending...';

    try {
      const result = await this.economyClient.redeemCredits({
        playerId: this.playerId,
        credits,
        model,
        prompt,
      });

      if (result.ok) {
        this.updateBalance(result.balance_remaining ?? this.balance - credits);
        this._showResult(`✅ AI Response (${result.model || model}):\n\n${result.content}`);
        this.el.querySelector('#redeem-prompt').value = '';
      } else {
        this._showResult(`❌ ${result.error || 'Redemption failed'}`);
      }
    } catch (err) {
      this._showResult(`❌ Error: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '⚡ Redeem & Send';
    }
  }

  _showResult(text) {
    const el = this.el?.querySelector('#redeem-result');
    if (el) {
      el.textContent = text;
      el.style.display = 'block';
    }
  }
}
