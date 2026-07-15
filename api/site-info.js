const { createClient } = require('@supabase/supabase-js');

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

    // Find user by agency token from agency_tokens table
    const { data: tokenRecord } = await sb.from('agency_tokens')
      .select('user_id')
      .eq('token', token)
      .maybeSingle();

    if (!tokenRecord) return res.status(404).json({ error: 'Agency not found' });

    const userId = tokenRecord.user_id;

    // Find the site by URL if provided
    let site = null;
    if (siteUrl) {
      try {
        const hostname = new URL(siteUrl).hostname;
        const { data: userSite } = await sb.from('user_sites')
          .select('id, user_id, url')
          .eq('user_id', userId)
          .ilike('url', '%' + hostname + '%')
          .maybeSingle();
        site = userSite;
      } catch(e) {}
    }

    return res.status(200).json({
      success: true,
      siteId: site ? site.id : null,
      userId: userId,
      url: site ? site.url : siteUrl
    });

  } catch(e) {
    console.error('site-info error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
