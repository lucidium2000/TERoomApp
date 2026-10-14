/* Face + hand detection off the main thread, so inference never stalls the globe.
 *
 * Classic worker (not module): MediaPipe's loader calls importScripts(), which
 * module workers don't allow. Its CommonJS build is loaded with a tiny shim.
 *
 * in:  { type: 'init', base, delegate, hands }    -> { type: 'ready', delegate, hands } | { type: 'error', message }
 *      { type: 'frame', bitmap, ts, face } (transfer) -> { type: 'result', box | null | undefined, hands, ms, w, h }
 *
 * hands[] are { x, y, score, lm } - x/y the palm centre (mean of the wrist and
 * the four knuckles, steadier than the wrist alone during a fast swipe), lm the
 * 21 landmarks for the debug view, all in 0..1 image coordinates.
 * `face: false` skips face detection on that frame (box comes back undefined),
 * so hand tracking can run at the full rate.
 */
/* global importScripts */
'use strict';

let face = null, hands = null;

async function create(Task, files, opts, want) {
  // GPU (WebGL in an OffscreenCanvas) is much faster where the device allows
  // it; fall back to CPU, which works everywhere.
  let lastErr;
  for (const delegate of want === 'cpu' ? ['CPU'] : ['GPU', 'CPU']) {
    try {
      const t = await Task.createFromOptions(files, { ...opts, baseOptions: { ...opts.baseOptions, delegate } });
      return { task: t, delegate };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('MediaPipe task failed to initialise');
}

async function init(base, want, wantHands) {
  self.exports = {};
  self.module = { exports: self.exports };
  importScripts(base + 'vision_bundle_cjs.js');   // CommonJS build, renamed .js so every server sends a JS MIME type
  const { FilesetResolver, FaceDetector, HandLandmarker } = self.module.exports.FilesetResolver ? self.module.exports : self.exports;
  const files = await FilesetResolver.forVisionTasks(base + 'wasm');
  const f = await create(FaceDetector, files, {
    baseOptions: { modelAssetPath: base + 'blaze_face_short_range.tflite' },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.5,
  }, want);
  face = f.task;
  let handsOk = false, handDelegate = null;
  if (wantHands) {
    try {
      const h = await create(HandLandmarker, files, {
        baseOptions: { modelAssetPath: base + 'hand_landmarker.task' },
        runningMode: 'VIDEO',
        numHands: 2,
        // Lenient: a swiping hand is blurred and partly out of frame.
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.3,
      }, want);
      hands = h.task; handsOk = true; handDelegate = h.delegate;
    } catch (e) { /* face tracking still works without hands */ }
  }
  // What the worker's "GPU" really is (a software renderer shows up here).
  let gl = 'none';
  try {
    const g = new OffscreenCanvas(1, 1).getContext('webgl2') || new OffscreenCanvas(1, 1).getContext('webgl');
    if (g) { const d = g.getExtension('WEBGL_debug_renderer_info'); gl = String(d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)); }
  } catch (e) { gl = 'error'; }
  return { delegate: f.delegate, hands: handsOk, handDelegate, gl };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    try {
      const r = await init(m.base, m.delegate, m.hands);
      self.postMessage({ type: 'ready', delegate: r.delegate, hands: r.hands, handDelegate: r.handDelegate, gl: r.gl });
    } catch (e) {
      self.postMessage({ type: 'error', message: String((e && e.message) || e) });
    }
    return;
  }
  if (m.type === 'frame') {
    const bmp = m.bitmap;
    let box = null, palms = [], ms = 0;
    const t0 = performance.now();
    if (m.face !== false) try {
      const res = face.detectForVideo(bmp, m.ts);
      // "Main object" = the largest face, i.e. whoever is closest.
      for (const d of res.detections || []) {
        const b = d.boundingBox;
        if (!box || b.width * b.height > box.width * box.height) box = { originX: b.originX, originY: b.originY, width: b.width, height: b.height };
      }
    } catch (e) { /* drop the frame */ }
    if (hands) {
      try {
        const res = hands.detectForVideo(bmp, m.ts);
        (res.landmarks || []).forEach((lm, k) => {
          const ids = [0, 5, 9, 13, 17];
          let x = 0, y = 0;
          for (const i of ids) { x += lm[i].x; y += lm[i].y; }
          const hd = res.handedness && res.handedness[k] && res.handedness[k][0];
          palms.push({ x: x / ids.length, y: y / ids.length, score: hd ? hd.score : 0, lm: lm.map((q) => [q.x, q.y]) });
        });
      } catch (e) { /* drop */ }
    }
    ms = performance.now() - t0;
    const w = bmp.width, h = bmp.height;
    bmp.close();
    self.postMessage({ type: 'result', box: m.face === false ? undefined : box, hands: palms, ms, w, h });
  }
};
