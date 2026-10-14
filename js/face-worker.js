/* Face detection off the main thread, so inference never stalls the globe.
 *
 * Classic worker (not module): MediaPipe's loader calls importScripts(), which
 * module workers don't allow. Its CommonJS build is loaded with a tiny shim.
 *
 * in:  { type: 'init', base, delegate }          -> { type: 'ready', delegate } | { type: 'error', message }
 *      { type: 'frame', bitmap, ts }  (transfer) -> { type: 'result', box | null, ms, w, h }
 */
/* global importScripts, FilesetResolver, FaceDetector */
'use strict';

let detector = null;

async function init(base, want) {
  self.exports = {};
  self.module = { exports: self.exports };
  importScripts(base + 'vision_bundle_cjs.js');   // CommonJS build, renamed .js so every server sends a JS MIME type
  const { FilesetResolver, FaceDetector } = self.module.exports.FilesetResolver ? self.module.exports : self.exports;
  const files = await FilesetResolver.forVisionTasks(base + 'wasm');
  // GPU (WebGL in an OffscreenCanvas) is much faster where the device allows
  // it; fall back to CPU, which works everywhere.
  const order = want === 'cpu' ? ['CPU'] : ['GPU', 'CPU'];
  let lastErr;
  for (const delegate of order) {
    try {
      detector = await FaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: base + 'blaze_face_short_range.tflite', delegate },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
      });
      return delegate;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Face detector failed to initialise');
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    try {
      const delegate = await init(m.base, m.delegate);
      self.postMessage({ type: 'ready', delegate });
    } catch (e) {
      self.postMessage({ type: 'error', message: String((e && e.message) || e) });
    }
    return;
  }
  if (m.type === 'frame') {
    const bmp = m.bitmap;
    let box = null, ms = 0;
    try {
      const t0 = performance.now();
      const res = detector.detectForVideo(bmp, m.ts);
      ms = performance.now() - t0;
      // "Main object" = the largest face, i.e. whoever is closest.
      for (const d of res.detections || []) {
        const b = d.boundingBox;
        if (!box || b.width * b.height > box.width * box.height) box = { originX: b.originX, originY: b.originY, width: b.width, height: b.height };
      }
    } catch (e) { /* drop the frame */ }
    const w = bmp.width, h = bmp.height;
    bmp.close();
    self.postMessage({ type: 'result', box, ms, w, h });
  }
};
