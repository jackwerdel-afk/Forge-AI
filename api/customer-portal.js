const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

    // Get Stripe customer ID from subscriptions table
    const { data: sub } = await sb.from('subscriptions')
      .select('stripe_customer_id, plan')
      .eq('email', user.email)
      .maybeSingle();

    if (!sub || !sub.stripe_customer_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // Create Stripe Customer Portal session
    const params = new URLSearchParams({
      customer: sub.stripe_customer_id,
      return_url: 'https://forgeai-wgs.com/forge-ai-billing.html'
    });

    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    let portalData;
    const portalText = await portalRes.text();
    try {
      portalData = JSON.parse(portalText);
    } catch(e) {
      console.error('Stripe portal raw response:', portalText.slice(0, 200));
      return res.status(500).json({ error: 'Stripe portal not configured. Please enable it in Stripe Dashboard → Settings → Billing → Customer Portal.' });
    }

    if (!portalRes.ok || !portalData.url) {
      console.error('Stripe portal error:', portalData);
      return res.status(500).json({ error: portalData.error?.message || 'Could not open billing portal. Make sure Customer Portal is enabled in Stripe Dashboard.' });
    }

    return res.status(200).json({ success: true, url: portalData.url });

  } catch(e) {
    console.error('Customer portal error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
