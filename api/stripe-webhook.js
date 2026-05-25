const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let event;
  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    event = JSON.parse(body);
  } catch(err) {
    return res.status(400).json({ error: 'Invalid payload' });
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

      const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
        headers: { 'Authorization': `Bearer ${stripeSecret}` }
      });
      const sub = await subRes.json();
      const amount = sub.items?.data?.[0]?.price?.unit_amount || 0;

      let plan = 'starter';
      let sitesLimit = 5;
      if (amount >= 39900) { plan = 'enterprise'; sitesLimit = 999; }
      else if (amount >= 14900) { plan = 'agency'; sitesLimit = 25; }
      else if (amount >= 4900) { plan = 'starter'; sitesLimit = 5; }

      console.log(`Plan: ${plan}`);

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
    }

    return res.status(200).json({ received: true });

  } catch(err) {
    console.error('Webhook error:', err.message);
    return res.status(200).json({ received: true });
  }
};
