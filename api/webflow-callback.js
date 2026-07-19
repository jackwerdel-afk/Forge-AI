const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  const { code, state, error } = req.query;

  // Handle Webflow OAuth errors
  if (error) {
    return res.redirect(302, 'https://forgeai-wgs.com/forge-ai-webflow.html?error=' + encodeURIComponent(error));
  }

  if (!code) {
    return res.redirect(302, 'https://forgeai-wgs.com/forge-ai-webflow.html?error=no_code');
  }

  try {
    // Exchange code for access token
    // Webflow requires application/x-www-form-urlencoded not JSON
    const tokenParams = new URLSearchParams({
      client_id: process.env.WEBFLOW_CLIENT_ID,
      client_secret: process.env.WEBFLOW_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: 'https://forgeai-wgs.com/api/webflow-callback'
    });

    console.log('Exchanging code for token, client_id length:', (process.env.WEBFLOW_CLIENT_ID||'').length);
    let tokenRes, tokenText;
    try {
      tokenRes = await fetch('https://api.webflow.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString()
      });
      tokenText = await tokenRes.text();
      console.log('Token response status:', tokenRes.status, 'body:', tokenText.slice(0, 300));
    } catch(fetchErr) {
      console.error('Fetch error:', fetchErr.message);
      return res.redirect(302, 'https://forgeai-wgs.com/forge-ai-webflow.html?error=fetch_failed_' + encodeURIComponent(fetchErr.message));
    }

    if (!tokenRes.ok) {
      console.error('Token exchange failed:', tokenRes.status, tokenText);
      return res.redirect(302, 'https://forgeai-wgs.com/forge-ai-webflow.html?error=token_failed_' + tokenRes.status);
    }

    const tokenData = JSON.parse(tokenText);
    const accessToken = tokenData.access_token;
    console.log('Got access token:', accessToken ? 'yes' : 'no');

    // Fetch all sites from Webflow
    const sitesRes = await fetch('https://api.webflow.com/v2/sites', {
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'accept-version': '2.0.0'
      }
    });

    const sitesText = await sitesRes.text();
    console.log('Sites response status:', sitesRes.status, 'body:', sitesText.slice(0, 500));

    if (!sitesRes.ok) {
      console.error('Sites fetch failed:', sitesRes.status, sitesText);
      return res.redirect(302, 'https://forgeai-wgs.com/forge-ai-webflow.html?error=sites_failed');
    }

    const sitesData = JSON.parse(sitesText);
    console.log('Sites found:', (sitesData.sites || []).length, 'raw sites:', JSON.stringify(sitesData).slice(0, 300));
    const sites = (sitesData.sites || []).map(function(site) {
      // Get the best URL — custom domain first, then shortName-based default
      var url = null;
      if (site.customDomains && site.customDomains.length > 0) {
        var domain = site.customDomains[0];
        url = 'https://' + (domain.url || domain.name || domain);
      } else if (site.defaultDomain) {
        url = 'https://' + site.defaultDomain;
      } else if (site.shortName) {
        url = 'https://' + site.shortName + '.webflow.io';
      }
      return {
        webflowId: site.id,
        name: site.displayName || site.shortName || site.id,
        url: url,
        previewUrl: site.previewUrl || null
      };
    }).filter(function(s) { return s.url; });

    // Parse state to get Forge AI token
    var forgeToken = '';
    try {
      var stateData = JSON.parse(Buffer.from(state, 'base64').toString());
      forgeToken = stateData.token || '';
    } catch(e) {}

    // Redirect back to Webflow page with sites data
    var sitesEncoded = encodeURIComponent(JSON.stringify(sites));
    var tokenEncoded = encodeURIComponent(forgeToken);
    return res.redirect(302,
      'https://forgeai-wgs.com/forge-ai-webflow.html?sites=' + sitesEncoded + '&forge_token=' + tokenEncoded + '&success=1'
    );

  } catch(err) {
    console.error('webflow-callback error:', err.message);
    return res.redirect(302, 'https://forgeai-wgs.com/forge-ai-webflow.html?error=' + encodeURIComponent(err.message));
  }
};
