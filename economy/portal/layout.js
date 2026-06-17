/* portal/layout.js — Shared layout components for the advertiser portal */
/* Renders sidebar, header, and handles auth state. */

const Layout = (() => {
  // ── Sidebar HTML ──────────────────────────────────────────────

  function renderSidebar(activePage = 'dashboard') {
    const account = API.getAccount();
    const companyName = account?.company_name || 'Advertiser';
    const email = account?.email || '';

    const navItems = [
      { id: 'dashboard', label: 'Dashboard', icon: '📊', href: '/portal/dashboard.html' },
      { id: 'campaigns', label: 'Campaigns', icon: '🎯', href: '/portal/dashboard.html' },
      { id: 'account', label: 'Account', icon: '👤', href: '/portal/account.html' },
    ];

    return `
      <aside class="portal-sidebar">
        <div class="sidebar-brand">
          <h1>⚡ Signal Rush</h1>
          <div class="brand-sub">Advertiser Portal</div>
        </div>
        <nav class="sidebar-nav">
          <div class="nav-section">
            <div class="nav-section-title">Menu</div>
            ${navItems.map(item => `
              <a href="${item.href}" class="nav-item ${activePage === item.id ? 'active' : ''}">
                <span class="nav-icon">${item.icon}</span>
                ${item.label}
              </a>
            `).join('')}
          </div>
        </nav>
        <div class="sidebar-footer">
          <div class="account-name truncate">${escapeHtml(companyName)}</div>
          <div class="account-email truncate">${escapeHtml(email)}</div>
          <button class="btn btn-ghost btn-sm mt-2" onclick="API.logout()">Log Out</button>
        </div>
      </aside>
    `;
  }

  // ── Header HTML ───────────────────────────────────────────────

  function renderHeader(title = 'Dashboard') {
    return `
      <header class="portal-header">
        <div class="header-title">${escapeHtml(title)}</div>
        <div class="header-actions">
          <a href="/portal/campaign-new.html" class="btn btn-primary btn-sm">+ New Campaign</a>
        </div>
      </header>
    `;
  }

  // ── Full Page Shell ───────────────────────────────────────────

  function renderShell(options = {}) {
    const { title = 'Dashboard', activePage = 'dashboard', content = '' } = options;
    return `
      <div class="portal-shell">
        ${renderSidebar(activePage)}
        <div class="portal-main">
          ${renderHeader(title)}
          <div class="portal-content">
            ${content}
          </div>
        </div>
      </div>
    `;
  }

  // ── Auth Guard ────────────────────────────────────────────────

  function requireAuth() {
    if (!API.isLoggedIn()) {
      window.location.href = '/portal/login.html';
      return false;
    }
    return true;
  }

  // ── Utility ───────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Public API ────────────────────────────────────────────────

  return {
    renderSidebar,
    renderHeader,
    renderShell,
    requireAuth,
    escapeHtml,
  };
})();
