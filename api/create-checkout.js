module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan } = req.body;
  if (!plan) return res.status(400).json({ error: 'Missing plan' });

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const BASE_URL = 'https://forgeai-wgs.com';

  const plans = {
    starter: { name: 'Forge AI Starter', description: 'Up to 5 client sites', amount: 2500, interval: 'month' },
    agency: { name: 'Forge AI Agency', description: 'Up to 25 client sites', amount: 7500, interval: 'month' },
    enterprise: { name: 'Forge AI Enterprise', description: 'Unlimited sites', amount: 24900, interval: 'month' }
  };

  const selectedPlan = plans[plan];
  if (!selectedPlan) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'mode': 'subscription',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': selectedPlan.name,
        'line_items[0][price_data][product_data][description]': selectedPlan.description,
        'line_items[0][price_data][recurring][interval]': selectedPlan.interval,
        'line_items[0][price_data][unit_amount]': selectedPlan.amount,
        'line_items[0][quantity]': '1',
        'success_url': `${BASE_URL}/forge-ai-success.html?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
        'cancel_url': `${BASE_URL}/forge-ai-pricing.html`,
        'allow_promotion_codes': 'true',
        'billing_address_collection': 'auto'
      }).toString()
    });

    const session = await response.json();
    if (!response.ok) throw new Error(session.error?.message || 'Could not create checkout session');
    return res.status(200).json({ url: session.url });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
