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

async function generateFix(issue, context, anthropicKey) {
  const prompts = {
    meta_description: `Write a meta description for this webpage. Return ONLY the meta description text. 120-160 characters. Professional tone. Never use the word I.\n\nPage: ${context}`,
    alt_text: `Write alt text for an image. Return ONLY the alt text. Under 125 characters. Descriptive and professional. Never use the word I.\n\nImage filename: ${context.filename || 'image'}\nPage: ${context.page || ''}`,
    page_title: `Rewrite this page title to under 60 characters. Return ONLY the new title. Professional tone.\n\nCurrent title: ${context}`
  };

  const prompt = prompts[issue];
  if (!prompt) return null;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'You are an SEO expert. Never use the word I. Return only the requested content with no explanation.',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  return data.content?.[0]?.text?.trim() || null;
}

async function applyFixToWordPress(siteUrl, credentials, fix) {
  const { type, postId, value } = fix;
  const authHeader = 'Basic ' + credentials;

  if (type === 'meta_description') {
    // Update via Yoast SEO meta or post meta
    const response = await fetch(`${siteUrl}/wp-json/wp/v2/posts/${postId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({
        meta: { _yoast_wpseo_metadesc: value, _forge_meta_description: value }
      })
    });
    return response.ok;
  }

  if (type === 'page_title') {
    const response = await fetch(`${siteUrl}/wp-json/wp/v2/posts/${postId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({ title: value })
    });
    return response.ok;
  }

  if (type === 'alt_text') {
    const response = await fetch(`${siteUrl}/wp-json/wp/v2/media/${fix.mediaId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({ alt_text: value })
    });
    return response.ok;
  }

  return false;
}

async function getPagesWithIssues(siteUrl, credentials) {
  const authHeader = 'Basic ' + credentials;
  const issues = [];

  try {
    // Get published posts and pages
    const [postsRes, pagesRes] = await Promise.all([
      fetch(`${siteUrl}/wp-json/wp/v2/posts?per_page=20&status=publish`, {
        headers: { 'Authorization': authHeader }
      }),
      fetch(`${siteUrl}/wp-json/wp/v2/pages?per_page=20&status=publish`, {
        headers: { 'Authorization': authHeader }
      })
    ]);

    const posts = postsRes.ok ? await postsRes.json() : [];
    const pages = pagesRes.ok ? await pagesRes.json() : [];
    const allContent = [...posts, ...pages];

    for (const item of allContent) {
      // Check meta description
      const meta = item.meta || {};
      const metaDesc = meta._yoast_wpseo_metadesc || meta._forge_meta_description || '';
      if (!metaDesc || metaDesc.length < 10) {
        issues.push({
          type: 'meta_description',
          postId: item.id,
          context: `Title: ${item.title?.rendered || ''}\nContent: ${(item.content?.rendered || '').replace(/<[^>]+>/g, ' ').slice(0, 500)}`
        });
      }

      // Check title length
      const title = item.title?.rendered || '';
      if (title.length > 60) {
        issues.push({
          type: 'page_title',
          postId: item.id,
          context: title
        });
      }
    }

    // Check media for missing alt text
    const mediaRes = await fetch(`${siteUrl}/wp-json/wp/v2/media?per_page=20`, {
      headers: { 'Authorization': authHeader }
    });
    if (mediaRes.ok) {
      const media = await mediaRes.json();
      for (const item of media) {
        if (!item.alt_text || item.alt_text.trim() === '') {
          issues.push({
            type: 'alt_text',
            mediaId: item.id,
            context: {
              filename: item.slug || 'image',
              page: item.post ? `Post ID: ${item.post}` : ''
            }
          });
        }
      }
    }

  } catch(e) {
    console.error('Get pages error:', e.message);
  }

  return issues;
}

module.exports = async (req, res) => {
  // Only allow internal calls from scheduled scan or manual trigger
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const anthropicKey = process.env.ANTHROPIC_KEY;
  const results = { fixed: 0, failed: 0, sites: [] };

  try {
    // Get all WordPress sites with auto-fix enabled and credentials stored
    const { data: sites, error } = await sb
      .from('scheduled_sites')
      .select('*')
      .eq('active', true)
      .eq('auto_fix', true)
      .eq('platform', 'wordpress')
      .not('wp_credentials', 'is', null);

    if (error) throw error;
    if (!sites || sites.length === 0) {
      return res.status(200).json({ message: 'No WordPress sites with auto-fix enabled', ...results });
    }

    console.log(`Auto-maintain: processing ${sites.length} WordPress sites`);

    for (const site of sites) {
      try {
        // Decrypt credentials
        const credentials = decrypt(site.wp_credentials);
        if (!credentials) {
          console.log('Could not decrypt credentials for:', site.url);
          continue;
        }

        // Save "starting" alert
        await sb.from('realtime_alerts').insert({
          user_id: site.user_id,
          url: site.url,
          site_name: site.name || site.url,
          message: 'Issues detected — Forge AI auto-fix is starting now.',
          severity: 'medium',
          read: false,
          created_at: new Date().toISOString()
        });

        // Get pages with issues
        const issues = await getPagesWithIssues(site.url, credentials);
        console.log(`Found ${issues.length} issues on ${site.url}`);

        if (issues.length === 0) continue;

        // Fix each issue
        const fixedItems = [];
        for (const issue of issues.slice(0, 20)) { // max 20 fixes per site per run
          try {
            const fixValue = await generateFix(issue.type, issue.context, anthropicKey);
            if (!fixValue) continue;

            const applied = await applyFixToWordPress(site.url, credentials, {
              ...issue,
              value: fixValue
            });

            if (applied) {
              fixedItems.push(`${issue.type.replace(/_/g, ' ')} on post ${issue.postId || issue.mediaId}`);
              results.fixed++;
            } else {
              results.failed++;
            }
          } catch(fixErr) {
            console.error('Fix error:', fixErr.message);
            results.failed++;
          }
        }

        // Save "complete" alert
        if (fixedItems.length > 0) {
          await sb.from('realtime_alerts').insert({
            user_id: site.user_id,
            url: site.url,
            site_name: site.name || site.url,
            message: `Auto-fix complete — ${fixedItems.length} issue${fixedItems.length !== 1 ? 's' : ''} resolved: ${fixedItems.slice(0, 3).join(', ')}${fixedItems.length > 3 ? ' and more' : ''}.`,
            severity: 'medium',
            read: false,
            created_at: new Date().toISOString()
          });

          results.sites.push({ url: site.url, fixed: fixedItems.length });
        }

      } catch(siteErr) {
        console.error('Site error for', site.url, ':', siteErr.message);
      }
    }

    return res.status(200).json({
      message: `Auto-maintain complete. Fixed ${results.fixed} issues across ${results.sites.length} sites.`,
      ...results
    });

  } catch(err) {
    console.error('Auto-maintain error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
