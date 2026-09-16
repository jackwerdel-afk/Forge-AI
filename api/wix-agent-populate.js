// ── WIX AGENT POPULATE ─────────────────────────────────────
// Called from the dashboard after every Wix site scan.
// Checks for fixable SEO issues and creates agent_fixes records
// so they appear in Forge Agent automatically.
// Only creates fixes if no pending/deployed fix already exists.

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

    const seoModule = result.modules && result.modules.seo;
    if (!seoModule) {
      return res.status(200).json({ success: true, generated: 0, message: 'No SEO module data' });
    }

    const deductions = seoModule.deductions || [];
    const fixes = [];

    // Check for missing meta description
    const missingMeta = deductions.find(d =>
      d.issue && (
        d.issue.toLowerCase().includes('meta description') ||
        d.issue.toLowerCase().includes('missing description')
      )
    );

    if (missingMeta && !currentMeta) {
      // Check if fix already exists
      const { data: existingFix } = await sb.from('agent_fixes')
        .select('id, status')
        .eq('site_id', siteId)
        .eq('user_id', userId)
        .eq('platform', 'wix')
        .in('status', ['pending', 'approved', 'deployed'])
        .ilike('issue_type', '%meta_description%')
        .maybeSingle();

      if (!existingFix) {
        // Write site-aware proposed fix
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

        console.log('wix-agent-populate: queued meta description fix for', siteUrl);
      } else {
        console.log('wix-agent-populate: fix already exists for', siteUrl, '— skipping');
      }
    }

    // Insert fixes
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
