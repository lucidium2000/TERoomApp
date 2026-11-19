// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
/* Flights button: live aircraft over and around the US from the OpenSky
 * Network. A GitHub Action (.github/workflows/flights.yml) publishes a
 * snapshot to the `flights` branch every 15 minutes (3 with an OpenSky API
 * client); between snapshots each plane is moved along its own reported track
 * and speed, so the picture keeps flowing. Hover or tap a plane for its
 * callsign, altitude and speed. Toggle: the Flights button, or ?flights=1. */
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const btn = document.getElementById('flightsBtn');
  let on = false;
  try { on = localStorage.getItem('te-flights') === '1'; } catch (_) { /* private mode */ }
  if (qs.has('flights')) on = qs.get('flights') !== '0';

  const RAD = Math.PI / 180, RE = 6371000;
  const MAX_AGE = 30 * 60;   // s: older than this, the snapshot is too stale to project
  const MAX_PROJECT = 20 * 60;   // s: never move a plane further than this past its fix

  // ── Data ────────────────────────────────────────────────────────────────
  function sourceUrl() {
    if (qs.get('flightsurl')) return qs.get('flightsurl');
    const h = location.hostname, repo = location.pathname.split('/').filter(Boolean)[0];
    if (/\.github\.io$/.test(h) && repo) return `https://raw.githubusercontent.com/${h.split('.')[0]}/${repo}/flights/flights.json`;
    return 'https://raw.githubusercontent.com/lucidium2000/TERoomApp/flights/flights.json';   // local testing
  }
  let snap = null, planes = [], loading = false, lastLoad = 0, err = '';
  async function load() {
    if (loading) return;
    loading = true; lastLoad = Date.now();
    try {
      const r = await fetch(sourceUrl(), { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!snap || j.t !== snap.t) {
        snap = j;
        planes = j.f.map(([id, cs, lon, lat, alt, spd, trk, vr]) => ({
          id, cs, alt, spd, trk, vr,
          lo: lon * RAD, sb: Math.sin(trk * RAD), cb: Math.cos(trk * RAD),
          sla: Math.sin(lat * RAD), cla: Math.cos(lat * RAD),
        }));
      }
      err = '';
    } catch (e) {
      err = 'flight data unavailable';
      console.warn('[flights]', e);
    }
    loading = false;
    showTag();
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
  // Thousands of planes are drawn by the WebGL globe (one buffer, refreshed
  // once a second); the 2D overlay only adds plane icons when zoomed in far
  // enough that few are in view, and the hover / tap card.
  const A = [0, 0, 0, 0, 0], B = [0, 0, 0, 0, 0];
  const TAIL_S = 180;   // tail length, seconds of flight behind the plane
  let gl = null, built = 0, builtFor = 0, vis = [], visXY = [], visAt = 0;
  const colour = (alt) => (alt < 3000 ? [0.18, 0.83, 0.75] : alt < 8000 ? [0.49, 0.83, 0.99] : [0.95, 0.96, 0.98]);

  function build(dt) {
    const n = planes.length, arr = new Float32Array(n * 3 * 8);
    for (let i = 0; i < n; i++) {
      const p = planes[i], [r, g, b] = colour(p.alt);
      at(p, dt, A); at(p, dt - TAIL_S, B);
      let o = i * 8;
      arr[o] = A[0]; arr[o + 1] = A[1]; arr[o + 2] = A[2]; arr[o + 3] = r; arr[o + 4] = g; arr[o + 5] = b; arr[o + 6] = 0.95; arr[o + 7] = 4.2 * (window.devicePixelRatio || 1);
      o = (n + i * 2) * 8;
      arr[o] = A[0]; arr[o + 1] = A[1]; arr[o + 2] = A[2]; arr[o + 3] = r; arr[o + 4] = g; arr[o + 5] = b; arr[o + 6] = 0.45; arr[o + 7] = 1;
      o += 8;
      arr[o] = B[0]; arr[o + 1] = B[1]; arr[o + 2] = B[2]; arr[o + 3] = r; arr[o + 4] = g; arr[o + 5] = b; arr[o + 6] = 0; arr[o + 7] = 1;
    }
    gl.setFlights(arr, n);
  }

  function draw(ctx, proj, k, now, glr) {
    gl = glr && glr.fx && glr.fx.available && glr.fx.setFlights ? glr.fx : null;
    const age = snap ? Date.now() / 1000 - snap.t : Infinity;
    if (!snap || !planes.length || age > MAX_AGE) { if (gl) gl.setFlights(null); return; }
    const dt = Math.min(Math.max(0, age), MAX_PROJECT), t = performance.now();
    if (gl && (t - built > 1000 || builtFor !== snap.t)) { build(dt); built = t; builtFor = snap.t; }
    // Twice a second: which planes are on screen (for icons and the hover card).
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
      // No WebGL extras: plain dots on the 2D overlay.
      ctx.fillStyle = 'rgba(226,232,240,.8)';
      ctx.beginPath();
      for (const i of vis) { at(planes[i], dt, A); const s = proj.point(A[3], A[4], [A[0], A[1], A[2]]); if (s) ctx.rect(s[0] - 1, s[1] - 1, 2.2, 2.2); }
      ctx.fill();
    }
    const icons = vis.length <= 300;
    let hit = -1, hx = 0, hy = 0, best = (ptr && ptr.touch ? 22 : 12) ** 2;
    if (live && !icons) {
      // Many in view: find the nearest from the twice-a-second positions, then place it exactly.
      let bi = -1;
      for (let j = 0; j < vis.length; j++) { const d = (visXY[2 * j] - ptr.x) ** 2 + (visXY[2 * j + 1] - ptr.y) ** 2; if (d < best) { best = d; bi = vis[j]; } }
      if (bi >= 0) { at(planes[bi], dt, A); const s = proj.point(A[3], A[4], [A[0], A[1], A[2]]); if (s) { hit = bi; hx = s[0]; hy = s[1]; } }
    }
    if (icons) {
      if (!icon) icon = planeIcon();
      const ps = 13 * Math.min(1.3, k);
      for (const i of vis) {
        const p = planes[i];
        at(p, dt, A);
        const s = proj.point(A[3], A[4], [A[0], A[1], A[2]]);
        if (!s) continue;
        {
          at(p, dt + 90, B);
          const s2 = proj.point(B[3], B[4], [B[0], B[1], B[2]]);
          ctx.save();
          ctx.globalAlpha = p.alt < 3000 ? 0.75 : 0.95;
          ctx.translate(s[0], s[1]); ctx.rotate(s2 ? Math.atan2(s2[1] - s[1], s2[0] - s[0]) : 0);
          ctx.drawImage(icon, -ps / 2, -ps / 2, ps, ps);
          ctx.restore();
        }
        if (live) { const d = (s[0] - ptr.x) ** 2 + (s[1] - ptr.y) ** 2; if (d < best) { best = d; hit = i; hx = s[0]; hy = s[1]; } }
      }
    }
    if (hit >= 0) card(ctx, hx, hy, planes[hit], k);
    ctx.restore();
  }
  function hide() { if (gl) gl.setFlights(null); }

  function card(ctx, x, y, p, k) {
    const font = (wt, px) => `${wt} ${Math.round(px * k)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    const ft = Math.round(p.alt * 3.281 / 100) * 100, kt = Math.round(p.spd * 1.944);
    const climb = p.vr > 1.5 ? ' · climbing' : p.vr < -1.5 ? ' · descending' : '';
    const head = p.cs || p.id.toUpperCase();
    const l1 = `${ft.toLocaleString()} ft · ${kt} kt · heading ${Math.round(p.trk)}°${climb}`;
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
