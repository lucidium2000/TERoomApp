/* "From this room": live response times from this browser to the services
 * people here depend on - a tiny, in-browser take on a ThousandEyes agent.
 *
 * Every CYCLE_MS each target gets a warm-up request (so the connection is
 * open) and then one timed request; the timing is HTTP response time as the
 * browser sees it, not ICMP. Status is judged against each target's OWN
 * recent baseline (median of its last good samples), so a service that is
 * always ~370 ms is green at 370 ms and only turns amber/red when it gets
 * noticeably slower than usual - or red when it can't be reached.
 *
 * RoomNet.start({ onUpdate(probes), outageFor(term) -> 'active'|'recent'|null })
 * ?roomnet=0 disables it.
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  // KEEP: an hour of samples, for the panel's timeline (one every CYCLE_MS).
  const CYCLE_MS = 30000, KEEP = 125, BASE_N = 10;
  // Lightweight SERVICE endpoints, not marketing sites (www.webex.com sits
  // behind bot protection and answers 403 after extra steps; office.com
  // redirects to a 60 KB sign-in page; zoom.us / aws.amazon.com aren't cached).
  // All five allow cross-origin reads (CORS), so the real HTTP status of the
  // HTTPS (443) request is visible - in no-cors mode browsers hide it.
  const TARGETS = [
    { name: 'Webex', term: 'webex', url: 'https://wdm-a.wbx2.com/wdm/api/v1/ping', what: 'Webex device management service health check' },
    { name: 'Microsoft 365', term: 'microsoft', url: 'https://graph.microsoft.com/v1.0/', what: 'Microsoft Graph API (Microsoft 365)' },
    { name: 'Zoom', term: 'zoom', url: 'https://st1.zoom.us/favicon.ico', what: 'Zoom static content network' },
    { name: 'Google', term: 'google', url: 'https://www.googleapis.com/discovery/v1/apis?name=drive&preferred=true', what: 'Google APIs front end' },
    { name: 'AWS', term: 'amazon', url: 'https://ec2.us-east-1.amazonaws.com/ping', what: 'AWS EC2 us-east-1 health check' },
  ];
  const REASON = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved', 302: 'Found', 304: 'Not Modified', 307: 'Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Not Allowed', 429: 'Too Many Requests',
    500: 'Server Error', 502: 'Bad Gateway', 503: 'Unavailable', 504: 'Gateway Timeout' };

  // Addresses edited on this device (the pencil in the panel), by term.
  const KEY = 'te-probe-urls';
  let custom = {};
  try { custom = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { custom = {}; }
  const probes = TARGETS.map((t) => ({
    ...t, defaultUrl: t.url, url: custom[t.term] || t.url, custom: !!custom[t.term], what: custom[t.term] ? 'Custom address' : t.what,
    samples: [], baseline: null, status: 'pending', last: null, code: null, reason: '',
  }));
  let opts = {}, timer = 0;

  async function timeOnce(url, p) {
    // No cache-busting query string: some APIs reject unknown parameters
    // (EC2's /ping answers 400). cache: 'no-store' already bypasses the cache.
    const t0 = performance.now();
    let r;
    try {
      if (p && p.opaque) throw new Error('opaque');
      r = await fetch(url, { mode: 'cors', cache: 'no-store', credentials: 'omit' });
    } catch (e) {
      // An address that doesn't allow cross-origin reads (common for sites
      // typed in by hand): still time it, without the status code. If it's
      // simply unreachable, this throws too and the check reads as down.
      const t1 = performance.now();
      await fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' });
      if (p) p.opaque = true;
      return { ms: performance.now() - t1, code: null, reason: '' };
    }
    const ms = performance.now() - t0;
    r.body && r.body.cancel && r.body.cancel().catch(() => {});
    return { ms, code: r.status, reason: r.statusText || REASON[r.status] || '' };
  }

  function median(a) {
    const s = a.slice().sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  }

  function judge(p) {
    const recent = p.samples.slice(-2);
    if (recent.length === 2 && recent.every((s) => s.ms == null)) return 'down';
    const last = p.samples[p.samples.length - 1];
    if (!last || last.ms == null) return p.status === 'pending' ? 'pending' : p.status;
    if (p.code >= 500) return 'slow';   // reachable but the service itself is erroring
    if (p.baseline == null) return 'ok';
    const r = last.ms / p.baseline, extra = last.ms - p.baseline;
    if (r > 1.8 && extra > 150) return 'slow';
    if (r > 1.35 && extra > 70) return 'warn';
    return 'ok';
  }

  async function probe(p) {
    let ms = null;
    try {
      await timeOnce(p.url, p).catch(() => {});   // warm-up: DNS, TCP, TLS
      const t = await timeOnce(p.url, p);
      ms = t.ms; p.code = t.code; p.reason = t.reason;
    } catch (_) { ms = null; p.code = null; p.reason = ''; }
    // Baseline from the good samples BEFORE this one, so a spike can't hide itself.
    const good = p.samples.filter((s) => s.ms != null).slice(-BASE_N).map((s) => s.ms);
    p.baseline = good.length >= 3 ? median(good) : (good.length ? Math.min(...good) : null);
    p.samples.push({ t: Date.now(), ms });
    if (p.samples.length > KEEP) p.samples.shift();
    p.last = ms;
    p.status = judge(p);
  }

  async function cycle() {
    if (document.hidden) return;
    for (const p of probes) {
      await probe(p);
      if (opts.onUpdate) opts.onUpdate(probes);
    }
  }

  window.RoomNet = {
    probes,
    /** Check a different address for probe i (null: back to the default).
     *  Saved on this device; history restarts and it's checked at once. */
    setUrl(i, url) {
      const p = probes[i];
      if (!p) return;
      p.url = url || p.defaultUrl; p.custom = !!url && url !== p.defaultUrl;
      p.what = p.custom ? 'Custom address' : (TARGETS[i] && TARGETS[i].what) || p.what;
      p.samples = []; p.baseline = null; p.status = 'pending'; p.last = null; p.code = null; p.reason = ''; p.opaque = false;
      if (p.custom) custom[p.term] = p.url; else delete custom[p.term];
      try { localStorage.setItem(KEY, JSON.stringify(custom)); } catch (_) { /* private mode */ }
      if (opts.onUpdate) opts.onUpdate(probes);
      probe(p).then(() => { if (opts.onUpdate) opts.onUpdate(probes); });
    },
    start(o) {
      if (qs.get('roomnet') === '0' || timer) return;
      opts = o || {};
      setTimeout(cycle, 3000);
      timer = setInterval(cycle, CYCLE_MS);
      if (opts.onUpdate) opts.onUpdate(probes);
    },
  };
})();
