const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify admin secret
  const auth = req.headers.authorization || '';
  const secret = auth.replace('Bearer ', '').trim();
  if (secret !== process.env.ADMIN_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const today = new Date(); today.setHours(0,0,0,0);
  const todayISO = today.toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const [
      userSites, schedSites, scansToday, openIncidents,
      uptimeToday, secFindings, recentIncidents,
      upChecksToday, incidentsThirty, openInc,
      avgChecks, memories, allSites, allSchedSites, betaApps,
      authUsersRes, subsRes
    ] = await Promise.allSettled([
      sb.from('user_sites').select('user_id, name, url, platform, score, auto_scan, last_scanned, created_at'),
      sb.from('scheduled_sites').select('user_id, name, url, platform, last_score, last_scanned, created_at'),
      sb.from('user_sites').select('*', { count: 'exact', head: true }).gte('last_scanned', todayISO),
      sb.from('uptime_incidents').select('*', { count: 'exact', head: true }).is('up_at', null),
      sb.from('uptime_checks').select('*', { count: 'exact', head: true }).gte('checked_at', todayISO),
      sb.from('security_findings').select('*', { count: 'exact', head: true }).is('resolved_at', null),
      sb.from('uptime_incidents').select('url, down_at, up_at, duration_seconds').order('down_at', { ascending: false }).limit(5),
      sb.from('uptime_checks').select('*', { count: 'exact', head: true }).eq('status', 'up').gte('checked_at', todayISO),
      sb.from('uptime_incidents').select('*', { count: 'exact', head: true }).gte('down_at', thirtyDaysAgo),
      sb.from('uptime_incidents').select('id, url, down_at, up_at, duration_seconds').is('up_at', null).order('down_at', { ascending: false }),
      sb.from('uptime_checks').select('response_time_ms').eq('status', 'up').gte('checked_at', todayISO).limit(500),
      sb.from('tesseract_memory').select('user_id, memory_type, content, created_at, updated_at').order('updated_at', { ascending: false }).limit(100),
      sb.from('user_sites').select('site_id, name, url, platform, score, auto_scan, last_scanned'),
      sb.from('scheduled_sites').select('id, name, url, platform, last_score, last_scanned'),
      sb.from('beta_applications').select('id, name, agency_name, email, website, reason, status, invite_token, created_at').order('created_at', { ascending: false }),
      sb.auth.admin.listUsers({ perPage: 1000 }),
      sb.from('subscriptions').select('user_id, plan, sites_limit')
    ]);

    // Log any failed queries for debugging
    const queryNames = ['userSites','schedSites','scansToday','openIncidents','uptimeToday','secFindings','recentIncidents','upChecksToday','incidentsThirty','openInc','avgChecks','memories','allSites','allSchedSites','betaApps','authUsersRes','subsRes'];
    [userSites,schedSites,scansToday,openIncidents,uptimeToday,secFindings,recentIncidents,upChecksToday,incidentsThirty,openInc,avgChecks,memories,allSites,allSchedSites,betaApps,authUsersRes,subsRes].forEach((r,i) => {
      if (r.status === 'rejected') console.error('Query failed:', queryNames[i], r.reason?.message);
    });

    const uSites = userSites.status === 'fulfilled' ? (userSites.value.data || []) : [];
    const sSites = schedSites.status === 'fulfilled' ? (schedSites.value.data || []) : [];

    // Build user email, joined, and plan maps
    const userEmailMap = {};
    const userJoinedMap = {};
    const userPlanMap = {};
    try {
      const authData = authUsersRes.status === 'fulfilled' ? authUsersRes.value : null;
      const authUsers = authData && authData.data ? authData.data.users : null;
      if (authUsers) authUsers.forEach(u => {
        userEmailMap[u.id] = u.email || null;
        userJoinedMap[u.id] = u.created_at || null;
      });
    } catch(e) { console.log('User fetch (non-fatal):', e.message); }
    try {
      const subsData = subsRes.status === 'fulfilled' ? (subsRes.value.data || []) : [];
      subsData.forEach(s => { userPlanMap[s.user_id] = s.plan || 'free'; });
    } catch(e) { console.log('Plan fetch (non-fatal):', e.message); }

    // Unique agencies
    const uniqueUsers = new Set([...uSites, ...sSites].map(s => s.user_id)).size;

    // Average response time
    const avgChecksData = avgChecks.status === 'fulfilled' ? (avgChecks.value.data || []) : [];
    const avgResponse = avgChecksData.length > 0
      ? Math.round(avgChecksData.reduce((a, c) => a + (c.response_time_ms || 0), 0) / avgChecksData.length)
      : null;

    // All sites for scan health — reuse userSites already fetched above
    const allSitesCombined = uSites;
    const scored = allSitesCombined.filter(s => s.score !== null);
    const avgScore = scored.length > 0 ? Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length) : null;

    // Merge user_sites and scheduled_sites — deduplicate by URL
    // scheduled_sites uses last_score, user_sites uses score — normalize to score
    const urlsSeen = new Set();
    const agencyMap = {};

    uSites.forEach(s => {
      urlsSeen.add(s.url);
      if (!agencyMap[s.user_id]) agencyMap[s.user_id] = {
        userId: s.user_id,
        email: userEmailMap[s.user_id] || null,
        plan: userPlanMap[s.user_id] || 'free',
        joinedAt: userJoinedMap[s.user_id] || null,
        sites: []
      };
      agencyMap[s.user_id].sites.push({ ...s, score: s.score });
    });

    sSites.forEach(s => {
      if (urlsSeen.has(s.url)) return;
      if (!agencyMap[s.user_id]) agencyMap[s.user_id] = {
        userId: s.user_id,
        email: userEmailMap[s.user_id] || null,
        plan: userPlanMap[s.user_id] || 'free',
        joinedAt: userJoinedMap[s.user_id] || null,
        sites: []
      };
      agencyMap[s.user_id].sites.push({ ...s, score: s.last_score || null });
    });

    return res.status(200).json({
      success: true,
      overview: {
        uniqueAgencies: uniqueUsers,
        totalSites: uSites.length + sSites.length,
        scansToday: scansToday.status === 'fulfilled' ? (scansToday.value.count || 0) : 0,
        openIncidents: openIncidents.status === 'fulfilled' ? (openIncidents.value.count || 0) : 0,
        uptimeChecksToday: uptimeToday.status === 'fulfilled' ? (uptimeToday.value.count || 0) : 0,
        openSecurityFindings: secFindings.status === 'fulfilled' ? (secFindings.value.count || 0) : 0,
      },
      recentIncidents: recentIncidents.status === 'fulfilled' ? (recentIncidents.value.data || []) : [],
      uptime: {
        checksToday: upChecksToday.status === 'fulfilled' ? (upChecksToday.value.count || 0) : 0,
        incidents30d: incidentsThirty.status === 'fulfilled' ? (incidentsThirty.value.count || 0) : 0,
        openIncidents: openInc.status === 'fulfilled' ? (openInc.value.data || []) : [],
        avgResponse,
      },
      scans: (function() {
        // Normalize URL — strip trailing slash for deduplication
        const norm = url => (url || '').replace(/\/+$/, '').toLowerCase();
        // Deduplicate by user_id + normalized URL
        const seenScan = new Set();
        const allSites = [];
        uSites.forEach(s => {
          const key = (s.user_id || '') + '|' + norm(s.url);
          if (!seenScan.has(key)) { seenScan.add(key); allSites.push({ ...s, auto_scan: s.auto_scan || false }); }
        });
        sSites.forEach(s => {
          const key = (s.user_id || '') + '|' + norm(s.url);
          // scheduled_sites sites are auto_scan ON by definition
          if (!seenScan.has(key)) { seenScan.add(key); allSites.push({ ...s, score: s.last_score || null, auto_scan: true }); }
        });
        const scored = allSites.filter(s => s.score !== null && s.score !== undefined);
        return {
          total: allSites.length,
          scannedToday: allSites.filter(s => s.last_scanned && new Date(s.last_scanned) >= today).length,
          neverScanned: allSites.filter(s => !s.last_scanned).length,
          avgScore: scored.length > 0 ? Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length) : null,
          sites: allSites,
        };
      })(),
      agencies: Object.values(agencyMap).map(a => ({ ...a, schedSites: [] })),
      tesseract: {
        memories: memories.status === 'fulfilled' ? (memories.value.data || []) : [],
      },
      signups: [...uSites, ...sSites].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)),
      beta: {
        applications: betaApps.status === 'fulfilled' ? (betaApps.value.data || []) : [],
      }
    });

  } catch(e) {
    console.error('Admin stats error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
