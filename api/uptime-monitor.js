const { createClient } = require('@supabase/supabase-js');
const Sentry = require('@sentry/node');
Sentry.init({ dsn: 'https://b906d32b0d61fe5bf13af61abaf76755@o4511809521713152.ingest.us.sentry.io/4511813224431616', environment: 'production' });

const TIMEOUT_MS = 10000;
const MAX_SITES_PER_RUN = 200;

// ── CHECK A SINGLE SITE ────────────────────────────────────
async function checkSite(url) {
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
    const { data: sites, error: sitesError } = await sb
      .from('user_sites')
      .select('site_id, user_id, name, url, auto_scan')
      .eq('auto_scan', true)
      .limit(MAX_SITES_PER_RUN);

    if (sitesError) throw sitesError;
    if (!sites || sites.length === 0) {
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
    const siteIds = sites.map(s => s.site_id);
    const { data: lastChecks } = await sb
      .from('uptime_checks')
      .select('site_id, status, checked_at')
      .in('site_id', siteIds)
      .order('checked_at', { ascending: false });

    // Build map of last known status per site
    const lastStatusMap = {};
    if (lastChecks) {
      lastChecks.forEach(c => {
        if (!lastStatusMap[c.site_id]) {
          lastStatusMap[c.site_id] = c.status;
        }
      });
    }

    // ── FETCH OPEN INCIDENTS ───────────────────────────────
    const { data: openIncidents } = await sb
      .from('uptime_incidents')
      .select('id, site_id, down_at')
      .in('site_id', siteIds)
      .is('up_at', null);

    const openIncidentMap = {};
    if (openIncidents) {
      openIncidents.forEach(i => { openIncidentMap[i.site_id] = i; });
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

        const previousStatus = lastStatusMap[site.site_id] || null;
        const isDown = result.status === 'down';
        const wasDown = previousStatus === 'down';
        const userEmail = userEmails[site.user_id];
        const emailAlertsEnabled = userSettings[site.user_id]?.email_alerts !== false;

        // ── SAVE CHECK RESULT ────────────────────────────
        await sb.from('uptime_checks').insert({
          site_id: site.site_id,
          user_id: site.user_id,
          url: site.url,
          status: result.status,
          status_code: result.statusCode,
          response_time_ms: result.responseTimeMs,
          error: result.error,
          checked_at: now.toISOString()
        });

        checked++;

        // ── SITE JUST WENT DOWN ──────────────────────────
        if (isDown && !wasDown && previousStatus !== null) {
          downed++;
          console.log(`🔴 DOWN: ${site.url} — ${result.error || result.statusCode}`);

          // Create incident
          await sb.from('uptime_incidents').insert({
            site_id: site.site_id,
            user_id: site.user_id,
            url: site.url,
            down_at: now.toISOString(),
            notified: false
          });

          // Save dashboard alert
          try {
            await sb.from('realtime_alerts').insert({
              user_id: site.user_id,
              site_url: site.url,
              message: `🔴 ${site.name || site.url} is DOWN — ${result.error || `HTTP ${result.statusCode}`}`,
              severity: 'critical',
              type: 'uptime',
              created_at: now.toISOString()
            });
          } catch(e) { console.log('Dashboard alert error:', e.message); }

          // Send email alert
          if (userEmail && emailAlertsEnabled) {
            await sendDownAlert(userEmail, site.name || site.url, site.url, result.responseTimeMs);
          }
        }

        // ── SITE JUST RECOVERED ──────────────────────────
        if (!isDown && wasDown) {
          recovered++;
          console.log(`🟢 UP: ${site.url} — ${result.responseTimeMs}ms`);

          // Close open incident
          const incident = openIncidentMap[site.site_id];
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
              await sb.from('realtime_alerts').insert({
                user_id: site.user_id,
                site_url: site.url,
                message: `🟢 ${site.name || site.url} is back UP — was down for ${Math.round(durationSeconds / 60)} min`,
                severity: 'info',
                type: 'uptime',
                created_at: now.toISOString()
              });
            } catch(e) { console.log('Recovery alert error:', e.message); }
          }
        }

        // Update last status map for next iteration
        lastStatusMap[site.site_id] = result.status;
      }
    }

    // ── CLEANUP OLD CHECKS (keep 7 days) ──────────────────
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      await sb.from('uptime_checks').delete().lt('checked_at', cutoff);
    } catch(e) { console.log('Cleanup error (non-fatal):', e.message); }

    console.log(`Uptime check complete: ${checked} checked, ${downed} down, ${recovered} recovered`);
    return res.status(200).json({ success: true, checked, downed, recovered });

  } catch(err) {
    Sentry.captureException(err);
    console.error('Uptime monitor error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
