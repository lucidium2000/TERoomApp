/* Live weather radar for the globe, from RainViewer (rainviewer.com).
 *
 * Free for personal, educational and small community use, no key; credit
 * "Weather data by RainViewer" must be visible (app.js shows it). Since 2026
 * the free tier is capped at zoom 7 and 100 requests a minute per IP - this
 * uses zoom 3 (64 tiles) every 10 minutes, paced to stay inside that.
 *
 * Every 10 minutes: read the frame list, fetch the latest radar frame as Web
 * Mercator tiles, stitch them, and reproject to the plain longitude/latitude
 * layout the globe's textures use (4096 x 2048). onFrames(canvases, times)
 * gets the result; the globe draws it in its shader (glglobe.js).
 *
 * Animated (the past hour): the last 7 frames, 10 minutes apart, newest first
 * (the newest is the live frame; older ones at zoom 2, 16 tiles each), shown
 * as they arrive; built frames are cached, so after the first load only the
 * newest frame is fetched each update. Requests are paced (token bucket).
 *
 * URL: radar=0 hides it entirely; radarcolor=<0-8> RainViewer colour scheme
 * (default 4, The Weather Channel); radarz=<1-4> live tile zoom (default 3);
 * radarloopz=<1-3> past-hour zoom (default 2); radarsoft=<px> smoothing blur
 * (default 1.2, 0 = off).
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
  const COLOR = Math.max(0, Math.min(8, parseInt(qs.get('radarcolor'), 10) || 4));
  // Detail: zoom 3 for the live frame (4096 x 2048 on the globe), zoom 2 for
  // the past-hour loop (2048 x 1024 per frame) - four times the pixels of the
  // first version. Capped by the GPU's texture size (setMaxTex).
  let Z = Math.max(1, Math.min(4, parseInt(qs.get('radarz'), 10) || 3));
  let LOOP_Z = Math.max(1, Math.min(3, parseInt(qs.get('radarloopz'), 10) || 2));
  const SOFT = Math.max(0, parseFloat(qs.get('radarsoft') ?? '1.2') || 0);   // blur, px at 4096 wide
  const TILE = 512, EVERY = 10 * 60e3, LOOP_FRAMES = 7;
  // RainViewer's free tier allows 100 requests a minute per IP: keep a token
  // bucket of 80 a minute, so a full first load can't trip it.
  let tokens = 80, tokenT = performance.now();
  async function token() {
    for (;;) {
      const now = performance.now();
      tokens = Math.min(80, tokens + (now - tokenT) * 80 / 60000); tokenT = now;
      if (tokens >= 1) { tokens -= 1; return; }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  let timer = 0, lastKey = '', onFrames = () => {}, frameTime = 0, running = false, animate = false, gen = 0;
  const built = new Map();   // "path|z" -> canvas, a few dozen at most

  const loadImg = (url) => token().then(() => new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';   // the tiles allow it; WebGL needs it
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('tile failed: ' + url));
    im.src = url;
  }));

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
    merc.width = 0;   // free the Mercator copy
    // Soften the radar's blocky bins: a light blur, scaled to the frame's
    // size (about 1.2 px live, 0.6 px for loop frames). Done once per frame
    // here, not per pixel on the GPU.
    let img = out;
    if (SOFT > 0) {
      img = document.createElement('canvas');
      img.width = outW; img.height = outH;
      const sg = img.getContext('2d');
      sg.filter = `blur(${(SOFT * outW / 4096).toFixed(2)}px)`;
      sg.drawImage(out, 0, 0);
      out.width = 0;
    }
    built.set(key, img);
    if (built.size > 24) built.delete(built.keys().next().value);
    return img;
  }

  async function update(force) {
    if (document.hidden) return;
    const mine = ++gen;   // a newer update (e.g. after toggling animation) wins
    try {
      const idx = await (await fetch(INDEX, { cache: 'no-store' })).json();
      const all = (idx.radar && idx.radar.past) || [];
      const frames = animate ? all.slice(-LOOP_FRAMES) : all.slice(-1);
      if (!frames.length) return;
      const key = frames.map((f) => f.path).join(',') + '|' + (animate ? LOOP_Z : Z);
      if (key === lastKey && !force) return;
      const times = frames.map((f) => f.time * 1000);
      frameTime = times[times.length - 1];
      if (!animate) {
        const img = await build(idx.host, frames[0].path, Z);
        if (!running || mine !== gen) return;
        lastKey = key; onFrames([img], times);
        return;
      }
      // The past hour, newest first: the latest frame is the live one (most
      // likely built already), shown at once; older frames join the loop as
      // they arrive, so it plays within seconds instead of after a minute.
      const imgs = new Array(frames.length).fill(null);
      for (let i = frames.length - 1; i >= 0; i--) {
        imgs[i] = await build(idx.host, frames[i].path, i === frames.length - 1 ? Z : LOOP_Z);
        if (!running || mine !== gen) return;
        const have = imgs.map((im, k) => [im, times[k]]).filter((x) => x[0]);
        onFrames(have.map((x) => x[0]), have.map((x) => x[1]));
      }
      lastKey = key;
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
    /** Keep the stitched size within the GPU's maximum texture size. */
    setMaxTex(px) {
      while (Z > 1 && TILE * (1 << Z) > px) Z--;
      while (LOOP_Z > 1 && TILE * (1 << LOOP_Z) > px) LOOP_Z--;
    },
  };
})();
