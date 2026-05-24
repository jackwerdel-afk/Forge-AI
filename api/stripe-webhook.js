const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeSecret = process.env.STRIPE_SECRET_KEY;

  let event;

  try {
    // Parse the raw body
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    event = JSON.parse(body);
  } catch(err) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const planLimits = {
    price_starter: { plan: 'starter', sites_limit: 5 },
    price_agency: { plan: 'agency', sites_limit: 25 },
    price_enterprise: { plan: 'enterprise', sites_limit: 999 }
  };

  try {
    switch(event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_details?.email || session.customer_email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        // Get subscription details from Stripe
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
          headers: { 'Authorization': `Bearer ${stripeSecret}` }
        });
        const sub = await subRes.json();
        const priceId = sub.items?.data?.[0]?.price?.id || '';
        const amount = sub.items?.data?.[0]?.price?.unit_amount || 0;

        // Determine plan based on amount
        let plan = 'starter';
        let sitesLimit = 5;
        if (amount >= 39900) { plan = 'enterprise'; sitesLimit = 999; }
        else if (amount >= 14900) { plan = 'agency'; sitesLimit = 25; }
        else if (amount >= 4900) { plan = 'starter'; sitesLimit = 5; }

        // Find user by email
        const { data: userData } = await sb.auth.admin.listUsers();
        const user = userData?.users?.find(u => u.email === email);

        if (user) {
          // Upsert subscription
          await sb.from('subscriptions').upsert({
            user_id: user.id,
            email: email,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            plan: plan,
            status: 'active',
            sites_limit: sitesLimit,
            updated_at: new Date().toISOString()
          }, { onConflict: 'email' });

          console.log(`Subscription activated: ${email} on ${plan} plan`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        // Get customer email from Stripe
        const custRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
          headers: { 'Authorization': `Bearer ${stripeSecret}` }
        });
        const customer = await custRes.json();

        // Downgrade to free
        await sb.from('subscriptions')
          .update({ plan: 'free', status: 'cancelled', sites_limit: 3, updated_at: new Date().toISOString() })
          .eq('email', customer.email);

        console.log(`Subscription cancelled: ${customer.email}`);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const amount = subscription.items?.data?.[0]?.price?.unit_amount || 0;

        let plan = 'starter';
        let sitesLimit = 5;
        if (amount >= 39900) { plan = 'enterprise'; sitesLimit = 999; }
        else if (amount >= 14900) { plan = 'agency'; sitesLimit = 25; }
        else if (amount >= 4900) { plan = 'starter'; sitesLimit = 5; }

        await sb.from('subscriptions')
          .update({ plan, sites_limit: sitesLimit, status: subscription.status, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subscription.id);

        console.log(`Subscription updated to ${plan}`);
        break;
      }
    }

    return res.status(200).json({ received: true });

  } catch(err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};
