const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // POST — generate a new client portal token
  if (req.method === 'POST') {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await sb.auth.getUser(token);
      if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

      const { siteUrl, siteName } = req.body;
      if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });

      // Generate unique token
      const portalToken = 'cp_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

      // Check if portal already exists for this site
      const { data: existing } = await sb.from('client_portals')
        .select('id, token')
        .eq('user_id', user.id)
        .eq('site_url', siteUrl)
        .eq('active', true)
        .maybeSingle();

      if (existing) {
        return res.status(200).json({ success: true, token: existing.token });
      }

      // Create new portal
      const { data, error } = await sb.from('client_portals').insert({
        user_id: user.id,
        site_url: siteUrl,
        site_name: siteName || siteUrl,
        token: portalToken,
        active: true
      }).select().single();

      if (error) throw error;

      return res.status(200).json({ success: true, token: data.token });
    } catch(e) {
      console.error('Client portal create error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // GET — fetch portal data by token
  if (req.method === 'GET') {
    try {
      const { token } = req.query;
      if (!token) return res.status(400).json({ error: 'Missing token' });

      // Look up portal
      const { data: portal, error: portalError } = await sb.from('client_portals')
        .select('*')
        .eq('token', token)
        .eq('active', true)
        .single();

      if (portalError || !portal) return res.status(404).json({ error: 'Portal not found' });

      // Get site data from user_sites
      let siteData = null;
      const { data: userSite } = await sb.from('user_sites')
        .select('*')
        .eq('user_id', portal.user_id)
        .eq('url', portal.site_url)
        .maybeSingle();

      if (userSite) {
        siteData = userSite;
      } else {
        // Try scheduled_sites
        const { data: schedSite } = await sb.from('scheduled_sites')
          .select('*')
          .eq('user_id', portal.user_id)
          .eq('url', portal.site_url)
          .maybeSingle();
        if (schedSite) siteData = schedSite;
      }

      if (!siteData) return res.status(404).json({ error: 'Site data not found' });

      // Get agency info
      const { data: agencyUser } = await sb.auth.admin.getUserById(portal.user_id);
      const agencyName = agencyUser?.user?.user_metadata?.agency_name || 'Your Agency';

      return res.status(200).json({
        success: true,
        portal: {
          siteName: portal.site_name || portal.site_url,
          siteUrl: portal.site_url,
          agencyName,
          score: siteData.score || siteData.last_score || null,
          grade: siteData.grade || null,
          lastScan: siteData.last_scan || siteData.last_scanned || null,
          scoreHistory: siteData.score_history || [],
          lastResult: siteData.last_result || null,
          platform: siteData.platform || null
        }
      });
    } catch(e) {
      console.error('Client portal fetch error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
