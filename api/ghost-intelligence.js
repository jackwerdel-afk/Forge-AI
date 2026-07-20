const { createClient } = require('@supabase/supabase-js');
const { runGhostScan } = require('./ghost-scan');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://forgeai-wgs.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { siteId, token } = req.body || {};
    if (!siteId || !token) return res.status(400).json({ error: 'siteId and token required' });

    // Validate token
    const { data: tokenData } = await sb
      .from('agency_tokens').select('user_id').eq('token', token).maybeSingle();
    if (!tokenData) return res.status(401).json({ error: 'Invalid token' });
    const userId = tokenData.user_id;

    // Get site URL
    const { data: site } = await sb
      .from('user_sites').select('url, platform').eq('site_id', siteId).eq('user_id', userId).maybeSingle();
    if (!site) return res.status(404).json({ error: 'Site not found' });
    if (site.platform !== 'ghost') return res.status(400).json({ error: 'Not a Ghost site' });

    // Get credentials
    const { data: creds } = await sb
      .from('platform_credentials').select('credentials').eq('site_id', siteId).eq('user_id', userId).maybeSingle();
    if (!creds || !creds.credentials || !creds.credentials.api_key) {
      return res.status(400).json({ error: 'No Ghost API key found for this site. Please reconnect.' });
    }

    const apiKey = creds.credentials.api_key;

    // Run Ghost scan
    console.log('Running Ghost intelligence scan for:', site.url);
    const results = await runGhostScan(site.url, apiKey);

    if (results.error) {
      return res.status(400).json({ error: 'Ghost API error: ' + results.error });
    }

    // Save results to user_sites ghost_intelligence field
    await sb.from('user_sites').update({
      ghost_intelligence: results,
      ghost_intelligence_updated: new Date().toISOString()
    }).eq('site_id', siteId).eq('user_id', userId);

    console.log('Ghost intelligence scan complete:', site.url, 'issues:', results.issues.length);
    return res.status(200).json({ success: true, results: results });

  } catch(err) {
    console.error('ghost-intelligence error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
