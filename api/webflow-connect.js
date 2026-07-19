const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://forgeai-wgs.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, sites } = req.body || {};

    if (!token) return res.status(401).json({ error: 'Forge AI token required' });
    if (!sites || !Array.isArray(sites) || sites.length === 0) {
      return res.status(400).json({ error: 'No sites selected' });
    }

    // Validate Forge AI token
    const { data: tokenData, error: tokenError } = await sb
      .from('agency_tokens')
      .select('user_id')
      .eq('token', token)
      .maybeSingle();

    if (tokenError || !tokenData) {
      return res.status(401).json({ error: 'Invalid Forge AI token' });
    }
    const userId = tokenData.user_id;

    const added = [];
    const failed = [];

    for (const site of sites) {
      if (!site.url) { failed.push(site.name || site.webflowId); continue; }

      const cleanUrl = site.url.replace(/\/$/, '');
      const siteId = 'wf_' + Buffer.from(cleanUrl).toString('base64').slice(0, 16).replace(/[+/=]/g, '0');

      const { error: upsertErr } = await sb.from('user_sites').upsert({
        site_id: siteId,
        user_id: userId,
        url: cleanUrl,
        name: site.name || cleanUrl,
        platform: 'webflow',
        score: null,
        grade: null,
        last_scan: null,
        scan_count: 0,
        auto_scan: true,
        issues: [],
        score_history: []
      }, { onConflict: 'user_id,url' });

      if (upsertErr) {
        console.error('Upsert error:', cleanUrl, upsertErr.message);
        failed.push(site.name || cleanUrl);
        continue;
      }

      // Add to scheduled_sites
      await sb.from('scheduled_sites').upsert({
        site_id: siteId,
        user_id: userId,
        url: cleanUrl,
        platform: 'webflow',
        auto_scan: true,
        scan_count: 0,
        created_at: new Date().toISOString()
      }, { onConflict: 'user_id,url' });

      // Trigger immediate scan
      fetch('https://forgeai-wgs.com/api/scheduled-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '')
        },
        body: JSON.stringify({ singleSite: { url: cleanUrl, user_id: userId, site_id: siteId } })
      }).catch(function(e) { console.log('Scan trigger error:', e.message); });

      added.push(site.name || cleanUrl);
    }

    console.log('Webflow sites added:', added.length, 'failed:', failed.length, 'for user:', userId);
    return res.status(200).json({
      success: true,
      added: added.length,
      failed: failed.length,
      message: added.length + ' site' + (added.length !== 1 ? 's' : '') + ' added successfully.'
    });

  } catch(err) {
    console.error('webflow-connect error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
