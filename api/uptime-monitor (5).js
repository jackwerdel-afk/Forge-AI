const { createClient } = require('@supabase/supabase-js');
const Sentry = require('@sentry/node');
Sentry.init({ dsn: 'https://b906d32b0d61fe5bf13af61abaf76755@o4511809521713152.ingest.us.sentry.io/4511813224431616', environment: 'production' });

const TIMEOUT_MS = 10000;
const MAX_SITES_PER_RUN = 200;

// ── CHECK A SINGLE SITE (with two-strike rule) ────────────
// A site must fail TWO consecutive checks before being marked down.
// This prevents false alerts from transient network blips.
async function checkSiteOnce(url) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'ForgeAI-Uptime/1.0' }
    });
    clearTimeout(t);
    const responseTime = Date.now() - start;
    const isUp = res.status < 500;
    return {
      status: isUp ? 'up' : 'down',
      statusCode: res.status,
      responseTimeMs: responseTime,
      error: null
    };
  } catch(e) {
    return {
      status: 'down',
      statusCode: null,
      responseTimeMs: Date.now() - start,
      error: e.name === 'AbortError' ? 'Request timed out' : e.message
    };
  }
}

async function checkSite(url) {
  const first = await checkSiteOnce(url);
  if (first.status === 'up') return first;
  // First check failed — wait 15 seconds and try again (two-strike rule)
  console.log(`First check failed for ${url} — retrying in 15s...`);
  await new Promise(r => setTimeout(r, 15000));
  const second = await checkSiteOnce(url);
  if (second.status === 'up') {
    console.log(`${url} recovered on second check — was a transient blip`);
    return second; // Site is actually up — don't mark as down
  }
  // Both checks failed — site is genuinely down
  return second;
}

// ── SEND DOWNTIME ALERT EMAIL ──────────────────────────────
async function sendDownAlert(userEmail, siteName, siteUrl, responseTime) {
  try {
    await fetch('https://forgeai-wgs.com/api/send-uptime-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: userEmail,
        siteName,
        siteUrl,
        type: 'down',
        responseTime,
        dashboardUrl: 'https://forgeai-wgs.com/forge-ai-dashboard.html'
      })
    });
  } catch(e) {
    console.error('Down alert email error:', e.message);
  }
}

// ── SEND RECOVERY ALERT EMAIL ──────────────────────────────
async function sendUpAlert(userEmail, siteName, siteUrl, durationSeconds) {
  try {
    await fetch('https://forgeai-wgs.com/api/send-uptime-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: userEmail,
        siteName,
        siteUrl,
        type: 'up',
        durationSeconds,
        dashboardUrl: 'https://forgeai-wgs.com/forge-ai-dashboard.html'
      })
    });
  } catch(e) {
    console.error('Up alert email error:', e.message);
  }
}

