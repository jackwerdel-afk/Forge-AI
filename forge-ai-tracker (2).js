(function() {
  'use strict';

  // Forge AI Analytics Tracker v1.1
  var ENDPOINT = 'https://forgeai-wgs.com/api/track';

  // Get site ID from script tag data attribute or window variable
  var scriptTag = document.currentScript || (function() {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('forge-ai-tracker') > -1) return scripts[i];
    }
    return null;
  })();

  var SITE_ID = (scriptTag && scriptTag.getAttribute('data-site-id')) || window.FORGE_AI_SITE_ID;

  if (!SITE_ID) return;

  // Session management
  var SESSION_KEY = 'fai_session_' + SITE_ID;
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
    if (ua.indexOf('Edg') > -1) return 'Edge';
    if (ua.indexOf('OPR') > -1 || ua.indexOf('Opera') > -1) return 'Opera';
    if (ua.indexOf('Chrome') > -1) return 'Chrome';
    if (ua.indexOf('Firefox') > -1) return 'Firefox';
    if (ua.indexOf('Safari') > -1) return 'Safari';
    return 'Other';
  }

  // OS detection
  function getOS() {
    var ua = navigator.userAgent;
    if (ua.indexOf('Windows') > -1) return 'Windows';
    if (ua.indexOf('Android') > -1) return 'Android';
    if (ua.indexOf('iPhone') > -1 || ua.indexOf('iPad') > -1) return 'iOS';
    if (ua.indexOf('Mac') > -1) return 'macOS';
    if (ua.indexOf('Linux') > -1) return 'Linux';
    return 'Other';
  }

  // Scroll depth tracking
  var maxScroll = 0;
  window.addEventListener('scroll', function() {
    var scrolled = Math.round((window.scrollY + window.innerHeight) / Math.max(document.body.scrollHeight, 1) * 100);
    if (scrolled > maxScroll) maxScroll = Math.min(scrolled, 100);
  }, { passive: true });

  // Page timing
  var startTime = Date.now();
  var isEntry = false;
  try {
    isEntry = !document.referrer || new URL(document.referrer).hostname !== window.location.hostname;
  } catch(e) {
    isEntry = !document.referrer;
  }

  // Send tracking data
  function send(isExit) {
    var duration = Math.round((Date.now() - startTime) / 1000);
    var data = {
      siteId: SITE_ID,
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
