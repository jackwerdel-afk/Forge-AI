const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token } = req.query;
    const { message, history, systemPrompt } = req.body;

    if (!token || !message) return res.status(400).json({ error: 'Missing token or message' });

    // Verify the token is valid
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: portal } = await sb.from('client_portals')
      .select('user_id, site_url, site_name')
      .eq('token', token)
      .eq('active', true)
      .maybeSingle();

    if (!portal) return res.status(401).json({ error: 'Invalid or expired portal link' });

    // Build messages array
    const messages = [];
    if (history && history.length > 0) {
      history.forEach(function(h) {
        if (h.role && h.content) {
          messages.push({ role: h.role, content: h.content });
        }
      });
    }
    // Add current message if not already in history
    if (!messages.length || messages[messages.length - 1].content !== message) {
      messages.push({ role: 'user', content: message });
    }

    // Call Anthropic API
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: systemPrompt || 'You are a friendly website assistant. Speak in plain English, no technical jargon. Keep answers short and reassuring.',
        messages: messages
      })
    });

    const anthropicData = await anthropicRes.json();
    const reply = anthropicData.content && anthropicData.content[0] && anthropicData.content[0].text
      ? anthropicData.content[0].text
      : "I'm here to help! Please try asking again.";

    return res.status(200).json({ success: true, reply });

  } catch(e) {
    console.error('Client chat error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
