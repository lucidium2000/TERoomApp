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
 *   renderer=2d     force the Canvas 2D renderer (default: WebGL when available)
 *   scale=<0.4-1>   fix the render resolution scale (default: adapts to keep >= ~25 fps)
 *   tex=<px>        WebGL land texture width, default 4096
 *   kiosk=1         hide the cursor
 *   signage=1       non-interactive digital signage: tour always on, no controls
 *   mode=free       clean globe: no panels; a floating callout appears at the outage
 *                   once the globe has zoomed in (default: hud). Remembered per device.
 *   zoom=<n>        resting zoom, default 1.2
 *   depth=<n>       Glass mode: how far behind the screen the globe sits, in screen
 *                   widths (default 0.6) - deeper = stronger parallax
 *   eye=<n>         assumed viewing distance in screen widths (default 1.0)
 *   eyerange=<n>    how far the virtual eye moves per unit of head movement (default 1.2)
 *   swipe=0         disable the experimental arm-swipe gesture in Glass mode
 *   glass=1         start Glass mode (camera parallax) on load, if the device allows it
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
  // The globe itself is drawn by WebGL where available (js/glglobe.js); the 2D
  // canvas on top then only carries markers, arcs and labels. Without WebGL the
  // 2D canvas draws everything and is opaque, so the browser skips blending it.
  const glCanvas = $('gl');
  let glr = null;
  try { glr = qs.get('renderer') !== '2d' && window.createGlobeGL ? window.createGlobeGL(glCanvas) : null; } catch (e) { reportError(e, 'WebGL init'); }
  if (!glr) glCanvas.style.display = 'none';
  // Opaque when 2D draws everything (the browser skips blending). If WebGL is
  // dropped later the 2D path paints an opaque sky itself, so it still works.
  const ctx = canvas.getContext('2d', { alpha: !!glr });

  /** Any WebGL failure, at any point, falls back to the 2D renderer for good. */
  function disableGL(why, e) {
    if (!glr) return;
    console.warn('[globe] WebGL disabled:', why, e || '');
    glr = null;
    glCanvas.style.display = 'none';
    S.glOff = why;
  }
  function glTry(what, fn) {
    if (!glr) return;
    try { fn(); } catch (e) { disableGL(what, e); }
  }
  glCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); disableGL('context lost'); });

  /** Surface unexpected errors on screen - room devices have no console. */
  function reportError(e, where) {
    const msg = (where ? where + ': ' : '') + ((e && (e.message || e.reason && e.reason.message)) || String(e));
    console.error('[globe]', msg, e);
    const box = document.getElementById('error');
    if (!box) return;
    box.hidden = false;
    box.dataset.diag = '1';
    box.textContent = 'Error - ' + msg.slice(0, 300);
  }
  window.addEventListener('error', (e) => reportError(e.error || e.message, 'error'));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'promise'));
  const el = {
    updated: $('updated'), list: $('list'), watch: $('watch'),
    statActive: $('statActive'), statNet: $('statNet'), statApp: $('statApp'), statLoc: $('statLoc'),
    card: $('card'), cardIcon: $('cardIcon'), cardKind: $('cardKind'), cardName: $('cardName'),
    cardMetrics: $('cardMetrics'), cardLocs: $('cardLocs'), cardProgress: $('cardProgress'),
    cardClose: $('cardClose'), tourBtn: $('tourBtn'), timeline: $('timeline'),
    toast: $('toast'), error: $('error'), panel: $('panel'),
  };

  // ── State ────────────────────────────────────────────────────────────────
  const DEFAULT_ZOOM = Math.max(0.6, Math.min(3, num('zoom', 1.2)));
  const view = { lon: -40, lat: 22, zoom: DEFAULT_ZOOM };   // centre of the visible face
  // Render resolution scale: 1 = full device resolution. Lowered automatically
  // if the device can't keep up (see adaptScale), or fixed with ?scale=.
  const FIXED_SCALE = qs.has('scale') ? Math.max(0.4, Math.min(1, num('scale', 1))) : 0;
  const S = {
    scale: FIXED_SCALE || 1, pr: CFG.dpr * (FIXED_SCALE || 1),
    data: null, outages: [], drawOrder: [], free: false, seen: new Set(), filter: 'all',
    selected: null, hits: [],
    lastInput: performance.now(), dragging: false, vel: { lon: 0, lat: 0 },
    flight: null, touring: false, tourIdx: -1, tourT0: 0,
    land: null, borders: null, stars: null, w: 0, h: 0,
  };

  // Resampling tolerance of 1px is invisible on 110m data and roughly halves projection work.
  const projection = d3.geoOrthographic().clipAngle(90).precision(1);
  const path = d3.geoPath(projection, ctx);
  const graticule = d3.geoGraticule().step([15, 15])();
  const SPHERE = { type: 'Sphere' };

  // ── Geometry helpers ─────────────────────────────────────────────────────
  // Measured on resize / mode change only: reading the panel's size every frame
  // forces a synchronous layout.
  // `layCur` eases toward the target so switching modes glides the globe over.
  let layoutCache = null, layCur = null;
  function layout() {
    const tgt = layoutCache || (layoutCache = measureLayout());
    if (!layCur) layCur = { ...tgt };
    return layCur;
  }
  function easeLayout(dt) {
    const tgt = layoutCache || (layoutCache = measureLayout());
    if (!layCur) { layCur = { ...tgt }; return; }
    const f = 1 - Math.pow(0.88, dt / 16);
    for (const k of ['cx', 'cy', 'base']) layCur[k] += (tgt[k] - layCur[k]) * f;
  }
  function invalidateLayout(snap) { layoutCache = null; if (snap) layCur = null; }
  function measureLayout() {
    const panelOnSide = window.innerWidth > 900 && !S.free;
    const panelW = panelOnSide ? el.panel.getBoundingClientRect().width + 32 : 0;
    const w = window.innerWidth, h = window.innerHeight;
    const availW = w - panelW;
    const availH = panelOnSide || S.free ? h : h * 0.62;
    return { cx: availW / 2, cy: availH / 2 + (panelOnSide ? -h * 0.02 : 0), base: Math.min(availW, availH) * 0.41 };
  }

  function wrapLon(l) { return ((l + 540) % 360) - 180; }
  function clampLat(l) { return Math.max(-85, Math.min(85, l)); }

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
    c.width = Math.round(w * S.pr); c.height = Math.round(h * S.pr);
    const g = c.getContext('2d', { alpha: false });
    g.fillStyle = '#05070d'; g.fillRect(0, 0, c.width, c.height);
    g.scale(S.pr, S.pr);
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

  // ── Glass mode parallax ──────────────────────────────────────────────────
  // How far each depth layer slides, as a fraction of the viewport, when the
  // viewer is at the edge of the tracked range. The UI is the "glass" and never
  // moves; the stars are farthest away, so they move most.
  const PARALLAX = { stars: 0.06, globe: 0.028, lon: 14, lat: 9 };
  // Lean-to-zoom: pose.z is log2(distance ratio), so twice as close -> 2^0.85 = 1.8x.
  const LEAN_ZOOM_GAIN = num('leanzoom', 0.85);
  const NO_POSE = { x: 0, y: 0, z: 0 };
  const pose = () => (window.Glass && window.Glass.pose) || NO_POSE;

  // ── Cached artwork ───────────────────────────────────────────────────────
  // Everything that looks the same frame to frame is drawn once into an
  // offscreen canvas and stamped with drawImage, which the GPU does almost for
  // free. Gradients in particular were being rebuilt per frame (and per marker).

  function offscreen(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  /** Atmosphere halo + shaded ocean, drawn for radius R. Smooth gradients scale
   *  without visible loss, so it's only rebuilt when R changes by >20%. */
  let sphereSprite = null;
  function getSphereSprite(R) {
    const want = R * S.pr;
    if (sphereSprite && want / sphereSprite.r > 0.83 && want / sphereSprite.r < 1.2) return sphereSprite;
    const r = Math.max(16, want), half = r * 1.24;
    const c = offscreen(half * 2, half * 2), g = c.getContext('2d');
    const cx = half, cy = half;
    const halo = g.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.22);
    halo.addColorStop(0, 'rgba(56,189,248,0.28)');
    halo.addColorStop(0.35, 'rgba(56,189,248,0.08)');
    halo.addColorStop(1, 'rgba(56,189,248,0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(cx, cy, r * 1.22, 0, 2 * Math.PI); g.fill();
    const sea = g.createRadialGradient(cx - r * 0.32, cy - r * 0.44, r * 0.05, cx, cy, r * 1.05);
    sea.addColorStop(0, '#1b2942'); sea.addColorStop(0.62, '#0f172a'); sea.addColorStop(1, '#080d18');
    g.fillStyle = sea;
    g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.fill();
    sphereSprite = { canvas: c, r, half };
    return sphereSprite;
  }

  /** Marker glow + core, one sprite per outage kind. Drawn at 4x the largest
   *  on-screen size so scaling down stays crisp. */
  const GLOW_PX = 96;
  const glowSprites = {};
  function getGlow(kind) {
    if (glowSprites[kind]) return glowSprites[kind];
    const c = offscreen(GLOW_PX * 2, GLOW_PX * 2), g = c.getContext('2d');
    const m = GLOW_PX, core = GLOW_PX / 3;     // glow reaches 3x the core radius
    const grad = g.createRadialGradient(m, m, 0, m, m, m);
    grad.addColorStop(0, `rgba(${RGB[kind]},0.55)`);
    grad.addColorStop(1, `rgba(${RGB[kind]},0)`);
    g.fillStyle = grad; g.beginPath(); g.arc(m, m, m, 0, 2 * Math.PI); g.fill();
    g.fillStyle = `rgb(${RGB[kind]})`; g.beginPath(); g.arc(m, m, core, 0, 2 * Math.PI); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.arc(m, m, core * 0.35, 0, 2 * Math.PI); g.fill();
    glowSprites[kind] = c;
    return c;
  }

  /** Night-side caps around the antisolar point. The geometry is rebuilt only
   *  when the sun has moved a quarter-degree (about once a minute). */
  const NIGHT_RADII = [95, 89, 83, 77];
  let night = { key: '', caps: [] };
  function nightCaps() {
    const sun = subsolar(Date.now());
    const anti = [wrapLon(sun.lon + 180), -sun.lat];
    const key = Math.round(anti[0] * 4) + ',' + Math.round(anti[1] * 4);
    if (key !== night.key) {
      night = { key, caps: NIGHT_RADII.map((r) => d3.geoCircle().center(anti).radius(r).precision(2)()) };
    }
    return night.caps;
  }

  // Location unit vectors, so the far-side test is a dot product per marker.
  function unitVec(lon, lat) {
    const l = lon * RAD, p = lat * RAD, c = Math.cos(p);
    return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
  }
  let viewVec = [1, 0, 0];
  const FAR_SIDE = Math.cos(Math.PI / 2 - 0.02);
  function isVisible(lon, lat, v) {
    v = v || unitVec(lon, lat);
    return v[0] * viewVec[0] + v[1] * viewVec[1] + v[2] * viewVec[2] > FAR_SIDE;
  }

  // ── Overlay projection ───────────────────────────────────────────────────
  // Everything drawn on the 2D overlay (markers, arcs, labels, taps, the
  // floating callout) goes through `proj`, so it lines up with whichever globe
  // is underneath: d3's orthographic for the 2D renderer, or the WebGL
  // renderer's off-axis perspective camera.
  const SCENE = { depth: num('depth', 0.6), eye: num('eye', 1.0), range: num('eyerange', 1.2) };
  let cam = null;   // perspective camera for this frame (WebGL), else null
  const proj = {
    point(lon, lat, v) {
      if (!cam) return isVisible(lon, lat, v) ? projection([lon, lat]) : null;
      v = v || unitVec(lon, lat);
      const { e, n, c, C, E, Rw } = cam;
      // world -> view -> scene axes (y down, z into the screen)
      const vx = e[0] * v[0] + e[1] * v[1] + e[2] * v[2];
      const vy = n[0] * v[0] + n[1] * v[1] + n[2] * v[2];
      const vz = c[0] * v[0] + c[1] * v[1] + c[2] * v[2];
      const nx = vx, ny = -vy, nz = -vz;
      const hx = C[0] + Rw * nx, hy = C[1] + Rw * ny, hz = C[2] + Rw * nz;
      // Facing the eye?
      const tx = E[0] - hx, ty = E[1] - hy, tz = E[2] - hz;
      if (nx * tx + ny * ty + nz * tz <= 0.02 * Math.hypot(tx, ty, tz)) return null;
      const t = -E[2] / (hz - E[2]);
      return [E[0] + (hx - E[0]) * t, E[1] + (hy - E[1]) * t];
    },
    invert(x, y) {
      if (!cam) {
        const ll = projection.invert([x, y]);
        return ll && d3.geoDistance(ll, [view.lon, view.lat]) < Math.PI / 2 ? ll : null;
      }
      const { e, n, c, C, E, Rw } = cam;
      let dx = x - E[0], dy = y - E[1], dz = -E[2];
      const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
      const ox = C[0] - E[0], oy = C[1] - E[1], oz = C[2] - E[2];
      const b = ox * dx + oy * dy + oz * dz, c2 = ox * ox + oy * oy + oz * oz - b * b;
      if (c2 >= Rw * Rw) return null;
      const t = b - Math.sqrt(Rw * Rw - c2);
      const nx = (E[0] + dx * t - C[0]) / Rw, ny = (E[1] + dy * t - C[1]) / Rw, nz = (E[2] + dz * t - C[2]) / Rw;
      const vx = nx, vy = -ny, vz = -nz;
      const w = [e[0] * vx + n[0] * vy + c[0] * vz, e[1] * vx + n[1] * vy + c[1] * vz, e[2] * vx + n[2] * vy + c[2] * vz];
      return [Math.atan2(w[1], w[0]) / RAD, Math.asin(Math.max(-1, Math.min(1, w[2]))) / RAD];
    },
    /** Great-circle arc a -> b into the current ctx path (visible runs only). */
    arc(a, b) {
      if (!cam) { path({ type: 'LineString', coordinates: [a, b] }); return; }
      const ip = d3.geoInterpolate(a, b);
      const steps = Math.max(8, Math.min(64, Math.ceil(d3.geoDistance(a, b) / RAD / 2)));
      let pen = false;
      for (let i = 0; i <= steps; i++) {
        const q = ip(i / steps), p = proj.point(q[0], q[1]);
        if (!p) { pen = false; continue; }
        if (pen) ctx.lineTo(p[0], p[1]); else { ctx.moveTo(p[0], p[1]); pen = true; }
      }
    },
  };

  /** Off-axis camera: screen = glass at z=0, eye at z=-D moved by head
   *  tracking, globe sized so that from a centred eye it looks exactly R. */
  function makeCamera(L, R, lon, lat, P) {
    const D = SCENE.eye * S.w, zf = SCENE.depth * S.w;
    const sinA = Math.sin(Math.atan(R / D));
    const Rw = sinA * (D + zf) / (1 - sinA);
    const l = lon * RAD, f = lat * RAD, sl = Math.sin(l), cl = Math.cos(l), sf = Math.sin(f), cf = Math.cos(f);
    return {
      Rw, D,
      C: [L.cx, L.cy, zf + Rw],
      E: [L.cx + P.x * S.w * SCENE.range, L.cy - P.y * S.h * SCENE.range, -D],
      e: [-sl, cl, 0], n: [-sf * cl, -sf * sl, cf], c: [cf * cl, cf * sl, sf],
    };
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function resize() {
    S.w = window.innerWidth; S.h = window.innerHeight;
    S.pr = CFG.dpr * S.scale;
    canvas.width = Math.round(S.w * S.pr); canvas.height = Math.round(S.h * S.pr);
    S.stars = buildStars(S.w, S.h);
    sphereSprite = null;
    glTry('resize', () => { glr.resize(canvas.width, canvas.height); glr.setStars(S.stars); });
    invalidateLayout(true);
  }

  function starOffset() {
    const P = pose();
    return {
      x: -(view.lon / 360) * S.w * 0.5 - P.x * S.w * PARALLAX.stars,
      y: (view.lat / 90) * S.h * 0.175 + P.y * S.h * PARALLAX.stars,
    };
  }

  function drawSky() {
    const { w, h } = S;
    // The sky drifts as the globe turns - half a screen per full revolution.
    // Plus the opposite-direction parallax shift when Glass mode is tracking.
    // The star tile is opaque (space colour baked in), so no clear is needed.
    const o = starOffset();
    let ox = o.x % w; if (ox > 0) ox -= w;
    let oy = o.y % h; if (oy > 0) oy -= h;
    for (let x = ox; x < w; x += w) for (let y = oy; y < h; y += h) ctx.drawImage(S.stars, x, y, w, h);
  }

  function drawGlobe(now, L) {
    // Glass mode: the globe slides opposite to the viewer's head and turns to
    // show the side they are now looking from - what an object behind a window
    // does - and leaning in zooms. Render-only; the user's own view (drag, zoom,
    // tour) is untouched.
    const P = pose();
    const R = L.base * Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.zoom * Math.pow(2, P.z * LEAN_ZOOM_GAIN)));
    S.R = R;

    if (glr) {
      // WebGL: a real perspective camera does the parallax - no fake offsets.
      cam = makeCamera(L, R, view.lon, view.lat, P);
      const sun = subsolar(Date.now()), pr = S.pr;
      // Stars are at infinity: on the glass they move exactly with the eye.
      const sx = -(view.lon / 360) * S.w * 0.5 + (cam.E[0] - L.cx);
      const sy = (view.lat / 90) * S.h * 0.175 + (cam.E[1] - L.cy);
      glTry('render', () => glr.render({
        eye: cam.E.map((v) => v * pr), ctr: cam.C.map((v) => v * pr), Rw: cam.Rw * pr, R: R * pr,
        lon: view.lon, lat: view.lat, sun: unitVec(sun.lon, sun.lat), starX: -sx * pr, starY: -sy * pr, px: pr,
      }));
    }
    if (!glr) {
      // 2D renderer: orthographic, with the simple slide-and-turn parallax.
      cam = null;
      L = { ...L, cx: L.cx - P.x * S.w * PARALLAX.globe, cy: L.cy + P.y * S.h * PARALLAX.globe };
      const cLon = view.lon + P.x * PARALLAX.lon, cLat = clampLat(view.lat + P.y * PARALLAX.lat);
      projection.translate([L.cx, L.cy]).scale(R).rotate([-cLon, -cLat]);
      viewVec = unitVec(cLon, cLat);
    }
    if (glr) {
      ctx.clearRect(0, 0, S.w, S.h);
      perfMark('gl');
      drawOutages(now, R);
      perfMark('markers');
      return;
    }

    // Halo + ocean (cached sprite).
    const sp = getSphereSprite(R);
    const k = R / (sp.r / S.pr);
    const hs = (sp.half / S.pr) * k;
    ctx.drawImage(sp.canvas, L.cx - hs, L.cy - hs, hs * 2, hs * 2);

    perfMark('sphere');
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(148,163,184,0.16)'; ctx.lineWidth = 0.7;
    ctx.beginPath(); path(graticule); ctx.stroke();

    if (S.land) {
      // One projection of the land serves both the fill and the coastline.
      ctx.beginPath(); path(S.land);
      ctx.fillStyle = '#24344b'; ctx.fill();
      ctx.strokeStyle = 'rgba(110,140,185,0.55)'; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.strokeStyle = '#486084'; ctx.lineWidth = 0.7;
      ctx.beginPath(); path(S.borders); ctx.stroke();
    }
    perfMark('land');

    // Night side: four soft bands so the terminator reads as dusk, not a line.
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    for (const cap of nightCaps()) { ctx.beginPath(); path(cap); ctx.fill(); }
    perfMark('night');

    // Limb.
    ctx.strokeStyle = 'rgba(56,189,248,0.45)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(L.cx, L.cy, R, 0, 2 * Math.PI); ctx.stroke();

    drawOutages(now, R);
    perfMark('markers');
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
      ctx.lineCap = 'round';
      for (const [w, a] of [[5, 0.25], [1.6, 0.95]]) {
        ctx.beginPath();
        for (const loc of sel.locations) {
          if (loc !== hub) proj.arc([hub.lon, hub.lat], [loc.lon, loc.lat]);
        }
        ctx.strokeStyle = `rgba(${RGB[sel.kind]},${a})`; ctx.lineWidth = w * k; ctx.stroke();
      }
      ctx.restore();
    }

    // Older first, so the freshest outages paint on top (order fixed at ingest).
    for (const o of S.drawOrder) {
      if (!outageVisible(o)) continue;
      const isSel = o === sel;
      const dim = sel && !isSel ? 0.35 : 1;
      const a = (o.active ? 1 : Math.max(0.35, 1 - o.ageMin / (24 * 60))) * dim;
      const sprite = getGlow(o.kind);
      for (const loc of o.locations) {
        const p = proj.point(loc.lon, loc.lat, loc.v);
        if (!p) continue;
        const r = (3.2 + Math.sqrt(loc.n) * 1.6) * k * (isSel ? 1.35 : 1);

        // Pulse rings on active and selected outages.
        if (o.active || isSel) {
          const period = isSel ? 1600 : 2400;
          ctx.lineWidth = 2 * k;
          for (let i = 0; i < 2; i++) {
            // Positive modulo: a negative longitude offset must not give a negative radius.
            const t = ((((now + i * period / 2 + (loc.lon * 37 | 0)) % period) + period) % period) / period;
            ctx.strokeStyle = `rgba(${RGB[o.kind]},${((1 - t) * 0.7 * dim).toFixed(3)})`;
            ctx.beginPath(); ctx.arc(p[0], p[1], r + t * 26 * k, 0, 2 * Math.PI); ctx.stroke();
          }
        }
        // Glow + core + highlight: one stamp.
        ctx.globalAlpha = a;
        ctx.drawImage(sprite, p[0] - r * 3, p[1] - r * 3, r * 6, r * 6);
        ctx.globalAlpha = 1;

        S.hits.push({ x: p[0], y: p[1], r: Math.max(22, r * 2), o });
      }
    }

    // City labels for the selected outage.
    if (sel) {
      ctx.font = `600 ${Math.round(13 * k)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textBaseline = 'middle';
      const placed = [];
      for (const loc of sel.byWeight) {
        const p = proj.point(loc.lon, loc.lat, loc.v);
        if (!p) continue;
        const label = loc.label;
        const x = p[0] + 14 * k, y = p[1];
        const tw = loc.tw || (loc.tw = ctx.measureText(label).width / k);
        const w = tw * k;
        if (placed.some((q) => Math.abs(q.y - y) < 18 * k && x < q.x + q.w && x + w > q.x)) continue;
        placed.push({ x, y, w });
        ctx.fillStyle = 'rgba(5,7,13,0.75)';
        ctx.fillRect(x - 5 * k, y - 11 * k, w + 10 * k, 22 * k);
        ctx.fillStyle = '#e6edf7';
        ctx.fillText(label, x, y + 0.5);
      }
    }
  }

  // ── Perf overlay (?perf=1) ───────────────────────────────────────────────
  const PERF = qs.get('perf') === '1';
  const perfAcc = {}; let perfT = 0, perfEl = null, perfFrames = 0, perfLast = 0;
  function perfMark(name) {
    if (!PERF) return;
    const t = performance.now();
    perfAcc[name] = (perfAcc[name] || 0) + (t - perfT);
    perfT = t;
  }
  function perfFrame(t, workMs) {
    if (!PERF) return;
    perfFrames++;
    perfAcc.total = (perfAcc.total || 0) + workMs;
    if (t - perfLast < 1000) return;
    if (!perfEl) {
      perfEl = document.createElement('pre');
      perfEl.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);margin:0;padding:6px 10px;'
        + 'background:rgba(0,0,0,.75);color:#9fe;font:12px/1.35 ui-monospace,Menlo,monospace;border-radius:8px;z-index:99;pointer-events:none';
      document.body.appendChild(perfEl);
    }
    const n = perfFrames, f = (k) => ((perfAcc[k] || 0) / n).toFixed(1);
    const G = window.Glass;
    perfEl.textContent = `${Math.round((n * 1000) / (t - perfLast))} fps (cap ${frameCap}) | ${glr ? 'webgl' : '2d' + (S.glOff ? ' [gl off: ' + S.glOff + ']' : '')} `
      + `scale ${S.scale.toFixed(2)} (${canvas.width}x${canvas.height}) | work ${f('total')}ms: `
      + (glr ? `gl ${f('gl')} markers ${f('markers')}` : `sky ${f('sky')} sphere ${f('sphere')} land ${f('land')} night ${f('night')} markers ${f('markers')}`)
      + (glr ? `\ngpu: ${glr.info.renderer || '?'} | tex ${S.texW || '-'} / max ${glr.info.maxTex} | lines ${S.segments || '-'} | lod ${glr.info.lod} aniso ${glr.info.aniso}` : '')
      + (G && G.on ? `\nglass ${G.stats.where} ${G.stats.hz}Hz detect ${G.stats.ms.toFixed(1)}ms z ${G.pose.z.toFixed(2)} swipe:${G.stats.swipe || '-'}` : '');
    for (const key in perfAcc) perfAcc[key] = 0;
    perfFrames = 0; perfLast = t;
  }

  // ── Motion: idle spin, inertia, flights, tour ────────────────────────────
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function flyTo(o, durMs = 2200) {
    const pts = o.locations.map((l) => [l.lon, l.lat]);
    const centre = pts.length > 1 ? d3.geoCentroid({ type: 'MultiPoint', coordinates: pts }) : pts[0];
    const spread = Math.max(0, ...pts.map((p) => d3.geoDistance(p, centre)));
    const zoom = Math.max(DEFAULT_ZOOM, Math.min(2.6, 1.05 / (spread + 0.32)));
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
        view.zoom += (DEFAULT_ZOOM - view.zoom) * 0.002 * dt / 16;
      }
    }

    // Tour: start when idle, advance on a timer.
    const tourOff = CFG.tour === '0' && !CFG.signage;
    if (!S.touring && !tourOff && S.outages.length && now - S.lastInput > CFG.idleMs) setTour(true);
    if (S.touring) {
      const frac = (now - S.tourT0) / CFG.dwellMs;
      el.cardProgress.style.transform = floatProgress.style.transform = `scaleX(${Math.min(1, frac).toFixed(4)})`;
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
    el.cardProgress.style.transform = 'scaleX(0)';
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
    if (!o) { el.card.hidden = true; hideFloat(); renderList(); renderTimeline(); return; }
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
    fillFloat(o, metrics, locs);
    // Restart the entrance animation.
    el.card.style.animation = 'none'; void el.card.offsetWidth; el.card.style.animation = '';
    if (!fromTour) { el.cardProgress.style.transform = 'scaleX(0)'; floatProgress.style.transform = 'scaleX(0)'; }
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
      // Per-location values the renderer would otherwise recompute every frame.
      locations: (o.locations || []).filter((l) => isFinite(l.lat) && isFinite(l.lon))
        .map((l) => ({ ...l, v: unitVec(l.lon, l.lat), label: String(l.name).split(',')[0] })),
    })).filter((o) => o.locations.length);
    S.outages.forEach((o) => { o.byWeight = o.locations.slice().sort((a, b) => b.n - a.n); });
    S.drawOrder = S.outages.slice().sort((a, b) => a.start - b.start);

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
      if (!el.error.dataset.diag) el.error.hidden = true;
    } catch (e) {
      console.error(e);
      if (!S.data) { el.error.textContent = 'Could not load outage data. Retrying…'; el.error.hidden = false; }
    }
  }

  /** WebGL gets the 50m Natural Earth data: vector coastlines and borders stay
   *  sharp at any zoom, and the GPU draws ~80k segments without noticing. */
  async function loadGLWorld() {
    if (!glr) return;
    let world;
    try { world = await (await fetch('vendor/countries-50m.json')).json(); } catch (e) { reportError(e, 'world map 50m'); return; }
    glTry('world', () => {
      const r = glr.setWorld({
        land: topojson.feature(world, world.objects.land),
        coast: topojson.mesh(world, world.objects.land),
        borders: topojson.mesh(world, world.objects.countries, (a, b) => a !== b),
        texWidth: num('tex', 8192),
      });
      S.texW = r.texW; S.segments = r.segments;
    });
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
      if (pinch > 0) { bakeLean(); view.zoom = clampZoom(view.zoom * (d / pinch)); }
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

  /** Manual zoom wins over lean-to-zoom: fold whatever the lean is adding into
   *  the view, then make the viewer's current distance the new zero. So after
   *  a pinch the globe stays exactly where the user put it, and leaning works
   *  relative to their new position. */
  function bakeLean() {
    const G = window.Glass;
    if (!G || !G.on) return;
    if (G.pose.z) view.zoom = clampZoom(view.zoom * Math.pow(2, G.pose.z * LEAN_ZOOM_GAIN));
    G.recalibrate();
  }

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
    if (pts.size < 2) { if (pinch) bakeLean(); pinch = 0; mid = null; }
    // Double tap: zoom in on that spot.
    if (down && !down.moved && e.type === 'pointerup') {
      const t = now();
      if (lastTap && t - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        lastTap = null;
        const ll = proj.invert(e.clientX, e.clientY);
        bakeLean();
        zoomTo(view.zoom * 1.8, ll);
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
    bakeLean();
    view.zoom = clampZoom(view.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.006 : 0.0015)));
  }, { passive: false });

  // Reset view (zoom is by pinch, double-tap, wheel, or leaning in with Glass mode).
  document.getElementById('zoomReset').addEventListener('click', () => { userInput(); select(null); zoomTo(DEFAULT_ZOOM, [view.lon, 18]); });
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

  // ── Glass mode controls ──────────────────────────────────────────────────
  const glassBtn = document.getElementById('glassBtn');
  const sheen = document.getElementById('sheen');
  const sheenGlare = sheen.querySelector('i');
  const camChip = document.getElementById('camChip');

  const swipeEl = document.getElementById('swipeHint');
  let swipeTimer = 0;
  function showSwipe(dir) {
    swipeEl.textContent = dir === 'left' ? '\u2190' : '\u2192';
    swipeEl.className = 'swipe-hint show ' + dir;
    clearTimeout(swipeTimer);
    swipeTimer = setTimeout(() => { swipeEl.className = 'swipe-hint'; }, 600);
  }

  function updateSheen() {
    if (!window.Glass || (!window.Glass.on && !sheen.classList.contains('on'))) return;
    const P = pose();
    // Reflections on glass drift WITH the viewer, against the scene behind it.
    // transform only: composited on the GPU, no full-screen repaint per frame.
    sheenGlare.style.transform = `translate3d(${(P.x * 30).toFixed(2)}vw, ${(-P.y * 25).toFixed(2)}vh, 0)`;
    camChip.classList.toggle('seen', !!P.seen);
  }

  if (window.Glass) {
    window.Glass.onState((state, detail) => {
      const on = state === 'starting' || state === 'face' || state === 'motion';
      glassBtn.setAttribute('aria-pressed', String(on));
      glassBtn.classList.toggle('busy', state === 'starting');
      sheen.classList.toggle('on', state === 'face' || state === 'motion');
      camChip.hidden = !(state === 'face' || state === 'motion');
      if (state === 'face') toast('Glass mode on: tracking your head');
      else if (state === 'motion') toast('Glass mode on: tracking movement (face model unavailable)');
      else if (state === 'error') toast(detail);
    });
    // Experimental arm swipe: next/previous outage while one is showing (or on
    // tour), otherwise a flick that spins the globe.
    window.Glass.onSwipe((dir) => {
      const sign = dir === 'left' ? 1 : -1;     // swipe left = move forward / spin east
      showSwipe(dir);
      if (S.touring || S.selected) {
        const list = tourList();
        if (!list.length) return;
        const i = Math.max(0, list.indexOf(S.selected));
        if (S.touring) { S.tourIdx = (i + sign + list.length) % list.length; select(list[S.tourIdx], { fromTour: true }); }
        else select(list[(i + sign + list.length) % list.length]);
      } else {
        S.flight = null;
        S.vel.lon = 0.12 * sign; S.vel.lat = 0;
        S.lastInput = performance.now();
      }
    });
    glassBtn.addEventListener('click', () => {
      userInput();
      if (window.Glass.on) window.Glass.stop(); else window.Glass.start();
    });
  } else {
    glassBtn.hidden = true;
  }

  // ── Free mode + floating callout ─────────────────────────────────────────
  const floatEl = document.getElementById('float');
  const floatProgress = document.getElementById('floatProgress');
  const modeBtn = document.getElementById('modeBtn');
  let floatSize = { w: 0, h: 0 }, floatShown = false;

  function fillFloat(o, metrics, locs) {
    floatEl.className = 'float ' + o.kind;
    document.getElementById('floatIcon').innerHTML = iconHtml(o);
    document.getElementById('floatKind').innerHTML = (o.kind === 'network' ? 'Network outage' : 'Application outage')
      + (o.active ? '<span class="pill">● ACTIVE</span>' : '');
    document.getElementById('floatName').textContent = o.name;
    document.getElementById('floatMetrics').innerHTML = metrics.slice(0, 3)
      .map(([b, t]) => `<div><b>${esc(b)}</b><span>${esc(t)}</span></div>`).join('');
    document.getElementById('floatLocs').textContent = locs.slice(0, 3).map((l) => l.label || l.name.split(',')[0]).join(' · ')
      + (locs.length > 3 ? ` +${locs.length - 3}` : '');
    // Measured once here, not per frame.
    floatSize = { w: floatEl.offsetWidth, h: floatEl.offsetHeight };
    floatShown = false;
  }

  function hideFloat() {
    if (floatShown) { floatEl.classList.remove('show'); floatShown = false; }
  }

  /** Pin the callout beside the outage's main location, once the camera has
   *  arrived. Moves by transform only, so following the globe is cheap. */
  function updateFloat() {
    const o = S.selected;
    if (!S.free || !o || S.flight) { hideFloat(); return; }
    const hub = o.byWeight[0];
    const p = proj.point(hub.lon, hub.lat, hub.v);
    if (!p) { hideFloat(); return; }
    const { w, h } = floatSize, gap = 46, pad = 16;
    let right = true;
    let x = p[0] + gap, y = p[1] - h - gap * 0.6;
    if (x + w > S.w - pad) { x = p[0] - gap - w; right = false; }
    x = Math.max(pad, Math.min(S.w - w - pad, x));
    y = Math.max(pad, Math.min(S.h - h - pad, y));
    floatEl.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    if (!floatShown) { floatEl.classList.add('show'); floatShown = true; }
    // Leader line from the location to the callout's nearest bottom corner.
    const ax = right ? x : x + w, ay = Math.min(y + h, Math.max(y, p[1]));
    ctx.strokeStyle = `rgba(${RGB[o.kind]},0.85)`; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(ax, ay); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, 2 * Math.PI); ctx.fill();
  }

  function setMode(free, save = true) {
    S.free = free;
    document.body.classList.toggle('free', free);
    modeBtn.setAttribute('aria-pressed', String(free));
    modeBtn.setAttribute('aria-label', free ? 'HUD mode: show panels' : 'Free mode: hide panels for a clean globe');
    if (!free) hideFloat();
    showChrome();
    invalidateLayout(false);   // globe glides to its new centre
    if (save) { try { localStorage.setItem('te-globe-mode', free ? 'free' : 'hud'); } catch (_) { /* */ } }
  }
  modeBtn.addEventListener('click', () => { userInput(); setMode(!S.free); });

  // Free mode: the control column fades away when nobody is touching the
  // screen, and any touch brings it back. Capture phase, so the reveal happens
  // even if the touch lands on the globe.
  const CHROME_HIDE_MS = 4000;
  let chromeTimer = 0;
  function showChrome() {
    document.body.classList.remove('chrome-hidden');
    clearTimeout(chromeTimer);
    if (S.free) chromeTimer = setTimeout(() => { if (S.free) document.body.classList.add('chrome-hidden'); }, CHROME_HIDE_MS);
  }
  document.addEventListener('pointerdown', showChrome, true);
  document.addEventListener('wheel', showChrome, { capture: true, passive: true });
  {
    let saved = null;
    try { saved = localStorage.getItem('te-globe-mode'); } catch (_) { /* */ }
    const m = qs.get('mode') || saved;
    if (m === 'free') setMode(true, false);
  }

  // ── Main loop ────────────────────────────────────────────────────────────
  // Adaptive pacing: if a frame's work regularly overruns a 60 Hz slot, render
  // every other vsync (30 fps) instead. Steady 30 looks far smoother than a
  // stuttering 40-50. Steps back up when there's headroom. ?maxfps=30 forces it.
  let last = now(), workAvg = 8, frameCap = num('maxfps', 60) <= 30 ? 30 : 60, lastDraw = 0;
  const FORCED_CAP = num('maxfps', 0) > 0 && num('maxfps', 0) <= 30;
  function frame(t) {
    // Schedule first: one bad frame must never stop the globe (and with it, all input).
    requestAnimationFrame(frame);
    if (frameCap === 30 && t - lastDraw < 1000 / 30 - 4) return;
    lastDraw = t;
    const dt = Math.min(64, t - last); last = t;
    const t0 = performance.now();
    perfT = t0;
    try {
      step(t, dt);
      easeLayout(dt);
      ctx.setTransform(S.pr, 0, 0, S.pr, 0, 0);
      if (!glr) drawSky();   // (also covers WebGL having been dropped mid-run)
      perfMark('sky');
      drawGlobe(t, layout());
      updateFloat();
      updateSheen();
    } catch (e) {
      if (!frame.warned) { frame.warned = true; console.error('[globe] frame error', e); }
    }
    const work = performance.now() - t0;
    workAvg += (work - workAvg) * 0.05;
    if (!FORCED_CAP) {
      if (frameCap === 60 && workAvg > 13) frameCap = 30;
      else if (frameCap === 30 && workAvg < 7) frameCap = 60;
    }
    adaptScale(t);
    perfFrame(t, work);
  }

  // Dynamic resolution: measure the real frame interval (which includes the
  // browser's own raster/composite time, not just our JS) and step the render
  // scale down if the device can't hold ~25 fps, back up when it has headroom.
  let intervalAvg = 16, lastFrameT = 0, scaleCheckT = 0;
  function adaptScale(t) {
    if (lastFrameT) intervalAvg += (Math.min(500, t - lastFrameT) - intervalAvg) * 0.1;
    lastFrameT = t;
    if (FIXED_SCALE || t - scaleCheckT < 2500) return;
    scaleCheckT = t;
    let next = S.scale;
    if (intervalAvg > 40 && S.scale > 0.5) next = Math.max(0.5, S.scale * 0.8);
    else if (intervalAvg < 24 && S.scale < 1) next = Math.min(1, S.scale * 1.15);
    if (Math.abs(next - S.scale) > 0.01) { S.scale = next; resize(); }
  }

  // Refresh relative times without refetching.
  setInterval(() => {
    if (!S.data) return;
    const n = Date.now();
    S.outages.forEach((o) => { o.ageMin = (n - o.start) / 60000; });
    renderList(); renderTimeline();
  }, 60000);

  (async function start() {
    // Each step is independent: a globe/GPU problem must never block the data.
    try { resize(); } catch (e) { reportError(e, 'resize'); }
    requestAnimationFrame(frame);
    const data = refresh();
    try { await loadWorld(); } catch (e) { reportError(e, 'world map'); }
    await data;
    // The land texture is the slowest one-off step, so it comes after the data
    // is on screen. Until then the WebGL globe shows ocean only.
    if (glr) setTimeout(loadGLWorld, 50);
    setInterval(refresh, CFG.refreshMs);
    // Tour runs from launch unless explicitly disabled with tour=0.
    if (CFG.tour !== '0' || CFG.signage) { S.lastInput = -Infinity; }
    if (qs.get('glass') === '1' && window.Glass) window.Glass.start();
  })();
})();
