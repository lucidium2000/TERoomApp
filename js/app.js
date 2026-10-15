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
 *   idle=<sec>      seconds without touch before the tour starts, default 10
 *   dwell=<sec>     seconds per outage on tour, default 10
 *   spin=<deg/s>    idle rotation speed, default 3
 *   watch=a,b,c     service keywords for "Your services", default webex,zoom,microsoft,google,amazon
 *   detail=50m      higher-resolution coastlines (heavier on the device)
 *   dpr=<n>         cap the render pixel ratio, default 1.5
 *   renderer=2d     force the Canvas 2D renderer (default: WebGL when available)
 *   scale=<0.4-1>   fix the render resolution scale (default: adapts to keep >= ~25 fps)
 *   tex=<px>        WebGL land texture width, default 4096
 *   kiosk=1         hide the cursor
 *   pathhigh=<ms>   path trace: latency a link must add to show red (amber at half), default 30
 *   units=c         weather on city labels in Celsius (default Fahrenheit)
 *   autoupdate=0    don't reload by itself when a new version is published
 *   signage=1       non-interactive digital signage: tour always on, no controls
 *   mode=free       clean globe: no panels; a floating callout appears at the outage
 *                   once the globe has zoomed in (default: hud). Remembered per device.
 *   zoom=<n>        resting zoom, default 1.2
 *   depth=<n>       Glass mode: how far behind the screen the globe sits, in screen
 *                   widths (default 0.6) - deeper = stronger parallax
 *   eye=<n>         assumed viewing distance in screen widths (default 1.0)
 *   parallax=<n>    strength of the head-tracked parallax (default 1; 0 = off)
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
    idleMs: num('idle', 10) * 1000,
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
  /** Interface sound (js/sound.js); silent until the first touch. */
  const sfx = (name) => { if (window.Sfx) window.Sfx.play(name); };
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
    updated: $('updated'), list: $('list'),
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
  // 2D-renderer fallback: gentle slide-and-turn, scaled by ?parallax=.
  const PARALLAX_K = Math.max(0, num('parallax', 1));
  const PARALLAX = { stars: 0.02 * PARALLAX_K, globe: 0.01 * PARALLAX_K, lon: 4 * PARALLAX_K, lat: 3 * PARALLAX_K };
  // Lean-to-zoom: pose.z is log2(distance ratio), so twice as close -> 2^0.85 = 1.8x.
  // Off by default: zoom is two-fist grab (pull apart / push together).
  // ?leanzoom=0.85 brings back lean-to-zoom.
  const LEAN_ZOOM_GAIN = num('leanzoom', 0);
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
  // eyeX / eyeY: how far the virtual eye moves at full head offset, as a share
  // of the screen. Small on purpose - a soft sense of depth, not a swing.
  const SCENE = { depth: num('depth', 0.6), eye: num('eye', 1.0), eyeX: 0.1 * PARALLAX_K, eyeY: 0.07 * PARALLAX_K };
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
      E: [L.cx + P.x * S.w * SCENE.eyeX, L.cy - P.y * S.h * SCENE.eyeY, -D],
      e: [-sl, cl, 0], n: [-sf * cl, -sf * sl, cf], c: [cf * cl, cf * sl, sf],
    };
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function resize() {
    S.w = window.innerWidth; S.h = window.innerHeight;
    // While the camera is on, render at 1x: the globe shares the GPU with the
    // face/hand models, and on a 4K (2x) screen 1.5x is 2.25x the pixels.
    S.pr = (S.camOn ? Math.min(1, CFG.dpr) : CFG.dpr) * S.scale;
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

  // ── Weather on city labels (Open-Meteo: free, no key, CORS) ────────────
  // Fetched for a selected outage's locations in one batched request, cached
  // 15 minutes, drawn as temperature + a small vector symbol (no emoji font
  // needed on the device).
  const WX_C = qs.get('units') === 'c';
  const wx = new Map();   // "lat,lon" -> { t, code, day, at } | 'pending'
  const wxKey = (l) => `${l.lat.toFixed(2)},${l.lon.toFixed(2)}`;
  function fetchWeather(locs) {
    const now = Date.now();
    const need = locs.filter((l) => { const w = wx.get(wxKey(l)); return !w || (w !== 'pending' && now - w.at > 15 * 60e3); }).slice(0, 40);
    if (!need.length) return;
    need.forEach((l) => wx.set(wxKey(l), 'pending'));
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + need.map((l) => l.lat.toFixed(3)).join(',')
      + '&longitude=' + need.map((l) => l.lon.toFixed(3)).join(',')
      + '&current=temperature_2m,weather_code,is_day' + (WX_C ? '' : '&temperature_unit=fahrenheit');
    fetch(url).then((r) => r.json()).then((d) => {
      const arr = Array.isArray(d) ? d : [d];
      arr.forEach((x, i) => { if (x && x.current) wx.set(wxKey(need[i]), { t: x.current.temperature_2m, code: x.current.weather_code, day: x.current.is_day === 1, at: Date.now() }); });
    }).catch(() => need.forEach((l) => wx.delete(wxKey(l))));
  }
  /** WMO weather code -> simple symbol, drawn centred at (x, y), size s. */
  function drawWx(code, day, x, y, s) {
    const kind = code === 0 ? 'clear' : code <= 2 ? 'partly' : code === 3 ? 'cloud' : code <= 48 ? 'fog'
      : code <= 67 || (code >= 80 && code <= 82) ? 'rain' : code <= 77 || code <= 86 ? 'snow' : 'storm';
    const sun = (cx, cy, r) => {
      if (day) {
        ctx.strokeStyle = ctx.fillStyle = '#fbbf24'; ctx.lineWidth = Math.max(1, r * 0.28);
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, 2 * Math.PI); ctx.fill();
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4;
          ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8); ctx.lineTo(cx + Math.cos(a) * r * 1.1, cy + Math.sin(a) * r * 1.1); ctx.stroke();
        }
      } else {
        ctx.fillStyle = '#cbd5e1';
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.75, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = 'rgba(5,7,13,1)';
        ctx.beginPath(); ctx.arc(cx + r * 0.35, cy - r * 0.25, r * 0.62, 0, 2 * Math.PI); ctx.fill();
      }
    };
    const cloud = (cx, cy, w, color) => {
      ctx.fillStyle = color || '#cbd5e1';
      ctx.beginPath();
      ctx.arc(cx - w * 0.25, cy + w * 0.05, w * 0.22, 0, 2 * Math.PI);
      ctx.arc(cx + w * 0.02, cy - w * 0.1, w * 0.3, 0, 2 * Math.PI);
      ctx.arc(cx + w * 0.28, cy + w * 0.06, w * 0.2, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillRect(cx - w * 0.25, cy + w * 0.05, w * 0.53, w * 0.21);
    };
    ctx.save();
    ctx.lineCap = 'round';
    if (kind === 'clear') sun(x, y, s * 0.5);
    else if (kind === 'partly') { sun(x + s * 0.18, y - s * 0.18, s * 0.38); cloud(x - s * 0.05, y + s * 0.08, s * 0.8); }
    else if (kind === 'cloud') cloud(x, y, s);
    else if (kind === 'fog') {
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = s * 0.12;
      for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(x - s * 0.4, y + i * s * 0.25); ctx.lineTo(x + s * 0.4, y + i * s * 0.25); ctx.stroke(); }
    } else {
      cloud(x, y - s * 0.12, s * 0.9);
      if (kind === 'rain') {
        ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = s * 0.1;
        for (const dx of [-0.22, 0, 0.22]) { ctx.beginPath(); ctx.moveTo(x + dx * s, y + s * 0.22); ctx.lineTo(x + dx * s - s * 0.07, y + s * 0.45); ctx.stroke(); }
      } else if (kind === 'snow') {
        ctx.fillStyle = '#f8fafc';
        for (const dx of [-0.22, 0, 0.22]) { ctx.beginPath(); ctx.arc(x + dx * s, y + s * 0.36, s * 0.07, 0, 2 * Math.PI); ctx.fill(); }
      } else {
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath(); ctx.moveTo(x + s * 0.05, y + s * 0.12); ctx.lineTo(x - s * 0.12, y + s * 0.38); ctx.lineTo(x + s * 0.02, y + s * 0.38);
        ctx.lineTo(x - s * 0.06, y + s * 0.58); ctx.lineTo(x + s * 0.16, y + s * 0.3); ctx.lineTo(x + s * 0.02, y + s * 0.3); ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
  }

  function outageVisible(o) { return S.filter === 'all' || o.kind === S.filter; }

  function drawOutages(now, R) {
    S.hits = [];
    drawPath(now, R);
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
      // Scrubbing the timeline: only outages that started near that time stay lit.
      const dim = S.timeFocus != null
        ? (Math.abs(o.start - S.timeFocus) <= SCRUB_WINDOW_MS ? 1 : 0.15)
        : (sel && !isSel ? 0.35 : 1);
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
        const wxv = wx.get(wxKey(loc)), hasWx = wxv && wxv !== 'pending';
        const temp = hasWx ? `${Math.round(wxv.t)}\u00B0` : '';
        const tempW = hasWx ? ctx.measureText(temp).width : 0;
        const extra = hasWx ? 8 * k + 16 * k + 4 * k + tempW : 0;   // gap, icon, gap, temperature
        const w = tw * k + extra;
        if (placed.some((q) => Math.abs(q.y - y) < 18 * k && x < q.x + q.w && x + w > q.x)) continue;
        placed.push({ x, y, w });
        ctx.fillStyle = 'rgba(5,7,13,0.75)';
        ctx.fillRect(x - 5 * k, y - 11 * k, w + 10 * k, 22 * k);
        ctx.fillStyle = '#e6edf7';
        ctx.fillText(label, x, y + 0.5);
        if (hasWx) {
          const ix = x + tw * k + 8 * k + 8 * k;
          drawWx(wxv.code, wxv.day, ix, y, 16 * k);
          ctx.fillStyle = '#e6edf7';
          ctx.fillText(temp, ix + 8 * k + 4 * k, y + 0.5);
        }
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
    perfEl.textContent = `${Math.round((n * 1000) / (t - perfLast))} fps (cap ${window.Glass && window.Glass.on ? '30 cam' : frameCap}) | ${glr ? 'webgl' : '2d' + (S.glOff ? ' [gl off: ' + S.glOff + ']' : '')} `
      + `scale ${S.scale.toFixed(2)} (${canvas.width}x${canvas.height}) rescales ${S.rescales} | work ${f('total')}ms: `
      + (glr ? `gl ${f('gl')} markers ${f('markers')}` : `sky ${f('sky')} sphere ${f('sphere')} land ${f('land')} night ${f('night')} markers ${f('markers')}`)
      + (glr ? `\ngpu: ${glr.info.renderer || '?'} | tex ${S.texW || '-'} / max ${glr.info.maxTex} | lines ${S.segments || '-'} | lod ${glr.info.lod} aniso ${glr.info.aniso}` : '')
      + (G && G.on ? `\nglass ${G.stats.where} ${G.stats.hz}Hz detect ${G.stats.ms.toFixed(1)}ms z ${G.pose.z.toFixed(2)} swipe:${G.stats.swipe || '-'}` : '');
    for (const key in perfAcc) perfAcc[key] = 0;
    perfFrames = 0; perfLast = t;
  }

  // ── Motion: idle spin, inertia, flights, tour ────────────────────────────
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /** Spin a whole number of turns and land on the same spot. Ease-out quartic:
   *  most of the distance goes in the first second, then a long coast - reads
   *  as a flick with real inertia. Lat and zoom are left alone. */
  const SPIN_MS = 4200;
  function spinTurns(turns) {
    const interrupted = !!S.flight;
    S.flight = null; S.vel.lon = S.vel.lat = 0;
    S.spin = { from: view.lon, total: turns * 360, t0: performance.now(), dur: SPIN_MS, interrupted };
  }

  /** Where the camera should sit to frame an outage's locations. */
  function framing(o) {
    const pts = o.locations.map((l) => [l.lon, l.lat]);
    const centre = pts.length > 1 ? d3.geoCentroid({ type: 'MultiPoint', coordinates: pts }) : pts[0];
    const spread = Math.max(0, ...pts.map((p) => d3.geoDistance(p, centre)));
    const zoom = Math.max(DEFAULT_ZOOM, Math.min(2.6, 1.05 / (spread + 0.32)));
    return { lon: centre[0], lat: clampLat(centre[1] - 6 / zoom), zoom };   // sit it a touch above centre
  }

  function flyTo(o, durMs = 2200) {
    const fr = framing(o), zoom = fr.zoom;
    const from = [view.lon, view.lat];
    const to = [fr.lon, fr.lat];
    const hop = d3.geoDistance(from, to);
    S.flight = {
      interp: d3.geoInterpolate(from, to), z0: view.zoom, z1: zoom,
      // Long hops pull back mid-flight, like a camera rising before it travels.
      lift: Math.min(0.45, hop / Math.PI * 0.7), t0: performance.now(), dur: durMs,
    };
    S.vel.lon = S.vel.lat = 0;
  }

  // Lazy follow while scrubbing the timeline: a soft, critically damped
  // spring toward the nearest outage. It starts from rest (very slow), keeps
  // its velocity when the target changes (no jolt), and eases in on arrival.
  const FOLLOW_HZ = 0.22;
  function stepFollow(dt) {
    const f = S.follow, sec = Math.min(0.05, dt / 1000), w = 2 * Math.PI * FOLLOW_HZ;
    const dLon = wrapLon(f.lon - view.lon), dLat = f.lat - view.lat, dZ = f.zoom - view.zoom;   // shortest way round
    f.vlon += (w * w * dLon - 2 * w * f.vlon) * sec;
    f.vlat += (w * w * dLat - 2 * w * f.vlat) * sec;
    f.vz += (w * w * dZ - 2 * w * f.vz) * sec;
    view.lon = wrapLon(view.lon + f.vlon * sec);
    view.lat = clampLat(view.lat + f.vlat * sec);
    view.zoom = clampZoom(view.zoom + f.vz * sec);
  }

  // Globe physics: the globe always carries its own velocity (S.vel, deg/ms).
  // It spins freely about its axis (long coast, a little constant friction so
  // it settles), while tilt (lat) is stiff and settles quickly - like a desk
  // globe on its stand.
  const SPIN_TAU_MS = 2600, SPIN_FRICTION = 0.000012, TILT_TAU_MS = 350, MAX_SPIN = 0.72;   // deg/ms
  function coast(dt) {
    const v = S.vel;
    view.lon = wrapLon(view.lon + v.lon * dt);
    const lat = view.lat + v.lat * dt;
    view.lat = clampLat(lat);
    if (lat !== view.lat) v.lat = 0;
    const sp = Math.abs(v.lon) * Math.exp(-dt / SPIN_TAU_MS) - SPIN_FRICTION * dt;
    v.lon = sp > 0 ? Math.sign(v.lon) * sp : 0;
    v.lat *= Math.exp(-dt / TILT_TAU_MS);
  }
  /** On letting go: a globe that was barely moving stays put - a slow drift
   *  at release is almost always the hand settling, not a flick. Speed is
   *  judged on screen (px/ms) so it means the same at any zoom: below
   *  FLING_MIN it stops, up to twice that it eases in, above it flies freely.
   *  ?flingmin= tunes it (px per second, default 250). */
  const FLING_MIN = num('flingmin', 250) / 1000;
  function releaseFling() {
    const degPerPx = 180 / (Math.PI * layout().base * view.zoom);
    const sp = Math.hypot(S.vel.lon, S.vel.lat) / degPerPx;   // px per ms
    const k = sp <= FLING_MIN ? 0 : sp >= 2 * FLING_MIN ? 1 : (sp - FLING_MIN) / FLING_MIN;
    S.vel.lon *= k; S.vel.lat *= k;
    capSpin();
  }
  function capSpin() {
    const v = S.vel;
    v.lon = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, v.lon));
    v.lat = Math.max(-MAX_SPIN / 2, Math.min(MAX_SPIN / 2, v.lat));
  }

  // Fist grab: the hand holds the globe through a stiff, critically damped
  // spring toward where the hand is now (its last sample, carried forward at
  // its own speed - hand results only arrive ~6-15 times a second). The globe
  // keeps its momentum the whole time: grabbing a spinning globe catches it,
  // and letting go (or the fist dropping out) leaves it spinning at whatever
  // speed it had.
  // GRAB_LEAD_MS: aim slightly ahead along the hand's motion, making up part
  // of the hand model's own delay (~150 ms on the Desk Pro).
  const GRAB_HZ = num('grabhz', 4), GRAB_LEAD_MS = num('grablead', 50);
  const grabLate = (g) => g.every * 1.25 + 40;
  function stepGrab(now, dt) {
    const g = S.grab, v = S.vel;
    const since = now - g.t;
    if (since > grabLate(g)) { coast(dt); return; }   // a fist sample is late (hand opening / lost): it's free
    const k = since + GRAB_LEAD_MS;   // carry the hand on at its own speed (plus a little lead) until the sample counts as late
    const w = 2 * Math.PI * GRAB_HZ / 1000;
    const eLon = wrapLon(g.lon + g.vlon * k - view.lon), eLat = clampLat(g.lat + g.vlat * k) - view.lat;
    v.lon += (w * w * eLon + 2 * w * (g.vlon - v.lon)) * dt;
    v.lat += (w * w * eLat + 2 * w * (g.vlat - v.lat)) * dt;
    capSpin();
    view.lon = wrapLon(view.lon + v.lon * dt);
    view.lat = clampLat(view.lat + v.lat * dt);
  }

  function step(now, dt) {
    if (S.follow && S.follow.lon != null) { stepFollow(dt); return; }
    if (S.grabTarget) view.zoom += (S.grabTarget - view.zoom) * (1 - Math.pow(0.8, dt / 16));
    if (S.grab) { for (let left = Math.min(dt, 100); left > 0; left -= 16) stepGrab(now, Math.min(16, left)); }
    if (S.spin) {
      const sp = S.spin, t = Math.min(1, (now - sp.t0) / sp.dur);
      view.lon = wrapLon(sp.from + sp.total * (1 - Math.pow(1 - t, 4)));
      if (t >= 1) {
        view.lon = sp.from;
        S.spin = null;
        if (S.touring) S.tourT0 = now;   // the tour waited; give this outage its full dwell
        if (S.selected && sp.interrupted) flyTo(S.selected, 1400);   // finish the flight the spin cut short
      }
    } else if (S.flight) {
      const f = S.flight;
      const t = Math.min(1, (now - f.t0) / f.dur), e = ease(t);
      const c = f.interp(e);
      view.lon = c[0]; view.lat = c[1];
      view.zoom = (f.z0 + (f.z1 - f.z0) * e) * (1 - f.lift * Math.sin(Math.PI * e));
      if (t >= 1) S.flight = null;
    } else if (!S.dragging) {
      // Inertia after a flick, then a slow idle spin.
      if (Math.abs(S.vel.lon) > 0.0005 || Math.abs(S.vel.lat) > 0.0005) {
        coast(Math.min(dt, 100));
      } else if (!S.selected && now - S.lastInput > SPIN_RESUME_MS) {
        view.lon = wrapLon(view.lon + (CFG.spinDegPerS * dt) / 1000);
        view.lat += (18 - view.lat) * 0.0006 * dt / 16;      // drift back to a pleasant tilt
        view.zoom += (DEFAULT_ZOOM - view.zoom) * 0.002 * dt / 16;
      }
    }

    // Tour: start when idle, advance on a timer.
    const tourOff = CFG.tour === '0' && !CFG.signage;
    if (!S.touring && !tourOff && !S.guideOpen && !S.pathOpen && S.outages.length && now - S.lastInput > CFG.idleMs) setTour(true);
    if (S.touring && !S.spin) {
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
    if (o && S.pathOpen) closePath();
    const had = S.selected;
    S.selected = o;
    if (!o) { if (had) sfx('close'); el.card.hidden = true; hideFloat(); renderList(); renderTimeline(); return; }
    if (!fromTour) sfx('select');   // tour steps are silent
    fetchWeather(o.locations);
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

  // ── "From this room" (js/roomnet.js) ───────────────────────────────────
  // Live response times from this browser, each judged against its own
  // baseline, tagged when the same provider also has an outage on the globe.
  const rnRows = document.getElementById('roomNetRows'), rnStrip = document.getElementById('roomNetStrip');
  function rnOutage(term) {
    if (!S.outages.length) return null;
    const { hits } = watchMatches(term);
    return hits.some((o) => o.active) ? 'active' : hits.length ? 'recent' : null;
  }
  function rnSpark(p) {
    const pts = p.samples.map((x) => x.ms);
    const vals = pts.filter((v) => v != null);
    if (vals.length < 2) return '<svg class="rn-spark" viewBox="0 0 56 14"></svg>';
    const max = Math.max(...vals) * 1.1, min = Math.min(...vals) * 0.9, n = Math.max(pts.length - 1, 1);
    let d = '', pen = false;
    pts.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      const x = (i / n) * 56, y = 13 - ((v - min) / (max - min || 1)) * 12;
      d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); pen = true;
    });
    return `<svg class="rn-spark" viewBox="0 0 56 14" preserveAspectRatio="none"><path d="${d}"/></svg>`;
  }
  /** "Your services": one row per watched service, combining its Internet
   *  Insights status (outages on the globe) with this room's live connection
   *  to it (latency, sparkline, HTTP result). The dot is the worse of the two. */
  const LEVEL = { ok: 0, warn: 1, bad: 2 };
  function probeFor(term, probes) {
    const t = term.toLowerCase();
    const alias = { aws: 'amazon', teams: 'microsoft' }[t] || t;
    return probes.find((p) => p.term === alias) || null;
  }
  function renderRoomNet(probes) {
    probes = probes || (window.RoomNet && window.RoomNet.probes) || [];
    const ms = (p) => (!p ? '\u2014' : p.last == null ? (p.status === 'pending' ? '\u2026' : 'no reply') : Math.round(p.last) + ' ms');
    const code = (p) => (p && p.code ? `<span class="rn-code rn-c${String(p.code)[0]}">${p.code} ${esc(p.reason || '')}</span>` : '<span class="rn-code">\u2014</span>');
    const rows = CFG.watch.map((term) => {
      const { preset, hits } = watchMatches(term);
      const p = probeFor(term, probes);
      const active = hits.some((o) => o.active);
      const ii = active ? 'active' : hits.length ? 'recent' : 'clear';
      const iiText = active ? 'active outage' : hits.length ? `${hits.length} in 24h` : 'clear';
      const iiLvl = active ? 'bad' : hits.length ? 'warn' : 'ok';
      const netLvl = p ? ({ slow: 'bad', down: 'bad', warn: 'warn' }[p.status] || 'ok') : 'ok';
      const lvl = LEVEL[iiLvl] >= LEVEL[netLvl] ? iiLvl : netLvl;
      const title = p ? `${p.what} - ${new URL(p.url).host}` + (p.baseline ? ` - usually ~${Math.round(p.baseline)} ms` : '') + ' - tap for path' : 'no local probe';
      return { term, label: preset.label, p, ii, iiText, lvl, title, idx: p ? probes.indexOf(p) : -1, hits: hits.length };
    });
    rnRows.innerHTML = rows.map((r) => `<div class="svc svc-${r.lvl}" ${r.idx >= 0 ? `data-i="${r.idx}"` : ''} title="${esc(r.title)}">`
      + `<i class="svc-dot"></i>`
      + `<div class="svc-main"><span class="svc-name">${esc(r.label)}</span>`
      + `<button class="svc-ii ii-${r.ii}" data-term="${esc(r.term)}"${r.hits ? ' title="tap to view the outage"' : ''}>${esc(r.iiText)}</button></div>`
      + `${r.p ? rnSpark(r.p) : '<span></span>'}<b class="svc-ms">${ms(r.p)}</b>${code(r.p)}</div>`).join('');
    rnStrip.innerHTML = rows.filter((r) => r.p).map((r) => `<span class="rn-chip svc-${r.lvl}" data-i="${r.idx}"><i class="svc-dot"></i>${esc(r.label)} <b>${ms(r.p)}</b></span>`).join('');
  }

  // ── Path trace (click a "From this room" row) ──────────────────────────
  // MTR from a Globalping probe on this room's ISP (js/pathtrace.js), drawn on
  // the globe from the probe through the geolocated hops to the service.
  const pathCard = document.getElementById('pathCard');
  const pathTitle = document.getElementById('pathTitle'), pathMeta = document.getElementById('pathMeta'), pathBody = document.getElementById('pathBody');
  let pathRun = 0;
  function openPath(p) {
    if (!window.PathTrace) return;
    const run = ++pathRun;
    userInput(); select(null); setTour(false);
    S.pathOpen = true; S.path = null;
    sfx('select');
    const host = new URL(p.url).host;
    pathTitle.textContent = `Path to ${p.name}`;
    pathMeta.textContent = host;
    pathBody.innerHTML = '<div class="pc-status">Starting\u2026</div>';
    pathCard.hidden = false;
    window.PathTrace.run(host, (msg) => { if (run === pathRun) pathBody.innerHTML = `<div class="pc-status">${esc(msg)}</div>`; })
      .then((r) => { if (run === pathRun) showPath(p, r); })
      .catch((e) => { if (run === pathRun) pathBody.innerHTML = `<div class="pc-status pc-err">Trace failed: ${esc(e.message || e)}</div>`; });
  }
  function closePath() {
    pathRun++; S.pathOpen = false; S.path = null;
    if (!pathCard.hidden) sfx('close');
    pathCard.hidden = true;
  }
  // Link colouring thresholds (added latency, ms): amber at half, red at full.
  const PATH_HIGH = Math.max(5, num('pathhigh', 30));
  const linkClass = (d) => (d == null ? 'pv-silent' : d >= PATH_HIGH ? 'pv-bad' : d >= PATH_HIGH / 2 ? 'pv-warn' : 'pv-ok');
  const shortHost = (h) => (h.host ? h.host.split('.')[0] : h.ip || '*');

  /** ThousandEyes-style path visualization: source -> hops -> destination,
   *  links labelled with the latency each adds, red/amber when high, red rings
   *  on hops with loss, dashed grey for hops that don't answer, and bands
   *  grouping consecutive hops on the same network. */
  function pathSvg(r, availW) {
    const all = [{ kind: 'src', label: 'Probe', sub: r.probe.city || '', avg: 0, loss: 0, asn: r.probe.asn, org: r.probe.network }]
      .concat(r.hops.map((h, i) => ({
        kind: i === r.hops.length - 1 ? 'dst' : h.ip ? 'hop' : 'silent',
        label: i === r.hops.length - 1 ? r.target.host.split('.')[0] : shortHost(h), sub: h.city || '',
        avg: h.avg, loss: h.ip ? h.loss : null, asn: h.asn, org: h.org, ip: h.ip, host: h.host,
      })));
    // Runs of silent hops collapse into one "* xN" node.
    const nodes = [];
    for (const n of all) {
      const prev = nodes[nodes.length - 1];
      if (n.kind === 'silent' && prev && prev.kind === 'silent') { prev.count = (prev.count || 1) + 1; prev.label = '* \u00D7' + prev.count; continue; }
      nodes.push(n);
    }
    // Space the nodes to fit the card; stagger labels when they get close.
    const X0 = 40, Y = 70;
    const fit = availW && nodes.length > 1 ? (availW - X0 * 2) / (nodes.length - 1) : 90;
    const GAP = Math.max(46, Math.min(110, fit));
    const stagger = GAP < 84;
    const W = X0 * 2 + GAP * (nodes.length - 1), H = stagger ? 168 : 146;
    const xs = nodes.map((_, i) => X0 + i * GAP);
    // Width 100% + viewBox: if the minimum spacing still overflows, it scales down instead of scrolling.
    let out = `<svg class="pv" viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:auto" role="img" aria-label="Path visualization">`;
    // Network bands: hops without an ASN (private LAN hops, silent hops)
    // belong to the network around them, so each network is one band.
    const bandAsn = [];
    nodes.forEach((n, k) => { bandAsn[k] = n.asn || bandAsn[k - 1] || null; });
    for (let k = nodes.length - 1; k >= 0; k--) if (!nodes[k].asn && bandAsn[k] !== bandAsn[k + 1] && bandAsn[k + 1] && !bandAsn[k]) bandAsn[k] = bandAsn[k + 1];
    let i = 0;
    while (i < nodes.length) {
      const a = bandAsn[i];
      let j = i;
      while (j + 1 < nodes.length && bandAsn[j + 1] === a) j++;
      if (a) {
        const x1 = xs[i] - GAP * 0.42, x2 = xs[j] + GAP * 0.42;
        const name = (nodes.slice(i, j + 1).find((n) => n.org) || {}).org || '';
        out += `<rect class="pv-band" x="${x1}" y="18" width="${x2 - x1}" height="${H - 26}" rx="10"/>`
          + `<text class="pv-band-t" x="${(x1 + x2) / 2}" y="32">${esc((name.split(/[ ,]/)[0] || 'AS') + ' \u00B7 AS' + a)}</text>`;
      }
      i = j + 1;
    }
    // Links, labelled with the latency added since the previous answering hop.
    let lastAvg = 0, lastIdx = 0;
    for (let k = 1; k < nodes.length; k++) {
      const n = nodes[k], silent = n.kind === 'silent' || nodes[k - 1].kind === 'silent' || n.avg == null;
      const delta = n.avg != null ? Math.max(0, n.avg - lastAvg) : null;
      const cls = silent && n.avg == null ? 'pv-silent' : linkClass(delta);
      out += `<line class="pv-link ${cls}" x1="${xs[k - 1] + 12}" y1="${Y}" x2="${xs[k] - 12}" y2="${Y}"/>`;
      if (n.avg != null) {
        const mx = (xs[lastIdx] + xs[k]) / 2;
        out += `<text class="pv-lat ${cls}" x="${mx}" y="${Y - 14}">+${delta.toFixed(delta < 10 ? 1 : 0)} ms</text>`;
        lastAvg = n.avg; lastIdx = k;
      }
    }
    // Nodes
    nodes.forEach((n, k) => {
      const x = xs[k];
      const lossy = n.loss != null && n.loss > 0 && n.loss < 100;
      const cls = `pv-node pv-${n.kind}${lossy ? ' pv-lossy' : ''}`;
      const title = esc([n.host || n.ip || '', n.org, n.sub, n.avg != null ? n.avg.toFixed(1) + ' ms' : '', n.loss != null ? Math.round(n.loss) + '% loss' : ''].filter(Boolean).join(' · '));
      out += `<g class="${cls}"><title>${title}</title>`;
      if (n.kind === 'src') out += `<rect x="${x - 11}" y="${Y - 11}" width="22" height="22" rx="5"/>`;
      else out += `<circle cx="${x}" cy="${Y}" r="${n.kind === 'silent' ? 7 : 11}"/>`;
      if (lossy) out += `<circle class="pv-ring" cx="${x}" cy="${Y}" r="17"/>`;
      const ly = Y + 30 + (stagger && k % 2 ? 24 : 0), maxc = stagger ? 16 : 14;
      out += `<text class="pv-l1" x="${x}" y="${ly}">${esc(n.label.slice(0, maxc))}</text>`
        + `<text class="pv-l2" x="${x}" y="${ly + 13}">${esc(lossy ? Math.round(n.loss) + '% loss' : (n.sub || '').slice(0, maxc))}</text></g>`;
    });
    return out + '</svg>';
  }

  function showPath(p, r) {
    const scopeTxt = { isp: `on ${r.room.org || 'your ISP'} (same ISP as this room)`, city: `in ${r.room.city} (same city)`, country: `in ${r.room.country}`, any: 'elsewhere' }[r.scope];
    const last = r.hops[r.hops.length - 1];
    pathMeta.innerHTML = `${esc(r.target.host)} &middot; ${esc(r.target.ip || '')} &middot; `
      + `MTR (TCP 443) from a Globalping probe in ${esc([r.probe.city, r.probe.state].filter(Boolean).join(', '))} &mdash; ${esc(scopeTxt)}`
      + (last && last.avg != null ? ` &middot; <b>end to end ~${Math.round(last.avg)} ms over ${r.hops.length} hops</b>` : '');
    pathBody.innerHTML = `<div class="pc-viz">${pathSvg(r, pathBody.clientWidth)}</div>`
      + `<div class="pc-legend"><span class="lg-ok">+&lt;${PATH_HIGH / 2} ms</span><span class="lg-warn">+${PATH_HIGH / 2}–${PATH_HIGH} ms</span><span class="lg-bad">+${PATH_HIGH}+ ms</span><span class="lg-loss">loss</span><span class="lg-silent">no reply</span></div>`
      + '<details class="pc-details"><summary>Hop details</summary>'
      + '<table class="pc-hops"><tr><th>#</th><th>hop</th><th>network</th><th>where</th><th>avg</th><th>loss</th></tr>'
      + r.hops.map((h) => `<tr class="${h.ip ? '' : 'pc-silent'}"><td>${h.n}</td>`
        + `<td title="${esc(h.ip || '')}">${esc(h.host || h.ip || '* (no reply)')}</td>`
        + `<td>${h.asn ? 'AS' + h.asn + ' ' : ''}${esc(h.org || '')}</td><td>${esc([h.city, h.country].filter(Boolean).join(', '))}</td>`
        + `<td>${h.avg != null ? h.avg.toFixed(1) + ' ms' : '-'}</td><td class="${h.loss > 0 && h.loss < 100 ? 'pc-loss' : ''}">${h.loss != null ? Math.round(h.loss) + '%' : '-'}</td></tr>`).join('')
      + '</table><div class="pc-note">Loss at middle hops is often a router deprioritising trace replies rather than real packet loss; loss that carries through to the destination is what matters.</div></details>';
    // Globe: probe -> located hops -> service, keeping each point's latency and
    // loss so segments and rings use the same colours as the diagram.
    const pts = [{ lon: r.probe.lon, lat: r.probe.lat, label: r.probe.city || 'probe', kind: 'start', avg: 0, loss: 0 }];
    for (const h of r.hops) {
      if (h.lat == null) continue;
      const prev = pts[pts.length - 1];
      if (d3.geoDistance([prev.lon, prev.lat], [h.lon, h.lat]) * 6371 < 40) {
        if (h.avg != null) prev.avg = h.avg;
        if (h.loss > 0 && h.loss < 100) prev.loss = Math.max(prev.loss || 0, h.loss);
        continue;
      }
      pts.push({ lon: h.lon, lat: h.lat, label: h.city || '', avg: h.avg, loss: h.loss > 0 && h.loss < 100 ? h.loss : 0 });
    }
    const end = pts[pts.length - 1];
    end.kind = 'end';
    end.label = (end.label ? end.label + ' · ' : '') + p.name;
    if (last && last.avg != null) end.avg = last.avg;
    S.path = { pts };
    flyTo({ locations: pts.map((q) => ({ lon: q.lon, lat: q.lat })) }, 1800);
  }
  function drawPath(now, R) {
    if (!S.path) return;
    const pts = S.path.pts, k = Math.max(0.7, Math.min(1.6, R / 430));
    const COL = { 'pv-ok': '52,211,153', 'pv-warn': '251,191,36', 'pv-bad': '244,63,94' };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.font = `700 ${Math.round(11 * k)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    let prevAvg = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const delta = b.avg != null ? Math.max(0, b.avg - (a.avg != null ? a.avg : prevAvg)) : null;
      if (a.avg != null) prevAvg = a.avg;
      const rgb = COL[linkClass(delta)] || '148,163,184';
      for (const [w, al, dash] of [[6, 0.22, null], [2.2, 0.95, [7 * k, 7 * k]]]) {
        ctx.beginPath(); proj.arc([a.lon, a.lat], [b.lon, b.lat]);
        ctx.setLineDash(dash || []); ctx.lineDashOffset = -(now / 30) % 1000;
        ctx.strokeStyle = `rgba(${rgb},${al})`; ctx.lineWidth = w * k; ctx.stroke();
      }
      // Latency timer at the segment's midpoint.
      if (delta != null) {
        const m = d3.geoInterpolate([a.lon, a.lat], [b.lon, b.lat])(0.5), sm = proj.point(m[0], m[1]);
        if (sm) {
          const t = `+${Math.round(delta)} ms`, tw = ctx.measureText(t).width;
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(5,7,13,0.8)'; ctx.fillRect(sm[0] - tw / 2 - 5 * k, sm[1] - 9 * k, tw + 10 * k, 18 * k);
          ctx.fillStyle = `rgb(${rgb})`; ctx.fillText(t, sm[0], sm[1] + 0.5);
        }
      }
    }
    ctx.setLineDash([]);
    ctx.textAlign = 'left';
    ctx.font = `600 ${Math.round(12 * k)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    for (const q of pts) {
      const s2 = proj.point(q.lon, q.lat);
      if (!s2) continue;
      const big = q.kind === 'start' || q.kind === 'end';
      ctx.fillStyle = q.kind === 'end' ? '#16bdeb' : q.kind === 'start' ? '#34d399' : '#cbd5e1';
      if (q.kind === 'start') ctx.fillRect(s2[0] - 6 * k, s2[1] - 6 * k, 12 * k, 12 * k);
      else { ctx.beginPath(); ctx.arc(s2[0], s2[1], (big ? 6 : 4) * k, 0, 2 * Math.PI); ctx.fill(); }
      if (q.loss > 0) {   // red ring on loss, pulsing gently
        const pr = (big ? 11 : 9) * k + Math.sin(now / 300) * 1.5 * k;
        ctx.strokeStyle = '#f43f5e'; ctx.lineWidth = 2.5 * k;
        ctx.beginPath(); ctx.arc(s2[0], s2[1], pr, 0, 2 * Math.PI); ctx.stroke();
      }
      if (big && q.label) {
        const tw = ctx.measureText(q.label).width;
        ctx.fillStyle = 'rgba(5,7,13,0.75)'; ctx.fillRect(s2[0] + 12 * k, s2[1] - 10 * k, tw + 10 * k, 20 * k);
        ctx.fillStyle = '#e6edf7'; ctx.fillText(q.label, s2[0] + 17 * k, s2[1] + 0.5);
      }
    }
    ctx.restore();
  }
  document.getElementById('pathClose').addEventListener('click', () => { userInput(); closePath(); });
  [rnRows, rnStrip].forEach((elx) => elx.addEventListener('click', (e) => {
    // The Internet Insights status jumps to that provider's outage (active
    // first, then latest); the rest of the row opens the path trace.
    const ii = e.target.closest('.svc-ii');
    if (ii) {
      e.stopPropagation(); userInput(); sfx('tap');
      const { preset, hits } = watchMatches(ii.dataset.term);
      const o = hits.slice().sort((a, b) => (b.active - a.active) || (b.start - a.start))[0];
      if (o) { closePath(); select(o); } else toast(`${preset.label}: no outages in the last 24 hours`);
      return;
    }
    const t = e.target.closest('[data-i]');
    const probes = window.RoomNet && window.RoomNet.probes;
    if (t && probes) openPath(probes[+t.dataset.i]);
  }));

  /** End of the data's 24 h window: when it was published (or now). */
  function dataNow() {
    const g = S.data && Date.parse(S.data.generatedAt);
    return g && isFinite(g) ? Math.min(Date.now(), g) : Date.now();
  }

  function renderTimeline() {
    const svg = el.timeline;
    // The window ends when the data was published, not "now": if refreshes
    // ever stall, the last 24 hours of data still fill the timeline.
    const W = 1000, H = 100, BINS = 48, now = dataNow(), span = 24 * 3600e3;
    const bins = Array.from({ length: BINS }, () => ({ network: 0, application: 0 }));
    for (const o of S.outages) {
      const i = Math.floor((o.start - (now - span)) / (span / BINS));
      if (i >= 0 && i < BINS) bins[i][o.kind]++;
    }
    const max = Math.max(1, ...bins.map((b) => b.network + b.application));
    const bw = W / BINS;
    // While scrubbing, bars near the scrub time stay bright and the rest fade.
    const near = (i) => S.timeFocus == null
      || Math.abs((now - span) + (i + 0.5) * (span / BINS) - S.timeFocus) <= SCRUB_WINDOW_MS + span / BINS / 2;
    let out = '';
    bins.forEach((b, i) => {
      const hn = (b.network / max) * (H - 6), ha = (b.application / max) * (H - 6);
      const x = (i * bw + 1.5).toFixed(1), w = (bw - 3).toFixed(1);
      const op = near(i) ? '.85' : '.25';
      if (hn) out += `<rect x="${x}" y="${(H - hn).toFixed(1)}" width="${w}" height="${hn.toFixed(1)}" rx="2" fill="${COLORS.network}" opacity="${op}"/>`;
      if (ha) out += `<rect x="${x}" y="${(H - hn - ha).toFixed(1)}" width="${w}" height="${ha.toFixed(1)}" rx="2" fill="${COLORS.application}" opacity="${op}"/>`;
      if (!hn && !ha) out += `<rect x="${x}" y="${H - 2}" width="${w}" height="2" rx="1" fill="rgba(148,163,184,.18)"/>`;
    });
    if (S.selected && S.timeFocus == null) {
      const x = ((S.selected.start - (now - span)) / span) * W;
      out += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="-4" y2="${H}" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke"/>`
        + `<circle cx="${x.toFixed(1)}" cy="-4" r="5" fill="#fff"/>`;
    }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = out;
  }

  // ── Timeline scrubbing ───────────────────────────────────────────────────
  // Drag (or tap) along the timeline: a line + time label follow the finger,
  // the globe and bars dim everything that didn't start near that time, and
  // releasing selects the outage nearest to it.
  const SCRUB_WINDOW_MS = 30 * 60e3;
  const tlChart = document.getElementById('tlChart'), tlScrub = document.getElementById('tlScrub'), tlLabel = document.getElementById('tlScrubLabel');
  let scrubbing = false;
  function scrubTimeAt(clientX) {
    const r = el.timeline.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return { t: dataNow() - 24 * 3600e3 + f * 24 * 3600e3, x: clientX - tlChart.getBoundingClientRect().left };
  }
  function nearestOutage(t) {
    let best = null, bd = Infinity;
    for (const o of S.outages) {
      if (!outageVisible(o)) continue;
      const d = Math.abs(o.start - t);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  function scrubTo(clientX) {
    const { t, x } = scrubTimeAt(clientX);
    S.timeFocus = t;
    // Start drifting toward the nearest outage (keeping any current velocity).
    const target = nearestOutage(t);
    if (target) {
      const fr = framing(target);
      S.follow = S.follow || { vlon: 0, vlat: 0, vz: 0 };
      S.follow.lon = fr.lon; S.follow.lat = fr.lat; S.follow.zoom = fr.zoom;
    }
    const count = S.outages.filter((o) => outageVisible(o) && Math.abs(o.start - t) <= SCRUB_WINDOW_MS).length;
    const n = nearestOutage(t);
    tlScrub.hidden = false;
    tlScrub.style.left = x + 'px';
    tlLabel.textContent = `${new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(t)} \u00B7 ${count} outage${count === 1 ? '' : 's'}`
      + (n && Math.abs(n.start - t) <= SCRUB_WINDOW_MS ? ` \u00B7 ${n.name}${n.locations[0] ? ', ' + n.locations[0].label : ''}` : '');
    // Keep the label on screen near the ends; the line itself stays exact.
    const cw = tlChart.clientWidth, lw = tlLabel.offsetWidth;
    const shift = Math.max(lw / 2 - x, Math.min(0, cw - x - lw / 2));
    tlLabel.style.transform = `translateX(calc(-50% + ${shift}px))`;
    renderTimeline();
  }
  tlChart.addEventListener('pointerdown', (e) => {
    scrubbing = true; userInput();
    S.flight = null; S.spin = null; S.vel.lon = S.vel.lat = 0;
    S.follow = { vlon: 0, vlat: 0, vz: 0, lon: null };
    try { tlChart.setPointerCapture(e.pointerId); } catch (_) { /* */ }
    scrubTo(e.clientX);
  });
  tlChart.addEventListener('pointermove', (e) => { if (scrubbing) { S.lastInput = performance.now(); scrubTo(e.clientX); } });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    const { t } = scrubTimeAt(e.clientX);
    S.timeFocus = null;
    S.follow = null;   // the fly-to takes over from wherever the drift got to
    tlScrub.hidden = true;
    const n = nearestOutage(t);
    if (n) { closePath(); select(n); } else renderTimeline();
  };
  tlChart.addEventListener('pointerup', endScrub);
  tlChart.addEventListener('pointercancel', endScrub);

  let toastTimer = 0;
  function toast(msg, kind) {
    el.toast.textContent = msg; el.toast.hidden = false;
    el.toast.classList.toggle('info', kind === 'info');
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

    renderStats(); renderList(); renderTimeline(); renderRoomNet();

    // Something new since the last refresh: call it out and go there.
    if (!firstLoad && fresh.length) {
      const o = fresh.sort((a, b) => b.start - a.start)[0];
      toast(`New ${o.kind} outage: ${o.name} · ${o.locations[0].name}`);
      sfx('alert');
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
    S.spin = null;   // grabbing the globe catches it mid-spin
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
    S.vel.lon += ((-dx * degPerPx) / dt - S.vel.lon) * 0.6; S.vel.lat += ((dy * degPerPx) / dt - S.vel.lat) * 0.6;
    capSpin();
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
        sfx('zoom');
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
    else if (down) releaseFling();
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
  document.getElementById('zoomReset').addEventListener('click', () => { userInput(); select(null); zoomTo(DEFAULT_ZOOM, [view.lon, 18]); sfx('reset'); });
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
    sfx('tap');
    userInput();
    S.filter = c.dataset.filter;
    document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    if (S.selected && !outageVisible(S.selected)) select(null);
    renderList();
  }));

  el.cardClose.addEventListener('click', () => { userInput(); select(null); });
  el.tourBtn.addEventListener('click', () => {
    const on = !S.touring;
    sfx(on ? 'on' : 'off');
    S.lastInput = now();
    setTour(on);
    if (!on) S.lastInput = now();
  });

  // Redraw in the same task as the resize: a resized canvas is blank until it
  // is drawn again, and waiting for the next frame can show that as a flash.
  /** Resize and redraw in the same task, so the wiped canvas is never shown. */
  function resizeAndDraw() {
    resize();
    try {
      ctx.setTransform(S.pr, 0, 0, S.pr, 0, 0);
      if (!glr) drawSky();
      drawGlobe(performance.now(), layout());
    } catch (e) { /* the next frame will draw */ }
  }
  window.addEventListener('resize', resizeAndDraw);

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
    let camWasOn = false;
    window.Glass.onState((state, detail) => {
      if (state === 'face' || state === 'motion') { if (!camWasOn) sfx('camOn'); camWasOn = true; }
      else if (state === 'off') { if (camWasOn) sfx('camOff'); camWasOn = false; }
      else if (state === 'error') { sfx('error'); camWasOn = false; }
      // Render resolution follows the camera (1x while it's on).
      if (S.camOn !== camWasOn) { S.camOn = camWasOn; resizeAndDraw(); }
      const on = state === 'starting' || state === 'face' || state === 'motion';
      glassBtn.setAttribute('aria-pressed', String(on));
      glassBtn.classList.toggle('busy', state === 'starting');
      sheen.classList.toggle('on', state === 'face' || state === 'motion');
      camChip.hidden = !(state === 'face' || state === 'motion');
      setHud(state === 'face' || state === 'motion' ? 'dormant' : 'off');
      // The gesture guide opens with the camera; the palm hold (or ✕) closes it.
      // (v2 has no guide yet - it's a different scheme; the info line is hidden too.)
      if ((state === 'face' || state === 'motion') && window.Glass.version === 'v1') openGuide();
      else if (state === 'off' || state === 'error') { if (S.guideOpen) closeGuide(); }
      if (state === 'face') toast('Gestures Enabled', 'info');
      else if (state === 'motion') toast('Gestures Enabled', 'info');
      else if (state === 'error') toast(detail);
    });
    // Air swipe: spin the world three full turns in the swipe's direction,
    // launched hard and coasting to a stop exactly where it started.
    // Fist grab. One fist: the globe follows it, like dragging with a finger.
    // Two fists: their spacing zooms (apart = in) and their midpoint still
    // turns the globe. Hand results arrive at ~10-15 Hz, so movement is queued
    // and eased in per frame; letting go flings with the fist's last velocity.
    const GRAB_PAN = num('grabpan', 1.6);   // screen widths of drag per frame-width of fist travel
    let grabZoom0 = 1;
    window.Glass.onGrab((state, info) => {
      const now = performance.now();
      if (state === 'start' || state === 'mode') {
        if (state === 'start') {
          // A swipe spin or flight in progress hands over its motion as momentum.
          if (S.spin || S.flight) { S.spin = null; S.flight = null; S.vel.lon = S.vel.lat = 0; }
          userInput();
          S.grab = { lon: view.lon, lat: view.lat, vlon: 0, vlat: 0, t: now, every: 150 };
          S.dragging = true;
        }
        grabZoom0 = S.grabTarget || view.zoom;
        S.grabTarget = info.mode === 'zoom' ? grabZoom0 : null;
      } else if (state === 'move' && S.grab) {
        S.lastInput = now;
        const g = S.grab, gap = Math.max(30, now - g.t);
        if (gap > grabLate(g)) {
          // The fist is back after a gap: take hold again from where the globe
          // has coasted to, at its current speed - no snapping back.
          g.lon = view.lon; g.lat = view.lat; g.vlon = S.vel.lon; g.vlat = S.vel.lat;
        }
        g.every += (Math.min(400, gap) - g.every) * 0.3;
        if (info.rejected) {
          // Too fast to trust: carry on at the hand's last known speed.
          g.lon = wrapLon(g.lon + g.vlon * gap); g.lat = clampLat(g.lat + g.vlat * gap);
        } else {
          const degPerPx = 180 / (Math.PI * layout().base * view.zoom);
          const dLon = -info.dx * S.w * GRAB_PAN * degPerPx, dLat = info.dy * S.w * GRAB_PAN * degPerPx;
          g.lon = wrapLon(g.lon + dLon); g.lat = clampLat(g.lat + dLat);
          const sLon = dLon / gap, sLat = dLat / gap;
          // The hand clearly slowed or stopped: brake now (no smoothing), and if
          // the globe already carried on past it, settle there rather than be
          // pulled back - a hand on a real globe doesn't drag it backwards.
          const sp = Math.hypot(sLon, sLat), was = Math.hypot(g.vlon, g.vlat);
          if (sp < was * 0.35) {
            g.vlon = sLon; g.vlat = sLat;
            if (wrapLon(g.lon - view.lon) * S.vel.lon < 0) g.lon = view.lon;
            if ((g.lat - view.lat) * S.vel.lat < 0) g.lat = view.lat;
          } else {
            g.vlon += (sLon - g.vlon) * 0.6; g.vlat += (sLat - g.vlat) * 0.6;
          }
        }
        g.t = now;
        if (info.mode === 'zoom') S.grabTarget = clampZoom(grabZoom0 * Math.pow(info.ratio, 1.4));
      } else if (state === 'end') {
        // Let go: the globe simply keeps the momentum it has (see coast()).
        S.grab = null;
        S.dragging = false;
        S.grabTarget = null;
        releaseFling();
      }
      if (state === 'start') sfx('grab');
      if (state === 'end') { sfx('release'); setHud(window.Glass.armed ? 'ready' : 'dormant'); }
      else setHud(info.mode === 'zoom' ? 'zoom' : 'drag');
    });
    // Gesture mini-HUD (top centre): one badge that tells the whole story.
    //   dormant - camera on, gestures paused: grey hand, "Ready"
    //   hold    - palm being held: the ring fills
    //   ready   - armed: green hand, "Ready"
    //   drag / zoom - a fist grab in progress
    const gestureEl = document.getElementById('gesture');
    const gestureRing = document.getElementById('gestureRing');
    const gestureLabel = document.getElementById('gestureLabel');
    function setHud(state, progress) {
      if (state === 'off') { gestureEl.className = 'gesture'; return; }
      const cls = { dormant: 'dormant', hold: 'dormant holding', ready: 'ready', drag: 'ready active drag', zoom: 'ready active zoom',
        next: 'ready active pinch', prev: 'ready active pinch' }[state];
      gestureEl.className = 'gesture show ' + cls;
      gestureRing.style.strokeDashoffset = String(state === 'dormant' ? 100 : state === 'hold' ? 100 - (progress || 0) * 100 : 0);
      clearTimeout(setHud.t);
      if (state === 'next' || state === 'prev') {
        // A pinch flashes briefly, then the badge returns to Ready.
        setHud.t = setTimeout(() => setHud(window.Glass.armed ? 'ready' : 'dormant'), 800);
      }
      gestureLabel.textContent = state === 'next' ? 'Next' : state === 'prev' ? 'Previous' : state === 'drag' ? 'Drag'
        : state === 'zoom' ? `Zoom \u00D7${(S.grabTarget || view.zoom).toFixed(1)}`
        : state === 'ready' ? 'Ready' : 'Lift palm to activate';
    }
    // Gesture guide: opened from the "Tap here for Gesture Info" line under the
    // paused badge. The tour waits while it's open.
    const guide = document.getElementById('guide');
    const openGuide = () => { userInput(); if (guide.hidden) sfx('open'); guide.hidden = false; S.guideOpen = true; };
    const closeGuide = () => { if (!guide.hidden) sfx('close'); guide.hidden = true; S.guideOpen = false; userInput(); };
    document.getElementById('gestureInfoBtn').addEventListener('click', (e) => { e.stopPropagation(); openGuide(); });
    document.getElementById('guideClose').addEventListener('click', closeGuide);
    guide.addEventListener('click', (e) => { if (e.target === guide) closeGuide(); });
    window.Glass.onGesture((state, progress) => {
      if (state === 'hold') setHud('hold', progress);
      else if (state === 'armed') { sfx('ready'); setHud('ready'); if (S.guideOpen) closeGuide(); }
      else { if (state === 'paused') sfx('pause'); setHud('dormant'); }   // cancel / paused
      camChip.classList.toggle('armed', state === 'armed');
      if (state === 'armed' || state === 'paused') camChip.lastChild.textContent = state === 'armed' ? 'CAMERA \u00B7 GESTURES' : 'CAMERA';
    });
    // Pinch (experimental): right hand = next outage, left hand = previous,
    // in the same order as the outage list.
    if (window.Glass.onPinch) window.Glass.onPinch((hand) => {
      const list = S.outages.filter(outageVisible).slice().sort((a, b) => (b.active - a.active) || (b.start - a.start));
      if (!list.length) return;
      userInput();
      const i = list.indexOf(S.selected);
      const step = hand === 'right' ? 1 : -1;
      const next = i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length;
      setHud(step > 0 ? 'next' : 'prev');
      sfx(step > 0 ? 'next' : 'prev');
      select(list[next]);
    });
    // Hand cursor (gestures v2): a translucent hand follows the open palm; its
    // centre dot is the pointer. A pinch clicks under the dot at once -
    // the same pointer events a finger tap makes, so every button, row, chip,
    // timeline and globe marker works. Hand results come ~6-15 times a second;
    // the cursor glides between them.
    const handCursor = document.getElementById('handCursor');
    // Each hand in view gets a silhouette drawn from its 21 tracked points: the
    // palm as one rounded shape and each finger as a rounded stroke through its
    // joints, all in one group so the overlaps merge into a single seamless
    // shadow. The dot rides the pointer hand.
    //
    // Motion: hand results arrive only ~6-15 times a second, so the cursor is
    // drawn slightly in the past and glides between the last two samples at
    // constant speed (snapshot interpolation, as network games do), timed by
    // each frame's CAPTURE time. If the next sample is late it carries on
    // briefly at the same speed, then waits. A light final smoothing rounds the
    // corners. ?handlag= (sample intervals, default 0.9) trades smoothness for
    // latency.
    const HC_LAG = num('handlag', 0.9), HC_EXTRAP = 0.35;
    const HC_SIZE = num('handsize', 140);
    // ?handalpha= sets how visible the silhouette is (default .035; grab/arming stay a touch stronger).
    if (qs.get('handalpha')) handCursor.style.setProperty('--hc-alpha', String(num('handalpha', 0.035)));   // px from wrist to middle knuckle on screen
    const SVGNS = 'http://www.w3.org/2000/svg';
    const hcSvg = handCursor.querySelector('svg'), hcDot = handCursor.querySelector('.hc-dot');
    const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
    const hc = { x: 0, y: 0, on: false, raf: 0, t: 0, hands: new Map(), latency: 150, every: 150, lastT: 0 };
    function hcHand(key) {
      let h = hc.hands.get(key);
      if (h) return h;
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'hc-hand');
      const palm = document.createElementNS(SVGNS, 'polygon');
      palm.setAttribute('class', 'hc-palm');
      g.appendChild(palm);
      const fingers = FINGERS.map((_, i) => {
        const f = document.createElementNS(SVGNS, 'polyline');
        f.setAttribute('class', 'hc-finger' + (i === 0 ? ' hc-thumb' : i === 4 ? ' hc-pinky' : ''));
        g.appendChild(f);
        return f;
      });
      hcSvg.insertBefore(g, hcDot);
      h = { g, palm, fingers, x: 0, y: 0, shape: null, buf: [], fresh: true };
      hc.hands.set(key, h);
      return h;
    }
    function hcFrame(t) {
      const dt = Math.min(100, t - (hc.t || t)); hc.t = t;
      const k = 1 - Math.exp(-dt / 35);
      const rt = performance.now() - hc.latency - hc.every * HC_LAG;   // render time, in capture-time terms
      for (const h of hc.hands.values()) {
        const b = h.buf, n = b.length;
        let A = b[Math.max(0, n - 2)], B = b[n - 1];
        for (let i = n - 1; i > 0; i--) if (b[i - 1].t <= rt) { A = b[i - 1]; B = b[i]; break; }
        const span = Math.max(1, B.t - A.t);
        const u = A === B ? 1 : Math.max(0, Math.min(1 + HC_EXTRAP, (rt - A.t) / span));
        const px = A.x + (B.x - A.x) * u, py = A.y + (B.y - A.y) * u;
        const us = Math.min(1, u);   // the shape never extrapolates
        const tshape = A.shape.map((q, i) => [q[0] + (B.shape[i][0] - q[0]) * us, q[1] + (B.shape[i][1] - q[1]) * us]);
        if (!h.shape) { h.shape = tshape; h.x = px; h.y = py; }
        h.x += (px - h.x) * k; h.y += (py - h.y) * k;
        h.shape.forEach((q, i) => { q[0] += (tshape[i][0] - q[0]) * k; q[1] += (tshape[i][1] - q[1]) * k; });
        const p = h.shape;
        const pt = (i) => `${(h.x + p[i][0] * HC_SIZE).toFixed(1)},${(h.y + p[i][1] * HC_SIZE).toFixed(1)}`;
        h.palm.setAttribute('points', [0, 1, 5, 9, 13, 17].map(pt).join(' '));
        FINGERS.forEach((f, i) => h.fingers[i].setAttribute('points', f.map(pt).join(' ')));
        if (h.primary) { hc.x = h.x; hc.y = h.y; }
      }
      hcDot.setAttribute('cx', hc.x.toFixed(1)); hcDot.setAttribute('cy', hc.y.toFixed(1));
      if (t - (hc.overT || 0) > 120) {   // what's under the dot, a few times a second
        hc.overT = t;
        handCursor.classList.toggle('over', !hc.grabbing && clickable(hc.x, hc.y));
      }
      hc.raf = hc.on ? requestAnimationFrame(hcFrame) : 0;
    }
    function clickable(x, y) {
      const elx = document.elementFromPoint(x, y);
      if (!elx) return false;
      if (elx === canvas) return S.hits.some((h) => Math.hypot(h.x - x, h.y - y) < h.r);
      return !!elx.closest('button, a, li, .chip, .svc, [role="button"], #tlChart, .rn-row, [data-id]');
    }
    function clickAt(x, y) {
      const elx = document.elementFromPoint(x, y);
      if (!elx) return;
      const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y,
        pointerId: 77, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, view: window };
      elx.dispatchEvent(new PointerEvent('pointerdown', o));
      elx.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
      elx.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0 }));
    }
    if (window.Glass.onCursor) window.Glass.onCursor((c) => {
      if (!c.visible) {
        hc.on = false; handCursor.hidden = true;
        for (const h of hc.hands.values()) h.g.remove();
        hc.hands.clear();
        return;
      }
      const seen = new Set(), arrive = performance.now(), ct = c.t || arrive;
      // How far behind real time results arrive, and how often (both smoothed).
      // Latency follows the SLOW frames quickly and the fast ones only slowly,
      // so the render clock stays steady instead of wobbling with each frame.
      const lat = arrive - ct;
      hc.latency += (lat - hc.latency) * (lat > hc.latency ? 0.5 : 0.03);
      if (hc.lastT && ct > hc.lastT) hc.every += (Math.min(500, ct - hc.lastT) - hc.every) * 0.2;
      hc.lastT = ct;
      for (const d of c.hands) {
        const h = hcHand(d.key);
        seen.add(d.key);
        h.buf.push({ t: ct, x: d.x * innerWidth, y: d.y * innerHeight, shape: d.shape });
        if (h.buf.length > 4) h.buf.shift();
        h.primary = !!d.primary;
        if (h.fresh) { h.fresh = false; if (h.primary && !hc.on) { hc.x = d.x * innerWidth; hc.y = d.y * innerHeight; } }
        h.g.classList.toggle('fist', !!d.fist);
        h.g.classList.toggle('arming', !!d.fist && c.arming > 0 && !c.grabbing);   // the fist that's about to grab
      }
      for (const [key, h] of hc.hands) if (!seen.has(key)) { h.g.remove(); hc.hands.delete(key); }
      if (!hc.on) {
        hc.on = true; handCursor.hidden = false;
        if (!hc.raf) { hc.t = 0; hc.raf = requestAnimationFrame(hcFrame); }
      }
      S.lastInput = performance.now();
      handCursor.classList.toggle('grab', !!c.grabbing);
      handCursor.classList.toggle('idle', !c.armed);
      hc.grabbing = !!c.grabbing;
    });
    if (window.Glass.onClick) window.Glass.onClick(() => {
      const x = hc.x, y = hc.y;
      handCursor.classList.remove('clicked'); void handCursor.offsetWidth; handCursor.classList.add('clicked');
      sfx('tap');
      userInput();
      clickAt(x, y);
    });
    if (window.Glass.version !== 'v1') document.getElementById('gestureInfoBtn').hidden = true;
    window.Glass.onSwipe((dir) => {
      showSwipe(dir);
      sfx('whoosh');
      spinTurns(dir === 'left' ? 3 : -3);   // swipe left = surface moves left = east comes round
    });
    // Tap: camera on/off. Press and hold (~0.6 s): camera debug view on/off
    // (turning the camera on too if needed) - for tuning on the device itself.
    let holdTimer = 0, held = false;
    glassBtn.addEventListener('pointerdown', () => {
      held = false;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        held = true;
        const on = !window.Glass.debug;
        window.Glass.setDebug(on);
        toast(on ? 'Camera debug view on (hold again to hide)' : 'Camera debug view off');
        sfx('tap');
      }, 600);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => glassBtn.addEventListener(t, () => clearTimeout(holdTimer)));
    glassBtn.addEventListener('contextmenu', (e) => e.preventDefault());   // touch long-press menu
    glassBtn.addEventListener('click', () => {
      userInput();
      if (held) { held = false; return; }   // that was a hold, not a tap
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
  modeBtn.addEventListener('click', () => { userInput(); setMode(!S.free); sfx('toggle'); });

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

  // ── Self-update ──────────────────────────────────────────────────────────
  // Every minute, fetch this page fresh (unique query = past every cache) and
  // compare it with what was loaded. Any deploy changes it (asset versions
  // live in the HTML), so a difference means "new version": reload once the
  // screen has been left alone for a moment.
  const UPDATE_EVERY_MS = 60000, UPDATE_IDLE_MS = 20000;
  let pageSig = null, updatePending = false;
  function sig(text) { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return h; }
  async function fetchPageSig() {
    const u = new URL(location.href); u.hash = ''; u.searchParams.set('u', Date.now());
    const r = await fetch(u.toString(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return sig(await r.text());
  }
  function reloadNow(msg) {
    try { sessionStorage.setItem('te-resume-glass', window.Glass && window.Glass.on ? '1' : ''); } catch (_) { /* */ }
    toast(msg || 'Updating\u2026', 'info');
    setTimeout(() => location.reload(), 900);
  }
  function startAutoUpdate() {
    if (qs.get('autoupdate') === '0' || location.protocol === 'file:') return;
    fetchPageSig().then((s0) => { pageSig = s0; }).catch(() => {});
    setInterval(async () => {
      if (!updatePending) {
        try {
          const s1 = await fetchPageSig();
          if (pageSig === null) pageSig = s1;
          else if (s1 !== pageSig) updatePending = true;
        } catch (_) { return; }
      }
      const idle = performance.now() - S.lastInput > UPDATE_IDLE_MS;
      const busy = (window.Glass && window.Glass.grabbing) || S.guideOpen || S.dragging;
      if (updatePending && idle && !busy) reloadNow();
    }, UPDATE_EVERY_MS);
  }
  // Manual: press and hold the ThousandEyes logo for a second.
  {
    const logo = document.querySelector('.brand-logo');
    let t = 0;
    logo.addEventListener('pointerdown', () => { clearTimeout(t); t = setTimeout(() => { sfx('tap'); reloadNow('Reloading\u2026'); }, 1000); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => logo.addEventListener(ev, () => clearTimeout(t)));
    logo.addEventListener('contextmenu', (e) => e.preventDefault());
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
    // While the camera is on, render at 30: the globe shares the GPU with the
    // hand/face models, and a slow-turning globe looks nearly the same at 30.
    const cap = window.Glass && window.Glass.on ? 30 : frameCap;
    if (cap === 30 && t - lastDraw < 1000 / 30 - 4) return;
    lastDraw = t;
    adaptScale(t);   // before drawing: a resized (wiped) canvas is redrawn this same frame
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
    perfFrame(t, work);
  }

  // Dynamic resolution, deliberately sluggish. Resizing a canvas wipes it, so
  // every change risks a visible flash; it only steps down after two straight
  // 3-second windows below ~22 fps (a one-off stall - a model loading, a GC
  // pause - can't trigger it), and only steps back up after two windows above
  // ~50 fps and at least 20 s since the last change. It runs at the START of a
  // frame, so a resized canvas is always redrawn before it's shown.
  let winT0 = 0, winFrames = 0, slowWins = 0, fastWins = 0, lastScaleChange = -Infinity;
  S.rescales = 0;
  function adaptScale(t) {
    if (FIXED_SCALE) return;
    if (!winT0) { winT0 = t; winFrames = 0; return; }
    winFrames++;
    if (t - winT0 < 3000) return;
    const fps = (winFrames * 1000) / (t - winT0);
    winT0 = t; winFrames = 0;
    if (document.hidden) { slowWins = fastWins = 0; return; }
    slowWins = fps < 22 ? slowWins + 1 : 0;
    fastWins = fps > 50 ? fastWins + 1 : 0;
    let next = S.scale;
    if (slowWins >= 2 && S.scale > 0.5) next = Math.max(0.5, S.scale * 0.8);
    else if (fastWins >= 2 && S.scale < 1 && t - lastScaleChange > 20000) next = Math.min(1, S.scale * 1.15);
    if (Math.abs(next - S.scale) > 0.01) {
      S.scale = next; slowWins = fastWins = 0; lastScaleChange = t; S.rescales++;
      resize();
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
    // Camera back on after a self-update (permission is already granted).
    let resumeGlass = false;
    try { resumeGlass = sessionStorage.getItem('te-resume-glass') === '1'; sessionStorage.removeItem('te-resume-glass'); } catch (_) { /* */ }
    if ((qs.get('glass') === '1' || resumeGlass) && window.Glass) window.Glass.start();
    startAutoUpdate();
    if (window.RoomNet) window.RoomNet.start({ onUpdate: renderRoomNet });
  })();
})();
