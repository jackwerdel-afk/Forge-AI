const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const { count: approved } = await sb
      .from('beta_waitlist')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'approved');

    const spotsLeft = Math.max(0, 10 - (approved || 0));
    const isFull = spotsLeft === 0;

    return res.status(200).json({
      spotsLeft,
      spotsTotal: 10,
      approved: approved || 0,
      isFull
    });
  } catch (err) {
    return res.status(200).json({ spotsLeft: 10, spotsTotal: 10, approved: 0, isFull: false });
  }
};
