/* Internet Outage Globe
 *
 * Full-screen canvas globe of ThousandEyes Internet Insights outages, styled
 * after TE-Optics' globe view: navy land on a shaded ocean, faint graticule,
 * real-time day/night terminator, panning starfield, cyan limb.
 *
 * URL parameters (all optional):
 *   data=<url>      outages.json to load (default: this repo's `data` branch)
 *   refresh=<sec>   reload interval, default 300
 *   tour=0          disable the tour (default: tours on load, and again after idle)
 *   idle=<sec>      seconds without touch before the tour starts, default 30
 *   dwell=<sec>     seconds per outage on tour, default 10
 *   spin=<deg/s>    idle rotation speed, default 3
 *   watch=a,b,c     service keywords for "Your services", default webex,zoom,microsoft,google,amazon
 *   detail=50m      higher-resolution coastlines (heavier on the device)
 *   dpr=<n>         cap the render pixel ratio, default 1.5
 *   kiosk=1         hide the cursor
 *   signage=1       non-interactive digital signage: tour always on, no controls
 */
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────
  const qs = new URLSearchParams(location.search);
  const num = (k, d) => (qs.has(k) && isFinite(+qs.get(k)) ? +qs.get(k) : d);
  const CFG = {
    refreshMs: Math.max(60, num('refresh', 300)) * 1000,
    idleMs: num('idle', 30) * 1000,
    dwellMs: Math.max(4, num('dwell', 10)) * 1000,
    spinDegPerS: num('spin', 3),
    dpr: Math.min(window.devicePixelRatio || 1, num('dpr', 1.5)),
    tour: qs.get('tour'),
    signage: qs.get('signage') === '1',
    detail: qs.get('detail') === '50m' ? '50m' : '110m',
    watch: (qs.get('watch') || 'webex,zoom,microsoft,google,amazon')
      .split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (qs.get('kiosk') === '1' || CFG.signage) document.body.classList.add('kiosk');
  if (CFG.signage) document.body.classList.add('signage');

  const COLORS = { network: '#f15e22', application: '#16bdeb' };
  const RGB = { network: '241,94,34', application: '22,189,235' };
  const RAD = Math.PI / 180;
  const ZOOM_MIN = 0.6, ZOOM_MAX = 8;
  const SPIN_RESUME_MS = 12000;   // leave the globe where the user put it for a while

  // Friendly labels + match terms for the "Your services" strip.
  const WATCH_PRESETS = {
    webex: { label: 'Webex', terms: ['webex'] },
    zoom: { label: 'Zoom', terms: ['zoom'] },
    microsoft: { label: 'Microsoft 365', terms: ['microsoft', 'office365', 'o365', 'teams', 'mson', 'outlook'] },
    teams: { label: 'Teams', terms: ['teams', 'office365', 'o365'] },
    google: { label: 'Google', terms: ['google', 'gmail', 'youtube'] },
    amazon: { label: 'AWS', terms: ['amazon', 'aws'] },
    aws: { label: 'AWS', terms: ['amazon', 'aws'] },
    salesforce: { label: 'Salesforce', terms: ['salesforce'] },
    slack: { label: 'Slack', terms: ['slack'] },
    cloudflare: { label: 'Cloudflare', terms: ['cloudflare'] },
    github: { label: 'GitHub', terms: ['github'] },
  };

  // ── DOM ──────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const canvas = $('globe');
  const ctx = canvas.getContext('2d');
  const el = {
    updated: $('updated'), list: $('list'), watch: $('watch'),
    statActive: $('statActive'), statNet: $('statNet'), statApp: $('statApp'), statLoc: $('statLoc'),
    card: $('card'), cardIcon: $('cardIcon'), cardKind: $('cardKind'), cardName: $('cardName'),
    cardMetrics: $('cardMetrics'), cardLocs: $('cardLocs'), cardProgress: $('cardProgress'),
    cardClose: $('cardClose'), tourBtn: $('tourBtn'), timeline: $('timeline'),
    toast: $('toast'), error: $('error'), panel: $('panel'),
  };

  // ── State ────────────────────────────────────────────────────────────────
  const view = { lon: -40, lat: 22, zoom: 1 };       // centre of the visible face
  const S = {
    data: null, outages: [], seen: new Set(), filter: 'all',
    selected: null, hits: [],
    lastInput: performance.now(), dragging: false, vel: { lon: 0, lat: 0 },
    flight: null, touring: false, tourIdx: -1, tourT0: 0,
    land: null, borders: null, stars: null, w: 0, h: 0,
  };

  const projection = d3.geoOrthographic().clipAngle(90).precision(0.6);
  const path = d3.geoPath(projection, ctx);
  const graticule = d3.geoGraticule10();
  const SPHERE = { type: 'Sphere' };

  // ── Geometry helpers ─────────────────────────────────────────────────────
  function layout() {
    const panelOnSide = window.innerWidth > 900;
    const panelW = panelOnSide ? el.panel.getBoundingClientRect().width + 32 : 0;
    const w = window.innerWidth, h = window.innerHeight;
    const availW = w - panelW;
    const availH = panelOnSide ? h : h * 0.62;
    return { cx: availW / 2, cy: availH / 2 + (panelOnSide ? -h * 0.02 : 0), base: Math.min(availW, availH) * 0.41 };
  }

  function wrapLon(l) { return ((l + 540) % 360) - 180; }
  function clampLat(l) { return Math.max(-85, Math.min(85, l)); }

  function isVisible(lon, lat) {
    return d3.geoDistance([lon, lat], [view.lon, view.lat]) < Math.PI / 2 - 0.02;
  }

  // Sun position (low-precision almanac; good to a fraction of a degree).
  function subsolar(ms) {
    const d = ms / 86400000 - 10957.5;                       // days since J2000.0
    const g = (357.529 + 0.98560028 * d) * RAD;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const e = (23.439 - 0.00000036 * d) * RAD;
    const dec = Math.asin(Math.sin(e) * Math.sin(L)) / RAD;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD;
    const gmst = 280.46061837 + 360.98564736629 * d;
    return { lon: wrapLon(ra - gmst), lat: dec };
  }

  // ── Starfield (built once per viewport, then just panned) ────────────────
  function buildStars(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.round(w * CFG.dpr); c.height = Math.round(h * CFG.dpr);
    const g = c.getContext('2d');
    g.scale(CFG.dpr, CFG.dpr);
    let seed = 0x9e3779b9;
    const rnd = () => {   // mulberry32 - deterministic, so stars don't reshuffle on resize
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const n = Math.max(80, Math.min(600, Math.round((w * h) / 3600)));
    for (let i = 0; i < n; i++) {
      const r = 0.4 + rnd() * 0.9;
      const o = 0.12 + Math.pow(rnd(), 2.2) * 0.6;
      g.fillStyle = `rgba(219,234,254,${o.toFixed(2)})`;
      g.beginPath(); g.arc(r + rnd() * (w - 2 * r), r + rnd() * (h - 2 * r), r, 0, 2 * Math.PI); g.fill();
    }
    return c;
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function resize() {
    S.w = window.innerWidth; S.h = window.innerHeight;
    canvas.width = Math.round(S.w * CFG.dpr); canvas.height = Math.round(S.h * CFG.dpr);
    S.stars = buildStars(S.w, S.h);
  }

  function drawSky() {
    const { w, h } = S;
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, w, h);
    // The sky drifts as the globe turns - half a screen per full revolution.
    let ox = (-(view.lon / 360) * w * 0.5) % w; if (ox > 0) ox -= w;
    let oy = ((view.lat / 90) * h * 0.175) % h; if (oy > 0) oy -= h;
    for (let x = ox; x < w; x += w) for (let y = oy; y < h; y += h) ctx.drawImage(S.stars, x, y, w, h);
  }

  function drawGlobe(now, L) {
    const R = L.base * view.zoom;
    projection.translate([L.cx, L.cy]).scale(R).rotate([-view.lon, -view.lat]);

    // Atmosphere halo.
    const halo = ctx.createRadialGradient(L.cx, L.cy, R * 0.96, L.cx, L.cy, R * 1.22);
    halo.addColorStop(0, 'rgba(56,189,248,0.28)');
    halo.addColorStop(0.35, 'rgba(56,189,248,0.08)');
    halo.addColorStop(1, 'rgba(56,189,248,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(L.cx, L.cy, R * 1.22, 0, 2 * Math.PI); ctx.fill();

    // Ocean - offset radial shading so it reads as a sphere, not a disc.
    const sea = ctx.createRadialGradient(L.cx - R * 0.32, L.cy - R * 0.44, R * 0.05, L.cx, L.cy, R * 1.05);
    sea.addColorStop(0, '#1b2942'); sea.addColorStop(0.62, '#0f172a'); sea.addColorStop(1, '#080d18');
    ctx.fillStyle = sea;
    ctx.beginPath(); path(SPHERE); ctx.fill();

    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(148,163,184,0.16)'; ctx.lineWidth = 0.7;
    ctx.beginPath(); path(graticule); ctx.stroke();

    if (S.land) {
      ctx.fillStyle = '#24344b';
      ctx.beginPath(); path(S.land); ctx.fill();
      ctx.strokeStyle = '#486084'; ctx.lineWidth = 0.7;
      ctx.beginPath(); path(S.borders); ctx.stroke();
      ctx.strokeStyle = 'rgba(110,140,185,0.55)'; ctx.lineWidth = 0.8;
      ctx.beginPath(); path(S.land); ctx.stroke();
    }

    // Night side: nested caps around the antisolar point, so the terminator
    // reads as dusk rather than a hard line.
    const sun = subsolar(Date.now());
    const anti = [wrapLon(sun.lon + 180), -sun.lat];
    ctx.fillStyle = 'rgba(0,0,0,0.075)';
    for (let r = 96; r >= 72; r -= 3) {
      ctx.beginPath(); path(d3.geoCircle().center(anti).radius(r).precision(3)()); ctx.fill();
    }

    // Limb.
    ctx.strokeStyle = 'rgba(56,189,248,0.45)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(L.cx, L.cy, R, 0, 2 * Math.PI); ctx.stroke();

    drawOutages(now, R);
  }

  function outageVisible(o) { return S.filter === 'all' || o.kind === S.filter; }

  function drawOutages(now, R) {
    S.hits = [];
    const k = Math.max(0.7, Math.min(1.6, R / 430));
    const sel = S.selected;

    // Selected outage: great-circle links from its biggest location to the rest.
    if (sel && sel.locations.length > 1) {
      const hub = sel.locations.reduce((a, b) => (b.n > a.n ? b : a));
      ctx.save();
      ctx.setLineDash([6 * k, 9 * k]);
      ctx.lineDashOffset = -(now / 40) % 1000;
      for (const loc of sel.locations) {
        if (loc === hub) continue;
        const line = { type: 'LineString', coordinates: [[hub.lon, hub.lat], [loc.lon, loc.lat]] };
        ctx.strokeStyle = `rgba(${RGB[sel.kind]},0.25)`; ctx.lineWidth = 5 * k;
        ctx.beginPath(); path(line); ctx.stroke();
        ctx.strokeStyle = `rgba(${RGB[sel.kind]},0.95)`; ctx.lineWidth = 1.6 * k;
        ctx.beginPath(); path(line); ctx.stroke();
      }
      ctx.restore();
    }

    // Older first, so the freshest outages paint on top.
    const list = S.outages.filter(outageVisible).slice().sort((a, b) => a.start - b.start);
    for (const o of list) {
      const isSel = o === sel;
      const dim = sel && !isSel ? 0.35 : 1;
      const fresh = o.active ? 1 : Math.max(0.35, 1 - o.ageMin / (24 * 60));
      for (const loc of o.locations) {
        if (!isVisible(loc.lon, loc.lat)) continue;
        const p = projection([loc.lon, loc.lat]);
        if (!p) continue;
        const r = (3.2 + Math.sqrt(loc.n) * 1.6) * k * (isSel ? 1.35 : 1);
        const a = fresh * dim;

        // Pulse rings on active and selected outages.
        if (o.active || isSel) {
          const period = isSel ? 1600 : 2400;
          for (let i = 0; i < 2; i++) {
            // Positive modulo: a negative longitude offset must not give a negative radius.
            const t = ((((now + i * period / 2 + (loc.lon * 37 | 0)) % period) + period) % period) / period;
            ctx.strokeStyle = `rgba(${RGB[o.kind]},${((1 - t) * 0.7 * dim).toFixed(3)})`;
            ctx.lineWidth = 2 * k;
            ctx.beginPath(); ctx.arc(p[0], p[1], r + t * 26 * k, 0, 2 * Math.PI); ctx.stroke();
          }
        }
        // Glow + core.
        const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 3);
        g.addColorStop(0, `rgba(${RGB[o.kind]},${(0.55 * a).toFixed(3)})`);
        g.addColorStop(1, `rgba(${RGB[o.kind]},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p[0], p[1], r * 3, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = `rgba(${RGB[o.kind]},${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${(0.85 * a).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(1.2, r * 0.35), 0, 2 * Math.PI); ctx.fill();

        S.hits.push({ x: p[0], y: p[1], r: Math.max(22, r * 2), o });
      }
    }

    // City labels for the selected outage.
    if (sel) {
      ctx.font = `600 ${Math.round(13 * k)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textBaseline = 'middle';
      const placed = [];
      for (const loc of sel.locations.slice().sort((a, b) => b.n - a.n)) {
        if (!isVisible(loc.lon, loc.lat)) continue;
        const p = projection([loc.lon, loc.lat]);
        const label = loc.name.split(',')[0];
        const x = p[0] + 14 * k, y = p[1];
        const tw = ctx.measureText(label).width;
        if (placed.some((q) => Math.abs(q.y - y) < 18 * k && x < q.x + q.w && x + tw > q.x)) continue;
        placed.push({ x, y, w: tw });
        ctx.fillStyle = 'rgba(5,7,13,0.75)';
        ctx.fillRect(x - 5 * k, y - 11 * k, tw + 10 * k, 22 * k);
        ctx.fillStyle = '#e6edf7';
        ctx.fillText(label, x, y + 0.5);
      }
    }
  }

  // ── Motion: idle spin, inertia, flights, tour ────────────────────────────
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function flyTo(o, durMs = 2200) {
    const pts = o.locations.map((l) => [l.lon, l.lat]);
    const centre = pts.length > 1 ? d3.geoCentroid({ type: 'MultiPoint', coordinates: pts }) : pts[0];
    const spread = Math.max(0, ...pts.map((p) => d3.geoDistance(p, centre)));
    const zoom = Math.max(1, Math.min(2.6, 1.05 / (spread + 0.32)));
    const from = [view.lon, view.lat];
    const to = [centre[0], clampLat(centre[1] - 6 / zoom)];   // sit it a touch above centre
    const hop = d3.geoDistance(from, to);
    S.flight = {
      interp: d3.geoInterpolate(from, to), z0: view.zoom, z1: zoom,
      // Long hops pull back mid-flight, like a camera rising before it travels.
      lift: Math.min(0.45, hop / Math.PI * 0.7), t0: performance.now(), dur: durMs,
    };
    S.vel.lon = S.vel.lat = 0;
  }

  function step(now, dt) {
    if (S.flight) {
      const f = S.flight;
      const t = Math.min(1, (now - f.t0) / f.dur), e = ease(t);
      const c = f.interp(e);
      view.lon = c[0]; view.lat = c[1];
      view.zoom = (f.z0 + (f.z1 - f.z0) * e) * (1 - f.lift * Math.sin(Math.PI * e));
      if (t >= 1) S.flight = null;
    } else if (!S.dragging) {
      // Inertia after a flick, then a slow idle spin.
      if (Math.abs(S.vel.lon) > 0.0005 || Math.abs(S.vel.lat) > 0.0005) {
        view.lon = wrapLon(view.lon + S.vel.lon * dt);
        view.lat = clampLat(view.lat + S.vel.lat * dt);
        const decay = Math.pow(0.94, dt / 16);
        S.vel.lon *= decay; S.vel.lat *= decay;
      } else if (!S.selected && now - S.lastInput > SPIN_RESUME_MS) {
        view.lon = wrapLon(view.lon + (CFG.spinDegPerS * dt) / 1000);
        view.lat += (18 - view.lat) * 0.0006 * dt / 16;      // drift back to a pleasant tilt
        view.zoom += (1 - view.zoom) * 0.002 * dt / 16;
      }
    }

    // Tour: start when idle, advance on a timer.
    const tourOff = CFG.tour === '0' && !CFG.signage;
    if (!S.touring && !tourOff && S.outages.length && now - S.lastInput > CFG.idleMs) setTour(true);
    if (S.touring) {
      const frac = (now - S.tourT0) / CFG.dwellMs;
      el.cardProgress.style.width = Math.min(100, frac * 100).toFixed(1) + '%';
      if (frac >= 1) nextTour();
    }
  }

  function tourList() {
    // Active first, then most recent; cap it so the loop stays about "now".
    return S.outages.filter(outageVisible)
      .slice().sort((a, b) => (b.active - a.active) || (b.start - a.start)).slice(0, 18);
  }

  function nextTour() {
    const list = tourList();
    if (!list.length) return;
    S.tourIdx = (S.tourIdx + 1) % list.length;
    select(list[S.tourIdx], { fromTour: true });
  }

  function setTour(on) {
    S.touring = on;
    el.tourBtn.setAttribute('aria-pressed', String(on));
    el.tourBtn.querySelector('span').textContent = on ? 'Touring' : 'Tour';
    el.tourBtn.querySelector('path').setAttribute('d', on ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
    el.cardProgress.style.width = '0';
    if (on) { S.tourIdx = -1; nextTour(); }
  }

  function userInput() {
    S.lastInput = performance.now();
    if (S.touring && !CFG.signage) setTour(false);
  }

  // ── Selection + UI ───────────────────────────────────────────────────────
  const fmtAgo = (min) => (min < 1 ? 'now' : min < 60 ? `${Math.round(min)}m ago`
    : `${Math.floor(min / 60)}h ${Math.round(min % 60)}m ago`);
  const fmtDur = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m`
    : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function iconHtml(o) {
    const logo = o.kind === 'application' && S.data.appLogos && S.data.appLogos[o.appId];
    if (logo) return `<img src="${esc(logo)}" alt="">`;
    const words = o.name.replace(/[,.]|\b(Inc|LLC|Corporation|Corp|Ltd)\b/g, '').trim().split(/\s+/);
    return esc((words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase());
  }

  function select(o, { fromTour = false } = {}) {
    S.selected = o;
    if (!o) { el.card.hidden = true; renderList(); renderTimeline(); return; }
    if (fromTour) S.tourT0 = performance.now();
    flyTo(o, fromTour ? 2600 : 1800);

    el.card.className = 'card ' + o.kind;
    el.cardIcon.innerHTML = iconHtml(o);
    el.cardKind.innerHTML = (o.kind === 'network' ? 'Network outage' : 'Application outage')
      + (o.active ? '<span class="pill">● ACTIVE</span>' : '');
    el.cardName.textContent = o.name;
    const metrics = [
      [fmtTime(o.start), 'Started'],
      [fmtDur(o.durationS), 'Duration'],
      [o.locations.length, o.locations.length === 1 ? 'Location' : 'Locations'],
      o.kind === 'network' ? [o.interfaces, 'Interfaces'] : [o.servers, 'Servers'],
    ];
    if (o.asn) metrics.push(['AS' + o.asn, 'Network']);
    el.cardMetrics.innerHTML = metrics.map(([b, s]) => `<div><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('');
    const locs = o.locations.slice().sort((a, b) => b.n - a.n);
    el.cardLocs.innerHTML = locs.slice(0, 8).map((l) => `<li>${esc(l.name)}</li>`).join('')
      + (locs.length > 8 ? `<li>+${locs.length - 8} more</li>` : '');
    el.card.hidden = false;
    // Restart the entrance animation.
    el.card.style.animation = 'none'; void el.card.offsetWidth; el.card.style.animation = '';
    if (!fromTour) el.cardProgress.style.width = '0';
    renderList();
    renderTimeline();
  }

  function renderList() {
    const list = S.outages.filter(outageVisible).slice().sort((a, b) => (b.active - a.active) || (b.start - a.start));
    if (!list.length) { el.list.innerHTML = '<li class="empty">No outages in the last 24 hours.</li>'; return; }
    el.list.innerHTML = list.map((o) => {
      const where = o.locations.length === 1 ? o.locations[0].name : `${o.locations.length} locations`;
      return `<li class="row ${o.kind}${o.active ? ' active' : ''}${o === S.selected ? ' sel' : ''}" data-id="${esc(o.id)}">`
        + `<div class="ico">${iconHtml(o)}</div>`
        + `<div><div class="nm">${esc(o.name)}</div><div class="meta">${esc(where)} · ${fmtDur(o.durationS)}</div></div>`
        + `<div class="ago">${o.active ? 'ACTIVE' : fmtAgo(o.ageMin)}</div></li>`;
    }).join('');
    const selRow = el.list.querySelector('.row.sel');
    if (selRow) selRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderStats() {
    const net = S.outages.filter((o) => o.kind === 'network');
    const app = S.outages.filter((o) => o.kind === 'application');
    const locs = new Set(S.outages.flatMap((o) => o.locations.map((l) => l.name)));
    el.statActive.textContent = S.outages.filter((o) => o.active).length;
    el.statNet.textContent = net.length;
    el.statApp.textContent = app.length;
    el.statLoc.textContent = locs.size;
  }

  function watchMatches(term) {
    const preset = WATCH_PRESETS[term.toLowerCase()] || { label: term, terms: [term.toLowerCase()] };
    const hits = S.outages.filter((o) => {
      const hay = [o.name, o.fullName, o.appId, ...(o.domains || [])].filter(Boolean).join(' ').toLowerCase();
      return preset.terms.some((t) => hay.includes(t));
    });
    return { preset, hits };
  }

  function renderWatch() {
    el.watch.innerHTML = CFG.watch.map((term) => {
      const { preset, hits } = watchMatches(term);
      const active = hits.some((o) => o.active);
      const cls = active ? 'bad' : hits.length ? 'warn' : '';
      const note = active ? 'active' : hits.length ? `${hits.length} in 24h` : 'clear';
      return `<button class="watch-pill ${cls}" data-term="${esc(term)}"><i></i>${esc(preset.label)} <small>${note}</small></button>`;
    }).join('');
  }

  function renderTimeline() {
    const svg = el.timeline;
    const W = 1000, H = 100, BINS = 48, now = Date.now(), span = 24 * 3600e3;
    const bins = Array.from({ length: BINS }, () => ({ network: 0, application: 0 }));
    for (const o of S.outages) {
      const i = Math.floor((o.start - (now - span)) / (span / BINS));
      if (i >= 0 && i < BINS) bins[i][o.kind]++;
    }
    const max = Math.max(1, ...bins.map((b) => b.network + b.application));
    const bw = W / BINS;
    let out = '';
    bins.forEach((b, i) => {
      const hn = (b.network / max) * (H - 6), ha = (b.application / max) * (H - 6);
      const x = (i * bw + 1.5).toFixed(1), w = (bw - 3).toFixed(1);
      if (hn) out += `<rect x="${x}" y="${(H - hn).toFixed(1)}" width="${w}" height="${hn.toFixed(1)}" rx="2" fill="${COLORS.network}" opacity=".85"/>`;
      if (ha) out += `<rect x="${x}" y="${(H - hn - ha).toFixed(1)}" width="${w}" height="${ha.toFixed(1)}" rx="2" fill="${COLORS.application}" opacity=".85"/>`;
      if (!hn && !ha) out += `<rect x="${x}" y="${H - 2}" width="${w}" height="2" rx="1" fill="rgba(148,163,184,.18)"/>`;
    });
    if (S.selected) {
      const x = ((S.selected.start - (now - span)) / span) * W;
      out += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="-4" y2="${H}" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke"/>`
        + `<circle cx="${x.toFixed(1)}" cy="-4" r="5" fill="#fff"/>`;
    }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = out;
  }

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg; el.toast.hidden = false;
    el.toast.style.animation = 'none'; void el.toast.offsetWidth; el.toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 6000);
  }

  // ── Data ─────────────────────────────────────────────────────────────────
  function dataUrls() {
    const urls = [];
    if (qs.get('data')) urls.push(qs.get('data'));
    // On GitHub Pages (<owner>.github.io/<repo>/) read the data branch straight
    // from raw.githubusercontent.com, which - unlike ThousandEyes - allows CORS.
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (m) {
      const owner = m[1];
      const seg = location.pathname.split('/').filter(Boolean)[0];
      const repo = seg && !/\.html?$/.test(seg) ? seg : `${owner}.github.io`;
      urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/data/outages.json`);
    }
    urls.push('data/outages.json');   // snapshot shipped with the app
    return urls;
  }

  async function loadData() {
    let lastErr;
    for (const u of dataUrls()) {
      try {
        const res = await fetch(u + (u.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
        if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`);
        const json = await res.json();
        if (!json || !Array.isArray(json.network)) throw new Error(`${u}: unexpected format`);
        return json;
      } catch (e) { lastErr = e; console.warn('[outages]', e.message || e); }
    }
    throw lastErr || new Error('No data source available');
  }

  function ingest(json) {
    const nowMs = Date.now();
    const latest = json.latestRoundId || Math.floor(Date.parse(json.generatedAt) / 1000);
    const prevSelId = S.selected && S.selected.id;
    const firstLoad = !S.data;
    S.data = json;
    S.outages = [...json.network, ...json.application].map((o) => ({
      ...o,
      ageMin: (nowMs - o.start) / 60000,
      // Still in progress if its last bad round is the latest (or previous) one.
      active: o.endRound >= latest - 300,
      locations: (o.locations || []).filter((l) => isFinite(l.lat) && isFinite(l.lon)),
    })).filter((o) => o.locations.length);

    const fresh = S.outages.filter((o) => !S.seen.has(o.id));
    S.outages.forEach((o) => S.seen.add(o.id));
    S.selected = prevSelId ? S.outages.find((o) => o.id === prevSelId) || null : null;

    const gen = new Date(json.generatedAt);
    const staleMin = (nowMs - gen.getTime()) / 60000;
    el.updated.textContent = `updated ${fmtTime(gen.getTime())}` + (staleMin > 30 ? ` (${Math.round(staleMin)}m old)` : '');

    renderStats(); renderWatch(); renderList(); renderTimeline();

    // Something new since the last refresh: call it out and go there.
    if (!firstLoad && fresh.length) {
      const o = fresh.sort((a, b) => b.start - a.start)[0];
      toast(`New ${o.kind} outage: ${o.name} · ${o.locations[0].name}`);
      if (now() - S.lastInput > 10000 || S.touring) select(o, { fromTour: S.touring });
    }
  }

  async function refresh() {
    try {
      ingest(await loadData());
      el.error.hidden = true;
    } catch (e) {
      console.error(e);
      if (!S.data) { el.error.textContent = 'Could not load outage data. Retrying…'; el.error.hidden = false; }
    }
  }

  async function loadWorld() {
    const world = await (await fetch(`vendor/countries-${CFG.detail}.json`)).json();
    S.land = topojson.feature(world, world.objects.land);
    S.borders = topojson.mesh(world, world.objects.countries, (a, b) => a !== b);
  }

  // ── Input ────────────────────────────────────────────────────────────────
  const now = () => performance.now();
  const pts = new Map();
  let pinch = 0, down = null, mid = null, lastTap = null;

  canvas.addEventListener('pointerdown', (e) => {
    userInput();
    S.flight = null;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* */ }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y); down = null; S.dragging = false;
      mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return;
    }
    down = { x: e.clientX, y: e.clientY, t: now(), moved: false, lx: e.clientX, ly: e.clientY, lt: now() };
    S.dragging = true; S.vel.lon = S.vel.lat = 0;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    userInput();
    if (pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0) view.zoom = clampZoom(view.zoom * (d / pinch));
      pinch = d;
      // Moving both fingers together turns the globe too.
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (mid) rotateByPixels(m.x - mid.x, m.y - mid.y);
      mid = m;
      return;
    }
    if (!down) return;
    const dx = e.clientX - down.lx, dy = e.clientY - down.ly, dt = Math.max(1, now() - down.lt);
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true;
    const degPerPx = rotateByPixels(dx, dy);
    S.vel.lon = (-dx * degPerPx) / dt; S.vel.lat = (dy * degPerPx) / dt;
    down.lx = e.clientX; down.ly = e.clientY; down.lt = now();
  });

  function clampZoom(z) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); }

  /** Drag the surface under the finger: degrees per pixel shrink as you zoom in. */
  function rotateByPixels(dx, dy) {
    const degPerPx = 180 / (Math.PI * layout().base * view.zoom);
    view.lon = wrapLon(view.lon - dx * degPerPx);
    view.lat = clampLat(view.lat + dy * degPerPx);
    return degPerPx;
  }

  /** Animated zoom, optionally re-centring on a lon/lat. Reuses the flight path. */
  function zoomTo(z, centre) {
    const from = [view.lon, view.lat];
    const to = centre ? [centre[0], clampLat(centre[1])] : from;
    S.flight = { interp: d3.geoInterpolate(from, to), z0: view.zoom, z1: clampZoom(z), lift: 0, t0: now(), dur: 650 };
    S.vel.lon = S.vel.lat = 0;
  }

  function endPointer(e) {
    pts.delete(e.pointerId);
    if (pts.size < 2) { pinch = 0; mid = null; }
    // Double tap: zoom in on that spot.
    if (down && !down.moved && e.type === 'pointerup') {
      const t = now();
      if (lastTap && t - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        lastTap = null;
        const ll = projection.invert([e.clientX, e.clientY]);
        zoomTo(view.zoom * 1.8, ll && d3.geoDistance(ll, [view.lon, view.lat]) < Math.PI / 2 ? ll : null);
        down = null; S.dragging = false;
        return;
      }
      lastTap = { t, x: e.clientX, y: e.clientY };
    }
    if (down && !down.moved && e.type === 'pointerup') {
      // Tap: pick the nearest marker, else clear the selection.
      let best = null, bd = Infinity;
      for (const h of S.hits) {
        const d = Math.hypot(h.x - e.clientX, h.y - e.clientY);
        if (d < h.r && d < bd) { bd = d; best = h; }
      }
      select(best ? best.o : null);
    }
    if (down && now() - down.lt > 80) S.vel.lon = S.vel.lat = 0;   // held still before release: no flick
    down = null; S.dragging = false;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); userInput(); S.flight = null;
    view.zoom = clampZoom(view.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.006 : 0.0015)));
  }, { passive: false });

  // On-screen zoom controls - pinch isn't obvious to everyone on a room device.
  document.getElementById('zoomIn').addEventListener('click', () => { userInput(); zoomTo(view.zoom * 1.6); });
  document.getElementById('zoomOut').addEventListener('click', () => { userInput(); zoomTo(view.zoom / 1.6); });
  document.getElementById('zoomReset').addEventListener('click', () => { userInput(); select(null); zoomTo(1, [view.lon, 18]); });
  // Stop the browser itself from zooming the page on a pinch (Safari/WebKit gesture events).
  ['gesturestart', 'gesturechange'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));

  el.list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    userInput();
    select(S.outages.find((o) => o.id === row.dataset.id) || null);
  });
  el.panel.addEventListener('pointerdown', userInput);

  document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    userInput();
    S.filter = c.dataset.filter;
    document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    if (S.selected && !outageVisible(S.selected)) select(null);
    renderList();
  }));

  el.watch.addEventListener('click', (e) => {
    const b = e.target.closest('.watch-pill');
    if (!b) return;
    userInput();
    const { preset, hits } = watchMatches(b.dataset.term);
    if (!hits.length) { toast(`${preset.label}: no outages detected in the last 24 hours`); return; }
    select(hits.sort((a, c) => (c.active - a.active) || (c.start - a.start))[0]);
  });

  el.cardClose.addEventListener('click', () => { userInput(); select(null); });
  el.tourBtn.addEventListener('click', () => {
    const on = !S.touring;
    S.lastInput = now();
    setTour(on);
    if (!on) S.lastInput = now();
  });

  window.addEventListener('resize', resize);

  // ── Main loop ────────────────────────────────────────────────────────────
  let last = now();
  function frame(t) {
    // Schedule first: one bad frame must never stop the globe (and with it, all input).
    requestAnimationFrame(frame);
    const dt = Math.min(64, t - last); last = t;
    try {
      step(t, dt);
      ctx.setTransform(CFG.dpr, 0, 0, CFG.dpr, 0, 0);
      drawSky();
      drawGlobe(t, layout());
    } catch (e) {
      if (!frame.warned) { frame.warned = true; console.error('[globe] frame error', e); }
    }
  }

  // Refresh relative times without refetching.
  setInterval(() => {
    if (!S.data) return;
    const n = Date.now();
    S.outages.forEach((o) => { o.ageMin = (n - o.start) / 60000; });
    renderList(); renderTimeline();
  }, 60000);

  (async function start() {
    resize();
    requestAnimationFrame(frame);
    try { await loadWorld(); } catch (e) { console.error('world map failed', e); }
    await refresh();
    setInterval(refresh, CFG.refreshMs);
    // Tour runs from launch unless explicitly disabled with tour=0.
    if (CFG.tour !== '0' || CFG.signage) { S.lastInput = -Infinity; }
  })();
})();
