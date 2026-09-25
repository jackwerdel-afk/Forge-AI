// ── WIX AGENT POPULATE ─────────────────────────────────────
// Called from the dashboard after every Wix site scan.
// Checks for fixable SEO issues and creates agent_fixes records
// so they appear in Forge Agent automatically.
// Only creates fixes if no pending/deployed fix already exists.
//
// Supported fix types:
//   meta_description  — Missing meta description
//   missing_h1        — Missing H1 heading
//   og_image          — Missing og:image Open Graph tag
//   structured_data   — No structured data / JSON-LD

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

    const { siteId, siteUrl, sitePlatform, result } = req.body || {};

    if (!siteId || !siteUrl || sitePlatform !== 'wix' || !result) {
      return res.status(200).json({ success: true, generated: 0, message: 'Not a Wix site or missing data' });
    }

    const userId = user.id;

    // Verify ownership
    const { data: siteRow } = await sb.from('user_sites')
      .select('site_id')
      .eq('site_id', siteId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!siteRow) return res.status(403).json({ error: 'Site not found' });

    // Check Wix app credentials exist
    const { data: cred } = await sb.from('platform_credentials')
      .select('credentials')
      .eq('user_id', userId)
      .eq('site_id', siteId)
      .eq('platform', 'wix')
      .maybeSingle();

    if (!cred || !cred.credentials || !cred.credentials.instance_id) {
      return res.status(200).json({ success: true, generated: 0, message: 'No Wix app credentials' });
    }

    // Get page content and SEO module from scan result
    const pc = result.page_content || {};
    const siteName = pc.site_name || siteUrl.replace(/^https?:\/\//, '');
    const pageTitle = pc.title || siteName;
    const textPreview = pc.text_preview || '';
    const currentMeta = pc.meta_description || null;
    const currentH1 = pc.h1 || null;

    const seoModule = result.modules && result.modules.seo;
    if (!seoModule) {
      return res.status(200).json({ success: true, generated: 0, message: 'No SEO module data' });
    }

    const deductions = seoModule.deductions || [];
    const fixes = [];

    // ── 1. MISSING META DESCRIPTION ──────────────────────────
    const missingMeta = deductions.find(d =>
      d.issue && (
        d.issue.toLowerCase().includes('meta description') ||
        d.issue.toLowerCase().includes('missing description')
      )
    );

    if (missingMeta && !currentMeta) {
      const { data: existingFix } = await sb.from('agent_fixes')
        .select('id, status')
        .eq('site_id', siteId)
        .eq('user_id', userId)
        .eq('platform', 'wix')
        .eq('issue_type', 'meta_description')
        .in('status', ['pending', 'approved', 'deployed'])
        .maybeSingle();

      if (!existingFix) {
        let proposed = '';
        if (textPreview && textPreview.length > 50) {
          const cleanText = textPreview
            .replace(/&nbsp;/g, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          proposed = (siteName + ' — ' + cleanText.substring(0, 120).trim()).substring(0, 155);
        } else if (pageTitle && pageTitle !== siteName) {
          proposed = (pageTitle + '. Learn more at ' + siteName + '.').substring(0, 155);
        } else {
          proposed = (siteName + ' — professional services for your business. Contact us today.').substring(0, 155);
        }

        fixes.push({
          user_id: userId,
          site_id: siteId,
          site_url: siteUrl,
          site_name: siteName,
          platform: 'wix',
          issue_type: 'meta_description',
          issue_description: 'Missing meta description on homepage — hurts SEO click-through rate in search results.',
          proposed_fix: proposed,
          target_id: null,
          target_type: 'homepage',
          target_label: 'Homepage',
          points_impact: Math.abs(missingMeta.points || 3),
          tesseract_reasoning: 'Auto-generated from scan data. Page title: "' + pageTitle + '". ' + (textPreview ? 'Based on homepage content.' : 'Generated from site name.'),
          status: 'pending',
          created_at: new Date().toISOString()
        });

        console.log('wix-agent-populate: queued meta_description fix for', siteUrl);
      } else {
        console.log('wix-agent-populate: meta_description fix already exists for', siteUrl, '— skipping');
      }
    }

    // ── 2. MISSING H1 HEADING ────────────────────────────────
    const missingH1 = deductions.find(d =>
      d.issue && d.issue.toLowerCase().includes('missing h1')
    );

    if (missingH1 && !currentH1) {
      const { data: existingH1Fix } = await sb.from('agent_fixes')
        .select('id, status')
        .eq('site_id', siteId)
        .eq('user_id', userId)
        .eq('platform', 'wix')
        .eq('issue_type', 'missing_h1')
        .in('status', ['pending', 'approved', 'deployed'])
        .maybeSingle();

      if (!existingH1Fix) {
        // Use the page title as the H1 suggestion, falling back to site name
        const h1Suggestion = pageTitle || siteName;

        fixes.push({
          user_id: userId,
          site_id: siteId,
          site_url: siteUrl,
          site_name: siteName,
          platform: 'wix',
          issue_type: 'missing_h1',
          issue_description: 'No H1 heading found on homepage — critical for SEO. Search engines rely on H1 to understand page topic and relevance for target keywords.',
          proposed_fix: '<h1>' + h1Suggestion + '</h1>',
          target_id: null,
          target_type: 'homepage',
          target_label: 'Homepage',
          points_impact: Math.abs(missingH1.points || 5),
          tesseract_reasoning: 'No <h1> tag detected in page HTML. Suggested H1 derived from page title: "' + h1Suggestion + '". Add this as the primary heading wrapping your main value proposition.',
          status: 'pending',
          created_at: new Date().toISOString()
        });

        console.log('wix-agent-populate: queued missing_h1 fix for', siteUrl);
      } else {
        console.log('wix-agent-populate: missing_h1 fix already exists for', siteUrl, '— skipping');
      }
    }

    // ── 3. MISSING OG:IMAGE ──────────────────────────────────
    const missingOgImage = deductions.find(d =>
      d.issue && (
        d.issue.toLowerCase().includes('og:image') ||
        (d.issue.toLowerCase().includes('open graph') && d.issue.toLowerCase().includes('image'))
      )
    );

    if (missingOgImage) {
      const { data: existingOgFix } = await sb.from('agent_fixes')
        .select('id, status')
        .eq('site_id', siteId)
        .eq('user_id', userId)
        .eq('platform', 'wix')
        .eq('issue_type', 'og_image')
        .in('status', ['pending', 'approved', 'deployed'])
        .maybeSingle();

      if (!existingOgFix) {
        const cleanSiteUrl = siteUrl.replace(/\/$/, '');

        fixes.push({
          user_id: userId,
          site_id: siteId,
          site_url: siteUrl,
          site_name: siteName,
          platform: 'wix',
          issue_type: 'og_image',
          issue_description: 'Missing og:image Open Graph tag — without it, social shares of your homepage show no image preview, reducing click-through rates.',
          proposed_fix: '<meta property="og:image" content="' + cleanSiteUrl + '/og-image.jpg" />\n<meta property="og:image:width" content="1200" />\n<meta property="og:image:height" content="630" />',
          target_id: null,
          target_type: 'homepage',
          target_label: 'Homepage',
          points_impact: Math.abs(missingOgImage.points || 2),
          tesseract_reasoning: 'og:image tag missing from page <head>. Add a 1200x630px branded image at the suggested URL and insert these meta tags in the page <head>. Update the image path to match your actual hosted image.',
          status: 'pending',
          created_at: new Date().toISOString()
        });

        console.log('wix-agent-populate: queued og_image fix for', siteUrl);
      } else {
        console.log('wix-agent-populate: og_image fix already exists for', siteUrl, '— skipping');
      }
    }

    // ── 4. MISSING STRUCTURED DATA ───────────────────────────
    const missingStructuredData = deductions.find(d =>
      d.issue && d.issue.toLowerCase().includes('structured data')
    );

    if (missingStructuredData) {
      const { data: existingSdFix } = await sb.from('agent_fixes')
        .select('id, status')
        .eq('site_id', siteId)
        .eq('user_id', userId)
        .eq('platform', 'wix')
        .eq('issue_type', 'structured_data')
        .in('status', ['pending', 'approved', 'deployed'])
        .maybeSingle();

      if (!existingSdFix) {
        const cleanSiteUrl = siteUrl.replace(/\/$/, '');
        const jsonLd = JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'ProfessionalService',
          'name': siteName,
          'url': cleanSiteUrl,
          'description': currentMeta || pageTitle || siteName
        }, null, 2);

        fixes.push({
          user_id: userId,
          site_id: siteId,
          site_url: siteUrl,
          site_name: siteName,
          platform: 'wix',
          issue_type: 'structured_data',
          issue_description: 'No structured data (JSON-LD) found on homepage — structured data helps search engines display rich results and improves local search visibility.',
          proposed_fix: '<script type="application/ld+json">\n' + jsonLd + '\n</script>',
          target_id: null,
          target_type: 'homepage',
          target_label: 'Homepage',
          points_impact: Math.abs(missingStructuredData.points || 1),
          tesseract_reasoning: 'No JSON-LD or itemtype schema markup found in page HTML. Add this ProfessionalService schema to the page <head>. Customize @type (e.g. LocalBusiness, WebDesign) and add address/phone fields as appropriate.',
          status: 'pending',
          created_at: new Date().toISOString()
        });

        console.log('wix-agent-populate: queued structured_data fix for', siteUrl);
      } else {
        console.log('wix-agent-populate: structured_data fix already exists for', siteUrl, '— skipping');
      }
    }

    // ── INSERT ALL FIXES ──────────────────────────────────────
    if (fixes.length > 0) {
      const { error } = await sb.from('agent_fixes').insert(fixes);
      if (error) throw new Error('Insert error: ' + error.message);
      console.log('wix-agent-populate: inserted', fixes.length, 'fix(es) for', siteUrl);
    }

    return res.status(200).json({ success: true, generated: fixes.length });

  } catch(err) {
    console.error('wix-agent-populate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
