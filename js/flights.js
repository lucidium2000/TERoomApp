// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
/* Flights button: major airlines' flights at cruise, worldwide, from the
 * OpenSky Network, thinned where the sky is crowded. A GitHub Action (.github/workflows/flights.yml) publishes a
 * snapshot to the `flights` branch every 15 minutes (3 with an OpenSky API
 * client); between snapshots each plane is moved along its own reported track
 * and speed, so the picture keeps flowing, and each plane draws the path it
 * is known to have flown over the last hour (positions from earlier
 * snapshots), with a pulse of light running along it. Hover or tap a plane
 * for its callsign, altitude and speed. Toggle: the Flights button, or ?flights=1. */
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const btn = document.getElementById('flightsBtn');
  let on = false;
  try { on = localStorage.getItem('te-flights') === '1'; } catch (_) { /* private mode */ }
  if (qs.has('flights')) on = qs.get('flights') !== '0';

  const RAD = Math.PI / 180, RE = 6371000;
  const MAX_AGE = 30 * 60;   // s: older than this, the tag says the data is delayed
  const HIDE_AGE = 3 * 3600;   // s: older than this, no planes at all
  const ALL = qs.get('flights') === 'all';
  // Thinning: in each CELL-degree square, keep about PER_CELL planes. Which ones is
  // decided by a hash of the aircraft's id, so the same planes stay from one
  // snapshot to the next (no flicker, paths stay whole).
  const CELL = 2, PER_CELL = 2.5;
  const hash01 = (id) => { let h = 2166136261; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  function thin(list) {
    const count = new Map(), key = (p) => Math.floor(p[2] / CELL) + ',' + Math.floor(p[3] / CELL);
    for (const p of list) { const k = key(p); count.set(k, (count.get(k) || 0) + 1); }
    return list.filter((p) => hash01(p[0]) < PER_CELL / count.get(key(p)));
  }
  const MAX_PROJECT = 45 * 60;   // s: keep flying a plane along its track until the next update, up to this
  const GLIDE_MS = 6000;   // a new update: each plane glides from where it was shown to its new position

  // ── Data ────────────────────────────────────────────────────────────────
  function sourceUrl() {
    if (qs.get('flightsurl')) return qs.get('flightsurl');
    const h = location.hostname, repo = location.pathname.split('/').filter(Boolean)[0];
    if (/\.github\.io$/.test(h) && repo) return `https://raw.githubusercontent.com/${h.split('.')[0]}/${repo}/flights/flights.json`;
    return 'https://raw.githubusercontent.com/lucidium2000/TERoomApp/flights/flights.json';   // local testing
  }
  let snap = null, planes = [], loading = false, lastLoad = 0, err = '', histFor = 0, glideUntil = 0;
  const A = [0, 0, 0, 0, 0], B = [0, 0, 0, 0, 0], X = [0, 0, 0];
  async function load() {
    if (loading) return;
    loading = true; lastLoad = Date.now();
    try {
      const r = await fetch(sourceUrl(), { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!snap || j.t !== snap.t) {
        // Where each plane is on screen now, so it can glide to its new position instead of jumping.
        const was = new Map();
        if (snap) {
          const odt = Math.min(Math.max(0, Date.now() / 1000 - snap.t), MAX_PROJECT);
          for (const p of planes) { pos(p, odt, A); was.set(p.id, [A[3], A[4]]); }
        }
        snap = j;
        // The data is already major airlines at cruise; thin out crowded skies (?flights=all keeps all).
        const list = ALL ? j.f : thin(j.f);
        planes = list.map(([id, cs, lon, lat, alt, spd, trk, vr, path]) => ({
          id, cs, alt, spd, trk, vr, lon, lat, path: path || [],
          lo: lon * RAD, sb: Math.sin(trk * RAD), cb: Math.cos(trk * RAD),
          sla: Math.sin(lat * RAD), cla: Math.cos(lat * RAD),
        }));
        histFor = 0;   // rebuild the paths
        const ndt = Math.min(Math.max(0, Date.now() / 1000 - snap.t), MAX_PROJECT), t0 = performance.now();
        for (const p of planes) {
          const w = was.get(p.id);
          if (!w) continue;
          at(p, ndt, A);
          let dlo = w[0] - A[3];
          if (dlo > 180) dlo -= 360; else if (dlo < -180) dlo += 360;
          const dla = w[1] - A[4];
          if (Math.abs(dlo) < 4 && Math.abs(dla) < 4) p.glide = { dlo, dla, t0 };   // a bigger gap: a different flight, no glide
        }
        glideUntil = t0 + GLIDE_MS;
      }
      err = '';
    } catch (e) {
      err = 'flight data unavailable';
      console.warn('[flights]', e);
    }
    loading = false;
    showTag();
  }

  /** A lon/lat in degrees as a unit vector. */
  function xyz(lon, lat, out) {
    const la = lat * RAD, lo = lon * RAD, c = Math.cos(la);
    out[0] = c * Math.cos(lo); out[1] = c * Math.sin(lo); out[2] = Math.sin(la);
    return out;
  }

  /** Where a plane is `dt` seconds after its fix (great circle along its track). */
  function at(p, dt, out) {
    const d = (p.spd * dt) / RE, sd = Math.sin(d), cd = Math.cos(d);
    const sla = p.sla * cd + p.cla * sd * p.cb;
    const la = Math.asin(sla);
    const lo = p.lo + Math.atan2(p.sb * sd * p.cla, cd - p.sla * sla);
    const c = Math.cos(la);
    out[0] = c * Math.cos(lo); out[1] = c * Math.sin(lo); out[2] = sla;
    out[3] = lo / RAD; out[4] = la / RAD;
    return out;
  }

  /** Where a plane is shown `dt` seconds after its fix: along its track, plus what's left of
   *  its glide from where it was shown before the latest update. */
  function pos(p, dt, out) {
    at(p, dt, out);
    const g = p.glide;
    if (!g) return out;
    const u = (performance.now() - g.t0) / GLIDE_MS;
    if (u >= 1) { p.glide = null; return out; }
    const f = 1 - u * u * (3 - 2 * u);   // ease in and out
    const lo = (out[3] + g.dlo * f) * RAD, la = (out[4] + g.dla * f) * RAD, c = Math.cos(la);
    out[0] = c * Math.cos(lo); out[1] = c * Math.sin(lo); out[2] = Math.sin(la);
    out[3] = lo / RAD; out[4] = la / RAD;
    return out;
  }

  // ── Button and the source tag ───────────────────────────────────────────
  const tag = document.createElement('div');
  tag.className = 'flights-tag'; tag.hidden = true;
  document.body.appendChild(tag);
  function showTag() {
    tag.hidden = !on;
    if (!on) return;
    if (err && !snap) { tag.innerHTML = `<b>Live flights</b> &middot; ${err}`; return; }
    if (!snap) { tag.innerHTML = '<b>Live flights</b> &middot; loading&hellip;'; return; }
    const age = Math.max(0, Date.now() / 1000 - snap.t), min = Math.round(age / 60);
    const when = age > MAX_AGE ? 'data delayed' : min < 1 ? 'positions just now' : `positions from ${min} min ago, projected forward`;
    tag.innerHTML = `<b>Live flights</b> &middot; ${planes.length.toLocaleString()} major-airline flights &middot; ${when} &middot; OpenSky Network`;
  }
  function show() {
    showTag();
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('span').textContent = on ? 'Flights: on' : 'Flights: off';
  }
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      on = !on;
      try { localStorage.setItem('te-flights', on ? '1' : '0'); } catch (_) { /* */ }
      try { if (window.Sfx) window.Sfx.play('tap'); } catch (_) { /* */ }
      if (on && Date.now() - lastLoad > 60000) load();
      if (!on) hide();
      show();
    });
  }
  show();
  if (on) load();
  setInterval(() => { if (on) { if (Date.now() - lastLoad > 3 * 60000) load(); else showTag(); } }, 20000);

  // Pointer, for the hover / tap card.
  let ptr = null;
  const setPtr = (e) => { ptr = { x: e.clientX, y: e.clientY, t: performance.now(), touch: e.pointerType === 'touch' }; };
  window.addEventListener('pointermove', setPtr, { passive: true, capture: true });
  window.addEventListener('pointerdown', setPtr, { passive: true, capture: true });

  // ── Google flight tracker link ──────────────────────────────────────────
  // Callsigns are ICAO (DAL123); Google knows flights by IATA code (DL123).
  const IATA = {
    AAL: 'AA', DAL: 'DL', UAL: 'UA', ASA: 'AS', JBU: 'B6', ACA: 'AC', WJA: 'WS', AMX: 'AM', BAW: 'BA', VIR: 'VS',
    EIN: 'EI', AFR: 'AF', KLM: 'KL', DLH: 'LH', SWR: 'LX', AUA: 'OS', SAS: 'SK', FIN: 'AY', IBE: 'IB', TAP: 'TP',
    ITY: 'AZ', THY: 'TK', UAE: 'EK', QTR: 'QR', ETD: 'EY', SVA: 'SV', ETH: 'ET', SAA: 'SA', SIA: 'SQ', CPA: 'CX',
    QFA: 'QF', ANZ: 'NZ', VOZ: 'VA', ANA: 'NH', JAL: 'JL', KAL: 'KE', AAR: 'OZ', CCA: 'CA', CES: 'MU', CSN: 'CZ',
    CAL: 'CI', EVA: 'BR', THA: 'TG', MAS: 'MH', GIA: 'GA', AIC: 'AI', TAM: 'LA', LAN: 'LA', AVA: 'AV', CMP: 'CM',
  };
  function flightNo(cs) {
    const m = /^([A-Z]{3})0*(\d+)$/.exec(cs || '');
    return m && IATA[m[1]] ? IATA[m[1]] + m[2] : '';
  }
  function trackerUrl(p) {
    const q = flightNo(p.cs) || p.cs || p.id;
    return 'https://www.google.com/search?q=' + encodeURIComponent(q + ' flight');
  }
  // From / to: looked up once per callsign when a plane is first hovered, from adsbdb.com
  // (a free, open route database keyed by callsign; it's the scheduled route, so now and
  // then out of date). Only the callsign is sent.
  const routes = new Map();   // callsign -> { from, to, airline } | 'loading' | null
  function route(cs) {
    if (!cs) return null;
    if (routes.has(cs)) return routes.get(cs);
    routes.set(cs, 'loading');
    fetch('https://api.adsbdb.com/v0/callsign/' + encodeURIComponent(cs), { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const fr = j && j.response && j.response.flightroute;
        const ap = (a) => a && { code: a.iata_code || a.icao_code, city: a.municipality || a.name || '', lon: a.longitude, lat: a.latitude };
        routes.set(cs, fr && fr.origin && fr.destination ? { from: ap(fr.origin), to: ap(fr.destination), airline: (fr.airline && fr.airline.name) || '' } : null);
      })
      .catch(() => routes.set(cs, null));
    return 'loading';
  }

  // The database gives a flight number's usual route, which is often another leg of the same
  // number (or the return leg). Only show it when it fits the plane: roughly on the line
  // between the two airports and heading for the destination. Flying the other way along
  // it: the return leg, so swap. Anything else: not shown.
  const gcDist = (lo1, la1, lo2, la2) => {
    const h = Math.sin((la2 - la1) * RAD / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin((lo2 - lo1) * RAD / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const bearing = (lo1, la1, lo2, la2) => {
    const y = Math.sin((lo2 - lo1) * RAD) * Math.cos(la2 * RAD);
    const x = Math.cos(la1 * RAD) * Math.sin(la2 * RAD) - Math.sin(la1 * RAD) * Math.cos(la2 * RAD) * Math.cos((lo2 - lo1) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  };
  function fitRoute(rt, p) {
    const { from: o, to: d } = rt;
    if (o.lat == null || d.lat == null) return null;
    const len = gcDist(o.lon, o.lat, d.lon, d.lat);
    const detour = gcDist(o.lon, o.lat, p.lon, p.lat) + gcDist(p.lon, p.lat, d.lon, d.lat) - len;
    if (detour > Math.max(250, 0.25 * len)) return null;   // not on this route at all
    const off = (to) => { const a = Math.abs(bearing(p.lon, p.lat, to.lon, to.lat) - p.trk); return a > 180 ? 360 - a : a; };
    if (off(d) < 70) return rt;
    if (off(o) < 70) return { from: d, to: o, airline: rt.airline };   // the return leg
    return null;
  }

  let pin = null;   // { id, t }: a plane picked in search
  window.addEventListener('pointerdown', (e) => { if (pin && !(hot && inRect(e.clientX, e.clientY, hot.rect))) pin = null; }, { passive: true, capture: true });

  // ── Search (used by the globe's search panel) ───────────────────────────
  const NAMES = {
    AAL: 'American Airlines', DAL: 'Delta Air Lines', UAL: 'United Airlines', ASA: 'Alaska Airlines', JBU: 'JetBlue',
    ACA: 'Air Canada', WJA: 'WestJet', AMX: 'Aeromexico', BAW: 'British Airways', VIR: 'Virgin Atlantic', EIN: 'Aer Lingus',
    AFR: 'Air France', KLM: 'KLM', DLH: 'Lufthansa', SWR: 'Swiss', AUA: 'Austrian', SAS: 'SAS', FIN: 'Finnair', IBE: 'Iberia',
    TAP: 'TAP Air Portugal', ITY: 'ITA Airways', THY: 'Turkish Airlines', UAE: 'Emirates', QTR: 'Qatar Airways', ETD: 'Etihad',
    SVA: 'Saudia', ETH: 'Ethiopian Airlines', SAA: 'South African Airways', SIA: 'Singapore Airlines', CPA: 'Cathay Pacific',
    QFA: 'Qantas', ANZ: 'Air New Zealand', VOZ: 'Virgin Australia', ANA: 'ANA', JAL: 'Japan Airlines', KAL: 'Korean Air',
    AAR: 'Asiana', CCA: 'Air China', CES: 'China Eastern', CSN: 'China Southern', CAL: 'China Airlines', EVA: 'EVA Air',
    THA: 'Thai Airways', MAS: 'Malaysia Airlines', GIA: 'Garuda Indonesia', AIC: 'Air India', TAM: 'LATAM', LAN: 'LATAM',
    AVA: 'Avianca', CMP: 'Copa Airlines',
  };
  /** Flights matching a callsign (DAL802), flight number (DL802) or airline name (delta). */
  function find(q, max = 8) {
    const Q = String(q || '').toUpperCase().replace(/\s+/g, '');
    if (Q.length < 2 || !planes.length) return [];
    const words = String(q).toLowerCase().trim();
    const out = [];
    for (const p of planes) {
      const fn = flightNo(p.cs), code = (p.cs || '').slice(0, 3), name = NAMES[code] || '';
      let score = 0;
      if (p.cs === Q || fn === Q) score = 3;
      else if ((p.cs || '').startsWith(Q) || (fn && fn.startsWith(Q))) score = 2;
      else if (words.length >= 3 && name.toLowerCase().startsWith(words)) score = 1;
      if (score) out.push({ score, id: p.id, cs: p.cs, flight: fn, airline: name, lon: p.lon, lat: p.lat, alt: p.alt });
    }
    out.sort((a, b) => b.score - a.score || (a.cs < b.cs ? -1 : 1));
    return out.slice(0, max);
  }
  /** Show a plane's card (it stays until the screen is touched elsewhere); returns where it is now. */
  function focus(id) {
    const p = planes.find((x) => x.id === id);
    if (!p) return null;
    pin = { id, t: performance.now() };
    const dt = snap ? Math.min(Math.max(0, Date.now() / 1000 - snap.t), MAX_PROJECT) : 0;
    pos(p, dt, A);
    return [A[3], A[4]];
  }
  /** Turn the Flights layer on (as the button would). */
  function turnOn() { if (!on && btn) btn.click(); }

  // The plane under the pointer and its card, from the last frame: a click on either opens the tracker.
  let hot = null;
  const inRect = (x, y, r) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  window.addEventListener('click', (e) => {
    if (!on || !hot) return;
    const onCard = inRect(e.clientX, e.clientY, hot.rect);
    const onPlane = (e.clientX - hot.x) ** 2 + (e.clientY - hot.y) ** 2 < (e.pointerType === 'touch' ? 22 : 12) ** 2;
    // Touch: the first tap shows the card, tapping the card opens it. Mouse: the plane or the card.
    if (!(onCard || (onPlane && e.pointerType !== 'touch'))) return;
    e.stopPropagation(); e.preventDefault();
    window.open(trackerUrl(hot.p), '_blank', 'noopener');
  }, true);

  // A small plane icon, drawn once (pointing right).
  let icon = null;
  function planeIcon() {
    const S = 48, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d'); g.translate(S / 2, S / 2); g.scale(S / 24, S / 24);
    g.fillStyle = '#f8fafc';
    g.beginPath();
    g.moveTo(10, 0); g.quadraticCurveTo(9, -1.3, 6, -1.3); g.lineTo(1.5, -1.3); g.lineTo(-3, -8.5); g.lineTo(-5, -8.5); g.lineTo(-2.2, -1.3);
    g.lineTo(-7, -1.3); g.lineTo(-9, -4); g.lineTo(-10.3, -4); g.lineTo(-9.2, 0);
    g.lineTo(-10.3, 4); g.lineTo(-9, 4); g.lineTo(-7, 1.3); g.lineTo(-2.2, 1.3); g.lineTo(-5, 8.5); g.lineTo(-3, 8.5); g.lineTo(1.5, 1.3);
    g.lineTo(6, 1.3); g.quadraticCurveTo(9, 1.3, 10, 0); g.closePath(); g.fill();
    return c;
  }

  // ── Drawing (called by app.js with its overlay projection) ─────────────
  // The WebGL globe draws everything: the known paths (one buffer per
  // snapshot) and the planes with the line from each fix to where the plane
  // is now (refreshed once a second). The 2D overlay only adds the hover /
  // tap card, and plain dots if WebGL extras aren't available.
  const TAIL_S = 180;   // no known path yet: a short tail along the track
  let gl = null, glOk = true, built = 0, builtFor = 0, vis = [], visXY = [], visAt = 0;
  const colour = (alt) => (alt < 3000 ? [0.18, 0.83, 0.75] : alt < 8000 ? [0.49, 0.83, 0.99] : [0.95, 0.96, 0.98]);
  const phase = (i) => ((i * 0.6180339887) % 1);

  function put(arr, o, P, tx, ty, tz, c, a, sz) {
    arr[o] = P[0]; arr[o + 1] = P[1]; arr[o + 2] = P[2];
    arr[o + 3] = tx; arr[o + 4] = ty; arr[o + 5] = tz;
    arr[o + 6] = c[0]; arr[o + 7] = c[1]; arr[o + 8] = c[2]; arr[o + 9] = a; arr[o + 10] = sz;
  }

  /** The known paths, as line vertices: path points (oldest first) then the fix. */
  function buildHist() {
    let segs = 0;
    for (const p of planes) segs += p.path.length ? p.path.length / 3 : 1;
    const arr = new Float32Array(segs * 2 * 11), P = [0, 0, 0], Q = [0, 0, 0];
    let o = 0;
    for (let i = 0; i < planes.length; i++) {
      const p = planes[i], c = colour(p.alt), ph = phase(i), h = p.path;
      const F = xyz(p.lon, p.lat, [0, 0, 0]);
      if (!h.length) {
        at(p, -TAIL_S, A);
        put(arr, o, A, ph, 0, 0, c, 0.75, -TAIL_S); o += 11; put(arr, o, F, ph, 0, 0, c, 0.75, 0); o += 11;
        continue;
      }
      for (let k = 0; k < h.length; k += 3) {
        xyz(h[k + 1], h[k + 2], P);
        const nx = k + 3 < h.length;
        if (nx) xyz(h[k + 4], h[k + 5], Q);
        put(arr, o, P, ph, 0, 0, c, 0.75, -h[k]); o += 11;
        put(arr, o, nx ? Q : F, ph, 0, 0, c, 0.75, nx ? -h[k + 3] : 0); o += 11;
      }
    }
    return arr;
  }

  function build(dt, R) {
    const n = planes.length, arr = new Float32Array(n * 3 * 11), dpr = window.devicePixelRatio || 1;
    for (let i = 0; i < n; i++) {
      const p = planes[i], c = colour(p.alt);
      pos(p, dt, A); pos(p, dt + 120, B);
      put(arr, i * 11, A, B[0], B[1], B[2], c, p.alt < 3000 ? 0.85 : 1, 1);
      const o = (n + i * 2) * 11;
      put(arr, o, xyz(p.lon, p.lat, X), phase(i), 0, 0, c, 0.75, 0);
      put(arr, o + 11, A, phase(i), 0, 0, c, 0.75, dt);
    }
    const hist = histFor !== snap.t ? buildHist() : null;
    histFor = snap.t;
    const px = Math.max(3.5, Math.min(13, R * 0.011)) * dpr;   // dots when the whole globe shows, aircraft when zoomed in
    return gl.setFlights(arr, n, hist, { now: dt, hist: snap.hist || 3600, px });
  }

  function draw(ctx, proj, k, now, glr, R) {
    gl = glOk && glr && glr.fx && glr.fx.available && glr.fx.setFlights ? glr.fx : null;   // glOk: false if its flight shader failed
    const age = snap ? Date.now() / 1000 - snap.t : Infinity;
    if (!snap || !planes.length || age > HIDE_AGE) { if (gl) gl.setFlights(null); return; }
    const dt = Math.min(Math.max(0, age), MAX_PROJECT), t = performance.now();
    R = R || 430 * k;
    // Move the planes once a second (a jet covers ~250 m, under a pixel zoomed out); more often
    // zoomed in, where that would be a visible step, and while they glide after an update.
    const every = t < glideUntil ? 50 : R > 2500 ? 100 : R > 1000 ? 250 : 1000;
    if (gl && (t - built > every || builtFor !== snap.t)) { if (!build(dt, R)) gl = null, glOk = false; built = t; builtFor = snap.t; }
    // Twice a second: which planes are on screen (for the hover card).
    const live = ptr && t - ptr.t < (ptr.touch ? 6000 : 3000);
    if (t - visAt > 500) {
      visAt = t; vis = []; visXY = [];
      const W = window.innerWidth, H = window.innerHeight;
      for (let i = 0; i < planes.length; i++) {
        pos(planes[i], dt, A);
        const s = proj.point(A[3], A[4], [A[0], A[1], A[2]]);
        if (s && s[0] > -20 && s[1] > -20 && s[0] < W + 20 && s[1] < H + 20) { vis.push(i); visXY.push(s[0], s[1]); }
      }
    }
    ctx.save();
    if (!gl) {
      // No WebGL extras: plain dots on the 2D overlay, plane icons when few are in view.
      const icons = vis.length <= 300;
      if (icons && !icon) icon = planeIcon();
      ctx.fillStyle = 'rgba(226,232,240,.8)';
      ctx.beginPath();
      for (const i of vis) {
        const p = planes[i];
        pos(p, dt, A); const s = proj.point(A[3], A[4], [A[0], A[1], A[2]]);
        if (!s) continue;
        if (!icons) { ctx.rect(s[0] - 1, s[1] - 1, 2.2, 2.2); continue; }
        pos(p, dt + 90, B); const s2 = proj.point(B[3], B[4], [B[0], B[1], B[2]]);
        const ps = 13 * Math.min(1.3, k);
        ctx.save(); ctx.translate(s[0], s[1]); ctx.rotate(s2 ? Math.atan2(s2[1] - s[1], s2[0] - s[0]) : 0);
        ctx.drawImage(icon, -ps / 2, -ps / 2, ps, ps); ctx.restore();
      }
      ctx.fill();
    }
    let hit = -1, hx = 0, hy = 0, best = (ptr && ptr.touch ? 22 : 12) ** 2;
    if (live) {
      let bi = -1;
      for (let j = 0; j < vis.length; j++) { const d = (visXY[2 * j] - ptr.x) ** 2 + (visXY[2 * j + 1] - ptr.y) ** 2; if (d < best) { best = d; bi = vis[j]; } }
      if (bi >= 0) { pos(planes[bi], dt, A); const s = proj.point(A[3], A[4], [A[0], A[1], A[2]]); if (s) { hit = bi; hx = s[0]; hy = s[1]; } }
    }
    // Keep the card while the pointer is on it or on its way there (other planes under it don't steal it).
    const near = hot && { x: hot.rect.x - 16, y: hot.rect.y - 16, w: hot.rect.w + 32, h: hot.rect.h + 32 };
    if (live && hot && hit !== hot.i && inRect(ptr.x, ptr.y, near) && planes[hot.i] === hot.p) {
      pos(hot.p, dt, A); const s = proj.point(A[3], A[4], [A[0], A[1], A[2]]);
      if (s) { hit = hot.i; hx = s[0]; hy = s[1]; }
    }
    // A plane picked in search: its card stays up until the screen is touched elsewhere (or 30 s).
    if (hit < 0 && pin && t - pin.t < 30000) {
      const i = planes.findIndex((p) => p.id === pin.id);
      if (i >= 0) { pos(planes[i], dt, A); const s = proj.point(A[3], A[4], [A[0], A[1], A[2]]); if (s) { hit = i; hx = s[0]; hy = s[1]; } }
    }
    if (hit >= 0) {
      trace(ctx, proj, planes[hit], dt, k);
      hot = { i: hit, p: planes[hit], x: hx, y: hy, rect: card(ctx, hx, hy, planes[hit], k) };
    } else hot = null;
    document.documentElement.classList.toggle('flight-hot', !!hot && !!ptr && !ptr.touch);
    ctx.restore();
  }

  /** The hovered plane's whole known path, highlighted. */
  function trace(ctx, proj, p, dt, k) {
    const pts = [];
    for (let i = 0; i < p.path.length; i += 3) pts.push([p.path[i + 1], p.path[i + 2]]);
    pts.push([p.lon, p.lat]);
    pos(p, dt, A); pts.push([A[3], A[4]]);
    ctx.strokeStyle = 'rgba(253,224,71,.9)'; ctx.lineWidth = 2 * k; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (const [lo, la] of pts) {
      const s = proj.point(lo, la, xyz(lo, la, X));
      if (!s) { pen = false; continue; }
      if (pen) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
      pen = true;
    }
    ctx.stroke();
  }
  function hide() { if (gl) gl.setFlights(null); hot = null; document.documentElement.classList.remove('flight-hot'); }

  function card(ctx, x, y, p, k) {
    const font = (wt, px) => `${wt} ${Math.round(px * k)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    const ft = Math.round(p.alt * 3.281 / 100) * 100, kt = Math.round(p.spd * 1.944);
    const climb = p.vr > 1.5 ? ' · climbing' : p.vr < -1.5 ? ' · descending' : '';
    const raw = route(p.cs), rt = raw && raw !== 'loading' ? fitRoute(raw, p) : raw;
    const head = (p.cs || p.id.toUpperCase()) + (raw && raw !== 'loading' && raw.airline ? ` · ${raw.airline}` : '');
    const known = p.path.length ? ` · path: last ${Math.max(1, Math.round(p.path[0] / 60))} min` : '';
    const lr = rt === 'loading' ? 'Looking up route…' : rt ? `${rt.from.code} ${rt.from.city}  →  ${rt.to.code} ${rt.to.city}` : raw ? 'Route not confirmed – see tracker' : 'Route not known';
    const l1 = `${ft.toLocaleString()} ft · ${kt} kt · heading ${Math.round(p.trk)}°${climb}${known}`;
    const l2 = `Track ${flightNo(p.cs) || p.cs || p.id} on Google ↗`;
    ctx.strokeStyle = 'rgba(253,224,71,.95)'; ctx.lineWidth = 1.6 * k;
    ctx.beginPath(); ctx.arc(x, y, 8 * k, 0, Math.PI * 2); ctx.stroke();
    ctx.font = font(800, 12); const w1 = ctx.measureText(head).width;
    ctx.font = font(700, 12); const wr = ctx.measureText(lr).width;
    ctx.font = font(500, 11); const w2 = ctx.measureText(l1).width;
    ctx.font = font(700, 11); const w3 = ctx.measureText(l2).width;
    const pad = 8 * k, w = Math.max(w1, wr, w2, w3) + pad * 2, h = 70 * k;
    let bx = x + 14 * k, by = y - h - 8 * k;
    const LEFT = 76;   // clear of the globe controls down the left edge
    if (bx + w > window.innerWidth - 4) bx = x - 14 * k - w;
    if (bx < LEFT) bx = Math.max(Math.min(LEFT, window.innerWidth - w - 4), Math.min(window.innerWidth - w - 4, x - w / 2));
    if (by < 4) by = y + 12 * k;
    ctx.fillStyle = 'rgba(8,13,26,.92)'; ctx.strokeStyle = 'rgba(125,211,252,.45)'; ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, w, h, 8 * k); else ctx.rect(bx, by, w, h);
    ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = font(800, 12); ctx.fillStyle = '#f8fafc'; ctx.fillText(head, bx + pad, by + 13 * k);
    ctx.font = font(700, 12); ctx.fillStyle = rt && rt !== 'loading' ? '#fde68a' : '#64748b'; ctx.fillText(lr, bx + pad, by + 29 * k);
    ctx.font = font(500, 11); ctx.fillStyle = '#94a3b8'; ctx.fillText(l1, bx + pad, by + 44 * k);
    ctx.font = font(700, 11); ctx.fillStyle = '#7dd3fc'; ctx.fillText(l2, bx + pad, by + 59 * k);
    ctx.fillRect(bx + pad, by + 65 * k, w3, Math.max(1, 0.8 * k));   // underline: it's a link
    return { x: bx, y: by, w, h };
  }

  window.Flights = { get on() { return on; }, draw, find, focus, turnOn, prefetch: () => { if (!snap) load(); }, _reload: () => { lastLoad = 0; return load(); }, _state: () => ({ snap: snap && { t: snap.t, n: snap.n }, err, inView: vis.length, firstXY: visXY.slice(0, 2), hot: hot && { cs: hot.p.cs, x: hot.x, y: hot.y, rect: hot.rect } }) };
})();
