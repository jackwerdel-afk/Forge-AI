// ── WIX REDIRECT ───────────────────────────────────────────
// Receives the browser redirect from Wix after a user installs
// the Forge AI app from the Wix App Market.
//
// Wix redirects to: /api/wix-redirect?token=<forge-token>&instanceId=<wix-instanceId>
//
// Flow:
//   1. Read ?token= (Forge install token we embedded in the redirect URL)
//   2. Read ?instanceId= (Wix instance ID, sent by Wix in the redirect)
//   3. Store instanceId on the wix_install_tokens row
//   4. wix-install.js (server webhook) can now match by instanceId
//   5. Return a small HTML page that closes the tab / shows success
//
// Security:
//   - No auth required — token is a one-time UUID, not a session credential
//   - We only write instanceId onto an existing token row (no new data created)
//   - Token must exist and be unused to accept the update

'use strict';
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  // Wix sends a GET redirect to this URL
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const forgeToken = req.query && req.query.token ? req.query.token.trim() : null;
  const instanceId = req.query && req.query.instanceId ? req.query.instanceId.trim() : null;

  if (!forgeToken || !instanceId) {
    console.warn('wix-redirect: missing token or instanceId', { forgeToken: !!forgeToken, instanceId: !!instanceId });
    return res.status(400).send(closePage('Missing required parameters.'));
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Find the token row and stamp instanceId onto it
    const { data: tokenRow, error: findErr } = await sb
      .from('wix_install_tokens')
      .select('id, forge_user_id, used')
      .eq('token', forgeToken)
      .maybeSingle();

    if (findErr || !tokenRow) {
      console.warn('wix-redirect: token not found:', forgeToken.substring(0, 8));
      return res.status(200).send(closePage('Install token not found. Please try again from Forge AI.'));
    }

    if (tokenRow.used) {
      // Already completed — that is fine, just close
      console.log('wix-redirect: token already used — closing tab');
      return res.status(200).send(closePage(null, true));
    }

    // Store instanceId so wix-install.js (server webhook) can match this install
    const { error: updateErr } = await sb
      .from('wix_install_tokens')
      .update({ instance_id: instanceId })
      .eq('id', tokenRow.id);

    if (updateErr) {
      console.error('wix-redirect: failed to store instanceId:', updateErr.message);
      // Non-fatal — webhook will still try to match, log for debugging
    } else {
      console.log('wix-redirect: instanceId stored for user:', tokenRow.forge_user_id, 'instance:', instanceId.substring(0, 8));
    }

  } catch(err) {
    console.error('wix-redirect error:', err.message);
    // Still show success page — worst case wix-install.js handles it via pending
  }

  // Return page that closes the tab and signals completion
  return res.status(200).send(closePage(null, true));
};

function closePage(errorMsg, success) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Forge AI — Installing...</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f1117; color: #e2e8f0; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; }
    .card { text-align: center; padding: 40px; max-width: 360px; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h2 { margin: 0 0 8px; font-size: 18px; font-weight: 700; }
    p { margin: 0; font-size: 14px; color: #94a3b8; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    ${errorMsg
      ? `<div class="icon">⚠️</div><h2>Something went wrong</h2><p>${errorMsg}</p>`
      : `<div class="icon">✅</div><h2>App installed!</h2><p>You can close this tab. Your Forge AI dashboard will update automatically.</p>`
    }
  </div>
  <script>
    // Signal the opener (forge-ai-wix.html) that install is complete
    if (window.opener) {
      try { window.opener.postMessage({ type: 'wix_install_complete' }, '*'); } catch(e) {}
    }
    // Close the tab after a short delay
    setTimeout(function() { window.close(); }, ${success ? 1500 : 4000});
  </script>
</body>
</html>`;
}
