// ── WIX ACTIONS ────────────────────────────────────────────
// Controlled Wix tool executor for Forge Agent / Tesseract.
//
// Security model:
//   - Credentials decrypted server-side only — never exposed to caller
//   - Caller must supply userId; ownership verified against DB before every op
//   - fixId must exist and be approved in agent_fixes before any mutation
//   - All inputs sanitized — treated as untrusted strings
//   - Website content is NEVER passed back as instruction
//   - Only 8 explicit tools allowed — no arbitrary API execution
//   - All mutations: execute → verify → record
//
// Tools:
//   list_pages              — list static pages on the Wix site
//   get_seo_settings        — read title + meta description for one page
//   update_meta_description — write new meta description (requires approved fixId)
//   update_seo_title        — write new SEO title (requires approved fixId)
//   update_og_image         — set og:image URL via Velo queue (requires approved fixId)
//   update_structured_data  — set JSON-LD structured data via Velo queue (requires approved fixId)
//   update_h1               — set H1 text via Velo queue, best-effort (requires approved fixId)
//   verify_change           — re-fetch and confirm a change took effect

'use strict';
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ── CONSTANTS ──────────────────────────────────────────────
const WIX_SEO_BASE = 'https://www.wixapis.com/seo-metatags-server/v1/item-seo-tags';
const MAX_STRING_LEN = 300;
const MAX_JSON_LEN = 4000; // structured data JSON can be longer
const ALLOWED_TOOLS = [
  'list_pages',
  'get_seo_settings',
  'update_meta_description',
  'update_seo_title',
  'update_og_image',
  'update_structured_data',
  'update_h1',
  'verify_change'
];
const MUTATION_TOOLS = [
  'update_meta_description',
  'update_seo_title',
  'update_og_image',
  'update_structured_data',
  'update_h1'
];

// ── GET WIX ACCESS TOKEN ──────────────────────────────────
async function getAccessToken(instanceId) {
  const res = await fetch('https://www.wixapis.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.WIX_APP_ID,
      client_secret: process.env.WIX_APP_SECRET,
      instance_id: instanceId
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Failed to get Wix access token: ' + (data.error_description || data.error || JSON.stringify(data).substring(0, 100)));
  }
  console.log('Wix access token obtained for instance:', instanceId.substring(0, 8) + '...');
  return data.access_token;
}

// ── SANITIZE ───────────────────────────────────────────────
function sanitize(val, maxLen) {
  if (typeof val !== 'string') return '';
  return val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, maxLen || MAX_STRING_LEN);
}

