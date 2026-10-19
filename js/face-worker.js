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

let face = null, hands = null, tfHands = null;

/** TF.js MediaPipe Hands lite on the WebGPU backend - inside this worker, so
 *  even a slow first run can't stall the page, and WebGPU reads results back
 *  asynchronously (WebGL's blocking readback is what locked up a Desk Pro). */
async function initWebGPUHands(tfBase) {
  if (!self.navigator || !self.navigator.gpu) throw new Error('no WebGPU in this worker');
  // Load the UMD bundles BEFORE the CommonJS shim exists, so they attach to
  // self.tf / self.handPoseDetection rather than to the shim's exports.
  for (const f of ['tf-core.min.js', 'tf-converter.min.js', 'tf-backend-webgpu.min.js', 'hand-pose-detection.min.js']) importScripts(tfBase + f);
  const tf = self.tf, hpd = self.handPoseDetection;
  if (!(await tf.setBackend('webgpu'))) throw new Error('WebGPU backend unavailable');
  await tf.ready();
  const det = await hpd.createDetector(hpd.SupportedModels.MediaPipeHands, {
    runtime: 'tfjs', modelType: 'lite', maxHands: 2,
    detectorModelUrl: tfBase + 'hand-lite/detector/model.json',
    landmarkModelUrl: tfBase + 'hand-lite/landmark/model.json',
  });
  // Warm-up: the first run compiles the shaders.
  const z = tf.zeros([180, 320, 3], 'int32');
  try { await det.estimateHands(z); } finally { z.dispose(); }
  return det;
}

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

async function init(base, want, wantHands, handEngine, tfBase, handConf = 0.35) {
  let webgpuErr = null;
  if (wantHands && handEngine === 'webgpu') {
    try { tfHands = await initWebGPUHands(tfBase); } catch (e) { tfHands = null; webgpuErr = String((e && e.message) || e); }
  }
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
  let handsOk = !!tfHands, handDelegate = tfHands ? 'lite/webgpu' : null;
  if (wantHands && !tfHands) {
    try {
      const h = await create(HandLandmarker, files, {
        baseOptions: { modelAssetPath: base + 'hand_landmarker.task' },
        runningMode: 'VIDEO',
        numHands: 2,
        // Lenient, so a moving (blurred, partly hidden) hand stays tracked:
        // presence at handConf (0.35 by default), detection a little stricter
        // (new hands only, so fewer phantoms), tracking low - at a few results
        // a second a moving hand shifts a lot, and a lost track re-runs the
        // slower palm detector.
        minHandDetectionConfidence: Math.max(handConf, 0.4),
        minHandPresenceConfidence: handConf,
        minTrackingConfidence: Math.min(0.3, handConf),
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
  return { delegate: f.delegate, hands: handsOk, handDelegate, gl, webgpuErr };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    try {
      const r = await init(m.base, m.delegate, m.hands, m.handEngine, m.tfBase, m.handConf);
      self.postMessage({ type: 'ready', delegate: r.delegate, hands: r.hands, handDelegate: r.handDelegate, gl: r.gl, webgpuErr: r.webgpuErr });
    } catch (e) {
      self.postMessage({ type: 'error', message: String((e && e.message) || e) });
    }
    return;
  }
  if (m.type === 'frame') {
    const bmp = m.bitmap;
    let box = null, palms = [], ms = 0, faces = [];
    const t0 = performance.now();
    if (m.face !== false) try {
      const res = face.detectForVideo(bmp, m.ts);
      // "Main object" = the largest face, i.e. whoever is closest.
      for (const d of res.detections || []) {
        const b = d.boundingBox;
        if (!box || b.width * b.height > box.width * box.height) box = { originX: b.originX, originY: b.originY, width: b.width, height: b.height };
        faces.push({ x: (b.originX + b.width / 2) / bmp.width, y: (b.originY + b.height / 2) / bmp.height, w: b.width / bmp.width, s: d.categories && d.categories[0] ? d.categories[0].score : 0 });
      }
    } catch (e) { /* drop the frame */ }
    if (tfHands) {
      try {
        const tf = self.tf;
        const img = tf.browser.fromPixels(bmp);
        let res;
        try { res = await tfHands.estimateHands(img, { flipHorizontal: false }); } finally { img.dispose(); }
        const bw = bmp.width, bh = bmp.height;
        for (const h of res || []) {
          const k = h.keypoints;
          let x = 0, y = 0;
          for (const i of [0, 5, 9, 13, 17]) { x += k[i].x; y += k[i].y; }
          palms.push({ x: x / 5 / bw, y: y / 5 / bh, score: h.score || 0, label: h.handedness || '', lm: k.map((q) => [q.x / bw, q.y / bh]) });
        }
      } catch (e) { /* drop */ }
    } else if (hands) {
      try {
        const res = hands.detectForVideo(bmp, m.ts);
        (res.landmarks || []).forEach((lm, k) => {
          const ids = [0, 5, 9, 13, 17];
          let x = 0, y = 0;
          for (const i of ids) { x += lm[i].x; y += lm[i].y; }
          const hd = res.handedness && res.handedness[k] && res.handedness[k][0];
          palms.push({ x: x / ids.length, y: y / ids.length, score: hd ? hd.score : 0, label: hd ? hd.categoryName : '', lm: lm.map((q) => [q.x, q.y]) });
        });
      } catch (e) { /* drop */ }
    }
    ms = performance.now() - t0;
    const w = bmp.width, h = bmp.height;
    bmp.close();
    self.postMessage({ type: 'result', box: m.face === false ? undefined : box, faces: m.face === false ? undefined : faces, hands: palms, ms, w, h, ts: m.ts });
  }
};
