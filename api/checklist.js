const Anthropic = require('@anthropic-ai/sdk');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = message.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const checklist = JSON.parse(clean);

    return res.status(200).json({ success: true, checklist });
  } catch(e) {
    console.error('Checklist error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
