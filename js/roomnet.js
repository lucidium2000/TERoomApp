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
  const CYCLE_MS = 30000, KEEP = 24, BASE_N = 10;
  // Lightweight SERVICE endpoints, not marketing sites (www.webex.com sits
  // behind bot protection and answers 403 after extra steps; office.com
  // redirects to a 60 KB sign-in page; zoom.us / aws.amazon.com aren't cached).
  const TARGETS = [
    { name: 'Webex', term: 'webex', url: 'https://wdm-a.wbx2.com/wdm/api/v1/ping', what: 'Webex device management service health check' },
    { name: 'Microsoft 365', term: 'microsoft', url: 'https://login.microsoftonline.com/favicon.ico', what: 'Microsoft Entra ID sign-in (M365 dependency)' },
    { name: 'Zoom', term: 'zoom', url: 'https://st1.zoom.us/favicon.ico', what: 'Zoom static content network' },
    { name: 'Google', term: 'google', url: 'https://www.gstatic.com/generate_204', what: "Google's connectivity check" },
    { name: 'AWS', term: 'amazon', url: 'https://ec2.us-east-1.amazonaws.com/ping', what: 'AWS EC2 us-east-1 health check' },
  ];

  const probes = TARGETS.map((t) => ({ ...t, samples: [], baseline: null, status: 'pending', last: null }));
  let opts = {}, timer = 0;

  async function timeOnce(url) {
    const u = url + (url.includes('?') ? '&' : '?') + 'rn=' + Date.now() + Math.random().toString(36).slice(2, 6);
    const t0 = performance.now();
    await fetch(u, { mode: 'no-cors', cache: 'no-store' });
    return performance.now() - t0;
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
    if (p.baseline == null) return 'ok';
    const r = last.ms / p.baseline, extra = last.ms - p.baseline;
    if (r > 1.8 && extra > 150) return 'slow';
    if (r > 1.35 && extra > 70) return 'warn';
    return 'ok';
  }

  async function probe(p) {
    let ms = null;
    try {
      await timeOnce(p.url).catch(() => {});   // warm-up: DNS, TCP, TLS
      ms = await timeOnce(p.url);
    } catch (_) { ms = null; }
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
    start(o) {
      if (qs.get('roomnet') === '0' || timer) return;
      opts = o || {};
      setTimeout(cycle, 3000);
      timer = setInterval(cycle, CYCLE_MS);
      if (opts.onUpdate) opts.onUpdate(probes);
    },
  };
})();
