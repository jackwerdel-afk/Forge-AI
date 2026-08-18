const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── ENCRYPTION ─────────────────────────────────────────────
// Uses the same key and algorithm as agent-deploy.js decrypt()
// so credentials saved here can be read there without changes.
function encrypt(text) {
  try {
    const key = crypto.scryptSync(
      process.env.WP_ENCRYPTION_KEY || process.env.CRON_SECRET || 'ForgeAI2026!',
      'salt',
      32
    );
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch(e) {
    console.error('Encryption error:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://forgeai-wgs.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { action, apiKey, accountId, token, siteIds } = body;

    if (!apiKey || !accountId) {
      return res.status(400).json({ error: 'API key and Account ID are required' });
    }

    // Validate Forge AI agency token
    if (!token) return res.status(401).json({ error: 'Forge AI token is required' });
    const { data: tokenData, error: tokenError } = await sb
      .from('agency_tokens')
      .select('user_id')
      .eq('token', token)
      .maybeSingle();
    if (tokenError || !tokenData) {
      return res.status(401).json({ error: 'Invalid Forge AI token' });
    }
    const userId = tokenData.user_id;

    // ── ACTION: LIST SITES ─────────────────────────────────
    if (action === 'list') {
      const wixRes = await fetch('https://www.wixapis.com/site-list/v2/sites/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': apiKey,
          'wix-account-id': accountId
        },
        body: JSON.stringify({
          query: {
            paging: { limit: 100, offset: 0 }
          }
        })
      });

      if (!wixRes.ok) {
        const errData = await wixRes.json().catch(() => ({}));
        if (wixRes.status === 401 || wixRes.status === 403) {
          return res.status(401).json({ error: 'Invalid API key or Account ID. Make sure you are using an Enterprise or Studio account API key.' });
        }
        if (wixRes.status === 404) {
          return res.status(404).json({ error: 'No sites found. Check your Account ID is correct.' });
        }
        return res.status(400).json({ error: errData.message || 'Failed to connect to Wix. Please check your credentials.' });
      }

      const wixData = await wixRes.json();
      const sites = (wixData.sites || []).map(function(site) {
        return {
          siteId: site.id,
          name: site.displayName || site.name || 'Untitled Site',
          url: site.url || (site.domains && site.domains[0]) || null,
          status: site.status || 'PUBLISHED'
        };
      }).filter(function(s) { return s.url; });

      if (sites.length === 0) {
        return res.status(200).json({ sites: [], message: 'No published sites found on this account.' });
      }

      console.log('Wix sites found:', sites.length, 'for user:', userId);
      return res.status(200).json({ sites: sites, total: sites.length });
    }

    // ── ACTION: ADD SITES ──────────────────────────────────
    if (action === 'add') {
      if (!siteIds || !Array.isArray(siteIds) || siteIds.length === 0) {
        return res.status(400).json({ error: 'No sites selected' });
      }

      // Get the full site list again to match IDs to URLs
      const wixRes = await fetch('https://www.wixapis.com/site-list/v2/sites/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': apiKey,
          'wix-account-id': accountId
        },
        body: JSON.stringify({ query: { paging: { limit: 100, offset: 0 } } })
      });

      if (!wixRes.ok) {
        return res.status(400).json({ error: 'Failed to fetch sites from Wix' });
      }

      const wixData = await wixRes.json();
      const allSites = wixData.sites || [];
      const selected = allSites.filter(function(s) { return siteIds.includes(s.id); });

      const added = [];
      const failed = [];

      for (const site of selected) {
        const url = site.url || (site.domains && site.domains[0]);
        if (!url) { failed.push(site.displayName || site.id); continue; }

        const cleanUrl = url.replace(/\/$/, '');
        const siteId = 'wix_' + Buffer.from(cleanUrl).toString('base64').slice(0, 16).replace(/[+/=]/g, '0');

        // Upsert into user_sites
        const { error: upsertErr } = await sb.from('user_sites').upsert({
          site_id: siteId,
          user_id: userId,
          url: cleanUrl,
          name: site.displayName || site.name || cleanUrl,
          platform: 'wix',
          score: null,
          grade: null,
          last_scan: null,
          scan_count: 0,
          auto_scan: true,
          issues: [],
          score_history: []
        }, { onConflict: 'user_id,url' });

        if (upsertErr) {
          console.error('Upsert error for', cleanUrl, upsertErr.message);
          failed.push(site.displayName || cleanUrl);
          continue;
        }

        // Add to scheduled_sites
        await sb.from('scheduled_sites').upsert({
          site_id: siteId,
          user_id: userId,
          url: cleanUrl,
          platform: 'wix',
          auto_scan: true,
          scan_count: 0,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,site_id' });

        // ── SAVE ENCRYPTED CREDENTIALS ─────────────────────
        // Store encrypted API key + plaintext account ID so
        // Forge Agent can make approved mutations later.
        // The API key is encrypted — account ID is not a secret.
        try {
          const encryptedApiKey = encrypt(apiKey);
          if (encryptedApiKey) {
            await sb.from('platform_credentials').upsert({
              user_id: userId,
              site_id: siteId,
              platform: 'wix',
              credentials: {
                encrypted_api_key: encryptedApiKey,
                account_id: accountId,
                // wix_site_id is the Wix-internal site ID required for
                // the wix-site-id header in all site-level Wix API calls
                wix_site_id: site.id || null
              }
            }, { onConflict: 'user_id,site_id' });
            console.log('Wix credentials saved for site:', siteId, 'wix_site_id:', site.id);
          } else {
            console.error('Encryption failed for site:', siteId, '— credentials not saved');
          }
        } catch(credErr) {
          // Non-fatal — site is still added, just without mutation capability
          console.error('Credential save error for', cleanUrl, credErr.message);
        }

        // Trigger immediate scan — await so Vercel doesn't kill it
        try {
          await fetch('https://forgeai-wgs.com/api/scheduled-scan', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '')
            },
            body: JSON.stringify({ singleSite: { url: cleanUrl, user_id: userId, site_id: siteId } })
          });
        } catch(e) { console.log('Scan trigger error:', e.message); }

        added.push(site.displayName || cleanUrl);
      }

      console.log('Wix sites added:', added.length, 'failed:', failed.length, 'for user:', userId);
      return res.status(200).json({
        success: true,
        added: added.length,
        failed: failed.length,
        message: added.length + ' site' + (added.length !== 1 ? 's' : '') + ' added successfully.'
      });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch(err) {
    console.error('wix-connect error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
