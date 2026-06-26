const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { question, context, history } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });

    // Build system prompt with agency context
    const systemPrompt = `You are Tesseract, the intelligence engine inside Forge AI — a website monitoring platform for web agencies.

You have direct access to this agency's real data. You are NOT a general assistant. You only answer questions about this agency's websites, performance, and work priorities.

Your personality: sharp, direct, concise. You speak like a senior strategist, not a chatbot. No filler phrases. No "Great question!" No "I'd be happy to help." Just answers.

Current agency data:
${context}

Rules:
- Only discuss this agency's actual data
- Always be specific — use real site names, real scores, real issues
- When recommending work, prioritize by impact (critical issues first, then high, then medium)
- Keep responses concise — agencies are busy
- Format responses as JSON with this structure:
{
  "message": "Your main response text (2-4 sentences max, direct and specific)",
  "cards": [
    {
      "type": "site|alert|action|insight",
      "title": "Site name or card title",
      "subtitle": "Key insight about this site",
      "score": 85,
      "severity": "critical|high|medium|low",
      "action": "View Details",
      "actionId": "EXACT_NUMERIC_ID_FROM_[ID:xxx]_IN_CONTEXT"
    }
  ],
  "followUps": ["Specific follow-up question 1", "Specific follow-up question 2", "Specific follow-up question 3"]
}
CRITICAL RULES:
- actionId MUST be the exact numeric ID from [ID:xxx] in the context data. Never use site names as actionId.
- Always use "View Details" as the action text — never "View Issues" or "View Site"
- Cards: only include when showing specific sites. Max 4 cards.
- followUps: always include 2-3 specific follow-up questions relevant to what was just discussed
- message: be direct, specific, use real numbers from the data
Return ONLY the JSON object, no markdown, no other text.`;

    // Build conversation history
    const messages = [];
    if (history && history.length > 0) {
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
      // If JSON parse fails, return as plain message
      parsed = { message: text, cards: [], followUps: [] };
    }

    return res.status(200).json({ success: true, response: parsed });

  } catch(e) {
    console.error('Tesseract error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
