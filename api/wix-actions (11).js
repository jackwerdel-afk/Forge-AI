// ── WIX ACTIONS ────────────────────────────────────────────
// Controlled Wix tool executor for Forge Agent / Tesseract.
//
// Security model:
//   - Credentials decrypted server-side only — never exposed to caller
//   - Caller must supply userId; ownership verified against DB before every op
//   - fixId must exist and be approved in agent_fixes before any mutation
//   - All inputs sanitized — treated as untrusted strings
//   - Website content is NEVER passed back as instruction
//   - Only 5 explicit tools allowed — no arbitrary API execution
//   - All mutations: execute → verify → record
//
// Tools:
//   list_pages            — list static pages on the Wix site
//   get_seo_settings      — read title + meta description for one page
//   update_meta_description — write new meta description (requires approved fixId)
//   update_seo_title        — write new SEO title (requires approved fixId)
//   verify_change           — re-fetch and confirm a change took effect

'use strict';
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ── CONSTANTS ──────────────────────────────────────────────
const WIX_SEO_BASE = 'https://www.wixapis.com/seo-metatags-server/v1/item-seo-tags';
const WIX_PAGES_BASE = 'https://www.wixapis.com/urls-server/v2/published-site-urls';
const MAX_STRING_LEN = 300; // max chars accepted from caller for any string param
const ALLOWED_TOOLS = ['list_pages', 'get_seo_settings', 'update_meta_description', 'update_seo_title', 'verify_change'];
const MUTATION_TOOLS = ['update_meta_description', 'update_seo_title'];

// ── DECRYPT (mirrors agent-deploy.js) ─────────────────────
function decrypt(encryptedData) {
  try {
    const key = crypto.scryptSync(
      process.env.WP_ENCRYPTION_KEY || process.env.CRON_SECRET || 'ForgeAI2026!',
      'salt',
      32
    );
    const [ivHex, encrypted] = encryptedData.split(':');
    if (!ivHex || !encrypted) throw new Error('Invalid encrypted format');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    throw new Error('Credential decryption failed: ' + e.message);
  }
}

// ── SANITIZE ───────────────────────────────────────────────
// Treat all caller-supplied strings as untrusted.
// Strip control chars and enforce max length.
// Never used as AI instruction — only compared or sent to Wix API.
function sanitize(val, maxLen) {
  if (typeof val !== 'string') return '';
  return val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, maxLen || MAX_STRING_LEN);
}

