const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Verify Stripe webhook signature
function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(',');
    const timestamp = parts.find(p => p.startsWith('t=')).slice(2);
    const sig = parts.find(p => p.startsWith('v1=')).slice(3);
    const signedPayload = `${timestamp}.${payload}`;
    const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    // Constant time comparison to prevent timing attacks
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch(e) {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Get raw body for signature verification
  let rawBody;
  try {
    rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  } catch(err) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Verify signature if webhook secret is set
  if (webhookSecret && sig) {
    if (!verifyStripeSignature(rawBody, sig, webhookSecret)) {
      console.error('Stripe signature verification failed');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  let event;
  try {
    event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch(err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const stripeSecret = process.env.STRIPE_SECRET_KEY;

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      console.log('Payment received for:', email);

      // Get subscription details from Stripe
      const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
        headers: { 'Authorization': `Bearer ${stripeSecret}` }
      });
      const sub = await subRes.json();
      const amount = sub.items?.data?.[0]?.price?.unit_amount || 0;

      // Beta prices: starter=$25(2500), agency=$75(7500), enterprise=$249(24900)
      // Full prices: starter=$49(4900), agency=$149(14900), enterprise=$399(39900)
      let plan = 'starter';
      let sitesLimit = 5;
      if (amount >= 24900) { plan = 'enterprise'; sitesLimit = 999; }
      else if (amount >= 7500) { plan = 'agency'; sitesLimit = 25; }
      else if (amount >= 2500) { plan = 'starter'; sitesLimit = 5; }

      console.log(`Plan: ${plan} (amount: ${amount})`);

      // Find user by email
      const { data: { users } } = await sb.auth.admin.listUsers();
      const user = users?.find(u => u.email?.toLowerCase() === email?.toLowerCase());

      const record = {
        email: email,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        plan: plan,
        status: 'active',
        sites_limit: sitesLimit,
        updated_at: new Date().toISOString()
      };

      if (user) record.user_id = user.id;

      await sb.from('subscriptions').upsert(record, { onConflict: 'email' });
      console.log('Subscription saved for:', email, 'plan:', plan);
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const custRes = await fetch(`https://api.stripe.com/v1/customers/${subscription.customer}`, {
        headers: { 'Authorization': `Bearer ${stripeSecret}` }
      });
      const customer = await custRes.json();
      await sb.from('subscriptions').update({
        plan: 'free', status: 'cancelled', sites_limit: 3,
        updated_at: new Date().toISOString()
      }).eq('email', customer.email);
      console.log('Subscription cancelled for:', customer.email);
    }

    return res.status(200).json({ received: true });

  } catch(err) {
    console.error('Webhook error:', err.message);
    return res.status(200).json({ received: true });
  }
};
