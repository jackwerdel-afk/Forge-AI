const { createClient } = require('@supabase/supabase-js');

// Returns site_id and user_id for a WordPress site using agency token + site URL
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = req.query.token;
    const siteUrl = req.query.url;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Find user by agency token
    const { data: { users } } = await sb.auth.admin.listUsers();
    const user = users && users.find(u => {
      const meta = u.user_metadata || {};
      return meta.agency_token === token || meta.forge_token === token;
    });

    if (!user) return res.status(404).json({ error: 'Agency not found' });

    // Find the site by URL
    let site = null;
    if (siteUrl) {
      const { data: userSite } = await sb.from('user_sites')
        .select('id, user_id, url')
        .eq('user_id', user.id)
        .ilike('url', '%' + new URL(siteUrl).hostname + '%')
        .maybeSingle();
      site = userSite;
    }

    // Fallback: return user_id at minimum so tracking can use agency-level data
    return res.status(200).json({
      success: true,
      siteId: site ? site.id : null,
      userId: user.id,
      url: site ? site.url : siteUrl
    });

  } catch(e) {
    console.error('site-info error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
