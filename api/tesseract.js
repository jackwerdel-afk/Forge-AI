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
  "message": "Your main response text",
  "cards": [
    {
      "type": "site|alert|action|insight",
      "title": "Card title",
      "subtitle": "Card subtitle", 
      "score": 85,
      "severity": "critical|high|medium|low",
      "action": "Action button text",
      "actionId": "site id or relevant id"
    }
  ],
  "followUps": ["Follow-up question 1", "Follow-up question 2"]
}
Cards are optional — only include them when they add value. followUps are optional suggested next questions.
Return ONLY the JSON, no other text.`;

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
