/* Glass mode (experimental): head-tracked parallax.
 *
 * The device camera finds the main subject in front of the screen - a face via
 * MediaPipe's BlazeFace detector, or, if that can't load, the centroid of
 * whatever is moving - and publishes where it is. app.js shifts the scene the
 * OPPOSITE way and turns the globe toward you, so the screen reads as a pane of
 * glass with the Earth floating behind it.
 *
 * Nothing leaves the device: frames are analysed in the page and dropped.
 * The camera only starts from an explicit tap (or ?glass=1), and stops on the
 * next tap, on page hide, or if the track ends (e.g. a call takes the camera).
 *
 * Exposes window.Glass = { start(), stop(), on, pose: {x, y, z, seen} }
 *   x, y  -1..1, the viewer's position from THEIR point of view (x+ = their right,
 *         y+ = up), smoothed.  z  >0 when leaning in.  seen  true while tracking.
 */
(function () {
  'use strict';

  const MP_BASE = new URL('../vendor/mediapipe/', document.currentScript.src).href;
  const DETECT_INTERVAL_MS = 66;   // ~15 Hz is plenty for parallax and spares the CPU
  const SMOOTH = 0.18;             // per-frame easing toward the measured pose
  const LOST_AFTER_MS = 1500;      // no subject for this long: drift back to centre

  const pose = { x: 0, y: 0, z: 0, seen: false };
  const target = { x: 0, y: 0, z: 0 };
  let stream = null, video = null, detector = null, motion = null;
  let timer = 0, raf = 0, lastSeen = 0, baselineSize = 0, onState = () => {};

  const G = {
    on: false, mode: null, pose,
    /** Called with ('starting' | 'face' | 'motion' | 'off' | 'error', detail). */
    onState(fn) { onState = fn; },
    start, stop,
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

    // Face detection first; fall back to motion if the model can't load here.
    try {
      const vision = await import(MP_BASE + 'vision_bundle.mjs');
      const files = await vision.FilesetResolver.forVisionTasks(MP_BASE + 'wasm');
      detector = await vision.FaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: MP_BASE + 'blaze_face_short_range.tflite', delegate: 'CPU' },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
      });
      G.mode = 'face';
    } catch (e) {
      console.warn('[glass] face detector unavailable, using motion tracking', e);
      motion = makeMotionTracker();
      G.mode = 'motion';
    }
    if (!G.on) { teardown(); return; }
    onState(G.mode);
    baselineSize = 0;
    detectLoop();
    smoothLoop();
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
    stopTracks();
    if (video) { video.srcObject = null; video = null; }
    if (detector) { try { detector.close(); } catch (_) { /* */ } detector = null; }
    motion = null; G.mode = null;
    target.x = target.y = target.z = 0;
    // Keep easing pose back to zero, then let the loop end.
  }

  // ── Measurement ──────────────────────────────────────────────────────────
  function detectLoop() {
    if (!G.on || !video) return;
    timer = setTimeout(detectLoop, DETECT_INTERVAL_MS);
    if (video.readyState < 2 || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    let hit = null;   // { cx, cy, size } in 0..1 image space
    try {
      if (detector) {
        const res = detector.detectForVideo(video, performance.now());
        // "Main object" = the largest face, i.e. whoever is closest.
        let best = null;
        for (const d of res.detections || []) {
          const b = d.boundingBox;
          if (!best || b.width * b.height > best.width * best.height) best = b;
        }
        if (best) hit = { cx: (best.originX + best.width / 2) / vw, cy: (best.originY + best.height / 2) / vh, size: best.width / vw };
      } else if (motion) {
        hit = motion(video);
      }
    } catch (e) {
      console.warn('[glass] detection error', e);
    }
    const now = performance.now();
    if (hit) {
      lastSeen = now;
      // The camera faces the viewer, so their right is the image's left: mirror x.
      target.x = clamp((0.5 - hit.cx) * 2.4, -1, 1);
      target.y = clamp((0.5 - hit.cy) * 2.4, -1, 1);
      if (hit.size) {
        baselineSize = baselineSize ? baselineSize + (hit.size - baselineSize) * 0.01 : hit.size;
        target.z = clamp((hit.size / baselineSize - 1) * 1.5, -0.6, 0.8);
      }
    } else if (now - lastSeen > LOST_AFTER_MS) {
      target.x = target.y = target.z = 0;
    }
    pose.seen = now - lastSeen < LOST_AFTER_MS;
  }

  function smoothLoop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      // Small deadzone so a seated, still viewer doesn't make the globe shimmer.
      const dz = (v) => (Math.abs(v) < 0.04 ? 0 : v);
      pose.x += (dz(target.x) - pose.x) * SMOOTH;
      pose.y += (dz(target.y) - pose.y) * SMOOTH;
      pose.z += (target.z - pose.z) * SMOOTH * 0.6;
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

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // Release the camera whenever the page is hidden (device sleeps, panel closed).
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.on) stop(); });
})();
