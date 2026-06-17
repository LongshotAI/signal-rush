/* portal/api.js — Signal Rush Advertiser Portal API Client */
/* All API calls go through here. Handles auth, errors, JSON parsing. */

const API = (() => {
  // ── Configuration ────────────────────────────────────────────
  // The portal is served from the same origin as the economy service.
  // In production, the economy service serves static files from /portal/
  // and the API is at the same origin.
  const BASE = '';

  // ── Token Management ─────────────────────────────────────────

  function getToken() {
    return localStorage.getItem('sr_api_key');
  }

  function setToken(key) {
    localStorage.setItem('sr_api_key', key);
  }

  function clearToken() {
    localStorage.removeItem('sr_api_key');
    localStorage.removeItem('sr_account');
  }

  function getAccount() {
    try {
      return JSON.parse(localStorage.getItem('sr_account') || 'null');
    } catch {
      return null;
    }
  }

  function setAccount(account) {
    localStorage.setItem('sr_account', JSON.stringify(account));
  }

  function isLoggedIn() {
    return !!getToken();
  }

  // ── HTTP Helper ──────────────────────────────────────────────

  async function request(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const opts = { method, headers };
    if (body) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${BASE}${path}`, opts);
    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.status === 401) {
      clearToken();
      // If not already on auth page, redirect
      if (!window.location.pathname.includes('login') && !window.location.pathname.includes('signup')) {
        window.location.href = '/portal/login.html';
      }
      throw new Error('Session expired. Please log in again.');
    }

    if (!res.ok) {
      throw new Error(data?.error || `Request failed (${res.status})`);
    }

    return data;
  }

  // ── Auth Endpoints ───────────────────────────────────────────

  async function signup(email, password, companyName) {
    const data = await request('POST', '/portal/signup', { email, password, company_name: companyName });
    if (data.ok) {
      setToken(data.api_key);
      setAccount({ id: data.id, email: data.email, company_name: data.company_name, status: data.status, balance_micros: data.balance_micros });
    }
    return data;
  }

  async function login(email, password) {
    const data = await request('POST', '/portal/login', { email, password });
    if (data.ok) {
      setToken(data.api_key);
      setAccount({ email: data.email, company_name: data.company_name });
    }
    return data;
  }

  function logout() {
    clearToken();
    window.location.href = '/portal/login.html';
  }

  async function getAccountInfo() {
    const data = await request('GET', '/portal/account');
    if (data) setAccount(data);
    return data;
  }

  // ── Campaign Endpoints ───────────────────────────────────────

  async function listCampaigns(limit = 50, offset = 0) {
    return request('GET', `/portal/campaigns?limit=${limit}&offset=${offset}`);
  }

  async function getCampaign(id) {
    return request('GET', `/portal/campaigns/${id}`);
  }

  async function createCampaign(params) {
    return request('POST', '/portal/campaigns', params);
  }

  async function updateCampaign(id, params) {
    return request('PATCH', `/portal/campaigns/${id}`, params);
  }

  async function deleteCampaign(id) {
    return request('DELETE', `/portal/campaigns/${id}`);
  }

  async function submitCampaign(id) {
    return request('POST', `/portal/campaigns/${id}/submit`);
  }

  async function pauseCampaign(id) {
    return request('POST', `/portal/campaigns/${id}/pause`);
  }

  async function resumeCampaign(id) {
    return request('POST', `/portal/campaigns/${id}/resume`);
  }

  // ── Creative Endpoints ───────────────────────────────────────

  async function listCreatives(campaignId) {
    return request('GET', `/portal/campaigns/${campaignId}/creatives`);
  }

  async function createCreative(campaignId, type, content) {
    return request('POST', `/portal/campaigns/${campaignId}/creatives`, { type, content });
  }

  // ── Stats Endpoints ──────────────────────────────────────────

  async function getCampaignStats(campaignId) {
    return request('GET', `/portal/campaigns/${campaignId}/stats`);
  }

  // ── Credits Endpoints ────────────────────────────────────────

  async function depositCredits(amountMicros) {
    return request('POST', '/portal/credits/deposit', { amount_micros: amountMicros });
  }

  // ── Admin Endpoints ──────────────────────────────────────────

  async function adminListCampaigns(status = null) {
    const qs = status ? `?status=${status}` : '';
    return request('GET', `/portal/admin/campaigns${qs}`);
  }

  async function adminApproveCampaign(id) {
    return request('POST', `/portal/admin/campaigns/${id}/approve`);
  }

  async function adminRejectCampaign(id) {
    return request('POST', `/portal/admin/campaigns/${id}/reject`);
  }

  // ── Formatting Helpers ───────────────────────────────────────

  function formatCurrency(micros) {
    if (micros === null || micros === undefined) return '—';
    const credits = micros / 1_000_000;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(credits);
  }

  function formatNumber(n) {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('en-US').format(n);
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function statusLabel(status) {
    const labels = {
      draft: 'Draft',
      pending_review: 'Pending Review',
      active: 'Active',
      paused: 'Paused',
      completed: 'Completed',
      rejected: 'Rejected',
    };
    return labels[status] || status;
  }

  function statusClass(status) {
    return `badge badge-${status}`;
  }

  function placementLabel(type) {
    const labels = {
      hud_frame: 'HUD Frame',
      interstitial: 'Interstitial',
      menu_banner: 'Menu Banner',
      game_over: 'Game Over',
    };
    return labels[type] || type;
  }

  // ── Public API ───────────────────────────────────────────────

  return {
    // Auth
    getToken, setToken, clearToken, getAccount, setAccount, isLoggedIn,
    signup, login, logout, getAccountInfo,
    // Campaigns
    listCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign,
    submitCampaign, pauseCampaign, resumeCampaign,
    // Creatives
    listCreatives, createCreative,
    // Stats
    getCampaignStats,
    // Credits
    depositCredits,
    // Admin
    adminListCampaigns, adminApproveCampaign, adminRejectCampaign,
    // Formatting
    formatCurrency, formatNumber, formatDate, formatDateTime,
    statusLabel, statusClass, placementLabel,
  };
})();
