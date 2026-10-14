/* Glass mode (experimental): head-tracked parallax and lean-to-zoom.
 *
 * The device camera finds the main subject in front of the screen - a face via
 * MediaPipe's BlazeFace detector, or, if that can't load, the centroid of
 * whatever is moving - and publishes where it is. app.js shifts the scene the
 * OPPOSITE way and turns the globe toward you, so the screen reads as a pane of
 * glass with the Earth floating behind it. Moving closer zooms in.
 *
 * Detection runs in a Web Worker where possible (js/face-worker.js), so model
 * inference never blocks rendering. Frames go over as ImageBitmaps, one at a
 * time: a new frame is sent only after the last result is back, so a slow
 * device just tracks at a lower rate instead of queueing work.
 *
 * Nothing leaves the device: frames are analysed in the page and dropped.
 * The camera only starts from an explicit tap (or ?glass=1), and stops on the
 * next tap, on page hide, or if the track ends (e.g. a call takes the camera).
 *
 * Experimental arm swipe: a fast horizontal sweep of motion beside the viewer
 * (the face region is masked out, so head movement doesn't count) fires
 * onSwipe('left' | 'right'), from the viewer's point of view. ?swipe=0 disables.
 *
 * Exposes window.Glass = { start(), stop(), recalibrate(), onSwipe(fn), on, mode, pose, stats }
 *   pose.x, pose.y  -1..1, the viewer's position from THEIR point of view
 *                   (x+ = their right, y+ = up), smoothed.
 *   pose.z          log2 of (face size / size when tracking began): +1 means
 *                   the viewer is about twice as close as when they started.
 *   pose.seen       true while a subject is being tracked.
 *   stats           { hz, ms, where } for the perf overlay.
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const MP_BASE = new URL('../vendor/mediapipe/', document.currentScript.src).href;
  const WORKER_URL = new URL('face-worker.js', document.currentScript.src).href;
  const MIN_INTERVAL_MS = 50;      // never ask for more than ~20 Hz
  const BUDGET = 0.3;              // main-thread fallback: spend at most ~30% of time detecting
  const MAX_INTERVAL_MS = 250;     // ...but never track slower than 4 Hz
  const WARMUP_FRAMES = 3;         // first GPU runs compile shaders: don't let them skew timing
  const GAIN_XY = 1.8;             // head offset from centre -> -1..1 (lower = needs more movement)
  const DEADZONE_XY = 0.1;         // "play": small head movements are ignored entirely
  const DEADZONE_Z = 0.15;         // ...and small leans
  const SMOOTH_XY = 0.09;          // per-frame easing toward the measured position
  const SMOOTH_Z = 0.05;           // distance is noisier than position: ease harder
  const LOST_AFTER_MS = 1500;      // no subject for this long: drift back to centre
  const RECALIBRATE_AFTER_MS = 4000;  // gone this long: treat the next face as a new viewer

  const pose = { x: 0, y: 0, z: 0, seen: false };
  const target = { x: 0, y: 0, z: 0 };
  const stats = { hz: 0, ms: 0, where: '' };
  let stream = null, video = null, worker = null, detector = null, motion = null;
  let timer = 0, raf = 0, lastSeen = 0, onState = () => {};
  let calib = null;    // { n, sum } while calibrating, then { size }
  let busy = false, lastSend = 0, rateT0 = 0, rateN = 0, nDetect = 0;
  let recent = [], lastSize = 0, faceBox = null, swipe = null, onSwipe = () => {}, lastSwipeSample = 0;
  const SWIPE_ON = qs.get('swipe') !== '0';

  const G = {
    on: false, mode: null, pose, stats,
    /** Called with ('starting' | 'face' | 'motion' | 'off' | 'error', detail). */
    onState(fn) { onState = fn; },
    onSwipe(fn) { onSwipe = fn; },
    start, stop,
    /** Make the current distance the new zero (called when the user zooms by hand). */
    recalibrate() {
      if (lastSize) calib = { size: lastSize };
      target.z = 0; pose.z = 0;
    },
  };
  window.Glass = G;

  async function start() {
    if (G.on) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      onState('error', 'This browser does not expose the camera to web pages.');
      return;
    }
    G.on = true;
    onState('starting');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Small frames: BlazeFace works at 128x128 internally, so more pixels
        // only cost upload and resize time.
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
    } catch (e) {
      G.on = false;
      const msg = e && e.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow camera use for web apps on this device, then try again.'
        : e && e.name === 'NotReadableError'
          ? 'The camera is busy (a call may be using it).'
          : 'Could not start the camera' + (e && e.message ? `: ${e.message}` : '.');
      onState('error', msg);
      return;
    }
    if (!G.on) { stopTracks(); return; }   // turned off while the prompt was up

    video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    await video.play().catch(() => {});
    stream.getVideoTracks()[0].addEventListener('ended', () => { stop(); onState('error', 'The camera was taken by another app.'); });

    const delegate = (qs.get('glassdelegate') || '').toLowerCase();
    G.mode = null;
    // 1. Worker (best: inference off the render thread).
    if (qs.get('glassworker') !== '0' && window.Worker && window.createImageBitmap) {
      try {
        worker = await startWorker(delegate);
        G.mode = 'face';
      } catch (e) {
        console.warn('[glass] worker detector unavailable', e);
        if (worker) worker.terminate();
        worker = null;
      }
    }
    // 2. Main thread.
    if (!G.mode) {
      try {
        const vision = await import(MP_BASE + 'vision_bundle.mjs');
        const files = await vision.FilesetResolver.forVisionTasks(MP_BASE + 'wasm');
        for (const d of delegate === 'cpu' ? ['CPU'] : ['GPU', 'CPU']) {
          try {
            detector = await vision.FaceDetector.createFromOptions(files, {
              baseOptions: { modelAssetPath: MP_BASE + 'blaze_face_short_range.tflite', delegate: d },
              runningMode: 'VIDEO', minDetectionConfidence: 0.5,
            });
            stats.where = 'main/' + d.toLowerCase();
            break;
          } catch (e) { if (d === 'CPU') throw e; }
        }
        G.mode = 'face';
      } catch (e) {
        console.warn('[glass] face detector unavailable, using motion tracking', e);
      }
    }
    // 3. Motion centroid.
    if (!G.mode) { motion = makeMotionTracker(); G.mode = 'motion'; stats.where = 'motion'; }

    if (!G.on) { teardown(); return; }
    onState(G.mode);
    calib = null; nDetect = 0; stats.ms = 0; recent = []; lastSize = 0; faceBox = null;
    swipe = SWIPE_ON ? makeSwipeDetector() : null;
    rateT0 = performance.now(); rateN = 0;
    loop();
    smoothLoop();
  }

  function startWorker(delegate) {
    return new Promise((resolve, reject) => {
      const w = new Worker(WORKER_URL);
      const to = setTimeout(() => reject(new Error('worker init timed out')), 20000);
      w.onerror = (e) => { clearTimeout(to); reject(e.message ? new Error(e.message) : e); };
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'ready') {
          clearTimeout(to);
          stats.where = 'worker/' + m.delegate.toLowerCase();
          w.onmessage = onWorkerMessage;
          resolve(w);
        } else if (m.type === 'error') { clearTimeout(to); reject(new Error(m.message)); }
      };
      w.postMessage({ type: 'init', base: MP_BASE, delegate });
    });
  }

  function onWorkerMessage(ev) {
    const m = ev.data;
    if (m.type !== 'result') return;
    busy = false;
    recordMs(m.ms);
    const b = m.box;
    measure(b ? { cx: (b.originX + b.width / 2) / m.w, cy: (b.originY + b.height / 2) / m.h, size: b.width / m.w } : null);
  }

  function stop() {
    if (!G.on && !stream) return;
    G.on = false;
    teardown();
    onState('off');
  }

  function stopTracks() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function teardown() {
    clearTimeout(timer); timer = 0;
    if (video && video.cancelVideoFrameCallback && video._vfc) video.cancelVideoFrameCallback(video._vfc);
    stopTracks();
    if (video) { video.srcObject = null; video = null; }
    if (worker) { worker.terminate(); worker = null; }
    if (detector) { try { detector.close(); } catch (_) { /* */ } detector = null; }
    motion = null; swipe = null; G.mode = null; busy = false;
    target.x = target.y = target.z = 0;
    // smoothLoop keeps easing pose back to zero, then ends.
  }

  // ── Measurement ──────────────────────────────────────────────────────────
  // Driven by new camera frames where the browser supports it, so a frame is
  // never analysed twice; otherwise a timer.
  function loop() {
    if (!G.on || !video) return;
    if (video.requestVideoFrameCallback) video._vfc = video.requestVideoFrameCallback(() => { tick(); loop(); });
    else timer = setTimeout(() => { tick(); loop(); }, MIN_INTERVAL_MS);
  }

  function tick() {
    if (!G.on || !video || video.readyState < 2 || !video.videoWidth) return;
    const now = performance.now();
    if (swipe && now - lastSwipeSample >= 60) {
      lastSwipeSample = now;
      const dir = swipe(video, faceBox, now);
      if (dir) onSwipe(dir);
    }
    if (now - lastSend < MIN_INTERVAL_MS) return;

    if (worker) {
      if (busy) return;   // one frame in flight at a time
      busy = true; lastSend = now;
      createImageBitmap(video).then((bitmap) => {
        if (!worker) { bitmap.close(); return; }
        worker.postMessage({ type: 'frame', bitmap, ts: now }, [bitmap]);
      }).catch(() => { busy = false; });
      countRate(now);
      return;
    }

    // Main-thread paths: keep inference inside a fixed share of the frame budget.
    if (detector && now - lastSend < Math.min(MAX_INTERVAL_MS, stats.ms / BUDGET)) return;
    lastSend = now;
    countRate(now);
    let hit = null;
    try {
      if (detector) {
        const t0 = performance.now();
        const res = detector.detectForVideo(video, now);
        recordMs(performance.now() - t0);
        let best = null;
        for (const d of res.detections || []) {
          const b = d.boundingBox;
          if (!best || b.width * b.height > best.width * best.height) best = b;
        }
        const vw = video.videoWidth, vh = video.videoHeight;
        if (best) hit = { cx: (best.originX + best.width / 2) / vw, cy: (best.originY + best.height / 2) / vh, size: best.width / vw };
      } else if (motion) {
        hit = motion(video);
      }
    } catch (e) {
      console.warn('[glass] detection error', e);
    }
    measure(hit);
  }

  function recordMs(ms) {
    if (++nDetect <= WARMUP_FRAMES) return;
    stats.ms = stats.ms ? stats.ms * 0.8 + ms * 0.2 : ms;
  }

  function countRate(now) {
    rateN++;
    if (now - rateT0 >= 1000) { stats.hz = Math.round((rateN * 1000) / (now - rateT0)); rateN = 0; rateT0 = now; }
  }

  function measure(hit) {
    const now = performance.now();
    if (hit) {
      if (now - lastSeen > RECALIBRATE_AFTER_MS) { calib = null; recent = []; }   // a new (or returning) viewer
      lastSeen = now;
      faceBox = hit.size ? { cx: hit.cx, cy: hit.cy, size: hit.size } : null;
      // Median of the last three detections: one bad frame can't make it jump.
      recent.push(hit); if (recent.length > 3) recent.shift();
      const med = (k) => recent.map((h) => h[k]).sort((a, b) => a - b)[Math.floor(recent.length / 2)];
      hit = { cx: med('cx'), cy: med('cy'), size: med('size') };
      lastSize = hit.size;
      // The camera faces the viewer, so their right is the image's left: mirror x.
      target.x = clamp((0.5 - hit.cx) * GAIN_XY, -1, 1);
      target.y = clamp((0.5 - hit.cy) * GAIN_XY, -1, 1);
      if (hit.size) {
        // Distance: calibrate on the first ~half second of sightings, then
        // compare. log2 makes "twice as close" and "twice as far" symmetric.
        if (!calib || calib.n !== undefined) {
          calib = calib || { n: 0, sum: 0 };
          calib.n++; calib.sum += hit.size;
          if (calib.n >= 6) calib = { size: calib.sum / calib.n };
          target.z = 0;
        } else {
          target.z = clamp(Math.log2(hit.size / calib.size), -1, 1.2);
        }
      }
    } else if (now - lastSeen > LOST_AFTER_MS) {
      target.x = target.y = target.z = 0;
    }
    pose.seen = now - lastSeen < LOST_AFTER_MS;
  }

  function smoothLoop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      // Small deadzones so a seated, still viewer doesn't make the globe shimmer.
      const dz = (v, d) => (Math.abs(v) < d ? 0 : v - Math.sign(v) * d);
      pose.x += (dz(target.x, DEADZONE_XY) - pose.x) * SMOOTH_XY;
      pose.y += (dz(target.y, DEADZONE_XY) - pose.y) * SMOOTH_XY;
      pose.z += (dz(target.z, DEADZONE_Z) - pose.z) * SMOOTH_Z;
      const settled = Math.abs(pose.x) + Math.abs(pose.y) + Math.abs(pose.z) < 0.002;
      if (G.on || !settled) raf = requestAnimationFrame(tick);
      else { pose.x = pose.y = pose.z = 0; pose.seen = false; }
    };
    raf = requestAnimationFrame(tick);
  }

  /** Fallback: centroid of pixels that differ from a slowly-adapting background,
   *  on a 64x48 greyscale copy of the frame. Dependency-free and cheap. */
  function makeMotionTracker() {
    const W = 64, H = 48;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    let bg = null;
    return (vid) => {
      g.drawImage(vid, 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H).data;
      if (!bg) { bg = new Float32Array(W * H); for (let i = 0; i < W * H; i++) bg[i] = px[i * 4 + 1]; return null; }
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, v = px[i * 4 + 1];
        const d = Math.abs(v - bg[i]);
        bg[i] += (v - bg[i]) * 0.02;
        if (d > 22) { sx += x; sy += y; n++; }
      }
      if (n < W * H * 0.01) return null;
      return { cx: sx / n / W, cy: sy / n / H, size: 0 };
    };
  }

  /** Experimental arm swipe. Frame-to-frame motion on a 48x36 copy, with the
   *  face (and a margin around it) masked out. A swipe is a big blob of motion
   *  whose centre travels a third of the frame in under ~0.7 s, mostly in one
   *  direction. Returns 'left' | 'right' (viewer's point of view) or null. */
  function makeSwipeDetector() {
    const W = 48, H = 36, MIN_MASS = W * H * 0.03, WINDOW_MS = 700, TRAVEL = 0.33, COOLDOWN_MS = 1200;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    let prev = null, hist = [], quietUntil = 0;
    return (vid, face, now) => {
      g.drawImage(vid, 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H).data;
      const cur = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) cur[i] = px[i * 4 + 1];
      if (!prev) { prev = cur; return null; }
      // Mask: the face box grown 1.4x sideways and down to the shoulders.
      let fx0 = -1, fx1 = -1, fy0 = -1, fy1 = -1;
      if (face) {
        const half = face.size * 1.4;
        fx0 = (face.cx - half) * W; fx1 = (face.cx + half) * W;
        fy0 = (face.cy - half) * H; fy1 = (face.cy + half * 1.6) * H;
      }
      let sx = 0, n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) continue;
        const i = y * W + x;
        if (Math.abs(cur[i] - prev[i]) > 28) { sx += x; n++; }
      }
      prev = cur;
      if (now < quietUntil) return null;
      if (n >= MIN_MASS) hist.push({ t: now, x: sx / n / W });
      hist = hist.filter((h) => now - h.t <= WINDOW_MS);
      if (hist.length < 4) return null;
      const dx = hist[hist.length - 1].x - hist[0].x;
      if (Math.abs(dx) < TRAVEL) return null;
      let agree = 0;
      for (let i = 1; i < hist.length; i++) if (Math.sign(hist[i].x - hist[i - 1].x) === Math.sign(dx)) agree++;
      if (agree / (hist.length - 1) < 0.7) return null;
      hist = []; quietUntil = now + COOLDOWN_MS;
      // Image x grows toward the viewer's LEFT (the camera faces them).
      return dx > 0 ? 'left' : 'right';
    };
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // Release the camera whenever the page is hidden (device sleeps, panel closed).
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.on) stop(); });
})();
