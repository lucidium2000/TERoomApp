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
 * Experimental air swipe: MediaPipe Hand Landmarker tracks palms in the same
 * worker; a palm that travels far enough, fast enough and mostly sideways (or
 * that was doing so when motion blur made it vanish) fires
 * onSwipe('left' | 'right'), from the viewer's point of view. If the hand
 * model can't load, a masked frame-difference detector is used instead.
 * ?swipe=0 disables; ?camdebug=1 shows a small camera preview with what's
 * being tracked.
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
  const TF_BASE = new URL('../vendor/tfjs/', document.currentScript.src).href;
  // Hand model on the main-thread path: 'lite' = TF.js MediaPipe Hands lite
  // (WebGL1-capable, smaller/faster), 'mediapipe' = MediaPipe Tasks full model.
  const HAND_ENGINE = (qs.get('hands') || 'lite').toLowerCase();
  // Share of wall time the lite loop may occupy (much of it is async GPU wait). 1 = back to back.
  const LITE_BUDGET = Math.max(0.1, Math.min(1, parseFloat(qs.get('handbudget')) || 0.6));
  // Carry glass.js's ?v= onto the worker, so a cached old worker is never paired with new code.
  const WORKER_URL = new URL('face-worker.js' + new URL(document.currentScript.src).search, document.currentScript.src).href;
  const MIN_INTERVAL_MS = 50;      // never ask for more than ~20 Hz
  const BUDGET = 0.3;              // main-thread fallback: spend at most ~30% of time detecting
  const MAX_INTERVAL_MS = 250;     // ...but never track slower than 4 Hz
  const WARMUP_FRAMES = 3;         // first GPU runs compile shaders: don't let them skew timing
  const GAIN_XY = 0.6;             // head offset from centre -> -1..1 (lower = needs more movement)
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
  let recent = [], lastSize = 0, faceBox = null, swipe = null, handSwipe = null, onSwipe = () => {}, lastSwipeSample = 0;
  let liteDet = null, liteTimer = 0, liteN = 0, liteT0 = 0;
  let handLm = null, lastSwipeAny = -Infinity, lastPalms = [], lastHandSeen = -Infinity;
  let debug = null, debugWanted = qs.get('camdebug') === '1', frameN = 0, resN = 0, resT0 = 0;
  const SWIPE_ON = qs.get('swipe') !== '0';

  const G = {
    on: false, mode: null, pose, stats,
    /** Called with ('starting' | 'face' | 'motion' | 'off' | 'error', detail). */
    onState(fn) { onState = fn; },
    onSwipe(fn) { onSwipe = fn; },
    /** fn(state: 'start' | 'mode' | 'move' | 'end', info): info.mode is 'pan'
     *  (one fist) or 'zoom' (two); info.dx/dy are the grab point's movement
     *  since the last update (0..1 frame units, viewer's view, +x = their
     *  right, +y = down); info.ratio is fist spacing / spacing at grab start. */
    onGrab(fn) { onGrab = fn; },
    get grabbing() { return grab.on; },
    start, stop,
    /** Show/hide the camera debug view (starts Glass mode if needed). */
    setDebug(on) {
      debugWanted = on;
      if (!on && debug) { debug.remove(); debug = null; }
      if (on && G.on && G.mode && !debug) debug = makeDebugView();
      if (on && !G.on) start();
    },
    get debug() { return debugWanted; },
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
        // 30 fps: shorter exposure (less blur on a swiping hand) and more samples per swipe.
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } },
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
    // MediaPipe's GPU path needs WebGL2. Inside a worker that means
    // OffscreenCanvas WebGL2, which some browsers (seen on a Desk Pro) lack, so
    // the worker falls back to CPU - fine for faces, far too slow for hands
    // (~3 Hz). If the page itself has WebGL2, run on the main thread instead.
    const mainGL2 = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (_) { return false; } })();
    const forceWorker = qs.get('glassworker') === '1';
    // 1. Worker (best when it gets the GPU: inference off the render thread).
    if (qs.get('glassworker') !== '0' && window.Worker && window.createImageBitmap) {
      try {
        worker = await startWorker(delegate);
        G.mode = 'face';
        if (SWIPE_ON && !forceWorker && delegate !== 'cpu' && stats.handDelegate !== 'GPU' && mainGL2) {
          console.info('[glass] worker hands are on CPU; moving detection to the main-thread GPU');
          worker.terminate(); worker = null; G.mode = null;
        }
      } catch (e) {
        console.warn('[glass] worker detector unavailable', e);
        if (worker) worker.terminate();
        worker = null;
      }
    }
    // 2. Main thread (GPU where WebGL2 allows), face + hands.
    if (!G.mode) {
      try {
        const vision = await import(MP_BASE + 'vision_bundle.mjs');
        const files = await vision.FilesetResolver.forVisionTasks(MP_BASE + 'wasm');
        const order = delegate === 'cpu' ? ['CPU'] : ['GPU', 'CPU'];
        for (const d of order) {
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
        if (SWIPE_ON && HAND_ENGINE === 'lite') {
          try {
            await startLiteHands();
            stats.hands = true; stats.handDelegate = 'lite/webgl';
          } catch (e) {
            console.warn('[glass] TF.js lite hands unavailable, trying MediaPipe', e);
          }
        }
        if (SWIPE_ON && !stats.hands) {
          for (const d of order) {
            try {
              handLm = await vision.HandLandmarker.createFromOptions(files, {
                baseOptions: { modelAssetPath: MP_BASE + 'hand_landmarker.task', delegate: d },
                runningMode: 'VIDEO', numHands: 2,
                minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.3,
              });
              stats.hands = true; stats.handDelegate = d;
              break;
            } catch (e) { /* try next; no hands is fine */ }
          }
        }
      } catch (e) {
        console.warn('[glass] face detector unavailable, using motion tracking', e);
      }
    }
    // 3. Motion centroid.
    if (!G.mode) { motion = makeMotionTracker(); G.mode = 'motion'; stats.where = 'motion'; }

    if (!G.on) { teardown(); return; }
    onState(G.mode);
    calib = null; nDetect = 0; stats.ms = 0; recent = []; lastSize = 0; faceBox = null;
    // Two swipe detectors: hand landmarks (precise, but only as fast as the
    // model runs) and a cheap motion sweep at ~16 Hz that covers for a slow model.
    handSwipe = SWIPE_ON && stats.hands ? makeHandSwipeDetector() : null;
    swipe = SWIPE_ON ? makeSwipeDetector() : null;
    stats.swipe = handSwipe ? 'hands+motion' : swipe ? 'motion' : 'off';
    lastSwipeAny = -Infinity;
    if (liteDet) liteLoop();
    debug = debugWanted ? makeDebugView() : null;
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
          stats.hands = !!m.hands;
          stats.handDelegate = m.handDelegate || null;
          w.onmessage = onWorkerMessage;
          resolve(w);
        } else if (m.type === 'error') { clearTimeout(to); reject(new Error(m.message)); }
      };
      w.postMessage({ type: 'init', base: MP_BASE, delegate, hands: SWIPE_ON });
    });
  }

  function onWorkerMessage(ev) {
    const m = ev.data;
    if (m.type !== 'result') return;
    busy = false;
    recordMs(m.ms);
    const b = m.box;
    if (b !== undefined) measure(b ? { cx: (b.originX + b.width / 2) / m.w, cy: (b.originY + b.height / 2) / m.h, size: b.width / m.w } : null);
    const now = performance.now();
    resN++;
    if (now - resT0 >= 1000) { stats.handHz = Math.round((resN * 1000) / (now - resT0)); resN = 0; resT0 = now; }
    processHands(m.hands || [], now, m.w && m.h ? m.h / m.w : 0.5625);
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
    if (handLm) { try { handLm.close(); } catch (_) { /* */ } handLm = null; }
    clearTimeout(liteTimer); liteTimer = 0;
    if (liteDet) { try { liteDet.dispose(); } catch (_) { /* */ } liteDet = null; }
    motion = null; swipe = null; handSwipe = null; G.mode = null; busy = false;
    if (grab.on) { grab.on = false; grab.mode = null; grab.endT = performance.now(); onGrab('end', { ratio: grab.ratio }); }
    if (debug) { debug.remove(); debug = null; }
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
      const dir = swipe(video, now);
      // Only trusted when someone is in front (a face, or a hand seen in the
      // last 2 s), and only needed when the hand model is missing or too slow
      // to catch a swipe itself.
      const handsSlow = !handSwipe || (stats.handHz || 0) < 8;
      const someone = pose.seen || now - lastHandSeen < 2000;
      if (dir && someone && handsSlow) emitSwipe(dir, 'motion');
      else if (dir && swipe.diag) swipe.diag.why = !someone ? 'nobody in view (ignored)' : 'hands fast: left to them';
    }
    if (now - lastSend < MIN_INTERVAL_MS) return;

    if (worker) {
      if (busy) return;   // one frame in flight at a time
      busy = true; lastSend = now;
      // With hands on, faces are only looked for on every other frame: head
      // position is heavily smoothed anyway, and the hand gets the full rate.
      const withFace = !handSwipe || (++frameN % 2 === 0);
      const vw = video.videoWidth, vh = video.videoHeight;
      const bmpOpts = vw > SMALL_W + 16 ? { resizeWidth: SMALL_W, resizeHeight: Math.round((SMALL_W * vh) / vw), resizeQuality: 'low' } : undefined;
      createImageBitmap(video, bmpOpts).then((bitmap) => {
        if (!worker) { bitmap.close(); return; }
        worker.postMessage({ type: 'frame', bitmap, ts: now, face: withFace }, [bitmap]);
      }).catch(() => { busy = false; });
      countRate(now);
      return;
    }

    // Main-thread paths: keep inference inside a fixed share of the frame budget.
    if (detector && now - lastSend < Math.min(MAX_INTERVAL_MS, stats.ms / BUDGET)) return;
    lastSend = now;
    countRate(now);
    let hit = null, palms = null;
    const withFace = !handLm || (++frameN % 2 === 0);
    try {
      if (detector) {
        const t0 = performance.now();
        const src = smallFrame();
        if (handLm) {
          const hr = handLm.detectForVideo(src, now);
          palms = (hr.landmarks || []).map((lm, k) => {
            let x = 0, y = 0;
            for (const i of [0, 5, 9, 13, 17]) { x += lm[i].x; y += lm[i].y; }
            const hd = hr.handedness && hr.handedness[k] && hr.handedness[k][0];
            return { x: x / 5, y: y / 5, score: hd ? hd.score : 0, lm: lm.map((q) => [q.x, q.y]) };
          });
        }
        const res = withFace ? detector.detectForVideo(src, now) : { detections: [] };
        recordMs(performance.now() - t0);
        if (handLm) {
          resN++;
          if (now - resT0 >= 1000) { stats.handHz = Math.round((resN * 1000) / (now - resT0)); resN = 0; resT0 = now; }
        }
        let best = null;
        for (const d of res.detections || []) {
          const b = d.boundingBox;
          if (!best || b.width * b.height > best.width * best.height) best = b;
        }
        // Box is in the pixels of the frame we fed in (possibly the shrunken copy).
        const vw = src.videoWidth || src.width, vh = src.videoHeight || src.height;
        if (best) hit = { cx: (best.originX + best.width / 2) / vw, cy: (best.originY + best.height / 2) / vh, size: best.width / vw };
      } else if (motion) {
        hit = motion(video);
      }
    } catch (e) {
      console.warn('[glass] detection error', e);
    }
    if (withFace || !detector) measure(hit);
    if (palms) processHands(palms, now, video.videoHeight / video.videoWidth);
    else if (debug && !worker) debug(lastPalms);
  }

  function recordMs(ms) {
    if (++nDetect <= WARMUP_FRAMES) return;
    stats.ms = stats.ms ? stats.ms * 0.8 + ms * 0.2 : ms;
  }

  /** The models work at ~128-224 px internally, but cameras often ignore the
   *  320x240 we ask for and deliver full HD. Shrinking each frame ourselves
   *  keeps the GPU upload and resize per detection small whatever we're sent. */
  const SMALL_W = 320;
  let smallC = null, smallG = null;
  function smallFrame(forceCanvas) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw <= SMALL_W + 16 && !forceCanvas) return video;
    const w = Math.min(SMALL_W, vw), h = Math.round((w * vh) / vw);
    if (!smallC || smallC.width !== w || smallC.height !== h) {
      smallC = document.createElement('canvas'); smallC.width = w; smallC.height = h;
      smallG = smallC.getContext('2d');
    }
    smallG.drawImage(video, 0, 0, w, h);
    return smallC;
  }

  // ── TF.js MediaPipe Hands (lite) ────────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-src="${src}"]`)) { resolve(); return; }
      const el = document.createElement('script');
      el.src = src; el.dataset.src = src; el.async = false;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(el);
    });
  }

  async function startLiteHands() {
    for (const f of ['tf-core.min.js', 'tf-converter.min.js', 'tf-backend-webgl.min.js', 'hand-pose-detection.min.js']) {
      await loadScript(TF_BASE + f);
    }
    const tf = window.tf, hpd = window.handPoseDetection;
    await tf.setBackend('webgl');
    await tf.ready();
    liteDet = await hpd.createDetector(hpd.SupportedModels.MediaPipeHands, {
      runtime: 'tfjs', modelType: 'lite', maxHands: 2,
      detectorModelUrl: TF_BASE + 'hand-lite/detector/model.json',
      landmarkModelUrl: TF_BASE + 'hand-lite/landmark/model.json',
    });
    // Warm-up run: the first call compiles shaders and would skew timing.
    if (video && video.videoWidth) { try { await liteDet.estimateHands(smallFrame(true)); } catch (_) { /* */ } }
  }

  /** Its own loop: estimateHands is async, so it runs alongside face detection,
   *  paced to use about BUDGET of the main thread (it blocks on GPU readback). */
  function liteLoop() {
    clearTimeout(liteTimer);
    if (!G.on || !liteDet || !video) return;
    if (video.readyState < 2 || !video.videoWidth) { liteTimer = setTimeout(liteLoop, 100); return; }
    const t0 = performance.now();
    // Always a canvas: TF.js sizes a <video> by its width/height ATTRIBUTES,
    // which are 0 unless set, and then every keypoint comes back NaN.
    const src = smallFrame(true);
    const sw = src.width, sh = src.height;
    liteDet.estimateHands(src, { flipHorizontal: false }).then((hands) => {
      const now = performance.now(), ms = now - t0;
      stats.handMs = stats.handMs ? stats.handMs * 0.8 + ms * 0.2 : ms;
      liteN++;
      if (!liteT0) liteT0 = now;
      if (now - liteT0 >= 1000) { stats.handHz = Math.round((liteN * 1000) / (now - liteT0)); liteN = 0; liteT0 = now; }
      const palms = (hands || []).map((h) => {
        const k = h.keypoints;
        let x = 0, y = 0;
        for (const i of [0, 5, 9, 13, 17]) { x += k[i].x; y += k[i].y; }
        return { x: x / 5 / sw, y: y / 5 / sh, score: h.score || 0, lm: k.map((q) => [q.x / sw, q.y / sh]) };
      });
      processHands(palms, now, sh / sw);
      liteTimer = setTimeout(liteLoop, Math.max(0, stats.handMs * (1 / LITE_BUDGET - 1)));
    }).catch((e) => {
      console.warn('[glass] lite hands error', e);
      liteTimer = setTimeout(liteLoop, 500);
    });
  }

  // ── Fist grab: drag to rotate, two fists to zoom ────────────────────────
  // A fist: fingertips curled in near the wrist. Measured against the hand's
  // own size (wrist -> middle knuckle), so distance from the camera doesn't
  // matter. Open hand ~1.9, fist ~1.0; hysteresis between FIST_ON and FIST_OFF.
  // One fist = 'pan' (the globe follows the fist). Two fists = 'zoom' (their
  // spacing zooms, their midpoint still pans). A grab starts once a fist has
  // been held HOLD_MS. It lets go after OPEN_MS of an open hand, or LOST_MS of
  // no hand at all (a hand the camera loses for a moment shouldn't drop the
  // globe). Switching between one and two fists mid-grab needs DEBOUNCE results.
  // MAX_SPEED / MAX_STEP / MAX_ZOOM_STEP: anything faster than a deliberate
  // drag or pull (tracking glitches, a misread hand, someone passing through)
  // is ignored - the grab re-anchors there instead of jumping the globe.
  // HOLD_DRIFT: the fist must stay this still (frame units) while engaging,
  // or the HOLD_MS timer restarts - a fist passing through doesn't grab.
  const GRAB = { FIST_ON: 1.3, FIST_OFF: 1.5, OPEN_MS: 250, LOST_MS: 750, AFTER_MS: 900, DEBOUNCE: 2, HOLD_MS: 250, HOLD_DRIFT: 0.06,
    MAX_SPEED: 1.5, MAX_STEP: 0.2, MAX_ZOOM_STEP: 0.35 };
  const grab = { on: false, mode: null, d0: 0, ratio: 1, px: 0, py: 0, lastSeen: 0, endT: -Infinity, curls: [], pendMode: null, pendN: 0,
    pendT0: 0, lastAction: 0, lastRatio: 1, latched: false };
  function releaseGrab(now, latch) {
    grab.on = false; grab.mode = null; grab.endT = now; grab.pendMode = null; grab.pendN = 0;
    if (latch) grab.latched = true;
    onGrab('end', { ratio: grab.ratio });
  }
  let onGrab = () => {};

  function curl(lm, aspect) {
    const d = (a, b) => Math.hypot(lm[a][0] - lm[b][0], (lm[a][1] - lm[b][1]) * aspect);
    const size = d(0, 9) || 1e-6;
    return (d(8, 0) + d(12, 0) + d(16, 0) + d(20, 0)) / 4 / size;
  }

  function updateGrab(palms, now, aspect) {
    const withLm = palms.filter((p) => p.lm);
    grab.curls = withLm.map((p) => curl(p.lm, aspect));
    const thr = grab.on ? GRAB.FIST_OFF : GRAB.FIST_ON;
    const fists = withLm.filter((p, i) => grab.curls[i] < thr);
    const mode = fists.length >= 2 ? 'zoom' : fists.length === 1 ? 'pan' : null;

    if (!mode) {
      grab.pendMode = null; grab.pendN = 0;
      const openHand = grab.curls.some((c) => c > GRAB.FIST_OFF);
      if (grab.on && now - grab.lastSeen > (openHand ? GRAB.OPEN_MS : GRAB.LOST_MS)) releaseGrab(now, false);
      return;
    }
    if (grab.latched) { grab.lastSeen = now; return; }
    if (mode !== grab.mode) {
      if (grab.on) {
        // Mid-grab switch between one and two fists: a quick debounce.
        grab.pendN = grab.pendMode === mode ? grab.pendN + 1 : 1;
        grab.pendMode = mode;
        if (grab.pendN < GRAB.DEBOUNCE) { grab.lastSeen = now; return; }
      } else {
        // New grab: the fist has to be held HOLD_MS, and held still.
        const c = mode === 'zoom' ? { x: (fists[0].x + fists[1].x) / 2, y: (fists[0].y + fists[1].y) / 2 } : fists[0];
        if (grab.pendMode !== mode || Math.hypot(c.x - grab.pendX, c.y - grab.pendY) > GRAB.HOLD_DRIFT) {
          grab.pendMode = mode; grab.pendT0 = now; grab.pendX = c.x; grab.pendY = c.y;
        }
        if (now - grab.pendT0 < GRAB.HOLD_MS) return;
      }
    }
    grab.lastSeen = now;
    const pt = mode === 'zoom' ? { x: (fists[0].x + fists[1].x) / 2, y: (fists[0].y + fists[1].y) / 2 } : fists[0];
    const dist = mode === 'zoom' ? Math.hypot(fists[0].x - fists[1].x, (fists[0].y - fists[1].y) * aspect) : 0;
    if (!grab.on || grab.mode !== mode) {
      const first = !grab.on;
      grab.on = true; grab.mode = mode; grab.px = pt.x; grab.py = pt.y; grab.lastAction = now; grab.lastT = now; grab.rejected = 0;
      if (mode === 'zoom') { grab.d0 = Math.max(0.05, dist); grab.ratio = 1; grab.lastRatio = 1; }
      onGrab(first ? 'start' : 'mode', { mode, ratio: 1 });
      return;
    }
    // Deltas from the viewer's point of view: the camera faces them, so mirror x.
    let dx = -(pt.x - grab.px), dy = pt.y - grab.py;
    const dt = Math.max(1, now - (grab.lastT || now)) / 1000;
    grab.px = pt.x; grab.py = pt.y; grab.lastT = now;
    const step = Math.hypot(dx, dy);
    if (step > GRAB.MAX_STEP || step / dt > GRAB.MAX_SPEED) {
      grab.rejected = (grab.rejected || 0) + 1;
      dx = 0; dy = 0;                       // too fast to be a drag: re-anchor, don't move
    }
    if (mode === 'zoom') {
      const r = dist / grab.d0;
      if (Math.abs(r / grab.ratio - 1) > GRAB.MAX_ZOOM_STEP) {
        grab.rejected = (grab.rejected || 0) + 1;
        grab.d0 = dist / grab.ratio;        // keep the current zoom; carry on from here
      } else {
        grab.ratio = r;
      }
    }
    onGrab('move', { mode, ratio: grab.ratio, dx, dy });
  }

  /** Every hand result, from whichever engine, comes through here. */
  function processHands(palms, now, aspect) {
    lastPalms = palms;
    if (palms.length) lastHandSeen = now;
    // Fist grabs are always on; intent comes from timing (a still fist held
    // HOLD_MS), speed limits and the let-go rules - no palm arming.
    updateGrab(palms, now, aspect || 0.5625);
    // While grabbing (and just after), two-handed movement must not swipe.
    if (handSwipe) {
      const dir = handSwipe(grab.on ? [] : palms, now);
      if (dir) emitSwipe(dir, 'hands');
    }
    if (debug) debug(palms);
  }

  /** Both detectors report here; one swipe can't be counted twice. */
  function emitSwipe(dir, source) {
    const now = performance.now();
    if (grab.on || now - grab.endT < GRAB.AFTER_MS) return;
    if (now - lastSwipeAny < 1000) return;
    lastSwipeAny = now;
    stats.lastSwipe = { dir, source, t: now };
    onSwipe(dir);
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

  /** Fast motion sweep (no model): frame-to-frame differences on a 64x48
   *  copy, ~16 Hz. A swipe is a big blob of motion whose centre travels >= 30%
   *  of the frame within ~0.6 s, mostly one way. Frames where most of the image
   *  changes (auto-exposure, lights) are skipped; the threshold adapts to
   *  sensor noise. Nothing is masked: a head turn moves the centre a little,
   *  an arm sweep moves it a lot. Returns 'left' | 'right' (viewer's view). */
  const MOTION = { TRAVEL: 0.3, WINDOW_MS: 650, MIN_MASS: 0.025, COOLDOWN_MS: 1000, REVERSE_MS: 1500 };
  function makeSwipeDetector() {
    const W = 64, H = 48, N = W * H;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    let prev = null, hist = [], quietUntil = 0, lastDir = null, lastT = 0;
    const diag = { travel: 0, mass: 0, why: 'warming up' };
    const fn = (vid, now) => {
      g.drawImage(vid, 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H).data;
      const cur = new Uint8Array(N);
      for (let i = 0; i < N; i++) cur[i] = (px[i * 4] + 2 * px[i * 4 + 1] + px[i * 4 + 2]) >> 2;
      if (!prev) { prev = cur; return null; }
      let sum = 0;
      for (let i = 0; i < N; i++) sum += Math.abs(cur[i] - prev[i]);
      const thr = Math.max(18, (sum / N) * 2.5);
      let sx = 0, n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (Math.abs(cur[i] - prev[i]) > thr) { sx += x; n++; }
      }
      prev = cur;
      diag.mass = n / N;
      if (n / N > 0.5) { hist = []; diag.why = 'whole-image change (skipped)'; return null; }
      if (now < quietUntil) { hist = []; diag.why = 'cooldown'; return null; }
      if (n / N >= MOTION.MIN_MASS) hist.push({ t: now, x: sx / n / W });
      hist = hist.filter((h) => now - h.t <= MOTION.WINDOW_MS);
      if (hist.length < 3) { diag.why = n / N >= MOTION.MIN_MASS ? 'moving' : 'still'; diag.travel = 0; return null; }
      const dx = hist[hist.length - 1].x - hist[0].x;
      diag.travel = Math.abs(dx);
      if (Math.abs(dx) < MOTION.TRAVEL) { diag.why = 'too short'; return null; }
      let agree = 0;
      for (let i = 1; i < hist.length; i++) if (Math.sign(hist[i].x - hist[i - 1].x) === Math.sign(dx)) agree++;
      if (agree / (hist.length - 1) < 0.7) { diag.why = 'back and forth'; return null; }
      hist = [];
      const dir = dx > 0 ? 'left' : 'right';   // image x grows toward the viewer's LEFT
      if (lastDir && dir !== lastDir && now - lastT < MOTION.REVERSE_MS) { diag.why = 'return stroke (ignored)'; return null; }
      quietUntil = now + MOTION.COOLDOWN_MS; lastDir = dir; lastT = now;
      diag.why = 'SWIPE ' + dir;
      return dir;
    };
    fn.diag = diag;
    return fn;
  }

  /** Air swipe from tracked palms. Each palm is linked to the nearest recent
   *  track; a track fires when, within the last ~0.6 s, it moved >= 15% of the
   *  frame width, at >= 0.6 frame-widths/s, and at least 1.5x more sideways
   *  than vertically. A track that vanishes mid-move (motion blur, or the hand
   *  leaving the frame) also fires if it had already covered 10%.
   *  The return stroke is handled by REVERSE_MS, not by speed. */
  const SWIPE = { WINDOW_MS: 600, LINK: 0.3, GAP_MS: 400, TRAVEL: 0.15, LOST_TRAVEL: 0.1, SPEED: 0.6, RATIO: 1.5, COOLDOWN_MS: 900, REVERSE_MS: 1500 };
  function makeHandSwipeDetector() {
    const C = SWIPE;
    let tracks = [], quietUntil = 0, lastDir = null, lastFireT = 0;
    const diag = { dx: 0, dy: 0, speed: 0, n: 0, why: 'no hand', fired: null, firedT: 0 };
    const judge = (pts, travel) => {
      if (pts.length < 2) { diag.why = 'tracking'; return null; }
      const a = pts[0], b = pts[pts.length - 1];
      const dx = b.x - a.x, dy = b.y - a.y, dt = Math.max(1, b.t - a.t) / 1000;
      Object.assign(diag, { dx, dy, speed: Math.abs(dx) / dt, n: pts.length });
      if (Math.abs(dx) < travel) { diag.why = 'too short'; return null; }
      if (Math.abs(dx) < C.RATIO * Math.abs(dy)) { diag.why = 'too vertical'; return null; }
      if (Math.abs(dx) / dt < C.SPEED) { diag.why = 'too slow'; return null; }
      // Image x grows toward the viewer's LEFT (the camera faces them).
      return dx > 0 ? 'left' : 'right';
    };
    const fire = (dir, now) => {
      tracks = [];
      if (lastDir && dir !== lastDir && now - lastFireT < C.REVERSE_MS) { diag.why = 'return stroke (ignored)'; return null; }
      quietUntil = now + C.COOLDOWN_MS; lastDir = dir; lastFireT = now;
      diag.why = 'SWIPE ' + dir; diag.fired = dir; diag.firedT = now;
      return dir;
    };
    const fn = (palms, now) => {
      // Cooldown: record nothing, so the rest of the same sweep can't fire again.
      if (now < quietUntil) { tracks = []; diag.why = 'cooldown'; return null; }
      if (palms.length) lastHandSeen = now;
      // Scale to the model's rate: at 5 Hz a fast hand moves ~0.4 of the frame
      // between samples, and a swipe needs a longer window to collect 3+ points.
      const hz = Math.max(2, stats.handHz || 10);
      const link = Math.min(0.5, Math.max(C.LINK, 2 / hz));
      const windowMs = Math.min(1000, Math.max(C.WINDOW_MS, 3.5 * 1000 / hz));
      // Link palms to tracks (greedy nearest).
      const used = new Set();
      for (const p of palms) {
        let best = null, bd = link;
        for (const tr of tracks) {
          if (used.has(tr)) continue;
          const last = tr.pts[tr.pts.length - 1];
          const d = Math.hypot(p.x - last.x, p.y - last.y);
          if (d < bd) { bd = d; best = tr; }
        }
        if (best) { best.pts.push({ x: p.x, y: p.y, t: now }); used.add(best); }
        else { const tr = { pts: [{ x: p.x, y: p.y, t: now }] }; tracks.push(tr); used.add(tr); }
      }
      if (!palms.length && !tracks.length) diag.why = 'no hand';
      for (const tr of tracks) tr.pts = tr.pts.filter((q) => now - q.t <= windowMs);
      for (const tr of tracks) {
        if (!used.has(tr)) {
          // Lost: judge once, right after it disappears.
          if (tr.judgedLost || !tr.pts.length || now - tr.pts[tr.pts.length - 1].t > Math.max(C.GAP_MS, 1500 / hz)) continue;
          tr.judgedLost = true;
          const dir = judge(tr.pts, C.LOST_TRAVEL);
          if (dir) return fire(dir, now);
        } else {
          const dir = judge(tr.pts, C.TRAVEL);
          if (dir) return fire(dir, now);
        }
      }
      tracks = tracks.filter((tr) => tr.pts.length && now - tr.pts[tr.pts.length - 1].t <= Math.max(C.GAP_MS, 1500 / hz));
      return null;
    };
    fn.tracks = () => tracks;
    fn.diag = diag;
    return fn;
  }

  /** Camera debug view (hold the camera button, or ?camdebug=1): mirrored
   *  preview with the face box, every hand's 21-point skeleton, swipe trails,
   *  and live numbers against the swipe thresholds. */
  const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
  function makeDebugView() {
    const W = 400, H = 300, TXT = 112;
    const c = document.createElement('canvas');
    c.width = W; c.height = H + TXT;
    c.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:98;border-radius:12px;'
      + 'border:1px solid rgba(255,255,255,.35);pointer-events:none;background:#000;width:400px;height:' + (H + TXT) + 'px';
    document.body.appendChild(c);
    const g = c.getContext('2d');
    const X = (x) => (1 - x) * W, Y = (y) => y * H;   // mirrored, like a selfie view
    const view = (palms) => {
      if (!video) return;
      g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(video, 0, 0, W, H); g.restore();
      g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, 0, W, H);
      // Swipe travel guides: the distance a hand has to cover.
      g.strokeStyle = 'rgba(255,255,255,.25)'; g.setLineDash([4, 6]);
      g.beginPath(); g.moveTo(W * (0.5 - SWIPE.TRAVEL / 2), H - 8); g.lineTo(W * (0.5 + SWIPE.TRAVEL / 2), H - 8); g.stroke();
      g.setLineDash([]);
      if (faceBox) {
        const s = faceBox.size * W;
        g.strokeStyle = '#16bdeb'; g.lineWidth = 2;
        g.strokeRect(X(faceBox.cx) - s / 2, Y(faceBox.cy) - s / 2, s, s);
      }
      if (handSwipe) {
        g.strokeStyle = '#f15e22'; g.lineWidth = 3;
        for (const tr of handSwipe.tracks()) {
          g.beginPath();
          tr.pts.forEach((q, i) => (i ? g.lineTo(X(q.x), Y(q.y)) : g.moveTo(X(q.x), Y(q.y))));
          g.stroke();
        }
      }
      for (const p of palms) {
        if (p.lm) {
          g.strokeStyle = 'rgba(52,211,153,.9)'; g.lineWidth = 2;
          g.beginPath();
          for (const [a, b] of BONES) { g.moveTo(X(p.lm[a][0]), Y(p.lm[a][1])); g.lineTo(X(p.lm[b][0]), Y(p.lm[b][1])); }
          g.stroke();
          g.fillStyle = '#34d399';
          for (const q of p.lm) { g.beginPath(); g.arc(X(q[0]), Y(q[1]), 2.2, 0, 7); g.fill(); }
        }
      }
      palms.forEach((p, i) => {
        const fist = grab.curls[i] !== undefined && grab.curls[i] < (grab.on ? GRAB.FIST_OFF : GRAB.FIST_ON);
        g.fillStyle = fist ? '#f43f5e' : '#fff';
        g.beginPath(); g.arc(X(p.x), Y(p.y), fist ? 9 : 6, 0, 7); g.fill();
      });
      if (grab.on && palms.length >= 2) {
        g.strokeStyle = '#f43f5e'; g.lineWidth = 2; g.setLineDash([6, 5]);
        g.beginPath(); g.moveTo(X(palms[0].x), Y(palms[0].y)); g.lineTo(X(palms[1].x), Y(palms[1].y)); g.stroke();
        g.setLineDash([]);
      }
      // Text panel.
      const d = handSwipe ? handSwipe.diag : null, md = swipe ? swipe.diag : null;
      g.fillStyle = '#0b1220'; g.fillRect(0, H, W, TXT);
      g.font = '12px ui-monospace,Menlo,monospace';
      const line = (i, t, col) => { g.fillStyle = col || '#9fe'; g.fillText(t, 8, H + 16 + i * 18); };
      const hz = stats.handHz || 0;
      line(0, `${stats.where} hands:${(stats.handDelegate || '-').toLowerCase()} ${hz}/s ${(stats.handMs || stats.ms).toFixed(0)}ms cam ${video.videoWidth}x${video.videoHeight}`, hz < 8 ? '#fbbf24' : '#9fe');
      line(1, `hands ${palms.length}  curl ${grab.curls.map((c) => c.toFixed(2)).join(' ') || '-'} (fist<${GRAB.FIST_ON})  face ${faceBox && pose.seen ? 'y' : 'n'}`);
      if (d) {
        const ok = (v, min) => (v >= min ? '#34d399' : '#fbbf24');
        g.fillStyle = '#9fe'; g.fillText('hand:', 8, H + 52);
        g.fillStyle = ok(Math.abs(d.dx), SWIPE.TRAVEL); g.fillText(`travel ${Math.abs(d.dx).toFixed(2)}/${SWIPE.TRAVEL}`, 56, H + 52);
        g.fillStyle = ok(d.speed, SWIPE.SPEED); g.fillText(`speed ${d.speed.toFixed(2)}/${SWIPE.SPEED}`, 200, H + 52);
        g.fillStyle = '#9fe'; g.fillText(d.why.slice(0, 14), 330, H + 52);
      }
      if (md) {
        g.fillStyle = '#9fe'; g.fillText('motion:', 8, H + 70);
        g.fillStyle = md.travel >= MOTION.TRAVEL ? '#34d399' : '#fbbf24';
        g.fillText(`travel ${md.travel.toFixed(2)}/${MOTION.TRAVEL}`, 70, H + 70);
        g.fillStyle = '#9fe'; g.fillText(`${md.why}`.slice(0, 26), 200, H + 70);
      }
      const ls = stats.lastSwipe;
      const recent = ls && performance.now() - ls.t < 1500;
      g.fillStyle = '#9fe';
      g.fillText(`grab: still fist ${GRAB.HOLD_MS}ms | let go: open ${GRAB.OPEN_MS}ms / gone ${GRAB.LOST_MS}ms`, 8, H + 88);
      if (!grab.on && grab.pendMode && !grab.latched) { line(5, `fist hold ${Math.min(100, Math.round((performance.now() - grab.pendT0) / GRAB.HOLD_MS * 100))}%`, '#f43f5e'); return; }
      if (grab.on) { line(5, (grab.mode === 'zoom' ? `GRAB (2 fists)  zoom x${grab.ratio.toFixed(2)} + rotate` : 'GRAB (1 fist)  rotate') + (grab.rejected ? `  [${grab.rejected} fast ignored]` : ''), '#f43f5e'); return; }
      line(5, recent ? `>>> SWIPE ${ls.dir.toUpperCase()} (${ls.source}) <<<` : (ls ? `last swipe: ${ls.dir} via ${ls.source}` : 'no swipe yet'), recent ? '#f15e22' : '#e6edf7');
    };
    view.remove = () => c.remove();
    return view;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // Release the camera whenever the page is hidden (device sleeps, panel closed).
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.on) stop(); });
})();
