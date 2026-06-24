// ── FORGE AI SHARED SIDEBAR ───────────────────────────────
// Include this script on every authenticated page.
// Usage: <script src="forge-ai-sidebar.js" data-active="dashboard"></script>

(async function() {
  const SUPABASE_URL = 'https://mybvzjcjfjytcfgitmpv.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15YnZ6amNqZmp5dGNmZ2l0bXB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MTE5MjgsImV4cCI6MjA5NDE4NzkyOH0.OHKGmKlyk86kdSXjFh5jVHqvMC-nPKhPkAtSraPVwEs';

  // Wait for supabase to be available
  let attempts = 0;
  while (typeof supabase === 'undefined' && attempts < 20) {
    await new Promise(r => setTimeout(r, 100));
    attempts++;
  }
  if (typeof supabase === 'undefined') return;

  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

  // Get active page from script tag data attribute
  const scriptTag = document.currentScript || document.querySelector('script[data-active]');
  const activePage = scriptTag ? scriptTag.getAttribute('data-active') : 'dashboard';

  // Find sidebar container
  const container = document.getElementById('sidebar-container');
  if (!container) return;

  // Nav items definition
  const navItems = [
    { key: 'dashboard',    href: 'forge-ai-dashboard.html',            icon: '⚡', label: 'Dashboard',   id: '' },
    { key: 'reports',      href: 'forge-ai-report.html',               icon: '📄', label: 'Reports',     id: '' },
    { key: 'alerts',       href: 'forge-ai-dashboard.html#alerts',     icon: '🔔', label: 'Alerts',      id: 'alerts-nav' },
    { key: 'connections',  href: 'forge-ai-dashboard.html#connections', icon: '🔗', label: 'Connections', id: 'connections-nav' },
    { key: 'team',         href: 'forge-ai-team.html',                 icon: '👥', label: 'Team',        id: 'team-nav' },
    { key: 'billing',      href: 'forge-ai-billing.html',              icon: '💳', label: 'Billing',     id: 'billing-nav' },
    { key: 'settings',     href: 'forge-ai-settings.html',             icon: '⚙️', label: 'Settings',    id: 'settings-nav' },
  ];

  // Build nav HTML — connections and team hidden by default, shown based on plan
  const navHTML = navItems.map(item => {
    const activeClass = item.key === activePage ? ' active' : '';
    const idAttr = item.id ? ` id="${item.id}"` : '';
    const hidden = (item.key === 'connections' || item.key === 'team') ? ' style="display:none"' : '';
    return `<a class="nav-item${activeClass}"${idAttr}${hidden} href="${item.href}">
        <span class="nav-item-icon">${item.icon}</span> ${item.label}
      </a>`;
  }).join('\n      ');

  // Inject sidebar HTML
  container.innerHTML = `
    <a href="forge-ai-dashboard.html" class="sidebar-logo">
      <img src="Powered by Werdel Global Systems.png" alt="Forge AI" 
           style="height:80px;width:auto;object-fit:contain;mix-blend-mode:screen;"
           onerror="this.style.display='none'">
    </a>
    <nav class="sidebar-nav">
      ${navHTML}
    </nav>
    <div class="sidebar-bottom">
      <div style="padding:12px 10px">
        <div style="font-size:10px;color:var(--muted2);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Agency</div>
        <div style="font-size:13px;font-weight:600;color:var(--text)" id="sb-agency-name">—</div>
        <div style="display:inline-block;margin-top:4px;padding:2px 8px;border-radius:100px;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase" id="sb-plan-badge">Free</div>
      </div>
      <button class="nav-item" onclick="window.sbSignOut()" style="color:var(--muted2);width:100%;text-align:left">
        <span class="nav-item-icon">→</span> Sign out
      </button>
    </div>`;

  // Sign out function
  window.sbSignOut = async function() {
    await sb.auth.signOut();
    window.location.href = 'forge-ai-login.html';
  };

  // Apply role and plan
  window.sbApplyRole = async function(userId, userEmail) {
    try {
      const hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
      const show = id => { const el = document.getElementById(id); if (el) el.style.display = 'flex'; };
      const planBadge = document.getElementById('sb-plan-badge');
      const agencyNameEl = document.getElementById('sb-agency-name');

      // Check if team member
      const { data: member } = await sb.from('team_members')
        .select('role, agency_id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle();

      if (member) {
        // Team member
        hide('team-nav'); hide('billing-nav'); hide('settings-nav'); hide('connections-nav');
        if (member.role !== 'developer') show('connections-nav');
        if (planBadge) { planBadge.textContent = member.role.charAt(0).toUpperCase() + member.role.slice(1); planBadge.style.background = 'rgba(34,201,122,0.1)'; planBadge.style.color = '#22c97a'; }
        if (agencyNameEl) agencyNameEl.textContent = 'Team Member';

        // Hide upgrade banner
        const banner = document.getElementById('plan-banner');
        if (banner) banner.style.display = 'none';

        return { role: member.role, agencyId: member.agency_id, isTeamMember: true, plan: 'agency' };
      } else {
        // Owner — load plan
        const { data: sub } = await sb.from('subscriptions')
          .select('plan, sites_limit')
          .eq('email', userEmail)
          .maybeSingle();

        const plan = (sub && sub.plan) ? sub.plan : 'free';
        const siteLimit = (sub && sub.sites_limit) ? sub.sites_limit : 3;
        const planColors = {
          free:       { bg: 'rgba(107,107,120,0.15)', color: '#70708a' },
          starter:    { bg: 'rgba(77,159,255,0.12)',  color: '#4d9fff' },
          agency:     { bg: 'rgba(34,201,122,0.12)',  color: '#22c97a' },
          enterprise: { bg: 'rgba(255,136,63,0.12)',  color: '#FF883F' },
        };
        const planNames = { free: 'Free', starter: 'Starter', agency: 'Agency', enterprise: 'Enterprise' };
        if (planBadge) {
          planBadge.textContent = planNames[plan] || 'Free';
          const c = planColors[plan] || planColors.free;
          planBadge.style.background = c.bg;
          planBadge.style.color = c.color;
        }

        // Store plan globally for other page logic
        window.FORGE_PLAN = plan;
        window.FORGE_SITES_LIMIT = siteLimit;

        if (plan === 'free') {
          hide('connections-nav'); hide('team-nav'); hide('alerts-nav');
        } else {
          show('connections-nav'); show('team-nav'); show('alerts-nav');
        }

        return { role: 'owner', agencyId: userId, isTeamMember: false, plan, siteLimit };
      }
    } catch(e) {
      console.log('Sidebar role error:', e.message);
      return { role: 'owner', agencyId: userId, isTeamMember: false, plan: 'free', siteLimit: 3 };
    }
  };

  // Set agency name in sidebar
  window.sbSetAgencyName = function(name) {
    const el = document.getElementById('sb-agency-name');
    if (el) el.textContent = name || '—';
  };

})();