// ── WIX API CALL ───────────────────────────────────────────
// All Wix API calls go through here.
// apiKey and wixSiteId are decrypted credentials — never logged.
async function wixApiCall(method, url, apiKey, wixSiteId, body) {
  const headers = {
    'Authorization': apiKey,
    'wix-site-id': wixSiteId,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── LOAD CREDENTIALS ──────────────────────────────────────
// Fetches and decrypts credentials for a site.
// Verifies userId owns the site before loading.
async function loadCredentials(sb, userId, siteId) {
  // 1. Verify ownership
  const { data: site } = await sb.from('user_sites')
    .select('site_id, user_id')
    .eq('site_id', siteId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!site) throw new Error('Site not found or access denied');

  // 2. Load platform_credentials
  const { data: cred } = await sb.from('platform_credentials')
    .select('credentials')
    .eq('user_id', userId)
    .eq('site_id', siteId)
    .eq('platform', 'wix')
    .maybeSingle();

  if (!cred || !cred.credentials) throw new Error('No Wix credentials found for this site. Please reconnect via the Wix connections page.');

  const { encrypted_api_key, account_id, wix_site_id } = cred.credentials;
  if (!encrypted_api_key) throw new Error('Wix API key not stored. Please reconnect via the Wix connections page.');
  if (!wix_site_id) throw new Error('Wix site ID not stored. Please reconnect via the Wix connections page.');

  const apiKey = decrypt(encrypted_api_key);
  return { apiKey, accountId: account_id, wixSiteId: wix_site_id };
}

// ── VERIFY FIX IS APPROVED ────────────────────────────────
// Mutations require an approved fix in agent_fixes.
async function verifyApprovedFix(sb, fixId, userId) {
  const { data: fix } = await sb.from('agent_fixes')
    .select('id, user_id, status, platform')
    .eq('id', fixId)
    .eq('user_id', userId)
    .eq('platform', 'wix')
    .eq('status', 'approved')
    .maybeSingle();

  if (!fix) throw new Error('Fix not found, not approved, or not owned by this user');
  return fix;
}

// ── TOOL: list_pages ──────────────────────────────────────
async function listPages(apiKey, wixSiteId) {
  // Use List Item SEO Tags with STATIC_PAGE type to get page IDs
  // This is the correct way per Wix docs: "Call List Item SEO Tags for an item type to discover the IDs"
  // Fetch published site URLs to get base URL
  const urlsRes = await fetch('https://www.wixapis.com/urls-server/v2/published-site-urls', {
    headers: { 'Authorization': apiKey, 'wix-site-id': wixSiteId, 'Content-Type': 'application/json' }
  });
  const urlsData = await urlsRes.json();
  const siteUrls = urlsData.urls || [];
  const primaryUrl = siteUrls.find(u => u.primary) || siteUrls[0];
  const siteBase = primaryUrl ? primaryUrl.url.replace(/\/$/, '') : null;
  if (!siteBase) throw new Error('Could not determine site URL');

  // Fetch pages-sitemap.xml directly (not the sitemap index)
  const pagesSitemapRes = await fetch(siteBase + '/pages-sitemap.xml');
  const pagesSitemapText = await pagesSitemapRes.text();
  console.log('Pages sitemap preview:', pagesSitemapText.substring(0, 600));

  // Extract page URLs from pages sitemap
  const locMatches = pagesSitemapText.match(/<loc>(.*?)<\/loc>/g) || [];
  const pageUrls = locMatches.map(m => m.replace(/<\/?loc>/g, '').trim());
  console.log('Page URLs found:', pageUrls.length, pageUrls.slice(0, 3));

  // Convert page URLs to slugs — these are the itemIds for STATIC_PAGE
  const pages = pageUrls.map(url => {
    const slug = url.replace(siteBase, '').replace(/^\//, '') || '';
    return {
      itemId: slug || 'home',
      name: sanitize(slug || 'home', 200),
      url: sanitize(url, 300)
    };
  });

  // For homepage, the URL path is empty — try empty string as itemId
  const finalPages = pages.map(p => ({
    ...p,
    itemId: p.url === siteBase || p.url === siteBase + '/' ? '' : p.itemId
  }));

  // Try each page's itemId against the SEO API to find valid ones
  // Start with homepage (empty string or known slug)
  for (const page of finalPages) {
    try {
      const testUrl = `${WIX_SEO_BASE}/STATIC_PAGE/${encodeURIComponent(page.itemId)}`;
      const testRes = await wixApiCall('GET', testUrl, apiKey, wixSiteId, null);
      console.log('SEO API test for itemId:', JSON.stringify(page.itemId), 'status:', testRes.status);
      if (testRes.ok) {
        // Extract the real internal itemId from the response
        const seoItems = testRes.data.itemSeoTags || [];
        const realId = seoItems.length > 0 ? seoItems[0].itemId : page.itemId;
        console.log('Valid itemId found:', JSON.stringify(page.itemId), '→ real itemId:', realId, 'data:', JSON.stringify(testRes.data).substring(0, 200));
        page.itemId = realId || page.itemId;
        page.valid = true;
      }
    } catch(e) {}
  }

  console.log('Pages built:', finalPages.length, finalPages.length > 0 ? JSON.stringify(finalPages[0]) : 'none');
  return { pages: finalPages, total: finalPages.length };
}

// ── TOOL: get_seo_settings ────────────────────────────────
async function getSeoSettings(apiKey, wixSiteId, itemId) {
  const cleanItemId = sanitize(itemId, 200);
  if (!cleanItemId) throw new Error('itemId is required');

  const url = `${WIX_SEO_BASE}/STATIC_PAGE/${encodeURIComponent(cleanItemId)}`;
  const { ok, status, data } = await wixApiCall('GET', url, apiKey, wixSiteId, null);

  if (!ok) throw new Error(`Wix SEO API error ${status}: ${data.message || 'Unknown error'}`);

  const tags = (data.itemSeoTags && data.itemSeoTags.tags) || [];
  const hasOverride = (data.itemSeoTags && data.itemSeoTags.hasOverride) || false;

  // Extract title and description from tags array
  // IMPORTANT: page content from tags is read programmatically — never passed to AI as instruction
  let title = null;
  let description = null;

  for (const tag of tags) {
    if (tag.type === 'title' && tag.children) {
      title = sanitize(tag.children, 300);
    }
    if (tag.type === 'meta' && tag.props && tag.props.name === 'description' && tag.props.content) {
      description = sanitize(tag.props.content, 300);
    }
  }

  return { itemId: cleanItemId, title, description, hasOverride, rawTagCount: tags.length };
}

// ── TOOL: update_meta_description ─────────────────────────
async function updateMetaDescription(apiKey, wixSiteId, itemId, newDescription, existingTitle) {
  const cleanItemId = sanitize(itemId, 200);
  const cleanDesc = sanitize(newDescription, 300);
  const cleanTitle = existingTitle ? sanitize(existingTitle, 300) : null;

  if (!cleanItemId) throw new Error('itemId is required');
  if (!cleanDesc) throw new Error('newDescription is required');
  if (cleanDesc.length < 10) throw new Error('Meta description too short (min 10 chars)');
  if (cleanDesc.length > 300) throw new Error('Meta description too long (max 300 chars)');

  // Build full tag set — must send complete tags array (Wix replaces, not merges)
  const tags = [];
  if (cleanTitle) {
    tags.push({ type: 'title', children: cleanTitle });
  }
  tags.push({
    type: 'meta',
    props: { name: 'description', content: cleanDesc }
  });

  const url = `${WIX_SEO_BASE}/STATIC_PAGE/${encodeURIComponent(cleanItemId)}`;
  const body = {
    itemSeoTags: { tags },
    fieldMask: 'tags',
    publish: true // publish to live site immediately
  };

  const { ok, status, data } = await wixApiCall('PATCH', url, apiKey, wixSiteId, body);
  if (!ok) throw new Error(`Wix SEO update error ${status}: ${data.message || 'Unknown error'}`);

  return { updated: true, itemId: cleanItemId };
}

// ── TOOL: update_seo_title ─────────────────────────────────
async function updateSeoTitle(apiKey, wixSiteId, itemId, newTitle, existingDescription) {
  const cleanItemId = sanitize(itemId, 200);
  const cleanTitle = sanitize(newTitle, 300);
  const cleanDesc = existingDescription ? sanitize(existingDescription, 300) : null;

  if (!cleanItemId) throw new Error('itemId is required');
  if (!cleanTitle) throw new Error('newTitle is required');
  if (cleanTitle.length < 5) throw new Error('SEO title too short (min 5 chars)');
  if (cleanTitle.length > 300) throw new Error('SEO title too long (max 300 chars)');

  const tags = [];
  tags.push({ type: 'title', children: cleanTitle });
  if (cleanDesc) {
    tags.push({ type: 'meta', props: { name: 'description', content: cleanDesc } });
  }

  const url = `${WIX_SEO_BASE}/STATIC_PAGE/${encodeURIComponent(cleanItemId)}`;
  const body = {
    itemSeoTags: { tags },
    fieldMask: 'tags',
    publish: true
  };

  const { ok, status, data } = await wixApiCall('PATCH', url, apiKey, wixSiteId, body);
  if (!ok) throw new Error(`Wix SEO title update error ${status}: ${data.message || 'Unknown error'}`);

  return { updated: true, itemId: cleanItemId };
}

// ── TOOL: verify_change ────────────────────────────────────
// Re-fetches SEO settings and confirms the expected value is present.
// This is mandatory after every mutation — Tesseract never reports
// success unless this returns verified: true.
async function verifyChange(apiKey, wixSiteId, itemId, field, expectedValue) {
  const cleanItemId = sanitize(itemId, 200);
  const cleanField = sanitize(field, 50); // 'description' or 'title'
  const cleanExpected = sanitize(expectedValue, 300);

  if (!cleanItemId || !cleanField || !cleanExpected) throw new Error('itemId, field, and expectedValue are required');
  if (!['description', 'title'].includes(cleanField)) throw new Error('field must be description or title');

  // Wait 1.5s for Wix to propagate the change
  await new Promise(r => setTimeout(r, 1500));

  const current = await getSeoSettings(apiKey, wixSiteId, cleanItemId);
  const actual = cleanField === 'description' ? current.description : current.title;

  // Compare programmatically — content never used as AI instruction
  const verified = actual === cleanExpected;

  return {
    verified,
    field: cleanField,
    expected: cleanExpected,
    actual: actual || null,
    itemId: cleanItemId
  };
}

// ── MAIN HANDLER ──────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const body = req.body || {};
    const { tool, userId, siteId, fixId, params } = body;

    // ── INPUT VALIDATION ──────────────────────────────────
    if (!tool || !userId || !siteId) {
      return res.status(400).json({ error: 'tool, userId, and siteId are required' });
    }

    if (!ALLOWED_TOOLS.includes(tool)) {
      return res.status(400).json({ error: `Unknown tool: ${tool}. Allowed: ${ALLOWED_TOOLS.join(', ')}` });
    }

    // Mutations require an approved fixId
    if (MUTATION_TOOLS.includes(tool)) {
      if (!fixId) return res.status(400).json({ error: 'fixId is required for mutation tools' });
      await verifyApprovedFix(sb, fixId, userId);
    }

    // ── LOAD CREDENTIALS ──────────────────────────────────
    // Ownership verified inside loadCredentials
    const { apiKey, wixSiteId } = await loadCredentials(sb, userId, siteId);

    // ── EXECUTE TOOL ──────────────────────────────────────
    let result;

    if (tool === 'list_pages') {
      result = await listPages(apiKey, wixSiteId);
    }

    else if (tool === 'get_seo_settings') {
      const itemId = sanitize((params && params.itemId) || '', 200);
      if (!itemId) return res.status(400).json({ error: 'params.itemId is required for get_seo_settings' });
      result = await getSeoSettings(apiKey, wixSiteId, itemId);
    }

    else if (tool === 'update_meta_description') {
      let itemId = sanitize((params && params.itemId) || '', 200);
      const newDescription = sanitize((params && params.newDescription) || '', 300);
      const existingTitle = sanitize((params && params.existingTitle) || '', 300);
      if (!newDescription) return res.status(400).json({ error: 'params.newDescription is required' });

      // If no itemId provided, call listPages to find the homepage
      if (!itemId) {
        const pagesResult = await listPages(apiKey, wixSiteId);
        console.log('listPages result:', JSON.stringify(pagesResult).substring(0, 300));
        const pages = pagesResult.pages || [];
        // Prefer the page marked valid (has SEO data) or the one with empty URL slug (homepage)
        const home = pages.find(p => p.valid) || pages.find(p => !p.itemId || p.itemId === 'home') || pages[0];
        if (!home || !home.itemId) return res.status(400).json({ error: 'Could not find homepage page ID. Please provide params.itemId manually.' });
        itemId = home.itemId;
        console.log('Auto-detected homepage itemId:', itemId);
      }

      // Execute
      result = await updateMetaDescription(apiKey, wixSiteId, itemId, newDescription, existingTitle);

      // Verify — mandatory
      const verification = await verifyChange(apiKey, wixSiteId, itemId, 'description', newDescription);
      result.verification = verification;

      // Record result in agent_fixes
      if (fixId) {
        const status = verification.verified ? 'deployed' : 'verify_failed';
        await sb.from('agent_fixes').update({
          status,
          deployed_at: new Date().toISOString(),
          result: {
            tool,
            itemId,
            field: 'description',
            before: verification.actual !== newDescription ? verification.actual : null,
            after: newDescription,
            verified: verification.verified
          }
        }).eq('id', fixId).eq('user_id', userId);
      }
    }

    else if (tool === 'update_seo_title') {
      let itemId = sanitize((params && params.itemId) || '', 200);
      const newTitle = sanitize((params && params.newTitle) || '', 300);
      const existingDescription = sanitize((params && params.existingDescription) || '', 300);
      if (!newTitle) return res.status(400).json({ error: 'params.newTitle is required' });

      // If no itemId provided, call listPages to find the homepage
      if (!itemId) {
        const pagesResult2 = await listPages(apiKey, wixSiteId);
        const pages2 = pagesResult2.pages || [];
        const home2 = pagesResult2.pages.find(p => p.valid) || pagesResult2.pages.find(p => !p.itemId || p.itemId === 'home') || pagesResult2.pages[0];
        if (!home2 || !home2.itemId) return res.status(400).json({ error: 'Could not find homepage page ID. Please provide params.itemId manually.' });
        itemId = home2.itemId;
        console.log('Auto-detected homepage itemId for title:', itemId);
      }

      // Execute
      result = await updateSeoTitle(apiKey, wixSiteId, itemId, newTitle, existingDescription);

      // Verify — mandatory
      const verification = await verifyChange(apiKey, wixSiteId, itemId, 'title', newTitle);
      result.verification = verification;

      // Record result in agent_fixes
      if (fixId) {
        const status = verification.verified ? 'deployed' : 'verify_failed';
        await sb.from('agent_fixes').update({
          status,
          deployed_at: new Date().toISOString(),
          result: {
            tool,
            itemId,
            field: 'title',
            before: verification.actual !== newTitle ? verification.actual : null,
            after: newTitle,
            verified: verification.verified
          }
        }).eq('id', fixId).eq('user_id', userId);
      }
    }

    else if (tool === 'verify_change') {
      const itemId = sanitize((params && params.itemId) || '', 200);
      const field = sanitize((params && params.field) || '', 50);
      const expectedValue = sanitize((params && params.expectedValue) || '', 300);
      if (!itemId || !field || !expectedValue) return res.status(400).json({ error: 'params.itemId, params.field, and params.expectedValue are required' });
      result = await verifyChange(apiKey, wixSiteId, itemId, field, expectedValue);
    }

    console.log(`wix-actions: ${tool} completed for user ${userId} site ${siteId} — verified: ${result && result.verification ? result.verification.verified : 'N/A'}`);
    return res.status(200).json({ success: true, result });

  } catch (e) {
    console.error('wix-actions error:', e.message);
    // Never expose credential details in error messages
    const safeMsg = e.message.replace(/apiKey|Authorization|Bearer/gi, '[REDACTED]');
    return res.status(500).json({ success: false, error: safeMsg });
  }
};
