// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
/* Flights button: live aircraft over and around the US from the OpenSky
 * Network. A GitHub Action (.github/workflows/flights.yml) publishes a
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
  const MAX_PROJECT = 20 * 60;   // s: never move a plane further than this past its fix

  // ── Data ────────────────────────────────────────────────────────────────
  function sourceUrl() {
    if (qs.get('flightsurl')) return qs.get('flightsurl');
    const h = location.hostname, repo = location.pathname.split('/').filter(Boolean)[0];
    if (/\.github\.io$/.test(h) && repo) return `https://raw.githubusercontent.com/${h.split('.')[0]}/${repo}/flights/flights.json`;
    return 'https://raw.githubusercontent.com/lucidium2000/TERoomApp/flights/flights.json';   // local testing
  }
  let snap = null, planes = [], loading = false, lastLoad = 0, err = '', histFor = 0;
  async function load() {
    if (loading) return;
    loading = true; lastLoad = Date.now();
    try {
      const r = await fetch(sourceUrl(), { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!snap || j.t !== snap.t) {
        snap = j;
        planes = j.f.map(([id, cs, lon, lat, alt, spd, trk, vr, path]) => ({
          id, cs, alt, spd, trk, vr, lon, lat, path: path || [],
          lo: lon * RAD, sb: Math.sin(trk * RAD), cb: Math.cos(trk * RAD),
          sla: Math.sin(lat * RAD), cla: Math.cos(lat * RAD),
        }));
        histFor = 0;   // rebuild the paths
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
    tag.innerHTML = `<b>Live flights</b> &middot; ${snap.n.toLocaleString()} aircraft &middot; ${when} &middot; OpenSky Network`;
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
  const A = [0, 0, 0, 0, 0], B = [0, 0, 0, 0, 0], X = [0, 0, 0];
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
      at(p, dt, A); at(p, dt + 120, B);
      put(arr, i * 11, A, B[0], B[1], B[2], c, p.alt < 3000 ? 0.85 : 1, 1);
      const o = (n + i * 2) * 11;
      put(arr, o, xyz(p.lon, p.lat, X), phase(i), 0, 0, c, 0.75, 0);
      put(arr, o + 11, A, phase(i), 0, 0, c, 0.75, dt);
    }
    const hist = histFor !== snap.t ? buildHist() : null;
    histFor = snap.t;
    const px = Math.max(4.5, Math.min(20, R * 0.017)) * dpr;   // dots when the whole globe shows, aircraft when zoomed in
    return gl.setFlights(arr, n, hist, { now: dt, hist: snap.hist || 3600, px });
  }

  function draw(ctx, proj, k, now, glr, R) {
    gl = glOk && glr && glr.fx && glr.fx.available && glr.fx.setFlights ? glr.fx : null;   // glOk: false if its flight shader failed
    const age = snap ? Date.now() / 1000 - snap.t : Infinity;
    if (!snap || !planes.length || age > HIDE_AGE) { if (gl) gl.setFlights(null); return; }
    const dt = Math.min(Math.max(0, age), MAX_PROJECT), t = performance.now();
    R = R || 430 * k;
    if (gl && (t - built > 1000 || builtFor !== snap.t)) { if (!build(dt, R)) gl = null, glOk = false; built = t; builtFor = snap.t; }
    // Twice a second: which planes are on screen (for the hover card).
    const live = ptr && t - ptr.t < (ptr.touch ? 6000 : 3000);
    if (t - visAt > 500) {
      visAt = t; vis = []; visXY = [];
      const W = window.innerWidth, H = window.innerHeight;
      for (let i = 0; i < planes.length; i++) {
        at(planes[i], dt, A);
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
        at(p, dt, A); const s = proj.point(A[3], A[4], [A[0], A[1], A[2]]);
        if (!s) continue;
        if (!icons) { ctx.rect(s[0] - 1, s[1] - 1, 2.2, 2.2); continue; }
        at(p, dt + 90, B); const s2 = proj.point(B[3], B[4], [B[0], B[1], B[2]]);
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
      if (bi >= 0) { at(planes[bi], dt, A); const s = proj.point(A[3], A[4], [A[0], A[1], A[2]]); if (s) { hit = bi; hx = s[0]; hy = s[1]; } }
    }
    if (hit >= 0) { trace(ctx, proj, planes[hit], dt, k); card(ctx, hx, hy, planes[hit], k); }
    ctx.restore();
  }

  /** The hovered plane's whole known path, highlighted. */
  function trace(ctx, proj, p, dt, k) {
    const pts = [];
    for (let i = 0; i < p.path.length; i += 3) pts.push([p.path[i + 1], p.path[i + 2]]);
    pts.push([p.lon, p.lat]);
    at(p, dt, A); pts.push([A[3], A[4]]);
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
  function hide() { if (gl) gl.setFlights(null); }

  function card(ctx, x, y, p, k) {
    const font = (wt, px) => `${wt} ${Math.round(px * k)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    const ft = Math.round(p.alt * 3.281 / 100) * 100, kt = Math.round(p.spd * 1.944);
    const climb = p.vr > 1.5 ? ' · climbing' : p.vr < -1.5 ? ' · descending' : '';
    const head = p.cs || p.id.toUpperCase();
    const known = p.path.length ? ` · path: last ${Math.max(1, Math.round(p.path[0] / 60))} min` : '';
    const l1 = `${ft.toLocaleString()} ft · ${kt} kt · heading ${Math.round(p.trk)}°${climb}${known}`;
    ctx.strokeStyle = 'rgba(253,224,71,.95)'; ctx.lineWidth = 1.6 * k;
    ctx.beginPath(); ctx.arc(x, y, 8 * k, 0, Math.PI * 2); ctx.stroke();
    ctx.font = font(800, 12); const w1 = ctx.measureText(head).width;
    ctx.font = font(500, 11); const w2 = ctx.measureText(l1).width;
    const pad = 8 * k, w = Math.max(w1, w2) + pad * 2, h = 38 * k;
    let bx = x + 14 * k, by = y - h - 8 * k;
    if (bx + w > window.innerWidth - 4) bx = x - 14 * k - w;
    if (by < 4) by = y + 12 * k;
    ctx.fillStyle = 'rgba(8,13,26,.92)'; ctx.strokeStyle = 'rgba(125,211,252,.45)'; ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, w, h, 8 * k); else ctx.rect(bx, by, w, h);
    ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = font(800, 12); ctx.fillStyle = '#f8fafc'; ctx.fillText(head, bx + pad, by + 13 * k);
    ctx.font = font(500, 11); ctx.fillStyle = '#94a3b8'; ctx.fillText(l1, bx + pad, by + 28 * k);
  }

  window.Flights = { get on() { return on; }, draw, _state: () => ({ snap: snap && { t: snap.t, n: snap.n }, err, inView: vis.length, firstXY: visXY.slice(0, 2) }) };
})();
