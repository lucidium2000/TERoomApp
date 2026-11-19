// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
/* Flights (demo): a SIMULATED picture of US air traffic, a mock-up of what a
 * live flight layer could look like. Planes fly great-circle routes between
 * real major airports, with traffic weighted by hub size and time sped up.
 * Nothing here is real flight data. Toggle: the "Flights (demo)" button or
 * ?flights=1. Remove: this file, the button in index.html, one call in app.js. */
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const btn = document.getElementById('flightsBtn');
  let on = false;
  try { on = localStorage.getItem('te-flights') === '1'; } catch (_) { /* private mode */ }
  if (qs.has('flights')) on = qs.get('flights') !== '0';

  // [code, lat, lon, weight] - weight is roughly relative hub traffic
  const AIRPORTS = [
    ['ATL', 33.64, -84.43, 10], ['DFW', 32.90, -97.04, 9], ['DEN', 39.86, -104.67, 9], ['ORD', 41.97, -87.91, 9],
    ['LAX', 33.94, -118.41, 8], ['JFK', 40.64, -73.78, 7], ['LAS', 36.08, -115.15, 6], ['MCO', 28.43, -81.31, 6],
    ['MIA', 25.80, -80.29, 5], ['CLT', 35.21, -80.94, 7], ['SEA', 47.45, -122.31, 6], ['PHX', 33.43, -112.01, 6],
    ['EWR', 40.69, -74.17, 6], ['SFO', 37.62, -122.38, 6], ['IAH', 29.99, -95.34, 6], ['BOS', 42.36, -71.01, 5],
    ['MSP', 44.88, -93.22, 5], ['DTW', 42.21, -83.35, 5], ['FLL', 26.07, -80.15, 4], ['PHL', 39.87, -75.24, 4],
    ['LGA', 40.78, -73.87, 5], ['BWI', 39.18, -76.67, 4], ['SLC', 40.79, -111.98, 4], ['DCA', 38.85, -77.04, 4],
    ['IAD', 38.95, -77.46, 3], ['SAN', 32.73, -117.19, 3], ['TPA', 27.98, -82.53, 3], ['BNA', 36.12, -86.68, 4],
    ['AUS', 30.19, -97.67, 3], ['MDW', 41.79, -87.75, 3], ['PDX', 45.59, -122.60, 3], ['STL', 38.75, -90.37, 2],
    ['RDU', 35.88, -78.79, 3], ['HNL', 21.32, -157.92, 3], ['MSY', 29.99, -90.26, 2], ['SJC', 37.36, -121.93, 2],
    ['SMF', 38.70, -121.59, 2], ['SAT', 29.53, -98.47, 2], ['MCI', 39.30, -94.71, 2], ['CLE', 41.41, -81.85, 2],
    ['PIT', 40.49, -80.23, 2], ['IND', 39.72, -86.29, 2], ['CMH', 39.99, -82.89, 2], ['ANC', 61.17, -149.99, 2],
    ['SJU', 18.44, -66.00, 2], ['ABQ', 35.04, -106.61, 1], ['BOI', 43.56, -116.22, 1], ['OMA', 41.30, -95.89, 1],
  ];
  const RAD = Math.PI / 180;
  const unit = (lat, lon) => { const p = lat * RAD, l = lon * RAD, c = Math.cos(p); return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)]; };
  const AP = AIRPORTS.map(([code, lat, lon, w]) => ({ code, lat, lon, w, v: unit(lat, lon) }));
  const TOTAL_W = AP.reduce((a, b) => a + b.w, 0);
  const pickAP = () => { let r = Math.random() * TOTAL_W; for (const a of AP) { r -= a.w; if (r <= 0) return a; } return AP[0]; };

  const N = 160;   // planes in the air at once
  const SPEED = 900 / 3600 * 40;   // km per real second: ~900 km/h, time sped up 40x
  const flights = [];
  function spawn(f, now, anyProgress) {
    let a, b, d;
    do { a = pickAP(); b = pickAP(); d = Math.acos(Math.max(-1, Math.min(1, a.v[0] * b.v[0] + a.v[1] * b.v[1] + a.v[2] * b.v[2]))); }
    while (a === b || d * 6371 < 350);
    const dur = (d * 6371 / SPEED) * 1000;
    f.a = a; f.b = b; f.ang = d; f.sin = Math.sin(d); f.dur = dur;
    f.t0 = now - (anyProgress ? Math.random() * dur : 0);
    f.lane = (Math.random() - 0.5) * 0.004;   // a little sideways spread so routes don't sit on one line
    return f;
  }
  /** Great-circle position at progress u (0-1), as a unit vector. */
  function pos(f, u) {
    const A = Math.sin((1 - u) * f.ang) / f.sin, B = Math.sin(u * f.ang) / f.sin;
    const v = [A * f.a.v[0] + B * f.b.v[0], A * f.a.v[1] + B * f.b.v[1], A * f.a.v[2] + B * f.b.v[2] + f.lane * Math.sin(u * Math.PI)];
    const n = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / n, v[1] / n, v[2] / n];
  }
  const llOf = (v) => [Math.atan2(v[1], v[0]) / RAD, Math.asin(v[2]) / RAD];

  // One small plane sprite, drawn once.
  let plane = null;
  function planeSprite() {
    const S = 48, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d'); g.translate(S / 2, S / 2); g.scale(S / 24, S / 24);
    g.fillStyle = '#f8fafc';
    g.beginPath();   // pointing right (+x)
    g.moveTo(10, 0); g.quadraticCurveTo(9, -1.3, 6, -1.3); g.lineTo(1.5, -1.3); g.lineTo(-3, -8.5); g.lineTo(-5, -8.5); g.lineTo(-2.2, -1.3);
    g.lineTo(-7, -1.3); g.lineTo(-9, -4); g.lineTo(-10.3, -4); g.lineTo(-9.2, 0);
    g.lineTo(-10.3, 4); g.lineTo(-9, 4); g.lineTo(-7, 1.3); g.lineTo(-2.2, 1.3); g.lineTo(-5, 8.5); g.lineTo(-3, 8.5); g.lineTo(1.5, 1.3);
    g.lineTo(6, 1.3); g.quadraticCurveTo(9, 1.3, 10, 0); g.closePath(); g.fill();
    return c;
  }

  // ── Button and the "simulated" tag ──────────────────────────────────────
  const tag = document.createElement('div');
  tag.className = 'flights-tag'; tag.hidden = true;
  tag.innerHTML = '<b>Simulated flights</b> &middot; mock-up, not live data';
  document.body.appendChild(tag);
  function show() {
    tag.hidden = !on;
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('span').textContent = on ? 'Flights (demo): on' : 'Flights (demo): off';
  }
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      on = !on;
      try { localStorage.setItem('te-flights', on ? '1' : '0'); } catch (_) { /* */ }
      try { if (window.Sfx) window.Sfx.play('tap'); } catch (_) { /* */ }
      show();
    });
  }
  show();

  // ── Drawing (called by app.js with its overlay projection) ─────────────
  function draw(ctx, proj, k, now) {
    if (!plane) plane = planeSprite();
    if (!flights.length) for (let i = 0; i < N; i++) flights.push(spawn({}, now, true));
    const ps = 11 * Math.min(1.3, k);   // plane size, px
    ctx.save();
    // airports: small soft dots
    ctx.fillStyle = 'rgba(125,211,252,.55)';
    ctx.beginPath();
    for (const a of AP) {
      const p = proj.point(a.lon, a.lat, a.v);
      if (p) { ctx.moveTo(p[0] + 1.8 * k, p[1]); ctx.arc(p[0], p[1], 1.8 * k, 0, Math.PI * 2); }
    }
    ctx.fill();
    // contrails, then planes
    ctx.lineCap = 'round';
    const drawn = [], trails = [];
    for (const f of flights) {
      let u = (now - f.t0) / f.dur;
      if (u >= 1) { spawn(f, now, false); u = 0; }
      const v = pos(f, u);
      const [lon, lat] = llOf(v);
      const p = proj.point(lon, lat, v);
      if (!p) continue;
      const v2 = pos(f, Math.min(1, u + 0.01)), ll2 = llOf(v2);
      const p2 = proj.point(ll2[0], ll2[1], v2);
      // contrail: the last stretch of the route (all batched into one stroke below)
      let prev = p;
      for (let j = 1; j <= 4; j++) {
        const uu = u - j * 0.03;
        if (uu < 0) break;
        const w = pos(f, uu), ll = llOf(w), q = proj.point(ll[0], ll[1], w);
        if (!q) break;
        trails.push(prev[0], prev[1], q[0], q[1]);
        prev = q;
      }
      drawn.push([p, p2 ? Math.atan2(p2[1] - p[1], p2[0] - p[0]) : 0, u]);
    }
    ctx.strokeStyle = 'rgba(226,232,240,.16)'; ctx.lineWidth = 1.1 * k;
    ctx.beginPath();
    for (let i = 0; i < trails.length; i += 4) { ctx.moveTo(trails[i], trails[i + 1]); ctx.lineTo(trails[i + 2], trails[i + 3]); }
    ctx.stroke();
    for (const [p, ang, u] of drawn) {
      const fade = Math.min(1, u * 12, (1 - u) * 12);   // take-off / landing fade
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.6 * fade;
      ctx.translate(p[0], p[1]); ctx.rotate(ang);
      ctx.drawImage(plane, -ps / 2, -ps / 2, ps, ps);
      ctx.restore();
    }
    ctx.restore();
  }

  window.Flights = { get on() { return on; }, draw };
})();
