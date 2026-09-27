// ── WIX MEDIA UPLOAD ───────────────────────────────────────
// Uploads an image to the Wix Media Manager for a given site,
// returning a permanent https URL suitable for use as og:image.
//
// Flow (Wix two-step upload):
//   1. GET  Wix upload URL from /media/v1/upload/url
//   2. PUT  the image binary to that upload URL
//   3. Return the resulting wixstatic.com media URL
//
// Called by forge-ai-agent.html when deploying an og_image fix.
// Auth: user Bearer token (Supabase JWT) — verified before any operation.
// File: multipart/form-data with field "image" (the agency's image file).
//
// Limits:
//   - Max file size: 4MB (Vercel serverless body limit)
//   - Accepted types: image/jpeg, image/png, image/webp, image/gif
//   - Requires agency or enterprise plan
//   - Requires Wix app installed on the site (platform_credentials row)

'use strict';
const { createClient } = require('@supabase/supabase-js');

// Vercel's built-in body parser handles multipart if we disable the default JSON parser.
// We use the raw buffer approach with a simple multipart boundary parser.
// This avoids needing busboy/multer (extra dependency) and stays within Vercel limits.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── AUTH ──────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  // ── PLAN CHECK ────────────────────────────────────────────
  const { data: memberRecord } = await sb.from('team_members')
    .select('agency_id, role')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  let planEmail = user.email;
  if (memberRecord && memberRecord.agency_id) {
    const { data: { users: allUsers } } = await sb.auth.admin.listUsers();
    const ownerUser = allUsers && allUsers.find(u => u.id === memberRecord.agency_id);
    if (ownerUser) planEmail = ownerUser.email;
  }

  const { data: userSub } = await sb.from('subscriptions')
    .select('plan')
    .eq('email', planEmail)
    .maybeSingle();
  const userPlan = (userSub && userSub.plan) ? userSub.plan : 'free';
  if (userPlan !== 'agency' && userPlan !== 'enterprise') {
    return res.status(403).json({ error: 'Forge Agent requires the Agency plan or higher.' });
  }

  const ownerUserId = memberRecord ? memberRecord.agency_id : user.id;

  // ── PARSE BODY ────────────────────────────────────────────
  // Expect JSON body: { siteId, fixId, imageDataUrl }
  // imageDataUrl is a base64 data URL from the browser FileReader API.
  // This avoids multipart parsing complexity entirely and stays well within
  // Vercel's 4.5MB body limit for typical og:image files (200–800KB = ~270–1100KB base64).
  const body = req.body || {};
  const { siteId, fixId, imageDataUrl } = body;

  if (!siteId) return res.status(400).json({ error: 'siteId is required' });
  if (!fixId) return res.status(400).json({ error: 'fixId is required' });
  if (!imageDataUrl) return res.status(400).json({ error: 'imageDataUrl is required' });

  // Validate data URL format
  const dataUrlMatch = imageDataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  if (!dataUrlMatch) {
    return res.status(400).json({ error: 'imageDataUrl must be a base64 data URL of type image/jpeg, image/png, image/webp, or image/gif' });
  }
  const mimeType = dataUrlMatch[1];
  const base64Data = dataUrlMatch[2];

  // Decode and check size (max 4MB decoded)
  const imageBuffer = Buffer.from(base64Data, 'base64');
  const MAX_SIZE = 4 * 1024 * 1024; // 4MB
  if (imageBuffer.length > MAX_SIZE) {
    return res.status(400).json({ error: 'Image too large. Maximum size is 4MB.' });
  }

  // ── VERIFY FIX OWNERSHIP ──────────────────────────────────
  const { data: fix } = await sb.from('agent_fixes')
    .select('id, user_id, status, platform, issue_type, site_id')
    .eq('id', fixId)
    .eq('user_id', ownerUserId)
    .eq('platform', 'wix')
    .eq('issue_type', 'og_image')
    .eq('status', 'approved')
    .maybeSingle();

  if (!fix) {
    return res.status(404).json({ error: 'Fix not found, not approved, or not an og_image fix' });
  }

  if (fix.site_id !== siteId) {
    return res.status(400).json({ error: 'siteId does not match fix site' });
  }

  // ── LOAD WIX CREDENTIALS ─────────────────────────────────
  const { data: cred } = await sb.from('platform_credentials')
    .select('credentials')
    .eq('user_id', ownerUserId)
    .eq('site_id', siteId)
    .eq('platform', 'wix')
    .maybeSingle();

  if (!cred || !cred.credentials || !cred.credentials.instance_id) {
    return res.status(400).json({ error: 'No Wix credentials found. Please reinstall the Forge AI Wix app.' });
  }

  const instanceId = cred.credentials.instance_id;

  // ── GET WIX ACCESS TOKEN ──────────────────────────────────
  let accessToken;
  try {
    const tokenRes = await fetch('https://www.wixapis.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: process.env.WIX_APP_ID,
        client_secret: process.env.WIX_APP_SECRET,
        instance_id: instanceId
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || 'Failed to get access token');
    }
    accessToken = tokenData.access_token;
  } catch(e) {
    console.error('wix-media-upload: token error:', e.message);
    return res.status(500).json({ error: 'Could not authenticate with Wix. Please try again.' });
  }

  const wixSiteId = cred.credentials.wix_site_id || instanceId;

  // ── STEP 1: GET WIX UPLOAD URL ────────────────────────────
  // Wix Media Manager v1 — get a pre-signed upload URL
  let uploadUrl, uploadToken;
  try {
    const ext = mimeType === 'image/jpeg' ? 'jpg'
              : mimeType === 'image/png'  ? 'png'
              : mimeType === 'image/webp' ? 'webp'
              : 'gif';
    const fileName = 'og-image-' + Date.now() + '.' + ext;

    const uploadUrlRes = await fetch('https://www.wixapis.com/site-media/v1/files/upload/url', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'wix-site-id': wixSiteId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        mimeType,
        fileName,
        sizeInBytes: imageBuffer.length
      })
    });

    const uploadUrlData = await uploadUrlRes.json();
    if (!uploadUrlRes.ok || !uploadUrlData.uploadUrl) {
      throw new Error((uploadUrlData.message || uploadUrlData.error || 'Failed to get upload URL') + ' (status ' + uploadUrlRes.status + ')');
    }
    uploadUrl = uploadUrlData.uploadUrl;
    uploadToken = uploadUrlData.uploadToken;
  } catch(e) {
    console.error('wix-media-upload: get upload URL error:', e.message);
    return res.status(500).json({ error: 'Could not get Wix upload URL: ' + e.message });
  }

  // ── STEP 2: UPLOAD IMAGE TO WIX ──────────────────────────
  let mediaUrl;
  try {
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(imageBuffer.length),
        // Include upload token if provided by Wix
        ...(uploadToken ? { 'Authorization': uploadToken } : {})
      },
      body: imageBuffer
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => '');
      throw new Error('Upload PUT failed (status ' + uploadRes.status + '): ' + errText.substring(0, 200));
    }

    // Wix returns the media URL in the response body or headers
    const uploadData = await uploadRes.json().catch(() => null);
    if (uploadData && uploadData.fileUrl) {
      mediaUrl = uploadData.fileUrl;
    } else if (uploadData && uploadData.file && uploadData.file.url) {
      mediaUrl = uploadData.file.url;
    } else {
      // Some Wix endpoints return the URL in the Location header
      mediaUrl = uploadRes.headers.get('Location') || null;
    }

    if (!mediaUrl) {
      throw new Error('Wix did not return a media URL after upload');
    }

    // Ensure it's an https URL
    if (!mediaUrl.startsWith('https://')) {
      mediaUrl = 'https://' + mediaUrl.replace(/^https?:\/\//, '');
    }

  } catch(e) {
    console.error('wix-media-upload: upload error:', e.message);
    return res.status(500).json({ error: 'Image upload to Wix failed: ' + e.message });
  }

  console.log('wix-media-upload: uploaded successfully —', mediaUrl.substring(0, 80));

  return res.status(200).json({
    success: true,
    mediaUrl,
    mimeType,
    sizeBytes: imageBuffer.length
  });
};
