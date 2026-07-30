const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const Sentry = require("@sentry/node");
Sentry.init({ dsn: "https://b906d32b0d61fe5bf13af61abaf76755@o4511809521713152.ingest.us.sentry.io/4511813224431616", environment: "production" });

function decrypt(text) {
  try {
    const key = crypto.scryptSync(process.env.WP_ENCRYPTION_KEY || process.env.CRON_SECRET || 'ForgeAI2026!', 'salt', 32);
    const [ivHex, encrypted] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch(e) { return null; }
}

async function wpFetch(siteUrl, credentials, endpoint) {
  const baseUrl = siteUrl.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/wp-json/wp/v2/${endpoint}`, {
    headers: {
      'Authorization': 'Basic ' + credentials,
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`WP API error: ${res.status}`);
  return res.json();
}

async function wpFetchRoot(siteUrl, credentials) {
  const baseUrl = siteUrl.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/wp-json/`, {
    headers: { 'Authorization': 'Basic ' + credentials },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`WP API error: ${res.status}`);
  return res.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { siteUrl, dataType } = req.body;
    if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });

    // Get credentials — check team member's agency owner if needed
    let credUserId = user.id;
    const { data: memberData } = await sb.from('team_members')
      .select('agency_id').eq('user_id', user.id).eq('status', 'active').maybeSingle();
    if (memberData && memberData.agency_id) credUserId = memberData.agency_id;

    const { data: siteData } = await sb.from('user_sites')
      .select('wp_credentials, wp_username, score, last_result, name, platform')
      .eq('user_id', credUserId)
      .eq('url', siteUrl)
      .maybeSingle();

    if (!siteData || !siteData.wp_credentials) {
      return res.status(404).json({ error: 'No WordPress credentials found for this site.' });
    }

    // Decrypt credentials
    const decrypted = decrypt(siteData.wp_credentials);
    if (!decrypted) return res.status(500).json({ error: 'Failed to decrypt credentials.' });

    // credentials are stored as base64(username:password)
    const credentials = decrypted;

    // Fetch requested data type
    let data = {};

    if (dataType === 'overview' || !dataType) {
      // Fetch site root info, plugins, users, posts in parallel
      const [rootInfo, plugins, users, posts, pages, themes] = await Promise.allSettled([
        wpFetchRoot(siteUrl, credentials),
        wpFetch(siteUrl, credentials, 'plugins?per_page=100&context=edit'),
        wpFetch(siteUrl, credentials, 'users?per_page=100&context=edit'),
        wpFetch(siteUrl, credentials, 'posts?per_page=1&per_page=1'),
        wpFetch(siteUrl, credentials, 'pages?per_page=1'),
        wpFetch(siteUrl, credentials, 'themes?context=edit'),
      ]);

      data.siteInfo = rootInfo.status === 'fulfilled' ? {
        name: rootInfo.value.name,
        description: rootInfo.value.description,
        url: rootInfo.value.url,
        wpVersion: rootInfo.value.wp_json_version || null,
        timezone: rootInfo.value.timezone_string,
        language: rootInfo.value.language || 'en_US',
        adminEmail: rootInfo.value.admin_email || null,
      } : null;

      data.plugins = plugins.status === 'fulfilled' ? plugins.value.map(p => ({
        name: p.name,
        version: p.version,
        status: p.status,
        author: p.author_header || p.author,
        description: p.description?.raw?.substring(0, 120) || '',
        pluginUri: p.plugin_uri || null,
        requiresWP: p.requires_wp || null,
        testedWP: p.tested_up_to || null,
      })) : [];

      data.users = users.status === 'fulfilled' ? users.value.map(u => ({
        id: u.id,
        name: u.name,
        username: u.slug,
        email: u.email || null,
        roles: u.roles || [],
        registered: u.registered_date || null,
        avatar: u.avatar_urls?.['48'] || null,
      })) : [];

      data.themes = themes.status === 'fulfilled' ? themes.value.map(t => ({
        name: t.name?.raw || t.name,
        version: t.version,
        status: t.status,
        author: t.author?.raw || t.author,
        screenshot: t.screenshot || null,
        template: t.template || null,
      })) : [];

      // Get post/page counts from headers
      data.postCount = 0;
      data.pageCount = 0;
      if (posts.status === 'fulfilled') {
        // We need total from headers — do a separate head request
        try {
          const postRes = await fetch(`${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2/posts?per_page=1`, {
            headers: { 'Authorization': 'Basic ' + credentials },
            signal: AbortSignal.timeout(8000)
          });
          data.postCount = parseInt(postRes.headers.get('X-WP-Total') || '0');
        } catch(e) {}
      }
      if (pages.status === 'fulfilled') {
        try {
          const pageRes = await fetch(`${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2/pages?per_page=1`, {
            headers: { 'Authorization': 'Basic ' + credentials },
            signal: AbortSignal.timeout(8000)
          });
          data.pageCount = parseInt(pageRes.headers.get('X-WP-Total') || '0');
        } catch(e) {}
      }

      // Include Forge AI scan data
      data.forgeScore = siteData.score || null;
      data.siteName = siteData.name || siteUrl;

      console.log('WP data fetched for:', siteUrl, '| plugins:', data.plugins.length, '| users:', data.users.length);
    }

    return res.status(200).json({ success: true, data });

  } catch(err) {
    Sentry.captureException(err);
    console.error('wp-data error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
