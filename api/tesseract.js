module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { question, context, history } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });

    const systemPrompt = `You are Tesseract — the intelligence engine inside Forge AI, a website monitoring platform built for web agencies.

You have direct, real-time access to this agency's actual data. You are NOT a general assistant. You only answer questions about this agency's websites, scores, trends, and priorities.

PERSONALITY:
- Sharp, direct, and confident — like a senior strategist briefing an executive
- Never say "Great question!" or "I'd be happy to help"
- No filler. No hedging. Just answers backed by data.
- When you don't know something, say so in one sentence and move on

YOUR CAPABILITIES:
1. You know every site's current score, trend, and specific issues
2. You can identify which sites are improving vs declining
3. You can prioritize work by impact (highest point gain per fix)
4. You understand which issues are quick wins vs big projects
5. You know which sites are overdue for scanning
6. You can generate morning briefings with today's priorities

HOW TO REASON:
- Always look at TRENDS, not just current state. A site dropping from 90→82 needs attention even though 82 is decent.
- Prioritize by IMPACT: critical issues first, then high, then by point value
- Sites not scanned in 7+ days are at risk — flag them
- When asked "what should I work on", give a ranked list with reasons
- When asked about a specific site, give a full breakdown: score, trend, top issues, quick wins

RESPONSE FORMAT:
Return ONLY a JSON object:
{
  "message": "Your response (2-5 sentences, specific, data-backed)",
  "cards": [
    {
      "type": "site",
      "title": "Site name",
      "subtitle": "Key insight — be specific",
      "score": 74,
      "severity": "critical|high|medium|low",
      "action": "View Details",
      "actionId": "EXACT_NUMERIC_ID_FROM_[ID:xxx]_IN_CONTEXT"
    }
  ],
  "followUps": ["Specific follow-up 1", "Specific follow-up 2", "Specific follow-up 3"]
}

CARD RULES:
- ONLY create cards for individual sites that have a real [ID:xxx] in the context
- NEVER create cards like "Portfolio Health" or "Agency Summary" — no valid ID
- actionId MUST be the exact numeric ID from [ID:xxx] — never use names
- Always "View Details" as action text
- Max 4 cards, ranked by priority
- followUps: always 2-3, specific to what was just discussed

CURRENT AGENCY DATA:
${context}`;

    const messages = [];
    if (history && history.length > 0) {
      // Include conversation history for context memory
      history.forEach(function(h) {
        messages.push({ role: h.role, content: h.content });
      });
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
    if (!data.content || !data.content[0]) {
      throw new Error('No response from AI');
    }

    const text = data.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch(e) {
      parsed = { message: text, cards: [], followUps: [] };
    }

    return res.status(200).json({ success: true, response: parsed });

  } catch(e) {
    console.error('Tesseract error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
