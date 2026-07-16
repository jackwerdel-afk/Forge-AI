const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { token, siteUrl, siteName, platform } = req.body;
    if (!token || !siteUrl) return res.status(400).json({ error: 'Missing token or siteUrl' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Find user by agency token
    const { data: tokenRecord } = await sb.from('agency_tokens')
      .select('user_id').eq('token', token).maybeSingle();

    if (!tokenRecord) return res.status(404).json({ error: 'Invalid agency token' });

    const userId = tokenRecord.user_id;

    // Check if site already exists
    const { data: existing } = await sb.from('user_sites')
      .select('id').eq('user_id', userId).eq('url', siteUrl).maybeSingle();

    if (existing) {
      return res.status(200).json({ success: true, siteId: existing.id, message: 'Site already registered' });
    }

    // Get user's plan to check site limit
    const { data: { users } } = await sb.auth.admin.listUsers();
    const user = users && users.find(u => u.id === userId);
    const { data: sub } = await sb.from('subscriptions')
      .select('plan').eq('email', user ? user.email : '').maybeSingle();
    const plan = sub && sub.plan ? sub.plan : 'free';
    const limits = { free: 1, starter: 5, agency: 20, enterprise: 999 };
    const limit = limits[plan] || 1;

    // Check site count
    const { count } = await sb.from('user_sites')
      .select('id', { count: 'exact', head: true }).eq('user_id', userId);

    if (count >= limit) {
      return res.status(200).json({ success: false, error: 'Site limit reached for your plan' });
    }

    // Add site to user_sites
    const siteId = require('crypto').randomUUID();
    const cleanUrl = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
    const now = new Date().toISOString();
    const hostname = new URL(siteUrl).hostname;

    const { error: insertErr } = await sb.from('user_sites').insert({
      id: siteId,
      user_id: userId,
      url: cleanUrl,
      name: siteName || hostname,
      platform: platform || 'wordpress',
      score: null,
      grade: null,
      last_scan: null,
      scan_count: 0,
      auto_scan: true,
      issues: [],
      score_history: []
    });

    if (insertErr) throw new Error(insertErr.message);

    // Also add to scheduled_sites for daily scanning
    await sb.from('scheduled_sites').upsert({
      user_id: userId,
      url: cleanUrl,
      name: siteName || hostname,
      platform: platform || 'wordpress',
      active: true,
      last_score: null,
      created_at: now
    }, { onConflict: 'user_id,url' });

    console.log(`Auto-added site ${cleanUrl} for user ${userId}`);

    // Trigger immediate scan via scheduled-scan with single site override
    try {
      fetch('https://forgeai-wgs.com/api/scheduled-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CRON_SECRET}`
        },
        body: JSON.stringify({ singleSite: { url: cleanUrl, user_id: userId, site_id: siteId } })
      }).catch(() => {});
      console.log(`Auto-scan triggered for ${cleanUrl}`);
    } catch(scanErr) {
      console.log('Auto-scan trigger failed (non-critical):', scanErr.message);
    }

    return res.status(200).json({ success: true, siteId, message: 'Site added and scan triggered' });

  } catch(e) {
    console.error('auto-add-site error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
