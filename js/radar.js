/* Live weather radar for the globe, from RainViewer (rainviewer.com).
 *
 * Free for personal, educational and small community use, no key; credit
 * "Weather data by RainViewer" must be visible (app.js shows it). Since 2026
 * the free tier is capped at zoom 7 and 100 requests a minute per IP - this
 * uses zoom 2 (16 small tiles) every 10 minutes, well inside that.
 *
 * Every 10 minutes: read the frame list, fetch the latest radar frame as Web
 * Mercator tiles, stitch them, and reproject to the plain longitude/latitude
 * layout the globe's textures use (2048 x 1024). onFrame(canvas, time) gets
 * the result; the globe draws it in its shader (glglobe.js setRadar).
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
  const TILE = 512, EVERY = 10 * 60e3;
  const OUT_W = 2048, OUT_H = 1024;

  let timer = 0, lastPath = '', onFrame = () => {}, frameTime = 0, running = false;

  const loadImg = (url) => new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';   // the tiles allow it; WebGL needs it
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('tile failed: ' + url));
    im.src = url;
  });

  async function update() {
    if (document.hidden) return;
    try {
      const idx = await (await fetch(INDEX, { cache: 'no-store' })).json();
      const frames = (idx.radar && idx.radar.past) || [];
      const f = frames[frames.length - 1];
      if (!f || f.path === lastPath) return;
      const n = 1 << Z, size = TILE * n;
      // Stitch the Mercator tiles.
      const merc = document.createElement('canvas');
      merc.width = merc.height = size;
      const mg = merc.getContext('2d');
      const jobs = [];
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
        const url = `${idx.host}${f.path}/${TILE}/${Z}/${x}/${y}/${COLOR}/1_1.png`;
        jobs.push(loadImg(url).then((im) => mg.drawImage(im, x * TILE, y * TILE)).catch(() => {}));
      }
      await Promise.all(jobs);
      // Reproject row by row: latitude -> Mercator y. Beyond +-85 deg (where
      // Mercator ends) stays clear.
      const out = document.createElement('canvas');
      out.width = OUT_W; out.height = OUT_H;
      const og = out.getContext('2d');
      og.imageSmoothingEnabled = true;
      const MAXLAT = 85.0511 * Math.PI / 180;
      for (let row = 0; row < OUT_H; row++) {
        const lat = (0.5 - (row + 0.5) / OUT_H) * Math.PI;
        if (Math.abs(lat) > MAXLAT) continue;
        const my = (0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)) * size;
        og.drawImage(merc, 0, Math.max(0, Math.min(size - 1, my - 0.5)), size, 1, 0, row, OUT_W, 1);
      }
      lastPath = f.path; frameTime = f.time * 1000;
      onFrame(out, frameTime);
    } catch (e) {
      console.warn('[radar]', e.message || e);
    }
  }

  window.Radar = {
    enabled: qs.get('radar') !== '0',
    start(fn) {
      if (fn) onFrame = fn;
      if (running) return;
      running = true; lastPath = '';
      update();
      timer = setInterval(update, EVERY);
    },
    stop() { running = false; clearInterval(timer); timer = 0; },
    get time() { return frameTime; },
  };
})();
