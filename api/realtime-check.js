const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  if (!body.token || !body.url || !body.issues) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: agency, error: agencyError } = await sb
      .from('agency_tokens')
      .select('user_id')
      .eq('token', body.token)
      .single();

    if (agencyError || !agency) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const issues = body.issues || [];

    // Real-time building alerts are ONLY for the editor sidebar
    // They should NEVER create dashboard notifications
    // Dashboard alerts only come from scheduled scans (score drops 10+ pts or new critical issues)

    return res.status(200).json({ success: true, issues });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
