/* Path trace for "From this room" (click a row).
 *
 * A web page can't traceroute (browsers give pages no access to TTLs or
 * ICMP), so this runs an MTR on Globalping (api.globalping.io, free, public)
 * from a probe on the SAME ISP as this room - found from the room's public
 * IP via ipinfo.io - falling back to the same city, then the same country.
 * Public hops are then geolocated (ipinfo.io) so the path can be drawn.
 *
 * PathTrace.run(host, onProgress) -> Promise<{
 *   room: {city, region, country, org, asn, lat, lon},
 *   probe: {city, state, country, network, asn, lat, lon},
 *   target: {host, ip}, scope: 'isp'|'city'|'country',
 *   hops: [{n, ip, host, asn, org, city, country, lat, lon, private,
 *           avg, loss,          // as measured (replies from the router itself)
 *           ms, lossEff,        // what traffic THROUGH the hop sees (see settle())
 *           slowReply, replyLoss}]
 * }>
 */
(function () {
  'use strict';

  const GP = 'https://api.globalping.io/v1/measurements';
  const PACKETS = 8;
  const geoCache = new Map();

  async function json(url, init) {
    const r = await fetch(url, init);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((body.error && body.error.message) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return body;
  }

  const isPrivate = (ip) => !ip || /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|fc|fd|fe80)/i.test(ip);

  async function geo(ip) {
    if (isPrivate(ip)) return null;
    if (geoCache.has(ip)) return geoCache.get(ip);
    const p = json(`https://ipinfo.io/${ip}/json`).then((g) => {
      if (!g || g.bogon || !g.loc) return null;
      const [lat, lon] = g.loc.split(',').map(Number);
      return { lat, lon, city: g.city, region: g.region, country: g.country, org: g.org || '' };
    }).catch(() => null);
    geoCache.set(ip, p);
    return p;
  }

  async function roomInfo() {
    try { const c = sessionStorage.getItem('te-room-info'); if (c) return JSON.parse(c); } catch (_) { /* */ }
    const g = await json('https://ipinfo.io/json');
    const [lat, lon] = (g.loc || '0,0').split(',').map(Number);
    const asn = parseInt(((g.org || '').match(/^AS(\d+)/) || [])[1], 10) || null;
    const info = { ip: g.ip, city: g.city, region: g.region, country: g.country, org: (g.org || '').replace(/^AS\d+\s*/, ''), asn, lat, lon };
    try { sessionStorage.setItem('te-room-info', JSON.stringify(info)); } catch (_) { /* */ }
    return info;
  }

  async function startMtr(host, locations) {
    return json(GP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // 8 packets per hop (was 3): with 3, a single stray packet reads as 33% loss.
      body: JSON.stringify({ type: 'mtr', target: host, locations, limit: 1, measurementOptions: { protocol: 'TCP', port: 443, packets: PACKETS } }),
    });
  }

  async function run(host, onProgress) {
    const say = (m) => { if (onProgress) onProgress(m); };
    say('Locating this room…');
    const room = await roomInfo();
    // Same ISP first (closest to this room's real path), then city, then country.
    const tries = [];
    if (room.asn) tries.push(['isp', [{ asn: room.asn }]]);
    if (room.city) tries.push(['city', [{ magic: room.city }]]);
    if (room.country) tries.push(['country', [{ country: room.country }]]);
    tries.push(['any', [{ magic: 'world' }]]);
    let created = null, scope = null;
    for (const [sc, loc] of tries) {
      say(`Starting MTR to ${host} from a probe (${sc === 'isp' ? room.org : sc === 'city' ? room.city : sc === 'country' ? room.country : 'anywhere'})…`);
      try { created = await startMtr(host, loc); scope = sc; break; } catch (e) { if (e.status !== 422) throw e; }
    }
    if (!created) throw new Error('no probe available');
    say('Tracing the path…');
    let m;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      m = await json(`${GP}/${created.id}`);
      if (m.status !== 'in-progress') break;
    }
    const r = m && m.results && m.results[0];
    if (!r || !r.result || !r.result.hops) throw new Error((r && r.result && r.result.rawOutput) || 'trace did not finish');
    const p = r.probe;
    const probe = { city: p.city, state: p.state, country: p.country, network: p.network, asn: p.asn, lat: p.latitude, lon: p.longitude };
    say('Mapping hops…');
    const hops = await Promise.all(r.result.hops.map(async (h, i) => {
      const g = await geo(h.resolvedAddress);
      return {
        n: i + 1, ip: h.resolvedAddress, private: !!h.resolvedAddress && isPrivate(h.resolvedAddress), host: h.resolvedHostname && h.resolvedHostname !== h.resolvedAddress ? h.resolvedHostname : null,
        asn: (h.asn || [])[0] || null, org: g ? g.org.replace(/^AS\d+\s*/, '') : '', city: g ? g.city : '', country: g ? g.country : '',
        lat: g ? g.lat : null, lon: g ? g.lon : null,
        avg: h.stats && h.stats.avg != null ? h.stats.avg : null, loss: h.stats ? h.stats.loss : null,
      };
    }));
    settle(hops);
    return { room, probe, scope, target: { host, ip: r.result.resolvedAddress }, hops };
  }

  /** A trace measures how fast each ROUTER answers, and routers answer traces
   *  on a slow, low-priority path (and rate-limit them) while forwarding real
   *  traffic at full speed. Read the way ThousandEyes/MTR experts read it:
   *  - traffic can't reach hop N+1 sooner than hop N, so a hop's latency is
   *    bounded by the lowest latency at any hop AFTER it - a 350 ms hop followed
   *    by 9 ms hops is really <= 9 ms (the extra is its slow reply);
   *  - loss only counts if it carries on to later hops - 33% at one hop with
   *    0% after it is the router not answering, not packets being dropped. */
  function settle(hops) {
    let bestLat = Infinity, bestLoss = Infinity;
    for (let i = hops.length - 1; i >= 0; i--) {
      const h = hops[i];
      if (!h.ip) continue;
      h.ms = h.avg != null ? Math.min(h.avg, bestLat) : null;
      h.slowReply = h.avg != null && h.ms != null && h.avg - h.ms > Math.max(15, h.ms * 0.5);
      h.lossEff = h.loss != null ? Math.min(h.loss, bestLoss) : null;
      h.replyLoss = h.loss != null && h.lossEff != null && h.loss - h.lossEff >= 1;
      if (h.avg != null) bestLat = Math.min(bestLat, h.avg);
      if (h.loss != null) bestLoss = Math.min(bestLoss, h.loss);
    }
  }

  window.PathTrace = { run, settle };
})();
