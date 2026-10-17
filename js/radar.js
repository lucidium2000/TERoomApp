/* Live weather radar for the globe, from RainViewer (rainviewer.com).
 *
 * Free for personal, educational and small community use, no key; credit
 * "Weather data by RainViewer" must be visible (app.js shows it). Since 2026
 * the free tier is capped at zoom 7 and 100 requests a minute per IP - this
 * uses zoom 2 (16 small tiles) every 10 minutes, well inside that.
 *
 * Every 10 minutes: read the frame list, fetch the latest radar frame as Web
 * Mercator tiles, stitch them, and reproject to the plain longitude/latitude
 * layout the globe's textures use (2048 x 1024). onFrames(canvases, times)
 * gets the result; the globe draws it in its shader (glglobe.js).
 *
 * Animated (the past hour): the last 7 frames, 10 minutes apart, at zoom 1
 * (4 tiles each: 28 requests to start, then one new frame per update);
 * built frames are cached, so only what's new is fetched.
 *
 * URL: radar=0 hides it entirely; radarcolor=<0-8> RainViewer colour scheme
 * (default 4, The Weather Channel); radarz=<1-3> tile zoom (default 2).
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
  const COLOR = Math.max(0, Math.min(8, parseInt(qs.get('radarcolor'), 10) || 4));
  const Z = Math.max(1, Math.min(3, parseInt(qs.get('radarz'), 10) || 2));
  const TILE = 512, EVERY = 10 * 60e3, LOOP_FRAMES = 7, LOOP_Z = 1;

  let timer = 0, lastKey = '', onFrames = () => {}, frameTime = 0, running = false, animate = false, gen = 0;
  const built = new Map();   // "path|z" -> canvas, a few dozen at most

  const loadImg = (url) => new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';   // the tiles allow it; WebGL needs it
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('tile failed: ' + url));
    im.src = url;
  });

  /** One radar frame as an equirectangular canvas (cached). */
  async function build(host, path, z) {
    const key = path + '|' + z;
    if (built.has(key)) return built.get(key);
    const n = 1 << z, size = TILE * n, outW = size, outH = size / 2;
    // Stitch the Mercator tiles.
    const merc = document.createElement('canvas');
    merc.width = merc.height = size;
    const mg = merc.getContext('2d');
    const jobs = [];
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
      const url = `${host}${path}/${TILE}/${z}/${x}/${y}/${COLOR}/1_1.png`;
      jobs.push(loadImg(url).then((im) => mg.drawImage(im, x * TILE, y * TILE)).catch(() => {}));
    }
    await Promise.all(jobs);
    // Reproject row by row: latitude -> Mercator y. Beyond +-85 deg (where
    // Mercator ends) stays clear.
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const og = out.getContext('2d');
    const MAXLAT = 85.0511 * Math.PI / 180;
    for (let row = 0; row < outH; row++) {
      const lat = (0.5 - (row + 0.5) / outH) * Math.PI;
      if (Math.abs(lat) > MAXLAT) continue;
      const my = (0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)) * size;
      og.drawImage(merc, 0, Math.max(0, Math.min(size - 1, my - 0.5)), size, 1, 0, row, outW, 1);
    }
    built.set(key, out);
    if (built.size > 24) built.delete(built.keys().next().value);
    return out;
  }

  async function update(force) {
    if (document.hidden) return;
    const mine = ++gen;   // a newer update (e.g. after toggling animation) wins
    try {
      const idx = await (await fetch(INDEX, { cache: 'no-store' })).json();
      const all = (idx.radar && idx.radar.past) || [];
      const frames = animate ? all.slice(-LOOP_FRAMES) : all.slice(-1);
      if (!frames.length) return;
      const z = animate ? LOOP_Z : Z;
      const key = frames.map((f) => f.path).join(',') + '|' + z;
      if (key === lastKey && !force) return;
      // One frame at a time, so a first load never bursts past the rate limit.
      const imgs = [];
      for (const f of frames) imgs.push(await build(idx.host, f.path, z));
      if (!running || mine !== gen) return;
      lastKey = key; frameTime = frames[frames.length - 1].time * 1000;
      onFrames(imgs, frames.map((f) => f.time * 1000));
    } catch (e) {
      console.warn('[radar]', e.message || e);
    }
  }

  window.Radar = {
    enabled: qs.get('radar') !== '0',
    /** fn(images, times): the frame(s) to show, oldest first. */
    start(fn) {
      if (fn) onFrames = fn;
      if (running) return;
      running = true; lastKey = '';
      update();
      timer = setInterval(update, EVERY);
    },
    /** Loop the past hour (true) or show the latest frame (false). */
    setAnimate(on) { if (animate === on) return; animate = on; lastKey = ''; if (running) update(true); },
    get animate() { return animate; },
    stop() { running = false; clearInterval(timer); timer = 0; },
    get time() { return frameTime; },
  };
})();
