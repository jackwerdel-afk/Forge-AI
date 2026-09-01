// ── WIX GENERATE TOKEN ─────────────────────────────────────
// Creates a short-lived install token tied to a Forge AI user.
// Also stores the site URL entered by the agency before installing.
// wix-install.js reads the token + site_url to link the install
// to the correct Forge AI account without calling any Wix URL API.

'use strict';
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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

    // Get site URL from request body — entered by agency before clicking install
    const body = req.body || {};
    let siteUrl = body.siteUrl || null;

    // Validate and normalize URL
    if (!siteUrl) return res.status(400).json({ error: 'Site URL is required' });
    if (!siteUrl.startsWith('http')) siteUrl = 'https://' + siteUrl;
    siteUrl = siteUrl.replace(/\/$/, '').toLowerCase().trim();

    // Generate unique install token
    const installToken = crypto.randomUUID();

    // Save to DB with site_url — expires in 30 minutes
    const { error } = await sb.from('wix_install_tokens').insert({
      token: installToken,
      forge_user_id: user.id,
      site_url: siteUrl
    });

    if (error) {
      console.error('wix-generate-token error:', error.message);
      return res.status(500).json({ error: 'Could not generate install token' });
    }

    console.log('Wix install token generated for user:', user.id, 'site:', siteUrl);
    return res.status(200).json({ success: true, token: installToken });

  } catch(err) {
    console.error('wix-generate-token error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
