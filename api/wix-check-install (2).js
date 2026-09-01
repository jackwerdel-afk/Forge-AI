// ── WIX CHECK INSTALL ──────────────────────────────────────
// Polls to check if a Wix app installation has been completed
// and linked to the agency's Forge AI account.
// Called every 3 seconds from forge-ai-wix.html after the
// agency opens the Wix install link.

'use strict';
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Verify session
    const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Check if the most recent install token for this user was marked as used
    const { data: installToken } = await sb.from('wix_install_tokens')
      .select('used, forge_user_id, site_url')
      .eq('forge_user_id', user.id)
      .eq('used', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!installToken) {
      // Not completed yet — keep polling
      return res.status(200).json({ completed: false });
    }

    // Install completed — get the newly linked site
    const { data: site } = await sb.from('user_sites')
      .select('site_id, url, platform')
      .eq('user_id', user.id)
      .eq('platform', 'wix')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return res.status(200).json({
      completed: true,
      siteUrl: site ? site.url : installToken.site_url,
      siteId: site ? site.site_id : null
    });

  } catch(err) {
    console.error('wix-check-install error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
