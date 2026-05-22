module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { webflowToken } = req.body;
  if (!webflowToken) return res.status(400).json({ error: 'Missing Webflow token' });

  try {
    const response = await fetch('https://api.webflow.com/v2/sites', {
      headers: {
        'Authorization': `Bearer ${webflowToken}`,
        'accept-version': '2.0.0',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.message || 'Invalid Webflow token');
    }

    const data = await response.json();
    const sites = data.sites || [];

    return res.status(200).json({
      success: true,
      sites: sites.map(s => ({
        id: s.id,
        name: s.name,
        displayName: s.displayName,
        customDomain: s.customDomains?.[0]?.url || null,
        previewUrl: s.previewUrl
      }))
    });

  } catch(err) {
    return res.status(400).json({ error: err.message });
  }
};
