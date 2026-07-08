const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function decrypt(text) {
  try {
    const key = crypto.scryptSync(process.env.CRON_SECRET || 'ForgeAI2026!', 'salt', 32);
    const [ivHex, encrypted] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch(e) {
    return null;
  }
}

async function generateFix(issueType, context) {
  const prompts = {
    meta_description: `Write a meta description for this webpage. Return ONLY the meta description text. 120-160 characters. Professional tone.\n\nPage context: ${context}`,
    alt_text: `Write descriptive alt text for an image. Return ONLY the alt text. Under 125 characters.\n\nImage: ${typeof context === 'object' ? JSON.stringify(context) : context}`,
    page_title: `Rewrite this page title to be under 60 characters and SEO-friendly. Return ONLY the new title.\n\nCurrent title: ${context}`
  };

  const prompt = prompts[issueType];
  if (!prompt) return null;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'You are an SEO expert. Return only the requested content with no explanation, no quotes, no markdown.',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  return data.content?.[0]?.text?.trim() || null;
}

async function getTesseractReasoning(issueType, siteName, proposedFix) {
  const typeLabels = {
    meta_description: 'missing meta description',
    alt_text: 'missing image alt text',
    page_title: 'page title too long'
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: 'You are Tesseract, an AI strategist for web agencies. Write one concise sentence explaining why this fix matters for the client site. No markdown.',
      messages: [{ role: 'user', content: `Site: ${siteName}. Issue: ${typeLabels[issueType] || issueType}. Proposed fix: "${proposedFix}". Why does this matter?` }]
    })
  });

  const data = await response.json();
  return data.content?.[0]?.text?.trim() || '';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  const internalKey = req.headers['x-internal'];
  const isInternal = internalKey === process.env.CRON_SECRET;

  if (!authHeader && !isInternal) return res.status(401).json({ error: 'Unauthorized' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Internal calls from scheduled scan — get all paid users
  if (isInternal && req.method === 'POST') {
    try {
      const { data: paidSubs } = await sb.from('subscriptions')
        .select('user_id')
        .neq('plan', 'free')
        .eq('status', 'active');
      
      let totalGenerated = 0;
      for (const sub of (paidSubs || [])) {
        try {
          const fakeUser = { id: sub.user_id };
          const generated = await generateFixesForUser(sb, fakeUser);
          totalGenerated += generated;
        } catch(e) {
          console.log('Agent error for user', sub.user_id, e.message);
        }
      }
      return res.status(200).json({ success: true, generated: totalGenerated, message: 'Internal agent run complete' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Verify user for normal requests
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  // Forge Agent requires Agency or Enterprise plan
  // For team members, check the agency owner's plan instead
  const { data: memberRecord } = await sb.from('team_members')
    .select('agency_id, role')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  let planEmail = user.email;
  if (memberRecord && memberRecord.agency_id) {
    // Get agency owner's email
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

  // Determine the owner user_id to query fixes
  // Team members see owner's fixes; developers only see fixes for their assigned sites
  const ownerUserId = memberRecord ? memberRecord.agency_id : user.id;

  // GET — return current queue
  if (req.method === 'GET') {
    try {
      let fixQuery = sb.from('agent_fixes')
        .select('*')
        .eq('user_id', ownerUserId)
        .order('created_at', { ascending: false })
        .limit(50);

      // Developers only see fixes for their assigned sites
      if (memberRecord && memberRecord.role === 'developer') {
        const { data: assignments } = await sb.from('site_assignments')
          .select('site_id')
          .eq('agency_id', ownerUserId)
          .eq('user_id', user.id);

        if (!assignments || assignments.length === 0) {
          return res.status(200).json({ success: true, fixes: [] });
        }

        // Get the URLs for assigned sites
        const siteIds = assignments.map(a => a.site_id);
        const { data: assignedSites } = await sb.from('user_sites')
          .select('url')
          .eq('user_id', ownerUserId)
          .in('site_id', siteIds);

        const assignedUrls = (assignedSites || []).map(s => s.url);
        if (assignedUrls.length > 0) {
          fixQuery = fixQuery.in('page_url', assignedUrls);
        } else {
          return res.status(200).json({ success: true, fixes: [] });
        }
      }

      const { data: fixes } = await fixQuery;
      return res.status(200).json({ success: true, fixes: fixes || [] });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — generate new fix queue (owner, manager, and developer can all trigger)
  if (req.method === 'POST') {
    try {
      // Generate fixes for the owner's sites
      const ownerUserObj = { id: ownerUserId, email: planEmail };
      const generated = await generateFixesForUser(sb, memberRecord ? ownerUserObj : user);
      // Log scan activity for team members
      if (memberRecord) {
        try {
          await sb.from('team_activity').insert({
            agency_id: ownerUserId,
            user_id: user.id,
            action: 'forge_agent_scan',
            details: `Triggered Forge Agent scan — generated ${generated} fix${generated !== 1 ? 'es' : ''} for review`,
            site_url: '',
            site_name: ''
          });
        } catch(logErr) { console.log('Activity log error:', logErr.message); }
      }
      return res.status(200).json({ success: true, generated, message: `Generated ${generated} fix${generated !== 1 ? 'es' : ''} for review` });
    } catch(e) {
      console.error('Agent queue error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

async function generateFixesForUser(sb, user) {
  try {
      // Get WordPress sites from user_sites and scheduled_sites
      const { data: userSites } = await sb.from('user_sites')
        .select('*')
        .eq('user_id', user.id)
        .eq('platform', 'wordpress');

      const { data: schedSites } = await sb.from('scheduled_sites')
        .select('*')
        .eq('user_id', user.id)
        .eq('active', true)
        .eq('platform', 'wordpress');

      // Merge and deduplicate by URL
      const allSites = [...(userSites || []), ...(schedSites || [])];
      const seen = new Set();
      const sites = allSites.filter(s => {
        const url = s.url;
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });

      if (!sites || sites.length === 0) {
        return res.status(200).json({ success: true, message: 'No WordPress sites connected', generated: 0 });
      }

      let generated = 0;

      for (const site of sites) {
        try {
          // Use authenticated requests if credentials available, otherwise public API
          const credentials = site.wp_credentials ? decrypt(site.wp_credentials) : null;
          const authHeaders = credentials ? { 'Authorization': 'Basic ' + credentials } : {};

          // Get posts and pages via public REST API
          const [postsRes, pagesRes] = await Promise.all([
            fetch(`${site.url}/wp-json/wp/v2/posts?per_page=20&status=publish`, {
              headers: authHeaders
            }),
            fetch(`${site.url}/wp-json/wp/v2/pages?per_page=20&status=publish`, {
              headers: authHeaders
            })
          ]);

          const posts = postsRes.ok ? await postsRes.json() : [];
          const pages = pagesRes.ok ? await pagesRes.json() : [];
          const allContent = [...(Array.isArray(posts) ? posts : []), ...(Array.isArray(pages) ? pages : [])];

          for (const item of allContent.slice(0, 10)) {
            const meta = item.meta || {};
            const title = (item.title?.rendered || '').replace(/<[^>]+>/g, '');
            const metaDesc = meta._yoast_wpseo_metadesc || meta._forge_meta_description || '';
            const context = `Title: ${title}\nContent: ${(item.content?.rendered || '').replace(/<[^>]+>/g, ' ').slice(0, 400)}`;

            // Check for missing meta description
            if (!metaDesc || metaDesc.length < 10) {
              // Check if fix already pending
              const { data: existing } = await sb.from('agent_fixes')
                .select('id')
                .eq('user_id', user.id)
                .eq('site_url', site.url)
                .eq('issue_type', 'meta_description')
                .eq('target_id', String(item.id))
                .in('status', ['pending', 'approved'])
                .maybeSingle();

              if (!existing) {
                const proposedFix = await generateFix('meta_description', context);
                if (proposedFix) {
                  const reasoning = await getTesseractReasoning('meta_description', site.name || site.url, proposedFix);
                  await sb.from('agent_fixes').insert({
                    user_id: user.id,
                    site_url: site.url,
                    site_name: site.name || site.url,
                    issue_type: 'meta_description',
                    issue_description: `"${title}" is missing a meta description`,
                    proposed_fix: proposedFix,
                    target_id: String(item.id),
                    target_type: item.type || 'post',
                    target_label: title || `Post #${item.id}`,
                    points_impact: 5,
                    tesseract_reasoning: reasoning,
                    status: 'pending'
                  });
                  generated++;
                }
              }
            }

            // Check for long page title
            if (title.length > 60) {
              const { data: existing } = await sb.from('agent_fixes')
                .select('id')
                .eq('user_id', user.id)
                .eq('site_url', site.url)
                .eq('issue_type', 'page_title')
                .eq('target_id', String(item.id))
                .in('status', ['pending', 'approved'])
                .maybeSingle();

              if (!existing) {
                const proposedFix = await generateFix('page_title', title);
                if (proposedFix) {
                  const reasoning = await getTesseractReasoning('page_title', site.name || site.url, proposedFix);
                  await sb.from('agent_fixes').insert({
                    user_id: user.id,
                    site_url: site.url,
                    site_name: site.name || site.url,
                    issue_type: 'page_title',
                    issue_description: `"${title.slice(0, 40)}..." is ${title.length} characters (max 60)`,
                    proposed_fix: proposedFix,
                    target_id: String(item.id),
                    target_type: item.type || 'post',
                    target_label: title || `Post #${item.id}`,
                    points_impact: 3,
                    tesseract_reasoning: reasoning,
                    status: 'pending'
                  });
                  generated++;
                }
              }
            }
          }

          // Check media for missing alt text
          const mediaRes = await fetch(`${site.url}/wp-json/wp/v2/media?per_page=20`, {
            headers: authHeaders
          });

          if (mediaRes.ok) {
            const media = await mediaRes.json();
            if (Array.isArray(media)) {
              for (const item of media.slice(0, 10)) {
                if (!item.alt_text || item.alt_text.trim() === '') {
                  const { data: existing } = await sb.from('agent_fixes')
                    .select('id')
                    .eq('user_id', user.id)
                    .eq('site_url', site.url)
                    .eq('issue_type', 'alt_text')
                    .eq('target_id', String(item.id))
                    .in('status', ['pending', 'approved'])
                    .maybeSingle();

                  if (!existing) {
                    const context = { filename: item.slug || 'image', page: item.post ? `Post ID: ${item.post}` : '' };
                    const proposedFix = await generateFix('alt_text', context);
                    if (proposedFix) {
                      const reasoning = await getTesseractReasoning('alt_text', site.name || site.url, proposedFix);
                      await sb.from('agent_fixes').insert({
                        user_id: user.id,
                        site_url: site.url,
                        site_name: site.name || site.url,
                        issue_type: 'alt_text',
                        issue_description: `Image "${item.slug || 'unknown'}" has no alt text`,
                        proposed_fix: proposedFix,
                        target_id: String(item.id),
                        target_type: 'media',
                        target_label: item.slug || `Image #${item.id}`,
                        points_impact: 2,
                        tesseract_reasoning: reasoning,
                        status: 'pending'
                      });
                      generated++;
                    }
                  }
                }
              }
            }
          }

        } catch(siteErr) {
          console.error('Site error:', site.url, siteErr.message);
        }
      }

      return generated;

  } catch(e) {
    console.error('generateFixesForUser error:', e.message);
    return 0;
  }
}
