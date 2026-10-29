/* Live weather radar for the globe: NOAA MRMS over North America (sharp,
 * quality-controlled), RainViewer (rainviewer.com) for the rest of the world.
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
 * (default 6, NEXRAD Level III); radarus=0 skips the NOAA layer; radarz=<1-4> live tile zoom (default 3);
 * radarloopz=<1-3> past-hour zoom (default 2); radarsoft=<px> smoothing blur
 * (default 1.2, 0 = off).
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
  // Colour scheme 6 (NEXRAD Level III) matches NOAA's palette at the seam.
  const COLOR = Math.max(0, Math.min(8, parseInt(qs.get('radarcolor'), 10) || 6));
  // North America: NOAA's MRMS quality-controlled reflectivity (US public
  // domain, no key, CORS open), as one plain lon/lat image per frame - about
  // 1.9 km a pixel, five times sharper than the global layer, and free of the
  // clutter rings raw radar has. Its domain covers southern Canada too.
  const REG = qs.get('radarus') !== '0';
  const REG_BOX = [-130, 20, -60, 55];
  const REG_WMS = 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows';
  let REG_W = 4096, REG_LOOP_W = 2048;
  // Detail: zoom 3 for the live frame (4096 x 2048 on the globe), zoom 2 for
  // the past-hour loop (2048 x 1024 per frame) - four times the pixels of the
  // first version. Capped by the GPU's texture size (setMaxTex).
  let Z = Math.max(1, Math.min(4, parseInt(qs.get('radarz'), 10) || 3));
  let LOOP_Z = Math.max(1, Math.min(3, parseInt(qs.get('radarloopz'), 10) || 2));
  const SOFT = Math.max(0, parseFloat(qs.get('radarsoft') ?? '1.2') || 0);   // blur, px at 4096 wide
  const TILE = 512, EVERY = 10 * 60e3, LOOP_FRAMES = 7;
  // RainViewer's free tier allows 100 requests a minute per IP: keep a token
  // bucket of 90 a minute, so a full first load can't trip it.
  // (Requests are made in priority order by update(); low = wait for others.)
  let tokens = 90, tokenT = performance.now(), worldWaiting = 0;
  async function token(low) {
    if (!low) worldWaiting++;
    try {
      for (;;) {
        const now = performance.now();
        tokens = Math.min(90, tokens + (now - tokenT) * 90 / 60000); tokenT = now;
        if (tokens >= 1 && (!low || worldWaiting === 0)) { tokens -= 1; return; }
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally { if (!low) worldWaiting--; }
  }

  let lite = false, full = null;
  let timer = 0, lastKey = '', onFrames = () => {}, frameTime = 0, running = false, animate = false, gen = 0;
  const built = new Map();   // "path|z" -> canvas, a few dozen at most

  const loadImg = (url, low) => token(low).then(() => new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';   // the tiles allow it; WebGL needs it
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('tile failed: ' + url));
    im.src = url;
  }));

  /** The regional frame nearest a time (null = latest), or null on failure. */
  const regBuilt = new Map();
  async function region(timeMs, w) {
    const key = (timeMs || 'now') + '|' + w;
    if (timeMs && regBuilt.has(key)) return regBuilt.get(key);
    const q = new URLSearchParams({
      SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', LAYERS: 'conus_bref_qcd', STYLES: '',
      SRS: 'EPSG:4326', BBOX: REG_BOX.join(','), WIDTH: w, HEIGHT: w / 2, FORMAT: 'image/png', TRANSPARENT: 'true',
    });
    if (timeMs) q.set('TIME', new Date(timeMs).toISOString().replace(/\.\d+Z$/, 'Z'));
    const img = await new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = REG_WMS + '?' + q;
    });
    if (img && timeMs) {
      regBuilt.set(key, img);
      if (regBuilt.size > 10) regBuilt.delete(regBuilt.keys().next().value);
    }
    return img;
  }

  // Detail boxes: the UK & Ireland and Australia from RainViewer at a much
  // higher zoom than the world layer (zoom 6 / 5 - about 1.2 / 2.5 km a pixel
  // against ~10 km - for every frame, the past-hour loop too; fetched after
  // the world layer, never ahead of it), packed into one atlas image so the globe needs a single extra
  // texture. The shader lays each box over the world layer, feathered at its
  // edges, as it does with NOAA over North America. ?radardetail=0 skips it.
  const DETAIL_ON = qs.get('radardetail') !== '0';
  const DETAIL = [
    { id: 'au', box: [112, -44.5, 155, -10], z: 5, rect: [0, 0, 0.625, 1] },
    { id: 'uk', box: [-11, 49.5, 3, 61], z: 6, rect: [0.625, 0, 1, 0.6426] },
  ];
  const detBuilt = new Map();
  const mercY = (lat, size) => (0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) / (2 * Math.PI)) * size;
  async function buildDetail(host, path) {
    const key = path;
    if (detBuilt.has(key)) return detBuilt.get(key);
    const W = 2048, H = W / 2;
    const atlas = document.createElement('canvas');
    atlas.width = W; atlas.height = H;
    const ag = atlas.getContext('2d');
    await Promise.all(DETAIL.map(async (d) => {
      const z = d.z, n = 1 << z, size = TILE * n;   // full detail for every frame
      const [w, s, e, nth] = d.box;
      const x0 = Math.floor((w + 180) / 360 * n), x1 = Math.floor((e + 180) / 360 * n);
      const y0 = Math.floor(mercY(nth, n)), y1 = Math.floor(mercY(s, n));
      const st = document.createElement('canvas');
      st.width = (x1 - x0 + 1) * TILE; st.height = (y1 - y0 + 1) * TILE;
      const sg = st.getContext('2d');
      const jobs = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        jobs.push(loadImg(`${host}${path}/${TILE}/${z}/${x}/${y}/${COLOR}/1_1.png`)
          .then((im) => sg.drawImage(im, (x - x0) * TILE, (y - y0) * TILE)).catch(() => {}));
      }
      await Promise.all(jobs);
      // Reproject the box, row by row, into its rectangle of the atlas.
      const rx = d.rect[0] * W, ry = d.rect[1] * H, rw = (d.rect[2] - d.rect[0]) * W, rh = (d.rect[3] - d.rect[1]) * H;
      const sx = (w + 180) / 360 * size - x0 * TILE, sw = (e - w) / 360 * size;
      for (let row = 0; row < rh; row++) {
        const lat = nth - ((row + 0.5) / rh) * (nth - s);
        const sy = mercY(lat, size) - y0 * TILE;
        ag.drawImage(st, sx, Math.max(0, Math.min(st.height - 1, sy - 0.5)), sw, 1, rx, ry + row, rw, 1);
      }
      st.width = 0;
    }));
    let img = atlas;
    if (SOFT > 0) {
      img = document.createElement('canvas');
      img.width = W; img.height = H;
      const g2 = img.getContext('2d');
      g2.filter = `blur(${(SOFT * 0.6).toFixed(2)}px)`;   // these pixels are already ~5x finer
      g2.drawImage(atlas, 0, 0);
      atlas.width = 0;
    }
    detBuilt.set(key, img);
    if (detBuilt.size > 9) detBuilt.delete(detBuilt.keys().next().value);
    return img;
  }

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
      // The world (and NOAA) layer first, exactly as fast as before; the UK /
      // Australia detail follows behind it (newest frame first) and is
      // patched in as each frame's is ready. Built frames are cached, so after
      // the first load only the newest frame's detail is fetched.
      const known = (k) => (DETAIL_ON ? detBuilt.get(frames[k].path) || null : null);
      if (!animate) {
        const [img, reg] = await Promise.all([build(idx.host, frames[0].path, Z), REG ? region(times[0], REG_W) : null]);
        if (!running || mine !== gen) return;
        lastKey = key; onFrames([img], times, [reg], [known(0)]);
        if (DETAIL_ON && !known(0)) {
          const det = await buildDetail(idx.host, frames[0].path);
          if (!running || mine !== gen) return;
          onFrames([img], times, [reg], [det]);
        }
        return;
      }
      // The past hour, newest first: the latest frame is the live one (most
      // likely built already), shown at once; older frames join the loop as
      // they arrive, so it plays within seconds instead of after a minute.
      const imgs = new Array(frames.length).fill(null), regs = new Array(frames.length).fill(null);
      const dets = frames.map((f, k) => known(k));
      const send = () => {
        const have = imgs.map((im, k) => k).filter((k) => imgs[k]);
        onFrames(have.map((k) => imgs[k]), have.map((k) => times[k]), have.map((k) => regs[k]), have.map((k) => dets[k]));
      };
      // Order: the newest frame's world layer, then its detail (so the sharp
      // UK / Australia view shows within seconds), then the older frames'
      // world layers, then their detail.
      const newest = frames.length - 1;
      const loadDetail = async (i) => {
        if (!DETAIL_ON || dets[i]) return true;
        dets[i] = await buildDetail(idx.host, frames[i].path);
        if (!running || mine !== gen) return false;
        send();
        return true;
      };
      for (let i = newest; i >= 0; i--) {
        const last = i === newest;
        [imgs[i], regs[i]] = await Promise.all([
          build(idx.host, frames[i].path, last ? Z : LOOP_Z),
          REG ? region(times[i], last ? REG_W : REG_LOOP_W) : null,
        ]);
        if (!running || mine !== gen) return;
        send();
        if (last && !(await loadDetail(i))) return;
      }
      lastKey = key;
      for (let i = newest - 1; i >= 0; i--) if (!(await loadDetail(i))) return;
      return;
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
    /** The regional layer's bounds: [west, south, east, north]. */
    regionBox: REG_BOX,
    /** The detail boxes and where each sits in the detail atlas. */
    detail: DETAIL.map((d) => ({ box: d.box, rect: d.rect })),
    /** Debugging: the detail atlases built so far (newest last). */
    get detailBuilt() { return [...detBuilt.values()]; },
    get debugState() { return { worldWaiting, tokens: Math.round(tokens), gen, animate, running, built: built.size }; },
    regional: REG,
    /** Keep the stitched size within the GPU's maximum texture size. */
    /** Lighter frames (half the size each way) while the camera's hand
     *  tracking shares the GPU; back to full detail when it stops. */
    setLite(on) {
      if (!!on === lite) return;
      lite = !!on;
      if (lite) { full = [Z, LOOP_Z, REG_W, REG_LOOP_W]; Z = Math.max(1, Z - 1); LOOP_Z = Math.max(1, LOOP_Z - 1); REG_W = Math.max(1024, REG_W / 2); REG_LOOP_W = Math.max(1024, REG_LOOP_W / 2); }
      else if (full) [Z, LOOP_Z, REG_W, REG_LOOP_W] = full;
      lastKey = '';
      if (running) update(true);
    },
    setMaxTex(px) {
      while (Z > 1 && TILE * (1 << Z) > px) Z--;
      while (LOOP_Z > 1 && TILE * (1 << LOOP_Z) > px) LOOP_Z--;
      while (REG_W > 1024 && REG_W > px) REG_W /= 2;
      while (REG_LOOP_W > 1024 && REG_LOOP_W > px) REG_LOOP_W /= 2;
    },
  };
})();
