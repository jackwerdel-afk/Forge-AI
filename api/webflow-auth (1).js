// Webflow OAuth — Step 1: Redirect to Webflow authorization page
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://forgeai-wgs.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientId = process.env.WEBFLOW_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Webflow OAuth not configured' });

  // Get Forge AI token from query param to pass through state
  const forgeToken = req.query.token || '';
  const state = Buffer.from(JSON.stringify({ token: forgeToken, ts: Date.now() })).toString('base64');

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: 'https://forgeai-wgs.com/api/webflow-callback',
    state: state,
    scope: 'sites:read'
  });

  const authUrl = 'https://webflow.com/oauth/authorize?' + params.toString();
  res.redirect(302, authUrl);
};
