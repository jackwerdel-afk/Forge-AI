(function() {
  'use strict';

  // Forge AI Analytics Tracker v1.0
  var ENDPOINT = 'https://forgeai-wgs.com/api/track';
  var SITE_ID = window.FORGE_AI_SITE_ID;
  var USER_ID = window.FORGE_AI_USER_ID;

  if (!SITE_ID || !USER_ID) return;

  // Session management
  var SESSION_KEY = 'fai_session';
  var session = sessionStorage.getItem(SESSION_KEY);
  if (!session) {
    session = Math.random().toString(36).substr(2, 16) + Date.now().toString(36);
    sessionStorage.setItem(SESSION_KEY, session);
  }

  // Device detection
  function getDevice() {
    var ua = navigator.userAgent;
    if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
    if (/mobile|android|iphone|ipod|blackberry|opera mini|iemobile/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  // Browser detection
  function getBrowser() {
    var ua = navigator.userAgent;
    if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome';
    if (ua.includes('Firefox')) return 'Firefox';
    if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
    if (ua.includes('Edg')) return 'Edge';
    if (ua.includes('OPR') || ua.includes('Opera')) return 'Opera';
    return 'Other';
  }

  // OS detection
  function getOS() {
    var ua = navigator.userAgent;
    if (ua.includes('Windows')) return 'Windows';
    if (ua.includes('Mac')) return 'macOS';
    if (ua.includes('Linux')) return 'Linux';
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
    return 'Other';
  }

  // Scroll depth tracking
  var maxScroll = 0;
  function trackScroll() {
    var scrolled = Math.round((window.scrollY + window.innerHeight) / document.body.scrollHeight * 100);
    if (scrolled > maxScroll) maxScroll = Math.min(scrolled, 100);
  }
  window.addEventListener('scroll', trackScroll, { passive: true });

  // Page timing
  var startTime = Date.now();
  var isEntry = !document.referrer || new URL(document.referrer).hostname !== window.location.hostname;

  // Send tracking data
  function send(isExit) {
    var duration = Math.round((Date.now() - startTime) / 1000);
    var data = {
      siteId: SITE_ID,
      userId: USER_ID,
      url: window.location.href,
      page: window.location.pathname || '/',
      referrer: document.referrer || '',
      device: getDevice(),
      browser: getBrowser(),
      os: getOS(),
      sessionId: session,
      duration: isExit ? duration : 0,
      scrollDepth: maxScroll,
      isEntry: isEntry,
      isExit: isExit || false
    };

    // Use sendBeacon for exit events (more reliable)
    if (isExit && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, JSON.stringify(data));
    } else {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        keepalive: true
      }).catch(function() {});
    }
  }

  // Track page view on load
  if (document.readyState === 'complete') {
    send(false);
  } else {
    window.addEventListener('load', function() { send(false); });
  }

  // Track exit
  window.addEventListener('beforeunload', function() { send(true); });
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') send(true);
  });

})();