module.exports = async (req, res) => {
  // Allow Vercel cron calls (x-vercel-cron header) or internal calls with CRON_SECRET
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const auth = req.headers.authorization || '';
  const isAuthorized = isVercelCron || auth.replace('Bearer ', '') === process.env.CRON_SECRET;
  if (!isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const now = new Date();
  let checked = 0, downed = 0, recovered = 0;

  try {
    // ── FETCH ALL SITES WITH AUTO_SCAN ENABLED ─────────────
    // Check both user_sites and scheduled_sites
    const [userSitesRes, schedSitesRes] = await Promise.allSettled([
      sb.from('user_sites').select('site_id, user_id, name, url, auto_scan').eq('auto_scan', true).limit(MAX_SITES_PER_RUN),
      sb.from('scheduled_sites').select('id, user_id, name, url, auto_scan').eq('auto_scan', true).limit(MAX_SITES_PER_RUN)
    ]);

    const userSites = (userSitesRes.status === 'fulfilled' && userSitesRes.value.data) ? userSitesRes.value.data.map(s => ({ site_id: s.site_id, user_id: s.user_id, name: s.name, url: s.url })) : [];
    const schedSites = (schedSitesRes.status === 'fulfilled' && schedSitesRes.value.data) ? schedSitesRes.value.data.map(s => ({ site_id: s.id, user_id: s.user_id, name: s.name, url: s.url })) : [];

    // Merge — deduplicate by URL
    const urlsSeen = new Set(userSites.map(s => s.url));
    const sites = [...userSites, ...schedSites.filter(s => !urlsSeen.has(s.url))];

    if (sites.length === 0) {
      return res.status(200).json({ success: true, message: 'No sites to monitor', checked: 0 });
    }

    // ── FETCH USER EMAILS ──────────────────────────────────
    const userIds = [...new Set(sites.map(s => s.user_id))];
    const userEmails = {};
    const userSettings = {};
    try {
      const { data: { users } } = await sb.auth.admin.listUsers({ perPage: 1000 });
      if (users) {
        users.forEach(u => {
          if (userIds.includes(u.id)) {
            userEmails[u.id] = u.email;
            userSettings[u.id] = u.user_metadata || {};
          }
        });
      }
    } catch(e) {
      console.error('User fetch error:', e.message);
    }

    // ── FETCH LAST STATUS FOR EACH SITE ───────────────────
    // Get most recent check per site to detect status changes
    const siteUrls = sites.map(s => s.url);

    // Query by URL — works for all site ID formats
    const { data: lastChecks } = await sb
      .from('uptime_checks')
      .select('url, status, checked_at')
      .in('url', siteUrls)
      .order('checked_at', { ascending: false });

    // Build map of last known status per URL
    const lastStatusMap = {};
    if (lastChecks) {
      lastChecks.forEach(c => {
        if (!lastStatusMap[c.url]) {
          lastStatusMap[c.url] = c.status;
        }
      });
    }

    // ── FETCH OPEN INCIDENTS ───────────────────────────────
    const { data: openIncidents } = await sb
      .from('uptime_incidents')
      .select('id, url, down_at')
      .in('url', siteUrls)
      .is('up_at', null);

    const openIncidentMap = {};
    if (openIncidents) {
      openIncidents.forEach(i => { openIncidentMap[i.url] = i; });
    }

    // ── CHECK ALL SITES IN PARALLEL (batches of 20) ───────
    const BATCH_SIZE = 20;
    for (let i = 0; i < sites.length; i += BATCH_SIZE) {
      const batch = sites.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(site => checkSite(site.url))
      );

      for (let j = 0; j < batch.length; j++) {
        const site = batch[j];
        const result = results[j].status === 'fulfilled'
          ? results[j].value
          : { status: 'down', statusCode: null, responseTimeMs: TIMEOUT_MS, error: 'Check failed' };

        const previousStatus = lastStatusMap[site.url] || null;
        const isDown = result.status === 'down';
        const wasDown = previousStatus === 'down';
        const userEmail = userEmails[site.user_id];
        const emailAlertsEnabled = userSettings[site.user_id]?.email_alerts !== false;

        // ── SAVE CHECK RESULT ────────────────────────────
        // Use null for non-UUID site_ids — query by URL instead
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const safeSiteId = uuidRegex.test(String(site.site_id)) ? site.site_id : null;

        const { error: insertErr } = await sb.from('uptime_checks').insert({
          site_id: safeSiteId,
          user_id: site.user_id,
          url: site.url,
          status: result.status,
          status_code: result.statusCode,
          response_time_ms: result.responseTimeMs,
          error: result.error,
          checked_at: now.toISOString()
        });
        if (insertErr) console.error('Insert error for', site.url, ':', insertErr.message);

        checked++;

        // ── SITE JUST WENT DOWN ──────────────────────────
        // Fire if: status changed from up→down OR site is down with no open incident
        const hasOpenIncident = !!openIncidentMap[site.url];
        if (isDown && (!wasDown || !hasOpenIncident) && previousStatus !== null) {
          if (!hasOpenIncident) {
            downed++;
            console.log(`🔴 DOWN: ${site.url} — ${result.error || result.statusCode}`);

          // Create incident
          const safeSiteId2 = uuidRegex.test(String(site.site_id)) ? site.site_id : null;
          await sb.from('uptime_incidents').insert({
            site_id: safeSiteId2,
            user_id: site.user_id,
            url: site.url,
            down_at: now.toISOString(),
            notified: false
          });

          // Save to site_alerts table (used by dashboard alerts system)
          try {
            await sb.from('site_alerts').insert({
              user_id: site.user_id,
              site_url: site.url,
              message: `🔴 ${site.name || site.url} is DOWN — ${result.error || `HTTP ${result.statusCode}`}`,
              severity: 'critical',
              type: 'uptime',
              resolved: false,
              created_at: now.toISOString()
            });
          } catch(e) { console.log('Dashboard alert insert (non-fatal):', e.message); }

          // Send email alert
          if (userEmail && emailAlertsEnabled) {
            await sendDownAlert(userEmail, site.name || site.url, site.url, result.responseTimeMs);
          }
          } // end !hasOpenIncident
        }

        // ── SITE JUST RECOVERED ──────────────────────────
        if (!isDown && wasDown) {
          recovered++;
          console.log(`🟢 UP: ${site.url} — ${result.responseTimeMs}ms`);

          // Close open incident
          const incident = openIncidentMap[site.url];
          if (incident) {
            const downAt = new Date(incident.down_at);
            const durationSeconds = Math.floor((now - downAt) / 1000);
            await sb.from('uptime_incidents').update({
              up_at: now.toISOString(),
              duration_seconds: durationSeconds
            }).eq('id', incident.id);

            // Send recovery email
            if (userEmail && emailAlertsEnabled) {
              await sendUpAlert(userEmail, site.name || site.url, site.url, durationSeconds);
            }

            // Dashboard recovery alert
            try {
              await sb.from('site_alerts').update({ resolved: true })
                .eq('user_id', site.user_id)
                .eq('site_url', site.url)
                .eq('type', 'uptime')
                .eq('resolved', false);
              await sb.from('site_alerts').insert({
                user_id: site.user_id,
                site_url: site.url,
                message: `🟢 ${site.name || site.url} is back UP — was down for ${Math.round(durationSeconds / 60)} min`,
                severity: 'info',
                type: 'uptime',
                resolved: true,
                created_at: now.toISOString()
              });
            } catch(e) { console.log('Recovery alert insert (non-fatal):', e.message); }
          }
        }

        // Update last status map for next iteration
        lastStatusMap[site.url] = result.status;
      }
    }

    // ── CLEANUP OLD DATA ──────────────────────────────────
    try {
      // Keep checks for 7 days (high volume — ~2016 checks/day per site)
      const checksCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      await sb.from('uptime_checks').delete().lt('checked_at', checksCutoff);
      // Keep resolved incidents for 90 days (low volume — important history)
      const incidentsCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      await sb.from('uptime_incidents').delete()
        .lt('down_at', incidentsCutoff)
        .not('up_at', 'is', null); // Only delete resolved incidents
      console.log('Cleanup complete');
    } catch(e) { console.log('Cleanup error (non-fatal):', e.message); }

    console.log(`Uptime check complete: ${checked} checked, ${downed} down, ${recovered} recovered`);
    return res.status(200).json({ success: true, checked, downed, recovered });

  } catch(err) {
    Sentry.captureException(err);
    console.error('Uptime monitor error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