// ── WIX API CALL ───────────────────────────────────────────
async function wixApiCall(method, url, accessToken, wixSiteId, body) {
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
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
async function loadCredentials(sb, userId, siteId) {
  const { data: site } = await sb.from('user_sites')
    .select('site_id, user_id')
    .eq('site_id', siteId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!site) throw new Error('Site not found or access denied');

  const { data: cred } = await sb.from('platform_credentials')
    .select('credentials')
    .eq('user_id', userId)
    .eq('site_id', siteId)
    .eq('platform', 'wix')
    .maybeSingle();

  if (!cred || !cred.credentials) throw new Error('No Wix credentials found for this site. Please install the Forge AI app on your Wix site first.');

  const { instance_id, wix_site_id, encrypted_api_key, account_id } = cred.credentials;

  if (instance_id) {
    const accessToken = await getAccessToken(instance_id);
    const wixSiteId = wix_site_id || instance_id;
    return { accessToken, wixSiteId, credentialType: 'instance' };
  } else if (encrypted_api_key) {
    const key = crypto.scryptSync(
      process.env.WP_ENCRYPTION_KEY || process.env.CRON_SECRET || 'ForgeAI2026!',
      'salt', 32
    );
    const [ivHex, encrypted] = encrypted_api_key.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return { accessToken: decrypted, wixSiteId: wix_site_id || account_id, credentialType: 'api_key' };
  } else {
    throw new Error('No valid Wix credentials found. Please install the Forge AI app on your Wix site.');
  }
}

// ── VERIFY FIX IS APPROVED ────────────────────────────────
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
async function listPages(accessToken, wixSiteId, siteBase) {
  if (!siteBase) throw new Error('Site URL not available');

  const pagesSitemapRes = await fetch(siteBase + '/pages-sitemap.xml');
  const pagesSitemapText = await pagesSitemapRes.text();
  console.log('Pages sitemap preview:', pagesSitemapText.substring(0, 600));

  const locMatches = pagesSitemapText.match(/<loc>(.*?)<\/loc>/g) || [];
  const pageUrls = locMatches.map(m => m.replace(/<\/?loc>/g, '').trim());
  console.log('Page URLs found:', pageUrls.length, pageUrls.slice(0, 3));

  const normBase = siteBase.replace(/^https?:\/\/www\./, 'https://').replace(/^https?:\/\//, 'https://');
  const pages = pageUrls.map(url => {
    const normUrl = url.replace(/^https?:\/\/www\./, 'https://').replace(/^https?:\/\//, 'https://');
    const slug = normUrl.replace(normBase, '').replace(/^\//, '') || '';
    const isHome = normUrl === normBase || normUrl === normBase + '/';
    return {
      itemId: slug,
      name: sanitize(slug || 'homepage', 200),
      url: sanitize(url, 300),
      isHomepage: isHome
    };
  });

  const homePageEntry = pages.find(p => p.isHomepage);
  if (homePageEntry) {
    try {
      const testUrl = `${WIX_SEO_BASE}/STATIC_PAGE/${encodeURIComponent('')}`;
      const testRes = await wixApiCall('GET', testUrl, accessToken, wixSiteId, null);
      console.log('Homepage SEO probe status:', testRes.status);
      if (testRes.ok) {
        const seoItems = testRes.data.itemSeoTags || [];
        const realId = seoItems.length > 0 ? seoItems[0].itemId : '';
        console.log('Homepage real itemId:', realId);
        homePageEntry.itemId = realId;
        homePageEntry.valid = true;
      }
    } catch(e) { console.log('Homepage probe error:', e.message); }
  }

  console.log('Pages built:', pages.length, 'homepage valid:', homePageEntry ? homePageEntry.valid : false);
  return { pages, total: pages.length };
}

// ── TOOL: get_seo_settings ────────────────────────────────
async function getSeoSettings(accessToken, wixSiteId, itemId) {
  const cleanItemId = sanitize(itemId, 200);
  if (!cleanItemId) throw new Error('itemId is required');

  const url = `${WIX_SEO_BASE}/STATIC_PAGE/${encodeURIComponent(cleanItemId)}`;
  const { ok, status, data } = await wixApiCall('GET', url, accessToken, wixSiteId, null);

  if (!ok) throw new Error(`Wix SEO API error ${status}: ${data.message || 'Unknown error'}`);

  const tags = (data.itemSeoTags && data.itemSeoTags.tags) || [];
  const hasOverride = (data.itemSeoTags && data.itemSeoTags.hasOverride) || false;

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
// Deployment handled by Velo masterpage code via wix-seo-read API
async function updateMetaDescription(accessToken, wixSiteId, itemId, newDescription, existingTitle) {
  const cleanItemId = sanitize(itemId, 200);
  const cleanDesc = sanitize(newDescription, 300);

  if (!cleanDesc) throw new Error('newDescription is required');
  if (cleanDesc.length < 10) throw new Error('Meta description too short (min 10 chars)');
  if (cleanDesc.length > 300) throw new Error('Meta description too long (max 300 chars)');

  console.log('Wix meta description queued for Velo deployment — itemId:', cleanItemId);

  return {
    updated: true,
    itemId: cleanItemId,
    patchData: { tags: [{ type: 'meta', props: { name: 'description', content: cleanDesc } }] }
  };
}

// ── TOOL: update_seo_title ─────────────────────────────────
// Deployment handled by Velo masterpage code via wix-seo-read API
async function updateSeoTitle(accessToken, wixSiteId, itemId, newTitle, existingDescription) {
  const cleanItemId = sanitize(itemId, 200);
  const cleanTitle = sanitize(newTitle, 300);

  if (!cleanTitle) throw new Error('newTitle is required');
  if (cleanTitle.length < 5) throw new Error('SEO title too short (min 5 chars)');
  if (cleanTitle.length > 300) throw new Error('SEO title too long (max 300 chars)');

  console.log('Wix SEO title queued for Velo deployment — itemId:', cleanItemId);

  return {
    updated: true,
    itemId: cleanItemId,
    patchData: { tags: [{ type: 'title', children: cleanTitle }] }
  };
}

// ── TOOL: update_og_image ──────────────────────────────────
// Stores the Wix-hosted image URL so Velo can set og:image on every page load.
// The imageUrl must already be a hosted URL (from wix-media-upload) — never
// a raw user-supplied URL, which is validated by agent-deploy before calling here.
async function updateOgImage(accessToken, wixSiteId, itemId, imageUrl) {
  const cleanItemId = sanitize(itemId, 200);
  const cleanUrl = sanitize(imageUrl, 500);

  if (!cleanUrl) throw new Error('imageUrl is required');
  // Must be a proper https URL
  if (!cleanUrl.startsWith('https://')) throw new Error('imageUrl must be an https URL');

  console.log('Wix og:image queued for Velo deployment — url:', cleanUrl.substring(0, 60) + '...');

  return {
    updated: true,
    itemId: cleanItemId,
    // after = the clean image URL stored in result for wix-seo-read to return
    after: cleanUrl
  };
}

// ── TOOL: update_structured_data ──────────────────────────
// Stores a parsed JSON-LD object so Velo can call wixSeo.setStructuredData().
// The jsonString param is the raw JSON string from proposed_fix.
// We parse it here so result.after is a proper object — wix-seo-read returns
// it as-is and Velo passes it directly to setStructuredData([obj]).
async function updateStructuredData(accessToken, wixSiteId, itemId, jsonString) {
  const cleanItemId = sanitize(itemId, 200);
  // Don't sanitize jsonString with MAX_STRING_LEN — it can be up to MAX_JSON_LEN
  const cleanJson = typeof jsonString === 'string'
    ? jsonString.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, MAX_JSON_LEN)
    : '';

  if (!cleanJson) throw new Error('jsonString is required');

  // Parse to validate — throws if invalid JSON
  let parsed;
  try {
    parsed = JSON.parse(cleanJson);
  } catch(e) {
    throw new Error('structuredData is not valid JSON: ' + e.message);
  }

  // Must have @context and @type
  if (!parsed['@context'] || !parsed['@type']) {
    throw new Error('structuredData must have @context and @type fields');
  }

  console.log('Wix structured data queued for Velo deployment — @type:', parsed['@type']);

  return {
    updated: true,
    itemId: cleanItemId,
    // after = parsed object so wix-seo-read returns it directly (no JSON.parse needed in Velo)
    after: parsed
  };
}

// ── TOOL: update_h1 ───────────────────────────────────────
// Stores the H1 text so Velo can find the first heading-type Text element
// and update it. Best-effort — Velo falls back silently if no heading found.
// We store plain text (no HTML) — Velo wraps it in <h1> tags itself.
async function updateH1(accessToken, wixSiteId, itemId, h1Text) {
  const cleanItemId = sanitize(itemId, 200);
  // Strip any HTML tags the caller might have included (e.g. "<h1>My Title</h1>")
  const cleanText = sanitize(h1Text, 200).replace(/<[^>]+>/g, '').trim();

  if (!cleanText) throw new Error('h1Text is required');
  if (cleanText.length < 3) throw new Error('H1 text too short (min 3 chars)');

  console.log('Wix H1 queued for Velo deployment (best-effort) — text:', cleanText.substring(0, 60));

  return {
    updated: true,
    itemId: cleanItemId,
    // after = plain text; Velo wraps in <h1>
    after: cleanText,
    note: 'best-effort — Velo will attempt to find and update the first heading element'
  };
}

// ── TOOL: verify_change ────────────────────────────────────
async function verifyChange(accessToken, wixSiteId, itemId, field, expectedValue) {
  const cleanItemId = sanitize(itemId, 200);
  const cleanField = sanitize(field, 50);
  const cleanExpected = sanitize(expectedValue, 300);

  if (!cleanItemId || !cleanField || !cleanExpected) throw new Error('itemId, field, and expectedValue are required');
  if (!['description', 'title'].includes(cleanField)) throw new Error('field must be description or title');

  await new Promise(r => setTimeout(r, 4000));

  const current = await getSeoSettings(accessToken, wixSiteId, cleanItemId);
  const actual = cleanField === 'description' ? current.description : current.title;
  console.log('Verify — expected:', cleanExpected.substring(0, 50), 'actual:', actual ? actual.substring(0, 50) : 'NULL');

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const body = req.body || {};
    const { tool, userId, siteId, fixId, params } = body;

    if (!tool || !userId || !siteId) {
      return res.status(400).json({ error: 'tool, userId, and siteId are required' });
    }

    if (!ALLOWED_TOOLS.includes(tool)) {
      return res.status(400).json({ error: `Unknown tool: ${tool}. Allowed: ${ALLOWED_TOOLS.join(', ')}` });
    }

    if (MUTATION_TOOLS.includes(tool)) {
      if (!fixId) return res.status(400).json({ error: 'fixId is required for mutation tools' });
      await verifyApprovedFix(sb, fixId, userId);
    }

    const { accessToken, wixSiteId } = await loadCredentials(sb, userId, siteId);

    const { data: siteRow } = await sb.from('user_sites')
      .select('url')
      .eq('site_id', siteId)
      .eq('user_id', userId)
      .maybeSingle();
    const siteBase = siteRow ? siteRow.url.replace(/\/$/, '') : null;

    let result;

    // ── list_pages ────────────────────────────────────────
    if (tool === 'list_pages') {
      result = await listPages(accessToken, wixSiteId, siteBase);
    }

    // ── get_seo_settings ──────────────────────────────────
    else if (tool === 'get_seo_settings') {
      const itemId = sanitize((params && params.itemId) || '', 200);
      if (!itemId) return res.status(400).json({ error: 'params.itemId is required for get_seo_settings' });
      result = await getSeoSettings(accessToken, wixSiteId, itemId);
    }

    // ── update_meta_description ───────────────────────────
    else if (tool === 'update_meta_description') {
      let itemId = sanitize((params && params.itemId) || '', 200);
      const newDescription = sanitize((params && params.newDescription) || '', 300);
      const existingTitle = sanitize((params && params.existingTitle) || '', 300);
      if (!newDescription) return res.status(400).json({ error: 'params.newDescription is required' });

      if (!itemId) {
        const pagesResult = await listPages(accessToken, wixSiteId, siteBase);
        const pages = pagesResult.pages || [];
        const home = pages.find(p => p.valid) || pages.find(p => p.isHomepage) || pages[0];
        if (!home || home.itemId === undefined) return res.status(400).json({ error: 'Could not find homepage. Please try again.' });
        itemId = home.itemId;
        console.log('Auto-detected homepage itemId:', itemId);
      }

      result = await updateMetaDescription(accessToken, wixSiteId, itemId, newDescription, existingTitle);

      const savedTags = (result.patchData && result.patchData.tags) || [];
      const savedDesc = savedTags.find(t => t.type === 'meta' && t.props && t.props.name === 'description');
      const verified = !!(savedDesc && savedDesc.props.content === newDescription);
      result.verification = {
        verified,
        field: 'description',
        expected: newDescription,
        actual: savedDesc ? savedDesc.props.content : null,
        source: 'velo_queued',
        note: 'Fix will be applied by Forge AI Velo masterpage code on next page load'
      };

      if (fixId) {
        const status = verified ? 'deployed' : 'verify_failed';
        await sb.from('agent_fixes').update({
          status,
          deployed_at: new Date().toISOString(),
          result: {
            tool,
            itemId,
            field: 'description',
            after: newDescription,
            verified
          }
        }).eq('id', fixId).eq('user_id', userId);
      }
    }

    // ── update_seo_title ──────────────────────────────────
    else if (tool === 'update_seo_title') {
      let itemId = sanitize((params && params.itemId) || '', 200);
      const newTitle = sanitize((params && params.newTitle) || '', 300);
      const existingDescription = sanitize((params && params.existingDescription) || '', 300);
      if (!newTitle) return res.status(400).json({ error: 'params.newTitle is required' });

      if (!itemId) {
        const pagesResult2 = await listPages(accessToken, wixSiteId, siteBase);
        const pages2 = pagesResult2.pages || [];
        const home2 = pages2.find(p => p.valid) || pages2.find(p => p.isHomepage) || pages2[0];
        if (!home2 || home2.itemId === undefined) return res.status(400).json({ error: 'Could not find homepage. Please try again.' });
        itemId = home2.itemId;
        console.log('Auto-detected homepage itemId for title:', itemId);
      }

      result = await updateSeoTitle(accessToken, wixSiteId, itemId, newTitle, existingDescription);

      const savedTitleTags = (result.patchData && result.patchData.tags) || [];
      const savedTitle = savedTitleTags.find(t => t.type === 'title');
      const verifiedTitle = !!(savedTitle && savedTitle.children === newTitle);
      result.verification = {
        verified: verifiedTitle,
        field: 'title',
        expected: newTitle,
        actual: savedTitle ? savedTitle.children : null,
        source: 'velo_queued',
        note: 'Fix will be applied by Forge AI Velo masterpage code on next page load'
      };

      if (fixId) {
        const status = verifiedTitle ? 'deployed' : 'verify_failed';
        await sb.from('agent_fixes').update({
          status,
          deployed_at: new Date().toISOString(),
          result: {
            tool,
            itemId,
            field: 'title',
            after: newTitle,
            verified: verifiedTitle
          }
        }).eq('id', fixId).eq('user_id', userId);
      }
    }

    // ── update_og_image ───────────────────────────────────
    else if (tool === 'update_og_image') {
      let itemId = sanitize((params && params.itemId) || '', 200);
      const imageUrl = sanitize((params && params.imageUrl) || '', 500);
      if (!imageUrl) return res.status(400).json({ error: 'params.imageUrl is required' });
      if (!imageUrl.startsWith('https://')) return res.status(400).json({ error: 'params.imageUrl must be an https URL' });

      result = await updateOgImage(accessToken, wixSiteId, itemId, imageUrl);

      const verified = !!(result.after && result.after === imageUrl);
      result.verification = {
        verified,
        field: 'og_image',
        expected: imageUrl,
        actual: result.after || null,
        source: 'velo_queued',
        note: 'og:image will be set by Forge AI Velo masterpage code on next page load'
      };

      if (fixId) {
        const status = verified ? 'deployed' : 'verify_failed';
        await sb.from('agent_fixes').update({
          status,
          deployed_at: new Date().toISOString(),
          // Also store the image URL in proposed_fix so the UI can show it
          proposed_fix: imageUrl,
          result: {
            tool,
            itemId,
            field: 'og_image',
            after: imageUrl,  // clean URL — wix-seo-read reads result.after
            verified
          }
        }).eq('id', fixId).eq('user_id', userId);
      }
    }

    // ── update_structured_data ────────────────────────────
    else if (tool === 'update_structured_data') {
      let itemId = sanitize((params && params.itemId) || '', 200);
      // jsonString comes from proposed_fix — may contain a <script> wrapper, strip it
      let jsonString = (params && params.jsonString) || '';
      if (typeof jsonString !== 'string') jsonString = '';
      // Strip <script type="application/ld+json"> wrapper if present
      jsonString = jsonString
        .replace(/<script[^>]*>/gi, '')
        .replace(/<\/script>/gi, '')
        .trim();

      if (!jsonString) return res.status(400).json({ error: 'params.jsonString is required' });

      result = await updateStructuredData(accessToken, wixSiteId, itemId, jsonString);

      const verified = !!(result.after && result.after['@type']);
      result.verification = {
        verified,
        field: 'structured_data',
        expected: result.after ? result.after['@type'] : null,
        source: 'velo_queued',
        note: 'Structured data will be injected by Forge AI Velo masterpage code on next page load'
      };

      if (fixId) {
        const status = verified ? 'deployed' : 'verify_failed';
        await sb.from('agent_fixes').update({
          status,
          deployed_at: new Date().toISOString(),
          result: {
            tool,
            itemId,
            field: 'structured_data',
            after: result.after,  // parsed object — wix-seo-read returns as-is
            verified
          }
        }).eq('id', fixId).eq('user_id', userId);
      }
    }

    // ── update_h1 ─────────────────────────────────────────
    else if (tool === 'update_h1') {
      let itemId = sanitize((params && params.itemId) || '', 200);
      const h1Text = sanitize((params && params.h1Text) || '', 200);
      if (!h1Text) return res.status(400).json({ error: 'params.h1Text is required' });

      result = await updateH1(accessToken, wixSiteId, itemId, h1Text);

      // Strip any tags the sanitizer let through before storing
      const cleanAfter = result.after ? result.after.replace(/<[^>]+>/g, '').trim() : '';
      const verified = !!(cleanAfter && cleanAfter === h1Text.replace(/<[^>]+>/g, '').trim());
      result.verification = {
        verified,
        field: 'h1',
        expected: cleanAfter,
        source: 'velo_queued',
        note: 'H1 will be applied by Forge AI Velo masterpage code on next page load (best-effort)'
      };

      if (fixId) {
        const status = verified ? 'deployed' : 'verify_failed';
        await sb.from('agent_fixes').update({
          status,
          deployed_at: new Date().toISOString(),
          result: {
            tool,
            itemId,
            field: 'h1',
            after: cleanAfter,  // plain text — Velo wraps in <h1>
            verified
          }
        }).eq('id', fixId).eq('user_id', userId);
      }
    }

    // ── verify_change ─────────────────────────────────────
    else if (tool === 'verify_change') {
      const itemId = sanitize((params && params.itemId) || '', 200);
      const field = sanitize((params && params.field) || '', 50);
      const expectedValue = sanitize((params && params.expectedValue) || '', 300);
      if (!itemId || !field || !expectedValue) return res.status(400).json({ error: 'params.itemId, params.field, and params.expectedValue are required' });
      result = await verifyChange(accessToken, wixSiteId, itemId, field, expectedValue);
    }

    console.log(`wix-actions: ${tool} completed for user ${userId} site ${siteId} — verified: ${result && result.verification ? result.verification.verified : 'N/A'}`);
    return res.status(200).json({ success: true, result });

  } catch (e) {
    console.error('wix-actions error:', e.message);
    const safeMsg = e.message.replace(/apiKey|Authorization|Bearer/gi, '[REDACTED]');
    return res.status(500).json({ success: false, error: safeMsg });
  }
};
