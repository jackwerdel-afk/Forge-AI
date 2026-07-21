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
      if (plan !== 'agency' && plan !== 'enterprise') {
        return res.status(403).json({ error: 'Tesseract requires the Agency plan or higher.' });
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
- Health scores, module breakdowns, issue lists
- Score trends and history
- Client name and email (if set)
- Ghost Intelligence data (for Ghost sites) — post count, missing meta descriptions, missing feature images, untagged posts
- Analytics data (if available) — visitor counts, top pages, device breakdown, traffic trends
- Reports sent — when the last report was sent to each client

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
${context}${reportsContext}`;

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
