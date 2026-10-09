// ── WIX CHECK INSTALL ──────────────────────────────────────
// Polls to check if a specific Wix install token has been completed.
// Called every 3 seconds from forge-ai-wix.html after the agency
// opens the Wix install link.
//
// Polls the exact token UUID — zero false positives from old installs.

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

    const body = req.body || {};
    const installToken = body.installToken || null;

    if (!installToken) {
      return res.status(400).json({ error: 'installToken required' });
    }

    // Look up this exact token — only returns used=true when wix-install.js
    // has processed the webhook and marked it complete. No false positives.
    const { data: tokenRow } = await sb
      .from('wix_install_tokens')
      .select('used, site_url, forge_user_id')
      .eq('token', installToken)
      .eq('forge_user_id', user.id)
      .maybeSingle();

    if (!tokenRow) {
      return res.status(200).json({ completed: false });
    }

    if (!tokenRow.used) {
      return res.status(200).json({ completed: false });
    }

    console.log('wix-check-install: token completed for user:', user.id);
    return res.status(200).json({
      completed: true,
      siteUrl: tokenRow.site_url
    });

  } catch(err) {
    console.error('wix-check-install error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
