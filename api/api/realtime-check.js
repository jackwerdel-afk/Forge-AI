const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, url, pageTitle, issues, timestamp } = req.body;

  if (!token || !url || !issues) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: agency, error: agencyError } = await sb
      .from('agency_tokens')
      .select('user_id, user_email')
      .eq('token', token)
      .single();

    if (agencyError || !agency) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { error: saveError } = await sb
      .from('realtime_alerts')
      .insert({
        user_id: agency.user_id,
        url: url,
        page_title: pageTitle,
        issues: issues,
        critical_count: issues.filter(i => i.severity === 'critical').length,
        high_count: issues.filter(i => i.severity === 'high').length,
        medium_count: issues.filter(i => i.severity === 'medium').length,
        timestamp: timestamp || new Date().toISOString()
      });

    if (saveError) throw saveError;

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
