/* Kokoro text-to-speech, in a module worker so the globe and gestures keep
 * running while it thinks (experimental: ?tts=1, or the Device Lab test).
 *
 * kokoro-js (Apache-2.0) runs the Kokoro-82M model with ONNX Runtime Web:
 * on WebGPU when the browser hands one out, otherwise on the CPU (WASM). The
 * library comes from jsDelivr and the model (~90 MB at q8) and voices from
 * Hugging Face; the browser caches them after the first load.
 *
 * In:  {type:'load', device:'auto'|'webgpu'|'wasm', dtype?}
 *      {type:'speak', id, text, voice, speed}   {type:'stop', id}
 * Out: {type:'progress', loaded, total}  {type:'ready', device, dtype, loadMs, threads}
 *      {type:'chunk', id, audio:Float32Array, rate, ms, text, last}  {type:'done', id}
 *      {type:'error', id?, message}
 */
const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts = null, loading = null;
const stopped = new Set();
const post = (m, transfer) => self.postMessage(m, transfer || []);

async function load({ device, dtype }) {
  const t0 = performance.now();
  const { KokoroTTS } = await import(KOKORO_URL);
  let dev = device && device !== 'auto' ? device : 'wasm';
  if (!device || device === 'auto') {
    try { if (self.navigator.gpu && (await self.navigator.gpu.requestAdapter())) dev = 'webgpu'; } catch (_) { /* no adapter */ }
  }
  // fp32 on the GPU; the 8-bit model on the CPU (a quarter of the size, faster there).
  const dt = dtype || (dev === 'webgpu' ? 'fp32' : 'q8');
  const files = {};
  tts = await KokoroTTS.from_pretrained(MODEL, {
    dtype: dt, device: dev,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.file) return;
      files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
      const all = Object.values(files);
      post({ type: 'progress', loaded: all.reduce((a, f) => a + f.loaded, 0), total: all.reduce((a, f) => a + f.total, 0) });
    },
  });
  const info = { device: dev, dtype: dt, loadMs: Math.round(performance.now() - t0), threads: self.crossOriginIsolated ? (self.navigator.hardwareConcurrency || 1) : 1 };
  post({ type: 'ready', ...info });
}

/** Sentences (and over-long sentences at commas), so the first one can play
 *  while the rest are still being generated. */
function chunks(text) {
  const out = [];
  for (const s of String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?;:])\s+/)) {
    if (s.length <= 220) { if (s) out.push(s); continue; }
    let cur = '';
    for (const part of s.split(/(?<=,)\s+/)) {
      if ((cur + ' ' + part).length > 220 && cur) { out.push(cur); cur = part; } else cur = cur ? cur + ' ' + part : part;
    }
    if (cur) out.push(cur);
  }
  return out;
}

async function speak({ id, text, voice, speed }) {
  if (!tts) { if (!loading) loading = load({}); await loading; }
  const parts = chunks(text);
  for (let i = 0; i < parts.length; i++) {
    if (stopped.has(id)) break;
    const t0 = performance.now();
    const out = await tts.generate(parts[i], { voice: voice || 'af_heart', speed: speed || 1 });
    if (stopped.has(id)) break;
    const audio = out.audio instanceof Float32Array ? out.audio : new Float32Array(out.audio);
    post({ type: 'chunk', id, audio, rate: out.sampling_rate, ms: Math.round(performance.now() - t0), text: parts[i], last: i === parts.length - 1 }, [audio.buffer]);
  }
  stopped.delete(id);
  post({ type: 'done', id });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    if (!loading) loading = load(m).catch((err) => { loading = null; post({ type: 'error', message: String((err && err.message) || err) }); });
  } else if (m.type === 'speak') {
    speak(m).catch((err) => post({ type: 'error', id: m.id, message: String((err && err.message) || err) }));
  } else if (m.type === 'stop') {
    stopped.add(m.id);
  }
};
