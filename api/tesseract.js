const Sentry = require("@sentry/node");
Sentry.init({ dsn: "https://b906d32b0d61fe5bf13af61abaf76755@o4511809521713152.ingest.us.sentry.io/4511813224431616", environment: "production" });

// ── SUPABASE RATE LIMITING ─────────────────────────────────
// Uses Supabase instead of in-memory Map — works correctly
// across all serverless function instances and cold starts.
async function rateLimitDB(sb, key, maxRequests, windowMs) {
  try {
    const now = new Date();
    const resetAt = new Date(Date.now() + windowMs);

    // Try to get existing record
    const { data: existing } = await sb
      .from('rate_limits')
      .select('count, reset_at')
      .eq('key', key)
      .maybeSingle();

    if (!existing || new Date(existing.reset_at) < now) {
      // No record or expired — create/reset
      await sb.from('rate_limits').upsert({
        key,
        count: 1,
        reset_at: resetAt.toISOString()
      }, { onConflict: 'key' });
      return { allowed: true, remaining: maxRequests - 1 };
    }

    if (existing.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt: existing.reset_at };
    }

    // Increment count
    await sb.from('rate_limits')
      .update({ count: existing.count + 1 })
      .eq('key', key);

    return { allowed: true, remaining: maxRequests - existing.count - 1 };
  } catch(e) {
    // If rate limiting fails, allow the request rather than blocking legitimate users
    console.error('Rate limit DB error (allowing request):', e.message);
    return { allowed: true, remaining: -1 };
  }
}


