// api/scheduled-scan.js
// This runs automatically every day at 8am UTC
// It scans all sites registered in Supabase and saves results

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

module.exports = async (req, res) => {
  // Security check - only allow Vercel cron or manual trigger with secret
  const authHeader = req.headers.authorization;
  if (req.method !== 'GET' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('Scheduled scan started:', new Date().toISOString());

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Get all sites that need scanning from Supabase
    const { data: sites, error } = await sb
      .from('scheduled_sites')
      .select('*')
      .eq('active', true);

    if (error) throw error;
    if (!sites || sites.length === 0) {
      return res.status(200).json({ message: 'No sites to scan', scanned: 0 });
    }

    console.log(`Found ${sites.length} sites to scan`);

    const results = [];

    for (const site of sites) {
      try {
        console.log(`Scanning: ${site.url}`);

        // Fetch page content
        let pageData = `URL: ${site.url}\nAnalyze based on domain.`;
        try {
          const pageRes = await fetch(
            `https://api.allorigins.win/get?url=${encodeURIComponent(site.url)}`
          );
          const pageJson = await pageRes.json();
          const html = pageJson.contents || '';

          // Simple text extraction
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i);
          const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

          pageData = `URL: ${site.url}
Title: "${titleMatch ? titleMatch[1] : 'Not found'}"
Meta Description: "${metaMatch ? metaMatch[1] : 'MISSING'}"
H1: "${h1Match ? h1Match[1] : 'NONE FOUND'}"`;
        } catch (fetchErr) {
          console.log(`Could not fetch ${site.url}:`, fetchErr.message);
        }

        // Call Claude API
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 1500,
            messages: [{
              role: 'user',
              content: `Analyze this website and return ONLY raw JSON no markdown:
${pageData}

{"overall_score":<0-100>,"grade":"<A-F>","site_name":"<name>","summary":"<2 sentences>","modules":{"seo":{"score":<0-20>,"issues":[{"name":"<issue>","description":"<detail>","severity":"<critical|high|medium>","deduction":<int>}]},"speed":{"score":<0-20>,"issues":[{"name":"<issue>","description":"<detail>","severity":"<critical|high|medium>","deduction":<int>}]},"mobile":{"score":<0-20>,"issues":[{"name":"<issue>","description":"<detail>","severity":"<critical|high|medium>","deduction":<int>}]},"ux":{"score":<0-20>,"issues":[{"name":"<issue>","description":"<detail>","severity":"<critical|high|medium>","deduction":<int>}]},"maintenance":{"score":<0-20>,"issues":[{"name":"<issue>","description":"<detail>","severity":"<critical|high|medium>","deduction":<int>}]}},"critical_issues":[<list of critical issue names>]}`
            }]
          })
        });

        const claudeData = await claudeRes.json();
        if (!claudeData.content) throw new Error('No response from Claude');

        let raw = claudeData.content.map(c => c.text || '').join('').trim();
        raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in response');
        const scanResult = JSON.parse(jsonMatch[0]);

        // Save scan result to Supabase
        const { error: saveError } = await sb
          .from('scan_results')
          .insert({
            site_id: site.id,
            user_id: site.user_id,
            url: site.url,
            score: scanResult.overall_score,
            grade: scanResult.grade,
            result: scanResult,
            scanned_at: new Date().toISOString(),
            critical_issues: scanResult.critical_issues || []
          });

        if (saveError) console.error('Save error:', saveError);

        // Check if score dropped significantly or critical issues found
        const previousScore = site.last_score || 100;
        const scoreDrop = previousScore - scanResult.overall_score;
        const hasCritical = (scanResult.critical_issues || []).length > 0;

        // Update site with latest score
        await sb
          .from('scheduled_sites')
          .update({
            last_score: scanResult.overall_score,
            last_scanned: new Date().toISOString(),
            has_critical: hasCritical
          })
          .eq('id', site.id);

        const needsAlert = hasCritical || scoreDrop >= 10;

        // Send email alert if critical issues found or score dropped
        if (needsAlert && site.user_email) {
          try {
            await fetch(`${process.env.VERCEL_URL || 'https://forge-ai-six-psi.vercel.app'}/api/send-alert`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: site.user_email,
                siteName: site.name || site.url,
                siteUrl: site.url,
                score: scanResult.overall_score,
                criticalIssues: scanResult.critical_issues || [],
                dashboardUrl: 'https://forge-ai-six-psi.vercel.app/forge-ai-dashboard.html'
              })
            });
            console.log(`Alert sent to ${site.user_email} for ${site.url}`);
          } catch (alertErr) {
            console.error('Alert send failed:', alertErr.message);
          }
        }

        results.push({
          url: site.url,
          score: scanResult.overall_score,
          previousScore,
          scoreDrop,
          hasCritical,
          needsAlert
        });

        console.log(`✓ ${site.url} scored ${scanResult.overall_score}/100`);

      } catch (siteErr) {
        console.error(`✗ Failed to scan ${site.url}:`, siteErr.message);
        results.push({ url: site.url, error: siteErr.message });
      }

      // Wait 2 seconds between scans to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));
    }

    const successful = results.filter(r => !r.error).length;
    const needAlerts = results.filter(r => r.needsAlert).length;

    console.log(`Scan complete: ${successful}/${sites.length} successful, ${needAlerts} need alerts`);

    return res.status(200).json({
      message: 'Scheduled scan complete',
      scanned: successful,
      total: sites.length,
      needAlerts,
      results
    });

  } catch (err) {
    console.error('Scheduled scan error:', err);
    return res.status(500).json({ error: err.message });
  }
};
