const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { siteId, userId, url, platform, scanResult, previousScore, userEmail } = req.body;
  if (!url || !scanResult) return res.status(400).json({ error: 'Missing required fields' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let pageContent = '';
  let pageTitle = '';
  let metaDesc = '';
  try {
    const pageRes = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`);
    const pageJson = await pageRes.json();
    const html = pageJson.contents || '';
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i);
    pageTitle = titleMatch ? titleMatch[1].trim() : '';
    metaDesc = metaMatch ? metaMatch[1].trim() : '';
    pageContent = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,3000);
  } catch(e) { pageContent = `Website at ${url}`; }

  const issues = Object.values(scanResult.modules || {}).flatMap(m => m.issues || []);
  const criticalIssues = issues.filter(i => i.severity === 'critical');
  const scoreDrop = previousScore ? previousScore - scanResult.overall_score : 0;
  const fixes = [];

  if (issues.length > 0) {
    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 2000,
          messages: [{ role: 'user', content: `You are Forge AI's autonomous maintenance system. Generate intelligent context-aware fixes for this website.

WEBSITE: ${url}
PAGE TITLE: ${pageTitle || 'MISSING'}
META DESCRIPTION: ${metaDesc || 'MISSING'}
PAGE CONTENT: ${pageContent}

ISSUES:
${issues.map(i => `- [${i.severity.toUpperCase()}] ${i.name}: ${i.description}`).join('\n')}

Return ONLY raw JSON:
{"fixes":[{"issue":"<name>","severity":"<critical|high|medium>","field":"<meta_description|page_title|alt_text|heading|cta>","current":"<current or MISSING>","fixed_value":"<actual improved content specific to this site>","explanation":"<why this helps>","can_auto_apply":<true|false>}],"maintenance_summary":"<2-3 sentences>","priority_action":"<most important next step>"}

Rules: fixed_value must be specific to this website. Meta descriptions 120-160 chars. Titles under 60 chars. Everything must read naturally and professionally.` }]
        })
      });

      const claudeData = await claudeRes.json();
      if (claudeData.content) {
        let raw = claudeData.content.map(c => c.text || '').join('').trim().replace(/```json\s*/g,'').replace(/```\s*/g,'').trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          fixes.push(...(result.fixes || []));
          await sb.from('maintenance_logs').insert({
            user_id: userId, site_id: siteId, url, platform: platform || 'url',
            score: scanResult.overall_score, previous_score: previousScore || scanResult.overall_score,
            score_drop: scoreDrop, issues_found: issues.length, fixes_generated: fixes.length,
            auto_fixes: fixes.filter(f => f.can_auto_apply).length, fixes,
            summary: result.maintenance_summary, priority_action: result.priority_action,
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch(e) { console.error('Fix generation error:', e.message); }
  }

  const needsAlert = criticalIssues.length > 0 || scoreDrop >= 10;
  if (needsAlert && userEmail && fixes.length > 0) {
    try {
      await fetch('https://forge-ai-six-psi.vercel.app/api/send-maintenance-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: userEmail, url, score: scanResult.overall_score, previousScore, scoreDrop, fixes, criticalCount: criticalIssues.length, platform })
      });
    } catch(e) { console.error('Alert error:', e.message); }
  }

  return res.status(200).json({ success: true, issuesFound: issues.length, fixesGenerated: fixes.length, fixes, needsAlert });
};
