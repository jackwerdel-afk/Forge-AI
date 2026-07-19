const { createClient } = require('@supabase/supabase-js');

// Tell Vercel not to auto-parse body so we can handle text/plain from sendBeacon
module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };

// Lightweight analytics tracking endpoint
module.exports = async (req, res) => {
  // CORS — allow any site to send tracking data
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // Parse body — sendBeacon sends as text/plain, fetch sends as application/json
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }
    if (!body || typeof body !== 'object') body = {};

    const {
      siteId, userId: bodyUserId, url, page, referrer,
      device, browser, os, sessionId,
      duration, scrollDepth, isEntry, isExit
    } = body;

    console.log('track received:', JSON.stringify({ siteId, page, bodyUserId }));
    if (!siteId || !page) {
      console.log('track 400 — body was:', JSON.stringify(req.body));
      return res.status(400).json({ error: 'Missing required fields: siteId=' + siteId + ' page=' + page });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Look up userId from user_sites if not provided in request
    let userId = bodyUserId;
    if (!userId) {
      const { data: siteData } = await sb
        .from('user_sites')
        .select('user_id')
        .eq('site_id', siteId)
        .maybeSingle();
      if (!siteData) return res.status(404).json({ error: 'Site not found' });
      userId = siteData.user_id;
    }

    // Get geo data from IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '';
    // Allow country/city override from request (for testing or manual data)
    let country = req.body.country || 'Unknown';
    let city = req.body.city || 'Unknown';
    
    // Only do IP lookup if no override provided
    if (country === 'Unknown') {
      try {
        if (ip && ip !== '127.0.0.1' && !ip.startsWith('192.168') && !ip.startsWith('10.')) {
          const geoRes = await fetch(`https://ipapi.co/${ip}/json/`);
          const geo = await geoRes.json();
          country = geo.country_name || 'Unknown';
          city = geo.city || 'Unknown';
        }
      } catch(e) {}
    }

    const today = new Date().toISOString().split('T')[0];

    // Insert raw page view
    await sb.from('page_views').insert({
      site_id: siteId,
      user_id: userId,
      url: url || '',
      page: page || '/',
      referrer: referrer || '',
      country,
      city,
      device: device || 'unknown',
      browser: browser || 'unknown',
      os: os || 'unknown',
      session_id: sessionId || '',
      duration_seconds: duration || 0,
      scroll_depth: scrollDepth || 0,
      is_entry: isEntry || false,
      is_exit: isExit || false,
      created_at: new Date().toISOString()
    });

    // Upsert daily site analytics
    const { data: existing } = await sb.from('site_analytics')
      .select('*').eq('site_id', siteId).eq('date', today).maybeSingle();

    if (existing) {
      const newViews = (existing.page_views || 0) + 1;
      const newVisitors = isEntry ? (existing.visitors || 0) + 1 : (existing.visitors || 0);
      const newAvgDuration = duration
        ? Math.round(((existing.avg_duration_seconds || 0) * (existing.page_views || 1) + duration) / newViews)
        : existing.avg_duration_seconds;

      await sb.from('site_analytics').update({
        page_views: newViews,
        visitors: newVisitors,
        avg_duration_seconds: newAvgDuration,
        top_country: country !== 'Unknown' ? country : existing.top_country,
        top_device: device || existing.top_device
      }).eq('site_id', siteId).eq('date', today);
    } else {
      await sb.from('site_analytics').insert({
        site_id: siteId,
        user_id: userId,
        date: today,
        visitors: isEntry ? 1 : 0,
        page_views: 1,
        avg_duration_seconds: duration || 0,
        top_country: country,
        top_device: device || 'unknown'
      });
    }

    // Upsert page stats
    const { data: existingPage } = await sb.from('page_stats')
      .select('*').eq('site_id', siteId).eq('page', page).eq('date', today).maybeSingle();

    if (existingPage) {
      const newPageViews = (existingPage.views || 0) + 1;
      const newAvg = duration
        ? Math.round(((existingPage.avg_duration_seconds || 0) * (existingPage.views || 1) + duration) / newPageViews)
        : existingPage.avg_duration_seconds;

      await sb.from('page_stats').update({
        views: newPageViews,
        unique_visitors: isEntry ? (existingPage.unique_visitors || 0) + 1 : existingPage.unique_visitors,
        avg_duration_seconds: newAvg,
        entries: isEntry ? (existingPage.entries || 0) + 1 : existingPage.entries,
        exits: isExit ? (existingPage.exits || 0) + 1 : existingPage.exits
      }).eq('site_id', siteId).eq('page', page).eq('date', today);
    } else {
      await sb.from('page_stats').insert({
        site_id: siteId,
        user_id: userId,
        page,
        date: today,
        views: 1,
        unique_visitors: isEntry ? 1 : 0,
        avg_duration_seconds: duration || 0,
        entries: isEntry ? 1 : 0,
        exits: isExit ? 1 : 0
      });
    }

    return res.status(200).json({ success: true });

  } catch(e) {
    console.error('Track error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
