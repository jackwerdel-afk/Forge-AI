const { createClient } = require('@supabase/supabase-js');
const Sentry = require("@sentry/node");
Sentry.init({ dsn: "https://b906d32b0d61fe5bf13af61abaf76755@o4511809521713152.ingest.us.sentry.io/4511813224431616", environment: "production" });

// ── RATE LIMITING ──────────────────────────────────────────
const rateLimitStore = new Map();
function rateLimit(userId) {
  const now = Date.now();
  const window = 3600000; // 1 hour
  const max = 100; // 100 requests per hour
  const record = rateLimitStore.get(userId);
  if (!record || now > record.resetAt) {
    rateLimitStore.set(userId, { count: 1, resetAt: now + window });
    return { allowed: true, remaining: max - 1, resetAt: now + window };
  }
  if (record.count >= max) {
    return { allowed: false, remaining: 0, resetAt: record.resetAt };
  }
  record.count++;
  return { allowed: true, remaining: max - record.count, resetAt: record.resetAt };
}

// ── TOKEN VALIDATION ───────────────────────────────────────
async function validateToken(sb, req) {
  const auth = req.headers.authorization || req.headers['x-api-key'];
  if (!auth) return null;
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;

  const { data: tokenData } = await sb.from('agency_tokens')
    .select('user_id').eq('token', token).maybeSingle();
  if (!tokenData) return null;

  // Check plan — API access requires Agency or Enterprise
  const { data: { users } } = await sb.auth.admin.listUsers({ perPage: 1000 });
  const user = users && users.find(u => u.id === tokenData.user_id);
  if (!user) return null;

  const { data: sub } = await sb.from('subscriptions')
    .select('plan').eq('email', user.email).maybeSingle();
  const plan = (sub && sub.plan) ? sub.plan : 'free';

  if (plan !== 'agency' && plan !== 'enterprise') {
    return { error: 'API access requires the Agency or Enterprise plan.', plan };
  }

  return { userId: tokenData.user_id, user, plan, token };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Validate token
    const auth = await validateToken(sb, req);
    if (!auth) return res.status(401).json({ error: 'Invalid or missing API token. Get yours from the Forge AI dashboard.' });
    if (auth.error) return res.status(403).json({ error: auth.error, upgrade: 'https://forgeai-wgs.com/forge-ai-billing.html' });

    // Rate limiting
    const rl = rateLimit(auth.userId);
    res.setHeader('X-RateLimit-Limit', '100');
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(rl.resetAt / 1000)));
    if (!rl.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded. 100 requests per hour.',
        resetAt: new Date(rl.resetAt).toISOString()
      });
    }

    // Route by path and method
    const url = req.url || '';
    const path = url.split('?')[0].replace(/^\/api\/forge-api\/?/, '');
    const method = req.method;

    // ── GET /sites ──────────────────────────────────────────
    if ((path === 'sites' || path === '') && method === 'GET') {
      const { data: sites } = await sb.from('user_sites')
        .select('site_id, name, url, platform, score, last_scanned, last_result, client_name, client_email')
        .eq('user_id', auth.userId)
        .order('name');

      return res.status(200).json({
        success: true,
        count: (sites || []).length,
        sites: (sites || []).map(s => ({
          id: s.site_id,
          name: s.name || s.url,
          url: s.url,
          platform: s.platform || 'other',
          score: s.score,
          grade: s.score >= 90 ? 'A' : s.score >= 80 ? 'B' : s.score >= 70 ? 'C' : s.score >= 60 ? 'D' : s.score ? 'F' : null,
          lastScanned: s.last_scanned,
          client: s.client_name ? { name: s.client_name, email: s.client_email } : null,
        }))
      });
    }

    // ── GET /sites/:url ─────────────────────────────────────
    if (path.startsWith('sites/') && method === 'GET') {
      const siteUrl = decodeURIComponent(path.replace('sites/', ''));
      const { data: site } = await sb.from('user_sites')
        .select('site_id, name, url, platform, score, last_scanned, last_result, client_name, client_email, score_history')
        .eq('user_id', auth.userId)
        .eq('url', siteUrl)
        .maybeSingle();

      if (!site) return res.status(404).json({ error: 'Site not found in your account.' });

      // Parse issues from last_result
      let issues = [];
      try {
        const result = typeof site.last_result === 'string' ? JSON.parse(site.last_result) : site.last_result;
        issues = result?.issues || [];
      } catch(e) {}

      return res.status(200).json({
        success: true,
        site: {
          id: site.site_id,
          name: site.name || site.url,
          url: site.url,
          platform: site.platform || 'other',
          score: site.score,
          grade: site.score >= 90 ? 'A' : site.score >= 80 ? 'B' : site.score >= 70 ? 'C' : site.score >= 60 ? 'D' : site.score ? 'F' : null,
          lastScanned: site.last_scanned,
          client: site.client_name ? { name: site.client_name, email: site.client_email } : null,
          issues: issues.slice(0, 20).map(i => ({
            type: i.type || i.issue,
            severity: i.severity || 'medium',
            description: i.description || i.message || '',
          })),
          scoreHistory: (site.score_history || []).slice(-10),
        }
      });
    }

    // ── POST /scan ──────────────────────────────────────────
    if (path === 'scan' && method === 'POST') {
      const { url: siteUrl } = req.body || {};
      if (!siteUrl) return res.status(400).json({ error: 'url is required in request body.' });

      // Verify site belongs to this user
      const { data: site } = await sb.from('user_sites')
        .select('site_id, url').eq('user_id', auth.userId).eq('url', siteUrl).maybeSingle();
      if (!site) return res.status(404).json({ error: 'Site not found in your account.' });

      // Trigger scan asynchronously
      res.status(202).json({
        success: true,
        message: 'Scan triggered. Results will be available shortly.',
        siteId: site.site_id,
        url: siteUrl
      });

      // Fire scan after responding
      try {
        await fetch('https://forgeai-wgs.com/api/scan', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '')
          },
          body: JSON.stringify({ url: siteUrl, userId: auth.userId, siteId: site.site_id })
        });
      } catch(e) { console.log('Scan trigger error:', e.message); }
      return;
    }

    // ── GET /reports ────────────────────────────────────────
    if (path === 'reports' && method === 'GET') {
      const { data: reports } = await sb.from('client_reports')
        .select('id, site_name, site_url, client_name, client_email, score, grade, sent_at')
        .eq('user_id', auth.userId)
        .order('sent_at', { ascending: false })
        .limit(50);

      return res.status(200).json({
        success: true,
        count: (reports || []).length,
        reports: reports || []
      });
    }

    // ── POST /report/send ───────────────────────────────────
    if (path === 'report/send' && method === 'POST') {
      const { url: siteUrl, clientEmail, clientName } = req.body || {};
      if (!siteUrl || !clientEmail) return res.status(400).json({ error: 'url and clientEmail are required.' });

      // Validate email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(clientEmail)) return res.status(400).json({ error: 'Invalid clientEmail format.' });

      // Get site data
      const { data: site } = await sb.from('user_sites')
        .select('site_id, name, url, score').eq('user_id', auth.userId).eq('url', siteUrl).maybeSingle();
      if (!site) return res.status(404).json({ error: 'Site not found in your account.' });

      // Get agency name
      const agencyName = (auth.user.user_metadata && auth.user.user_metadata.agency_name) || 'Forge AI';

      // Get or create portal link
      const { data: portal } = await sb.from('client_portals')
        .select('token').eq('user_id', auth.userId).eq('site_url', siteUrl).maybeSingle();
      const portalLink = portal ? 'https://forgeai-wgs.com/forge-ai-client.html?token=' + portal.token : 'https://forgeai-wgs.com';

      // Send report
      const sendRes = await fetch('https://forgeai-wgs.com/api/send-client-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientEmail, clientName: clientName || '',
          siteName: site.name || siteUrl,
          siteUrl, score: site.score,
          portalLink, agencyName,
          summary: '', userId: auth.userId, siteId: site.site_id
        })
      });

      const sendData = await sendRes.json();
      if (!sendRes.ok) return res.status(500).json({ error: sendData.error || 'Failed to send report.' });

      return res.status(200).json({ success: true, message: 'Report sent successfully.', to: clientEmail });
    }

    // ── 404 ─────────────────────────────────────────────────
    return res.status(404).json({
      error: 'Endpoint not found.',
      availableEndpoints: [
        'GET  /api/forge-api/sites',
        'GET  /api/forge-api/sites/:url',
        'POST /api/forge-api/scan',
        'GET  /api/forge-api/reports',
        'POST /api/forge-api/report/send',
      ]
    });

  } catch(err) {
    Sentry.captureException(err);
    console.error('forge-api error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};
