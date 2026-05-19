const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (req.method !== 'GET' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('Scheduled scan started:', new Date().toISOString());

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data: sites, error } = await sb
      .from('scheduled_sites')
      .select('*')
      .eq('active', true);

    if (error) throw error;
    if (!sites || sites.length === 0) {
      return res.status(200).json({ message: 'No sites to scan', scanned: 0 });
    }

    const results = [];

    for (const site of sites) {
      try {
        let pageData = `URL: ${site.url}\nAnalyze based on domain.`;
        try {
          const pageRes = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(site.url)}`);
          const pageJson = await pageRes.json();
          const html = pageJson.contents || '';
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i);
          const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
          pageData = `URL: ${site.url}
Title: "${titleMatch ? titleMatch[1] : 'Not found'}"
Meta Description: "${metaMatch ? metaMatch[1] : 'MISSING'}"
H1: "${h1Match ? h1Match[1] : 'NONE FOUND'}"`;
        } catch (fetchErr) {
          console.log(`Could not fetch ${site.url}`);
        }

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

        await sb.from('scan_results').insert({
          site_id: site.id,
          user_id: site.user_id,
          url: site.url,
          score: scanResult.overall_score,
          grade: scanResult.grade,
          result: scanResult,
          scanned_at: new Date().toISOString(),
          critical_issues: scanResult.critical_issues || []
        });

        const previousScore = site.last_score || 100;
        const scoreDrop = previousScore - scanResult.overall_score;
        const hasCritical = (scanResult.critical_issues || []).length > 0;

        await sb.from('scheduled_sites').update({
          last_score: scanResult.overall_score,
          last_scanned: new Date().toISOString(),
          has_critical: hasCritical
        }).eq('id', site.id);

        results.push({
          url: site.url,
          score: scanResult.overall_score,
          previousScore,
          scoreDrop,
          hasCritical,
          needsAlert: hasCritical || scoreDrop >= 10
        });

      } catch (siteErr) {
        results.push({ url: site.url, error: siteErr.message });
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    return res.status(200).json({
      message: 'Scheduled scan complete',
      scanned: results.filter(r => !r.error).length,
      total: sites.length,
      results
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
