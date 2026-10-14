/* Face + hand detection off the main thread, so inference never stalls the globe.
 *
 * Classic worker (not module): MediaPipe's loader calls importScripts(), which
 * module workers don't allow. Its CommonJS build is loaded with a tiny shim.
 *
 * in:  { type: 'init', base, delegate, hands }    -> { type: 'ready', delegate, hands } | { type: 'error', message }
 *      { type: 'frame', bitmap, ts }  (transfer)  -> { type: 'result', box | null, hands: [{x, y}], ms, w, h }
 *
 * hands[] are palm centres (mean of the wrist and the four knuckles) in 0..1
 * image coordinates - steadier than the wrist alone during a fast swipe.
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
  let handsOk = false;
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
      hands = h.task; handsOk = true;
    } catch (e) { /* face tracking still works without hands */ }
  }
  return { delegate: f.delegate, hands: handsOk };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    try {
      const r = await init(m.base, m.delegate, m.hands);
      self.postMessage({ type: 'ready', delegate: r.delegate, hands: r.hands });
    } catch (e) {
      self.postMessage({ type: 'error', message: String((e && e.message) || e) });
    }
    return;
  }
  if (m.type === 'frame') {
    const bmp = m.bitmap;
    let box = null, palms = [], ms = 0;
    const t0 = performance.now();
    try {
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
        for (const lm of res.landmarks || []) {
          const ids = [0, 5, 9, 13, 17];
          let x = 0, y = 0;
          for (const i of ids) { x += lm[i].x; y += lm[i].y; }
          palms.push({ x: x / ids.length, y: y / ids.length });
        }
      } catch (e) { /* drop */ }
    }
    ms = performance.now() - t0;
    const w = bmp.width, h = bmp.height;
    bmp.close();
    self.postMessage({ type: 'result', box, hands: palms, ms, w, h });
  }
};
