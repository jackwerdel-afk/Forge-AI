const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { forgeToken, webflowToken, sites } = req.body;
  if (!forgeToken || !sites) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: agency, error: agencyError } = await sb
      .from('agency_tokens')
      .select('user_id')
      .eq('token', forgeToken)
      .single();

    if (agencyError || !agency) {
      return res.status(401).json({ error: 'Invalid Forge AI token' });
    }

    const siteRecords = sites.map(s => ({
      user_id: agency.user_id,
      url: s.customDomain || s.previewUrl || `https://${s.name}.webflow.io`,
      name: s.displayName || s.name,
      schedule: 'daily',
      active: true,
      platform: 'webflow',
      platform_site_id: s.id,
      platform_token: webflowToken
    }));

    const { error: saveError } = await sb
      .from('scheduled_sites')
      .upsert(siteRecords, { onConflict: 'user_id,url' });

    if (saveError) throw saveError;

    return res.status(200).json({
      success: true,
      connected: sites.length
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