module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { createClient } = require('@supabase/supabase-js');

  try {
    const authHeader = req.headers.authorization;
    const internalKey = req.headers['x-internal'];
    const isInternal = internalKey === process.env.CRON_SECRET;

    if (!isInternal) {
      if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await sb.auth.getUser(token);
      if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

      // Per-user rate limiting — 20 requests per minute
      const rlResult = await rateLimitDB(sb, 'tesseract:' + user.id, 20, 60000);
      if (!rlResult.allowed) {
        return res.status(429).json({ error: 'Too many requests. Please wait a moment before sending another message.' });
      }

      // Tesseract requires Agency or Enterprise plan
      // For team members, check the agency owner's plan
      let planEmail = user.email;
      const { data: memberRecord } = await sb.from('team_members')
        .select('agency_id, role')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();

      if (memberRecord && memberRecord.agency_id) {
        // Get owner's email for plan check
        const { data: { users: allUsers } } = await sb.auth.admin.listUsers();
        const ownerUser = allUsers && allUsers.find(u => u.id === memberRecord.agency_id);
        if (ownerUser) planEmail = ownerUser.email;
      }

      const { data: sub } = await sb.from('subscriptions')
        .select('plan')
        .eq('email', planEmail)
        .maybeSingle();

      const plan = (sub && sub.plan) ? sub.plan : 'free';
      // Starter can use Tesseract for report summary generation only
      const isReportSummary = req.body && req.body.context === 'Single site report. Return only message text, no cards.';
      if (plan !== 'agency' && plan !== 'enterprise' && plan !== 'starter') {
        return res.status(403).json({ error: 'Tesseract requires the Starter plan or higher.' });
      }
      if (plan === 'starter' && !isReportSummary) {
        return res.status(403).json({ error: 'Full Tesseract requires the Agency plan or higher.' });
      }
    }

    const { question, context, history, userId } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });

    // Fetch recent reports for this user
    let reportsContext = '';
    try {
      if (userId) {
        const { data: reports } = await sb
          .from('client_reports')
          .select('site_name, site_url, client_name, client_email, score, grade, sent_at')
          .eq('user_id', userId)
          .order('sent_at', { ascending: false })
          .limit(20);

        if (reports && reports.length > 0) {
          reportsContext = '\nCLIENT REPORTS SENT (most recent first):\n';
          reports.forEach(function(r) {
            var daysAgo = Math.floor((Date.now() - new Date(r.sent_at)) / 86400000);
            var when = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : daysAgo + ' days ago';
            reportsContext += '  - Sent to ' + (r.client_name || r.client_email || 'unknown client');
            if (r.client_email) reportsContext += ' (' + r.client_email + ')';
            reportsContext += ' for ' + (r.site_name || r.site_url || 'unknown site');
            if (r.score) reportsContext += ' — score: ' + r.score + '/100';
            reportsContext += ' — ' + when + '\n';
          });
        }
      }
    } catch(reportsErr) {
      console.log('Reports fetch error (non-fatal):', reportsErr.message);
    }

    // ── FETCH ALL DATA SERVER-SIDE ─────────────────────────
    // Tesseract builds its own complete intelligence context
    // from Supabase directly — not relying on the dashboard client

    let serverContext = '';
    try {
      const dataUserId = memberRecord ? memberRecord.agency_id : user.id;

      // Fetch all sites with full data
      const { data: allSites } = await sb.from('user_sites')
        .select('site_id, name, url, platform, score, last_scanned, last_result, score_history, client_name, client_email, wp_username, auto_scan, auto_fix, scan_count')
        .eq('user_id', dataUserId)
        .order('score', { ascending: true });

      // Fetch security findings
      const { data: secFindings } = await sb.from('security_findings')
        .select('site_id, finding_id, category, title, severity, confidence, evidence, fix, first_detected_at, last_detected_at, resolved_at, scan_count')
        .eq('user_id', dataUserId)
        .is('resolved_at', null)
        .order('severity', { ascending: true })
        .limit(100);

      // Fetch team members
      const { data: teamMembers } = await sb.from('team_members')
        .select('user_id, role, status, created_at')
        .eq('agency_id', dataUserId)
        .eq('status', 'active');

      // Fetch recent alerts
      const { data: recentAlerts } = await sb.from('site_alerts')
        .select('site_url, message, severity, created_at, resolved')
        .eq('user_id', dataUserId)
        .order('created_at', { ascending: false })
        .limit(10);

      // Fetch client portals
      const { data: portals } = await sb.from('client_portals')
        .select('site_url, site_name, client_email, token, created_at, last_accessed_at')
        .eq('user_id', dataUserId)
        .limit(20);

      // Fetch agent jobs
      const { data: agentJobs } = await sb.from('agent_jobs')
        .select('site_url, fix_type, status, created_at, completed_at')
        .eq('user_id', dataUserId)
        .order('created_at', { ascending: false })
        .limit(20);

      // ── BUILD SERVER CONTEXT ───────────────────────────────
      const today = new Date();
      serverContext += '\n=== LIVE DATABASE CONTEXT (fetched ' + today.toISOString() + ') ===\n';

      // Portfolio summary
      const sites = allSites || [];
      const scanned = sites.filter(s => s.score !== null);
      const avgScore = scanned.length > 0 ? Math.round(scanned.reduce((a, s) => a + s.score, 0) / scanned.length) : 0;
      const critical = sites.filter(s => s.score !== null && s.score < 60);
      const needsWork = sites.filter(s => s.score !== null && s.score < 80);

      serverContext += '\nPORTFOLIO SUMMARY:\n';
      serverContext += '  Total sites: ' + sites.length + '\n';
      serverContext += '  Scanned: ' + scanned.length + '\n';
      serverContext += '  Average score: ' + avgScore + '/100\n';
      serverContext += '  Critical (below 60): ' + critical.length + '\n';
      serverContext += '  Needs work (below 80): ' + needsWork.length + '\n';

      // Platform breakdown
      const platforms = {};
      sites.forEach(s => { const p = s.platform || 'other'; platforms[p] = (platforms[p] || 0) + 1; });
      serverContext += '  Platforms: ' + Object.entries(platforms).map(([p, n]) => p + ': ' + n).join(', ') + '\n';

      // Site details
      if (sites.length > 0) {
        serverContext += '\nSITE DETAILS:\n';
        sites.forEach(s => {
          serverContext += '\n  [' + s.site_id + '] ' + (s.name || s.url) + '\n';
          serverContext += '    URL: ' + s.url + '\n';
          serverContext += '    Platform: ' + (s.platform || 'unknown') + '\n';
          serverContext += '    Score: ' + (s.score !== null ? s.score + '/100' : 'never scanned') + '\n';
          if (s.client_name) serverContext += '    Client: ' + s.client_name + (s.client_email ? ' <' + s.client_email + '>' : '') + '\n';
          if (s.last_scanned) {
            const days = Math.floor((Date.now() - new Date(s.last_scanned)) / 86400000);
            serverContext += '    Last scanned: ' + (days === 0 ? 'today' : days + ' days ago') + '\n';
          }
          if (s.auto_scan) serverContext += '    Auto-scan: enabled\n';
          // Score history
          if (s.score_history && s.score_history.length > 1) {
            const hist = s.score_history.slice(-5);
            const scores = hist.map(h => h.score !== undefined ? h.score : h);
            serverContext += '    Score history: ' + scores.join(' → ') + '\n';
            const trend = scores[scores.length - 1] - scores[0];
            if (trend <= -5) serverContext += '    TREND: DECLINING (' + trend + ' pts)\n';
            else if (trend >= 5) serverContext += '    TREND: IMPROVING (+' + trend + ' pts)\n';
          }
          // Module scores from last result
          if (s.last_result && s.last_result.modules) {
            const mods = s.last_result.modules;
            const modScores = Object.entries(mods)
              .filter(([, m]) => m && m.score !== undefined)
              .map(([name, m]) => name.toUpperCase() + ': ' + m.score + '/20');
            if (modScores.length) serverContext += '    Modules: ' + modScores.join(', ') + '\n';
            // Top issues
            const deductions = Object.entries(mods).flatMap(([mod, m]) =>
              m && m.deductions ? m.deductions.map(d => ({ ...d, module: mod })) : []
            ).sort((a, b) => (b.points || 0) - (a.points || 0));
            if (deductions.length > 0) {
              serverContext += '    Top issues:\n';
              deductions.slice(0, 5).forEach(d => {
                serverContext += '      [' + (d.severity || 'MEDIUM') + '] ' + d.issue + ' (' + (d.points || 0) + ' pts)\n';
              });
            }
          }
        });
      }

      // Security findings
      const activeFindings = secFindings || [];
      if (activeFindings.length > 0) {
        serverContext += '\nACTIVE SECURITY FINDINGS (' + activeFindings.length + ' unresolved):\n';
        const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
        activeFindings.forEach(f => { if (bySeverity[f.severity]) bySeverity[f.severity].push(f); });
        ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].forEach(sev => {
          if (bySeverity[sev].length > 0) {
            serverContext += '  ' + sev + ' (' + bySeverity[sev].length + '):\n';
            bySeverity[sev].slice(0, 5).forEach(f => {
              // Find site name
              const site = sites.find(s => s.site_id === f.site_id);
              const siteName = site ? (site.name || site.url) : f.site_id;
              serverContext += '    - ' + siteName + ': ' + f.title + '\n';
              serverContext += '      First detected: ' + (f.first_detected_at ? new Date(f.first_detected_at).toLocaleDateString() : 'unknown') + '\n';
              serverContext += '      Fix: ' + (f.fix || 'See dashboard') + '\n';
            });
          }
        });
      }

      // Team members
      if (teamMembers && teamMembers.length > 0) {
        serverContext += '\nTEAM MEMBERS (' + teamMembers.length + ' active):\n';
        teamMembers.forEach(m => {
          serverContext += '  - ' + m.role + ' (joined ' + (m.created_at ? new Date(m.created_at).toLocaleDateString() : 'unknown') + ')\n';
        });
      }

      // Recent alerts
      if (recentAlerts && recentAlerts.length > 0) {
        serverContext += '\nRECENT ALERTS:\n';
        recentAlerts.forEach(a => {
          serverContext += '  - ' + (a.site_url || 'unknown') + ': ' + (a.message || 'alert') + ' [' + (a.severity || 'medium') + ']\n';
        });
      }

      // Client portals
      if (portals && portals.length > 0) {
        serverContext += '\nCLIENT PORTALS (' + portals.length + '):\n';
        portals.forEach(p => {
          const lastAccess = p.last_accessed_at ? Math.floor((Date.now() - new Date(p.last_accessed_at)) / 86400000) : null;
          serverContext += '  - ' + (p.site_name || p.site_url) + ' — ' + (p.client_email || 'no email');
          if (lastAccess !== null) serverContext += ' — last accessed ' + (lastAccess === 0 ? 'today' : lastAccess + ' days ago');
          serverContext += '\n';
        });
      }

      // Agent jobs
      if (agentJobs && agentJobs.length > 0) {
        serverContext += '\nFORGE AGENT JOBS (recent):\n';
        agentJobs.forEach(j => {
          serverContext += '  - ' + (j.site_url || 'unknown') + ': ' + (j.fix_type || 'fix') + ' — ' + (j.status || 'pending') + '\n';
        });
      }

      serverContext += '\n=== END LIVE DATABASE CONTEXT ===\n';

    } catch(dataErr) {
      console.error('Server context fetch error (non-fatal):', dataErr.message);
      serverContext = '\n[Note: Live database context unavailable — using dashboard context only]\n';
    }

    const systemPrompt = `You are Tesseract — the intelligence engine inside Forge AI, a website monitoring platform for web agencies.

You have direct access to this agency's real data. You are a strategic business intelligence engine, not a general assistant.

WHAT YOU ARE:
A senior digital strategist who has been working with this agency for months. You know their portfolio deeply. You think in terms of business impact, patterns, and priorities — not just raw data.

PERSONALITY:
- Sharp, direct, confident. Like a trusted advisor who cuts through noise.
- Never say "Great question!" or "I'd be happy to help" or "Certainly!"
- No filler. No hedging. If you have an opinion, state it.
- When something is urgent, say it is urgent. When something can wait, say so.
- Short answers when the question is simple. Detailed when it matters.

WHAT YOU KNOW ABOUT EACH SITE:
- Platform (WordPress, Webflow, Wix, Ghost, Squarespace, Framer, Shopify, etc.)
- Health scores, module breakdowns, issue lists — fetched live from database
- Score trends and full history
- Client name and email (if set)
- Ghost Intelligence data (for Ghost sites) — post count, missing meta descriptions, missing feature images, untagged posts
- Analytics data (if available) — visitor counts, top pages, device breakdown, traffic trends
- Reports sent — when the last report was sent to each client
- Security findings — every active unresolved security issue, severity, when first detected, fix instructions
- WordPress sites — plugin data, user data, security check results
- Team members — who is on the agency team and their roles
- Client portals — which clients have portal access and when they last viewed it
- Forge Agent jobs — what automated fixes have been run and their status
- Alerts — recent monitoring alerts across the portfolio

USE PLATFORM KNOWLEDGE:
- When discussing Ghost sites, reference Ghost Intelligence data if available (missing meta, feature images, etc.)
- When an agency asks about a platform (e.g. "my Webflow sites"), filter to only those sites
- Mention platform-specific context: "Ghost handles SSL automatically" or "Webflow sites tend to score well on performance"

USE REPORTS DATA:
- If a report was sent recently (within 7 days), note that the client has been updated
- If no report has been sent in 30+ days for a site with a client, flag it as overdue for reporting
- Example: "You sent a report to John (john@example.com) for ClientSite.com 2 weeks ago when it was scoring 74."

USE ANALYTICS DATA:
- If analytics data is in context, reference visitor trends
- Flag sites where traffic is declining alongside score drops — double warning signal

HOW TO THINK AND REASON:

1. PATTERNS OVER SNAPSHOTS
   - Don't just report current scores. Look at trends. A site at 84 dropping from 92 is more urgent than a site stuck at 75.
   - Identify SYSTEMIC issues — when the same problem appears on 3+ sites, that is a portfolio-wide gap, not a one-off.
   - Flag sites that have been stuck (no score change) for multiple scans — stagnation is a warning sign.

2. BUSINESS IMPACT FRAMING
   - Translate technical issues into business consequences:
     * Missing H1/meta description = losing Google rankings and organic traffic
     * Slow LCP/PageSpeed = visitors leaving before the page loads
     * No CTA = losing leads and conversions
     * No HTTPS = destroying visitor trust and Google ranking
     * Mobile issues = broken for 60%+ of visitors
     * Missing alt text = accessibility and SEO gap
   - Always connect the technical problem to what it means for the client's business.

3. PRIORITIZATION WITH JUDGMENT
   - Critical sites (below 60) need immediate escalation, not just a note.
   - Declining sites need more urgency than low-scoring but stable sites.
   - Sites with clients attached are higher priority — there is a business relationship at stake.
   - Quick wins (high point fixes in under 15 minutes) should always be called out.

4. ESCALATION DETECTION
   - If a site has been critical for multiple scans with no improvement, flag it explicitly.
   - If a site is declining consistently, warn that it will cross a threshold soon.
   - If overdue sites have clients attached, note the reputational risk.

5. PORTFOLIO INTELLIGENCE
   - Use the SYSTEMIC ISSUES section to identify agency-wide patterns.
   - When a pattern exists across multiple sites, recommend a systematic fix rather than site-by-site.
   - Track which sites are improving vs stuck vs declining as a group.

6. MORNING BRIEFING INTELLIGENCE
   - When asked for a briefing, structure it as: (1) what is urgent today, (2) what is improving, (3) what to watch.
   - Be specific — name sites, name issues, give point values.
   - End with one clear recommendation for what to do first.

RESPONSE FORMAT — return ONLY this JSON:
{
  "message": "Your response. Direct, specific, data-backed. Use real site names and real numbers. 2-5 sentences unless more detail is genuinely needed.",
  "cards": [
    {
      "type": "site",
      "title": "Site name",
      "subtitle": "Specific insight with business impact",
      "score": 74,
      "severity": "critical|high|medium|low",
      "action": "View Details",
      "actionId": "EXACT_NUMERIC_ID_FROM_[ID:xxx]_IN_CONTEXT"
    }
  ],
  "followUps": ["Specific follow-up 1", "Specific follow-up 2", "Specific follow-up 3"]
}

STRICT CARD RULES:
- ONLY create cards for sites with a real [ID:xxx] in the context. Never for summaries or patterns.
- actionId MUST be the exact numeric ID from [ID:xxx]. Never a name.
- action text options: "View Details" (default), "Scan Now" (if overdue), "View Details" (for issues/fixes)
- Max 4 cards, ranked by urgency.
- followUps: always 2-3, specific to what was just discussed — not generic.

CURRENT AGENCY DATA:
${context}${reportsContext}${serverContext}`;

    const messages = [];
    if (history && history.length > 0) {
      history.forEach(h => messages.push({ role: h.role, content: h.content }));
    }
    messages.push({ role: 'user', content: question });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: messages
      })
    });

    const data = await response.json();
    if (!data.content || !data.content[0]) throw new Error('No response from AI');

    const text = data.content[0].text.trim();
    // Strip any text before the first { to handle cases where model adds preamble
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    let clean = text;
    if (jsonStart !== -1 && jsonEnd !== -1) {
      clean = text.slice(jsonStart, jsonEnd + 1);
    } else {
      clean = text.replace(/```json|```/g, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch(e) {
      // If JSON parse fails, return the text before the JSON as the message
      const preJson = jsonStart > 0 ? text.slice(0, jsonStart).trim() : text;
      parsed = { message: preJson || text, cards: [], followUps: [] };
    }

    return res.status(200).json({ success: true, response: parsed });

  } catch(e) {
    console.error('Tesseract error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
