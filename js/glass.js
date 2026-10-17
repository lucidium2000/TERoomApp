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
  // Default 'mediapipe': the TF.js lite model locked up a Desk Pro (blocking
  // GPU readback on the main thread). Opt in with ?hands=lite (main thread,
  // WebGL) or ?hands=webgpu (worker, WebGPU - async, can't block the page).
  const HAND_ENGINE = (qs.get('hands') || 'mediapipe').toLowerCase();
  // Share of wall time the lite loop may occupy (much of it is async GPU wait). 1 = back to back.
  const LITE_BUDGET = Math.max(0.1, Math.min(1, parseFloat(qs.get('handbudget')) || 0.6));
  // Carry glass.js's ?v= onto the worker, so a cached old worker is never paired with new code.
  const WORKER_URL = new URL('face-worker.js' + new URL(document.currentScript.src).search, document.currentScript.src).href;
  const MIN_INTERVAL_MS = 50;      // never ask for more than ~20 Hz
  const BUDGET = 0.3;              // main-thread fallback: spend at most ~30% of time detecting
  const MAX_INTERVAL_MS = 250;     // ...but never track slower than 4 Hz
  const WARMUP_FRAMES = 3;         // first GPU runs compile shaders: don't let them skew timing
  // ── Head tracking: a soft, smooth parallax ───────────────────────────────
  // Face samples are sparse (faces share the model time with hands), so the
  // pose is never set directly: it is a critically damped spring pulled toward
  // a target, which makes every movement ease in and out with no jumps.
  //   - The viewer's resting position slowly becomes "centre" (NEUTRAL_TAU), so
  //     sitting off to one side doesn't leave the view permanently skewed.
  //   - A soft knee (no hard deadzone edge) ignores tiny movements and eases
  //     into larger ones; tanh saturation means it never hits a hard limit.
  const HEAD = {
    GAIN: 2.5,          // neutral-relative offset (frame = +-1) -> pose before shaping
    KNEE: 0.06,         // soft deadzone width, in pose units
    NEUTRAL_TAU: 10,    // seconds for the resting position to become centre
    SPRING_HZ: 0.9,     // spring frequency: lower = softer and slower
    SPRING_Z_HZ: 0.5,
    LOST_MS: 1500,      // no face this long: glide back to centre
    RESET_MS: 4000,     // gone this long: the next face is a new viewer (re-centre)
  };

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
  const SWIPE_ON = qs.get('swipe') !== '0';   // hand tracking on (the name is historical)
  // Swipe gestures (spin the globe) are retired; ?swipe=1 brings the detectors back.
  const SWIPE_GESTURE = qs.get('swipe') === '1';
  // With hands on, faces are only looked for on every FACE_EVERY-th frame:
  // head position is heavily smoothed, and the hand model gets the rest.
  const FACE_EVERY = Math.max(1, parseInt(qs.get('faceevery'), 10) || 4);

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
    /** fn('left' | 'right'): the viewer's hand that pinched (experimental). */
    onPinch(fn) { onPinch = fn; },
    /** fn(state: 'hold' | 'cancel' | 'armed' | 'paused', progress 0..1). */
    onGesture(fn) { onGesture = fn; },
    /** Hand cursor (gestures v2): fn({ visible, x, y, fist, progress }) - x/y
     *  0..1 of the screen (viewer's view), progress 0..1 of a fist-hold click. */
    onCursor(fn) { onCursor = fn; },
    /** fn(): a pinch (gestures v2) - click under the cursor. */
    onClick(fn) { onClick = fn; },
    /** 'v1' (palm hold arms, no cursor) or 'v2' (hand cursor, fist click). */
    get version() { return GESTURES_V1 ? 'v1' : 'v2'; },
    get armed() { return armed; },
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
    // Read-only hooks for the Device Lab (js/devlab.js).
    faces: [], facesT: 0,
    get video() { return video; },
    get track() { return stream ? stream.getVideoTracks()[0] : null; },
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
        if (SWIPE_ON && !forceWorker && delegate !== 'cpu' && (stats.handDelegate === 'CPU' || !stats.hands) && mainGL2) {
          console.info('[glass] worker hands are on CPU; moving detection to the main-thread GPU');
          worker.terminate(); worker = null; G.mode = null;
        }
      } catch (e) {
        console.warn('[glass] worker detector unavailable', e);
        if (worker) worker.terminate();
        worker = null;
      }
    }
    // 2. Main thread: face + hands (lite TF.js on WebGL by default).
    if (!G.mode) await startMainDetectors(delegate);
    // 3. Motion centroid.
    if (!G.mode) { motion = makeMotionTracker(); G.mode = 'motion'; stats.where = 'motion'; }

    if (!G.on) { teardown(); return; }
    onState(G.mode);
    calib = null; nDetect = 0; stats.ms = 0; recent = []; lastSize = 0; faceBox = null; neutral = null; lastMeasureT = 0;
    // Two swipe detectors: hand landmarks (precise, but only as fast as the
    // model runs) and a cheap motion sweep at ~16 Hz that covers for a slow model.
    handSwipe = SWIPE_GESTURE && stats.hands ? makeHandSwipeDetector() : null;
    swipe = SWIPE_GESTURE ? makeSwipeDetector() : null;
    stats.swipe = handSwipe ? 'hands+motion' : swipe ? 'motion' : 'off';
    lastSwipeAny = -Infinity;
    if (liteDet) liteLoop();
    debug = debugWanted ? makeDebugView() : null;
    rateT0 = performance.now(); rateN = 0;
    if (worker) scheduleWorkerCheck(delegate);
    loop();
    smoothLoop();
  }

  /** Main-thread detectors: MediaPipe face (GPU where WebGL2 allows) and the
   *  hand model (TF.js lite on WebGL by default - the same WebGL the globe
   *  renders with, which is genuinely hardware-accelerated on a Desk Pro). */
  async function startMainDetectors(delegate) {
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
      stats.hands = false; stats.handDelegate = null;
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
              minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.3,
            });
            stats.hands = true; stats.handDelegate = d;
            break;
          } catch (e) { /* try next; no hands is fine */ }
        }
      }
      return true;
    } catch (e) {
      console.warn('[glass] face detector unavailable, using motion tracking', e);
      return false;
    }
  }

  /** The worker's "GPU" can be a software WebGL emulation (seen on a Desk Pro:
   *  it reports GPU and runs at ~1 frame/s). So don't trust the label - measure.
   *  A few seconds in, if hands run below MIN_WORKER_HZ, move detection to the
   *  main thread with the lite model. */
  // Off by default (0) until the main-thread fallback is proven safe on the
  // device; ?minworkerhz=6 turns the measured switch on.
  const MIN_WORKER_HZ = parseFloat(qs.get('minworkerhz')) || 0;
  let workerCheck = 0;
  function scheduleWorkerCheck(delegate) {
    clearTimeout(workerCheck);
    workerCheck = setTimeout(async () => {
      if (!G.on || !worker || !SWIPE_ON || !MIN_WORKER_HZ || qs.get('glassworker') === '1') return;
      const hz = stats.handHz || 0;
      if (hz >= MIN_WORKER_HZ) return;
      console.info(`[glass] worker hands at ${hz}/s - switching to main-thread detection`);
      worker.terminate(); worker = null; busy = false;
      if (!(await startMainDetectors(delegate)) || !G.on) return;
      stats.switched = `worker was ${hz}/s`;
      stats.where += '*';   // * = auto-switched from a slow worker (see stats.switched)
      handSwipe = SWIPE_GESTURE && stats.hands ? makeHandSwipeDetector() : null;
      stats.swipe = handSwipe ? 'hands+motion' : swipe ? 'motion' : 'off';
      resN = 0; resT0 = performance.now(); stats.handHz = 0;
      if (liteDet) liteLoop();
    }, 6000);
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
          stats.workerGL = m.gl || '?';
          if (m.webgpuErr) { stats.webgpuErr = m.webgpuErr; console.warn('[glass] WebGPU hands unavailable:', m.webgpuErr); }
          w.onmessage = onWorkerMessage;
          resolve(w);
        } else if (m.type === 'error') { clearTimeout(to); reject(new Error(m.message)); }
      };
      w.postMessage({ type: 'init', base: MP_BASE, delegate, hands: SWIPE_ON, handEngine: HAND_ENGINE, tfBase: TF_BASE });
    });
  }

  function onWorkerMessage(ev) {
    const m = ev.data;
    if (m.type !== 'result') return;
    busy = false;
    recordMs(m.ms);
    const b = m.box;
    if (b !== undefined) measure(b ? { cx: (b.originX + b.width / 2) / m.w, cy: (b.originY + b.height / 2) / m.h, size: b.width / m.w } : null);
    if (m.faces) { G.faces = m.faces; G.facesT = performance.now(); }
    const now = performance.now();
    resN++;
    if (now - resT0 >= 1000) { stats.handHz = Math.round((resN * 1000) / (now - resT0)); resN = 0; resT0 = now; }
    processHands(m.hands || [], now, m.w && m.h ? m.h / m.w : 0.5625, m.ts);
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
    clearTimeout(workerCheck);
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
    if (armed || hold.active) { armed = false; hold.active = false; hold.latched = false; onGesture('paused', 0); }
    if (cur.visible) { cur.visible = false; onCursor({ visible: false }); }
    if (debug) { debug.remove(); debug = null; }
    target.x = target.y = target.z = 0;
    // smoothLoop keeps easing pose back to zero, then ends.
  }

  // ── Measurement ──────────────────────────────────────────────────────────
  // Driven by new camera frames where the browser supports it, so a frame is
  // never analysed twice; otherwise a timer.
  let camN = 0, camT0 = 0;
  function countCam() {
    const now = performance.now();
    camN++;
    if (!camT0) camT0 = now;
    if (now - camT0 >= 1000) { stats.camHz = Math.round((camN * 1000) / (now - camT0)); camN = 0; camT0 = now; }
  }
  function loop() {
    if (!G.on || !video) return;
    // Driven by new camera frames, so every rate downstream is capped by the
    // camera's actual frame rate (stats.camHz) - which drops in dim light.
    if (video.requestVideoFrameCallback) video._vfc = video.requestVideoFrameCallback(() => { countCam(); tick(); loop(); });
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
      const withFace = !handSwipe || (++frameN % FACE_EVERY === 0);
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
    const withFace = !handLm || (++frameN % FACE_EVERY === 0);
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
            return { x: x / 5, y: y / 5, score: hd ? hd.score : 0, label: hd ? hd.categoryName : '', lm: lm.map((q) => [q.x, q.y]) };
          });
        }
        const res = withFace ? detector.detectForVideo(src, now) : { detections: [] };
        recordMs(performance.now() - t0);
        if (handLm) {
          resN++;
          if (now - resT0 >= 1000) { stats.handHz = Math.round((resN * 1000) / (now - resT0)); resN = 0; resT0 = now; }
        }
        let best = null;
        // Box is in the pixels of the frame we fed in (possibly the shrunken copy).
        const vw = src.videoWidth || src.width, vh = src.videoHeight || src.height;
        const faces = [];
        for (const d of res.detections || []) {
          const b = d.boundingBox;
          if (!best || b.width * b.height > best.width * best.height) best = b;
          faces.push({ x: (b.originX + b.width / 2) / vw, y: (b.originY + b.height / 2) / vh, w: b.width / vw, s: d.categories && d.categories[0] ? d.categories[0].score : 0 });
        }
        if (withFace) { G.faces = faces; G.facesT = performance.now(); }
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
        return { x: x / 5 / sw, y: y / 5 / sh, score: h.score || 0, label: h.handedness || '', lm: k.map((q) => [q.x / sw, q.y / sh]) };
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
  // FIST_ON / FIST_OFF: curl thresholds (closed enough to grab / open enough to
  // let go). Kept close together so a half-opened hand doesn't keep holding.
  // UPRIGHT_DEG: only fists held upright count (wrist below the knuckles, hand
  // within this angle of vertical) - a hand tilting or turning as it opens
  // stops counting at once.
  // Gestures v2 (default): an open palm drives an on-screen hand cursor, and a
  // pinch (index to thumb, either hand) clicks under it; a fist grabs. ?gestures=v1 = the palm-hold version (tag
  // gestures-v1). X0..X1 / Y0..Y1: the part of the camera frame that maps to
  // the whole screen, so reaching the edges doesn't need a full arm stretch.
  const GESTURES_V1 = qs.get('gestures') === 'v1';
  const CURSOR = { X0: 0.2, X1: 0.8, Y0: 0.15, Y1: 0.7 };
  const cur = { x: 0.5, y: 0.5, visible: false };
  let onCursor = () => {}, onClick = () => {};

  // Starting a grab is deliberate: a tight fist (FIST_ON), upright, held still
  // (within HOLD_DRIFT, on the smoothed hand) for HOLD_MS AND seen closed in MIN_FRAMES hand results
  // in a row - a hand passing through a half-closed pose, or one stray frame,
  // never grabs. ?grabhold=<ms> tunes the hold.
  const GRAB = { FIST_ON: 1.1, FIST_OFF: 1.35, UPRIGHT_DEG: 35, OPEN_MS: 200, LOST_MS: 750, AFTER_MS: 900, DEBOUNCE: 2,
    HOLD_MS: Math.max(0, parseInt(qs.get('grabhold'), 10) || 300), HOLD_DRIFT: 0.04, MIN_FRAMES: 2,
    MAX_SPEED: 2.5, MAX_STEP: 0.3, MAX_ZOOM_STEP: 0.35 };
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

  /** Is the hand upright? Wrist below the middle knuckle, and the wrist ->
   *  knuckle direction within UPRIGHT_DEG of straight up. */
  function handUpright(lm, aspect) {
    const dx = lm[9][0] - lm[0][0], dy = (lm[0][1] - lm[9][1]) * aspect;   // dy > 0: knuckle above wrist
    return dy > 0 && Math.atan2(Math.abs(dx), dy) * 180 / Math.PI < GRAB.UPRIGHT_DEG;
  }

  function updateGrab(palms, now, aspect) {
    const withLm = palms.filter((p) => p.lm);
    grab.curls = withLm.map((p) => curl(p.lm, aspect));
    grab.upright = withLm.map((p) => handUpright(p.lm, aspect));
    const thr = grab.on ? GRAB.FIST_OFF : GRAB.FIST_ON;
    const fists = withLm.filter((p, i) => grab.curls[i] < thr && grab.upright[i]);
    const mode = fists.length >= 2 ? 'zoom' : fists.length === 1 ? 'pan' : null;

    if (!mode) {
      grab.pendMode = null; grab.pendN = 0;
      // Seen but not an upright fist (opened, or turned/tilted): fast release.
      const openHand = grab.curls.length > 0;
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
          grab.pendMode = mode; grab.pendT0 = now; grab.pendX = c.x; grab.pendY = c.y; grab.pendFrames = 0;
        }
        grab.pendFrames = (grab.pendFrames || 0) + 1;
        if (now - grab.pendT0 < GRAB.HOLD_MS || grab.pendFrames < GRAB.MIN_FRAMES) return;
      }
    }
    grab.lastSeen = now;
    // Dragging follows the RAW palm centre: the globe's own spring smooths it,
    // so the landmark filter's lag would only be extra delay here.
    const rx = (p) => (p.rx != null ? p.rx : p.x), ry = (p) => (p.ry != null ? p.ry : p.y);
    const pt = mode === 'zoom' ? { x: (rx(fists[0]) + rx(fists[1])) / 2, y: (ry(fists[0]) + ry(fists[1])) / 2 } : { x: rx(fists[0]), y: ry(fists[0]) };
    const dist = mode === 'zoom' ? Math.hypot(rx(fists[0]) - rx(fists[1]), (ry(fists[0]) - ry(fists[1])) * aspect) : 0;
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
    let rejected = false;
    if (step > GRAB.MAX_STEP || step / dt > GRAB.MAX_SPEED) {
      grab.rejected = (grab.rejected || 0) + 1;
      dx = 0; dy = 0; rejected = true;      // too fast to be a drag: re-anchor, don't move
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
    onGrab('move', { mode, ratio: grab.ratio, dx, dy, rejected });
  }

  // ── Palm hold: arm / pause fist gestures ─────────────────────────────────
  // One open hand, fingers up, held roughly still for HOLD_MS turns fist
  // gestures on ("Ready"). They pause by themselves once no hand has been seen
  // for IDLE_MS - an open palm while Ready just lets go of the globe.
  // OPEN: curl above this = fingers clearly spread. The hand must also be
  // upright within GRAB.UPRIGHT_DEG (same rule as fists) - a tilted or waved
  // hand doesn't arm gestures.
  // v2 (hand cursor) also needs the palm seen open in MIN_FRAMES hand results
  // in a row and held V2_HOLD_MS - a hand passing by never switches it on.
  // ?palmhold=<ms> tunes it.
  const PALM = { OPEN: 1.7, HOLD_MS: 500, DRIFT: 0.09, GAP_MS: 350, IDLE_MS: 500,
    V2_HOLD_MS: Math.max(0, parseInt(qs.get('palmhold'), 10) || 600), MIN_FRAMES: 3 };
  const hold = { active: false, t0: 0, x: 0, y: 0, lastSeen: 0, latched: false, progress: 0 };
  let armed = false, onGesture = () => {};

  function upright(lm, aspect) {
    const size = Math.hypot(lm[0][0] - lm[9][0], (lm[0][1] - lm[9][1]) * aspect);
    return lm[12][1] < lm[0][1] - size * 0.5 / aspect;   // middle fingertip well above the wrist
  }

  function updatePalmHold(palms, now, aspect) {
    const withLm = palms.filter((p) => p.lm);
    const open = withLm.filter((p) => curl(p.lm, aspect) > PALM.OPEN && upright(p.lm, aspect) && handUpright(p.lm, aspect));
    if (armed) {
      if (hold.active) { hold.active = false; hold.progress = 0; onGesture('cancel', 0); }
      if (now - lastHandSeen > PALM.IDLE_MS) {
        armed = false; hold.latched = false;
        if (grab.on) releaseGrab(now, false);
        onGesture('paused', 1);
      }
      return;
    }
    if (open.length === 1 && !grab.on) {
      const p = open[0];
      hold.lastSeen = now;
      if (hold.latched) return;
      if (!hold.active || Math.hypot(p.x - hold.x, p.y - hold.y) > PALM.DRIFT) {
        // (Re)start the hold here - moving the hand around doesn't count.
        hold.active = true; hold.t0 = now; hold.x = p.x; hold.y = p.y; hold.frames = 0;
      }
      hold.frames = (hold.frames || 0) + 1;
      const need = GESTURES_V1 ? PALM.HOLD_MS : PALM.V2_HOLD_MS;
      hold.progress = Math.min(1, (now - hold.t0) / Math.max(1, need));
      if (!GESTURES_V1 && hold.frames < PALM.MIN_FRAMES) hold.progress = Math.min(hold.progress, 0.95);
      if (hold.progress < 1) onGesture('hold', hold.progress);
      if (hold.progress >= 1) {
        armed = true;
        hold.active = false; hold.latched = true; hold.progress = 0;
        onGesture('armed', 1);
      }
    } else if (now - hold.lastSeen > PALM.GAP_MS) {
      if (hold.active) { hold.active = false; hold.progress = 0; onGesture('cancel', 0); }
      if (!open.length) hold.latched = false;   // hand gone: the next hold may toggle again
    }
  }

  // ── Pinch (experimental): index fingertip to thumb tip ───────────────────
  // Right hand pinch = next outage, left hand = previous. Fires once on the
  // pinch (edge), must open again before the next; only while armed, never
  // from a fist. Distance is measured against the hand's own size.
  // Which hand is which: the model's own label is used as-is (swapped from the
  // first version after testing on the device). ?pinchswap=1 flips it back.
  // MIN_FRAMES: seen pinched in this many hand results in a row (one noisy
  // frame never clicks). STILL: the palm must be moving slower than this
  // (frame widths/s) - a click lands where the hand is pointing, not mid-sweep.
  const PINCH = { ON: 0.35, OFF: 0.6, HOLD_MS: 120, COOLDOWN_MS: 600, MIN_FRAMES: 2, STILL: 0.8 };
  const PINCH_SWAP = qs.get('pinchswap') === '1';
  const pinch = { left: { on: false, t0: 0, last: -Infinity }, right: { on: false, t0: 0, last: -Infinity }, ratios: [] };
  let onPinch = () => {};

  function viewerHand(label) {
    const l = String(label || '').toLowerCase();
    if (l !== 'left' && l !== 'right') return null;
    const mirrored = l === 'left' ? 'right' : 'left';
    return PINCH_SWAP ? mirrored : l;
  }

  function updatePinch(palms, now, aspect) {
    const seen = { left: false, right: false };
    pinch.ratios = [];
    for (const p of palms) {
      if (!p.lm) { pinch.ratios.push(null); continue; }
      const lm = p.lm;
      const size = Math.hypot(lm[0][0] - lm[9][0], (lm[0][1] - lm[9][1]) * aspect) || 1e-6;
      const ratio = Math.hypot(lm[4][0] - lm[8][0], (lm[4][1] - lm[8][1]) * aspect) / size;
      pinch.ratios.push(ratio);
      const hand = viewerHand(p.label);
      if (!hand) continue;
      seen[hand] = true;
      const st = pinch[hand];
      const isFist = curl(lm, aspect) < GRAB.FIST_OFF;
      if (!st.on) {
        if (ratio < PINCH.ON && !isFist) {
          if (!st.t0) { st.t0 = now; st.n = 0; }
          st.n = (st.n || 0) + 1;
          const still = !GESTURES_V1 ? (p.speed || 0) < PINCH.STILL : true;
          if (!still) { st.t0 = now; st.n = 1; }
          if (still && st.n >= PINCH.MIN_FRAMES && now - st.t0 >= PINCH.HOLD_MS && now - st.last >= PINCH.COOLDOWN_MS) {
            st.on = true; st.last = now; st.t0 = 0;
            // v2: a pinch (either hand) is an instant click under the cursor.
            if (armed && !grab.on) { if (GESTURES_V1) onPinch(hand); else onClick(); }
          }
        } else st.t0 = 0;
      } else if (ratio > PINCH.OFF) {
        st.on = false;
      }
    }
    // A hand that left the view resets.
    for (const h of ['left', 'right']) if (!seen[h]) { pinch[h].on = false; pinch[h].t0 = 0; }
  }

  /** Gestures v2: the hand cursor follows the palm centre (mirrored) - the
   *  wrist and knuckles, which barely move when the fingers pinch, so a click
   *  lands where the hand was pointing. */
  function updateCursor(palms, now, aspect, capT) {
    const hands = palms.filter((p) => p.lm);
    if (!hands.length || !armed) {   // paused: no hands on screen
      if (cur.visible && (!armed || now - lastHandSeen > 300)) { cur.visible = false; onCursor({ visible: false }); }
      return;
    }
    // Every hand in view gets a silhouette; the pointer stays with one of them
    // (the same hand as last time while it's still in view).
    const out = hands.map((p, i) => {
      const lm = p.lm, ids = [0, 5, 9, 13, 17];
      const cx = ids.reduce((a, k) => a + lm[k][0], 0) / ids.length;
      const cy = ids.reduce((a, k) => a + lm[k][1], 0) / ids.length;
      // The hand's shape: all 21 points around the palm centre, mirrored
      // (viewer's view), square pixels, in units of the hand's own size
      // (wrist to middle knuckle) so it's the same size at any distance.
      const size = Math.hypot(lm[0][0] - lm[9][0], (lm[0][1] - lm[9][1]) * aspect) || 1e-6;
      return {
        key: p.key || String(p.label || i),
        x: clamp((CURSOR.X1 - cx) / (CURSOR.X1 - CURSOR.X0), 0, 1),
        y: clamp((cy - CURSOR.Y0) / (CURSOR.Y1 - CURSOR.Y0), 0, 1),
        shape: lm.map((q) => [-(q[0] - cx) / size, (q[1] - cy) * aspect / size]),
        fist: grab.curls[i] != null && grab.curls[i] < GRAB.FIST_ON,
      };
    });
    const prim = out.find((h) => h.key === cur.key) || out[0];
    cur.key = prim.key; prim.primary = true;
    cur.x = prim.x; cur.y = prim.y; cur.visible = true;
    const arming = !grab.on && grab.pendMode ? Math.min(1, (now - grab.pendT0) / Math.max(1, GRAB.HOLD_MS)) : 0;
    onCursor({ visible: true, t: capT, x: cur.x, y: cur.y, hands: out, armed, grabbing: grab.on, arming });
  }

  /** Every hand result, from whichever engine, comes through here. */
  // ── Landmark smoothing: One Euro filter (Casiez et al., CHI 2012) ─────────
  // Low cutoff when the hand is still (kills jitter that reads as a half-fist
  // or a pinch), rising with speed so fast moves don't lag. Driven by the
  // frame's CAPTURE time, so uneven inference times don't look like motion.
  // Tuned for ~6 results/s: 0.5 Hz / beta 4 halves still-hand jitter with
  // ~30-70 ms lag (vs 60% jitter, 45-85 ms at the textbook 1.0 / 2.0).
  // ?handcutoff= (Hz) and ?handbeta= tune it.
  const EURO = { MIN_CUTOFF: parseFloat(qs.get('handcutoff')) || 0.5, BETA: parseFloat(qs.get('handbeta')) || 4.0, D_CUTOFF: 1.0, RESET_MS: 500 };
  const euroAlpha = (fc, dt) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
  function makeEuro() {
    let x = null, dx = 0;
    return (v, dt) => {
      if (x == null || !(dt > 0)) { x = v; dx = 0; return v; }
      const d = (v - x) / dt;
      dx += euroAlpha(EURO.D_CUTOFF, dt) * (d - dx);
      x += euroAlpha(EURO.MIN_CUTOFF + EURO.BETA * Math.abs(dx), dt) * (v - x);
      return x;
    };
  }
  const euroHands = new Map();   // key (handedness) -> { t, f: [42 filters], cx, cy }
  function smoothHands(palms, capT) {
    const used = new Set();
    const out = palms.map((p, i) => {
      if (!p.lm) return p;
      let key = String(p.label || i);
      if (used.has(key)) key += '#' + i;   // two hands with the same label: keep them apart
      used.add(key);
      let st = euroHands.get(key);
      if (!st || capT - st.t > EURO.RESET_MS) { st = { t: capT, f: p.lm.map(() => [makeEuro(), makeEuro()]) }; euroHands.set(key, st); }
      const dt = Math.max(0, (capT - st.t) / 1000);
      st.t = capT;
      const lm = p.lm.map((q, k) => [st.f[k][0](q[0], dt), st.f[k][1](q[1], dt)]);
      let x = 0, y = 0;
      for (const k of [0, 5, 9, 13, 17]) { x += lm[k][0]; y += lm[k][1]; }
      x /= 5; y /= 5;
      // Palm speed (frame widths per second) for gestures that need a steady hand.
      const speed = st.cx != null && dt > 0 ? Math.hypot(x - st.cx, y - st.cy) / dt : 0;
      st.cx = x; st.cy = y;
      return { ...p, x, y, rx: p.x, ry: p.y, lm, speed, key };
    });
    for (const [k, st] of euroHands) if (capT - st.t > EURO.RESET_MS * 4) euroHands.delete(k);
    return out;
  }

  function processHands(rawPalms, now, aspect, capT) {
    capT = capT || now;
    const palms = smoothHands(rawPalms, capT);
    // Debug (option 5): palm velocity from the hand model, same units as motion.
    if (palms.length && lastPalms.length) {
      const dt = Math.max(1, now - (processHands.t || now)) / 1000;
      stats.handVel = { x: -(palms[0].x - lastPalms[0].x) / dt, y: (palms[0].y - lastPalms[0].y) / dt };
    } else stats.handVel = null;
    processHands.t = now;
    lastPalms = palms;
    if (palms.length) lastHandSeen = now;
    updatePalmHold(palms, now, aspect || 0.5625);
    updatePinch(palms, now, aspect || 0.5625);
    // Fist grabs only while armed by a palm hold.
    if (armed) updateGrab(palms, now, aspect || 0.5625);
    else grab.curls = palms.filter((p) => p.lm).map((p) => curl(p.lm, aspect || 0.5625));
    if (!GESTURES_V1) updateCursor(palms, now, aspect || 0.5625, capT);
    // While grabbing (and just after), two-handed movement must not swipe.
    if (handSwipe) {
      const dir = handSwipe(grab.on ? [] : rawPalms, now);   // swipes want the raw, unsmoothed motion
      if (dir) emitSwipe(dir, 'hands');
    }
    if (debug) debug(palms);
  }

  /** Debug (option 4): what this browser offers for acceleration. */
  function platformInfo() {
    const ua = navigator.userAgent;
    const info = { roomos: /RoomOS|Cisco|Webex/i.test(ua), webgpu: !!navigator.gpu, webnn: !!navigator.ml, gl2: 'none' };
    try {
      const g = document.createElement('canvas').getContext('webgl2');
      if (g) { const d = g.getExtension('WEBGL_debug_renderer_info'); info.gl2 = String(d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)); }
    } catch (_) { info.gl2 = 'error'; }
    const m = ua.match(/Chrome\/([\d.]+)/);
    info.chrome = m ? m[1].split('.')[0] : '?';
    return info;
  }
  let platform = null;

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

  let neutral = null, lastMeasureT = 0;
  const vel = { x: 0, y: 0, z: 0 };

  /** Soft knee around zero, then a soft ceiling: smooth everywhere. */
  function shape(v) {
    const k = HEAD.KNEE;
    return Math.tanh(v - k * Math.tanh(v / k));
  }

  function measure(hit) {
    const now = performance.now();
    if (hit) {
      if (now - lastSeen > HEAD.RESET_MS) { calib = null; recent = []; neutral = null; }   // a new (or returning) viewer
      lastSeen = now;
      faceBox = hit.size ? { cx: hit.cx, cy: hit.cy, size: hit.size } : null;
      // Median of the last three detections: one bad frame can't pull it.
      recent.push(hit); if (recent.length > 3) recent.shift();
      const med = (k) => recent.map((h) => h[k]).sort((a, b) => a - b)[Math.floor(recent.length / 2)];
      hit = { cx: med('cx'), cy: med('cy'), size: med('size') };
      lastSize = hit.size;
      // Face position in the viewer's frame (+x = their right, +y = up), -1..1.
      // The camera faces the viewer, so their right is the image's left: mirror x.
      const fx = (0.5 - hit.cx) * 2, fy = (0.5 - hit.cy) * 2;
      const dt = Math.min(1, (now - (lastMeasureT || now)) / 1000);
      lastMeasureT = now;
      if (!neutral) neutral = { x: fx, y: fy };
      else {
        const a = 1 - Math.exp(-dt / HEAD.NEUTRAL_TAU);
        neutral.x += (fx - neutral.x) * a; neutral.y += (fy - neutral.y) * a;
      }
      target.x = shape((fx - neutral.x) * HEAD.GAIN);
      target.y = shape((fy - neutral.y) * HEAD.GAIN);
      if (hit.size) {
        // Distance (only used if lean-to-zoom is turned on): calibrate on the
        // first sightings, then compare. log2 keeps closer/further symmetric.
        if (!calib || calib.n !== undefined) {
          calib = calib || { n: 0, sum: 0 };
          calib.n++; calib.sum += hit.size;
          if (calib.n >= 6) calib = { size: calib.sum / calib.n };
          target.z = 0;
        } else {
          target.z = clamp(Math.log2(hit.size / calib.size), -1, 1.2);
        }
      }
    } else if (now - lastSeen > HEAD.LOST_MS) {
      target.x = target.y = target.z = 0;
    }
    pose.seen = now - lastSeen < HEAD.LOST_MS;
  }

  /** Critically damped springs toward the target, integrated per frame. */
  function smoothLoop() {
    cancelAnimationFrame(raf);
    let last = performance.now();
    const spring = (axis, hz, dt) => {
      const w = 2 * Math.PI * hz;
      vel[axis] += (w * w * (target[axis] - pose[axis]) - 2 * w * vel[axis]) * dt;
      pose[axis] += vel[axis] * dt;
    };
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      spring('x', HEAD.SPRING_HZ, dt);
      spring('y', HEAD.SPRING_HZ, dt);
      spring('z', HEAD.SPRING_Z_HZ, dt);
      const settled = Math.abs(pose.x) + Math.abs(pose.y) + Math.abs(pose.z)
        + Math.abs(vel.x) + Math.abs(vel.y) + Math.abs(vel.z) < 0.002;
      if (G.on || !settled) raf = requestAnimationFrame(tick);
      else { pose.x = pose.y = pose.z = 0; vel.x = vel.y = vel.z = 0; pose.seen = false; }
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
    const diag = { travel: 0, mass: 0, why: 'warming up', vx: 0, vy: 0, hz: 0 };
    const fn = (vid, now) => {
      g.drawImage(vid, 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H).data;
      const cur = new Uint8Array(N);
      for (let i = 0; i < N; i++) cur[i] = (px[i * 4] + 2 * px[i * 4 + 1] + px[i * 4 + 2]) >> 2;
      if (!prev) { prev = cur; return null; }
      let sum = 0;
      for (let i = 0; i < N; i++) sum += Math.abs(cur[i] - prev[i]);
      const thr = Math.max(18, (sum / N) * 2.5);
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (Math.abs(cur[i] - prev[i]) > thr) { sx += x; sy += y; n++; }
      }
      prev = cur;
      diag.mass = n / N;
      // Debug (option 5): motion centroid and its velocity, viewer's frame
      // (+x = their right), frame-widths per second - what a motion-driven
      // drag would see at this detector's ~16 Hz.
      if (n / N >= MOTION.MIN_MASS) {
        const cx = sx / n / W, cy = sy / n / H;
        if (diag.cx !== undefined && diag.t) {
          const dt = Math.max(1, now - diag.t) / 1000;
          diag.vx += ((-(cx - diag.cx) / dt) - diag.vx) * 0.5;
          diag.vy += (((cy - diag.cy) / dt) - diag.vy) * 0.5;
        }
        diag.cx = cx; diag.cy = cy; diag.t = now;
      } else { diag.vx *= 0.6; diag.vy *= 0.6; diag.cx = undefined; }
      diag.n = (diag.n || 0) + 1;
      if (!diag.t0) diag.t0 = now;
      if (now - diag.t0 >= 1000) { diag.hz = Math.round((diag.n * 1000) / (now - diag.t0)); diag.n = 0; diag.t0 = now; }
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
    // The picture keeps the camera's own shape (16:9 on a Desk Pro, 4:3 on many
    // laptops) - a fixed 4:3 box made 16:9 video look squeezed.
    const vw = (video && video.videoWidth) || 4, vh = (video && video.videoHeight) || 3;
    const W = 400, H = Math.round((W * vh) / vw), TXT = 166;
    platform = platform || platformInfo();
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
        const fist = grab.curls[i] !== undefined && grab.curls[i] < (grab.on ? GRAB.FIST_OFF : GRAB.FIST_ON) && (grab.upright || [])[i];
        g.fillStyle = fist ? '#f43f5e' : '#fff';
        g.beginPath(); g.arc(X(p.x), Y(p.y), fist ? 9 : 6, 0, 7); g.fill();
      });
      if (grab.on && palms.length >= 2) {
        g.strokeStyle = '#f43f5e'; g.lineWidth = 2; g.setLineDash([6, 5]);
        g.beginPath(); g.moveTo(X(palms[0].x), Y(palms[0].y)); g.lineTo(X(palms[1].x), Y(palms[1].y)); g.stroke();
        g.setLineDash([]);
      }
      // Motion centroid (option 5): cyan dot with its velocity arrow.
      if (swipe && swipe.diag && swipe.diag.cx !== undefined) {
        const md0 = swipe.diag, mx = X(md0.cx), my = Y(md0.cy);
        g.strokeStyle = '#22d3ee'; g.fillStyle = '#22d3ee'; g.lineWidth = 2;
        g.beginPath(); g.arc(mx, my, 5, 0, 7); g.fill();
        g.beginPath(); g.moveTo(mx, my); g.lineTo(mx + md0.vx * W * 0.25, my + md0.vy * H * 0.25); g.stroke();
      }
      // Text panel.
      const d = handSwipe ? handSwipe.diag : null, md = swipe ? swipe.diag : null;
      g.fillStyle = '#0b1220'; g.fillRect(0, H, W, TXT);
      g.font = '12px ui-monospace,Menlo,monospace';
      const line = (i, t, col) => { g.fillStyle = col || '#9fe'; g.fillText(t, 8, H + 16 + i * 18); };
      const hz = stats.handHz || 0;
      line(0, `${stats.where} hands:${(stats.handDelegate || '-').toLowerCase()} ${hz}/s ${(stats.handMs || stats.ms).toFixed(0)}ms cam ${video.videoWidth}x${video.videoHeight}@${stats.camHz || '?'}fps`, hz < 8 ? '#fbbf24' : '#9fe');
      line(1, `hands ${palms.length}  ${palms.map((p, i) => {
        const c = grab.curls[i], pr = pinch.ratios[i], hnd = viewerHand(p.label);
        return (hnd ? hnd[0].toUpperCase() : '?') + ' ' + (c !== undefined ? c.toFixed(2) : '-') + ((grab.upright || [])[i] ? '\u2191' : '\u2715')
          + (pr !== null && pr !== undefined ? ' p' + pr.toFixed(2) : '');
      }).join('  ') || '-'}  face ${faceBox && pose.seen ? 'y' : 'n'}`);
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
      // Option 5: hand-model vs motion velocity (frame-widths/s) and rates.
      const hv = stats.handVel;
      g.fillStyle = '#22d3ee';
      g.fillText(`vel motion ${md ? md.vx.toFixed(2) + ',' + md.vy.toFixed(2) + ' @' + (md.hz || 0) + 'Hz' : '-'}  hand ${hv ? hv.x.toFixed(2) + ',' + hv.y.toFixed(2) : '-'} @${hz}Hz`, 8, H + 124);
      // Option 4: platform acceleration.
      const p4 = platform;
      g.fillStyle = '#c4b5fd';
      g.fillText(`roomos:${p4.roomos ? 'y' : 'n'} chrome ${p4.chrome} webgpu:${p4.webgpu ? 'y' : 'n'} webnn:${p4.webnn ? 'y' : 'n'}`, 8, H + 142);
      g.fillText(stats.webgpuErr ? `webgpu hands failed: ${stats.webgpuErr.slice(0, 40)}`
        : `gl main: ${p4.gl2.slice(0, 26)} | wrk: ${(stats.workerGL || '-').slice(0, 20)}`, 8, H + 160);
      const ls = stats.lastSwipe;
      const recent = ls && performance.now() - ls.t < 1500;
      g.fillStyle = armed ? '#34d399' : '#fbbf24';
      g.fillText(armed ? `gestures: READY (pauses after ${PALM.IDLE_MS / 1000}s with no hands)` : 'gestures: paused (palm 0.5s = ready)', 8, H + 88);
      if (hold.active) { line(5, `palm hold ${Math.round(hold.progress * 100)}%`, '#34d399'); return; }
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
