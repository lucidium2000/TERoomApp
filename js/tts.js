/* Spoken summaries with Kokoro (experimental). The model runs in
 * js/tts-worker.js; this side queues the audio it returns and plays it
 * through Web Audio, gap-free, as each sentence arrives.
 *
 * Off until the speaker button is pressed (so nothing big downloads on a
 * normal visit); turning it off unloads the model again. It never runs at
 * the same time as camera gestures (app.js switches one off for the other).
 *   tts=0          hide the speaker button
 *   ttsvoice=      a Kokoro voice (default af_heart; e.g. am_michael, bf_emma)
 *   ttsspeed=      0.5..2 (default 1)
 *   ttsdevice=     auto (WebGPU when available, else CPU) | webgpu | wasm
 *   ttsdtype=      fp32 | fp16 | q8 | q4 | q4f16 (default fp32 on WebGPU, q8 on CPU)
 *
 * window.Tts = { enabled, setEnabled(on), onChange(fn), speak(text), stop(), state, info, progress, stats }
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const AVAILABLE = qs.get('tts') !== '0';
  let enabled = false, onChange = () => {};
  const OPTS = {
    voice: qs.get('ttsvoice') || 'af_heart',
    speed: Math.max(0.5, Math.min(2, parseFloat(qs.get('ttsspeed')) || 1)),
    device: qs.get('ttsdevice') || 'auto',
    dtype: qs.get('ttsdtype') || '',
  };
  const VOICES = ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bm_george', 'bm_fable'];
  const WORKER_URL = new URL('tts-worker.js' + (new URL(document.currentScript.src).search || ''), document.currentScript.src).href;

  let worker = null, state = 'off', info = null, progress = 0, error = '';
  let ctx = null, gain = null, playAt = 0, curId = 0, sources = [];
  const stats = [];   // per sentence: { chars, ms, sec, rtf }

  // Audio may only start after a user gesture; until then speech is skipped.
  function unlock() {
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        gain = ctx.createGain(); gain.gain.value = 0.9; gain.connect(ctx.destination);
      } catch (_) { ctx = null; }
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  ['pointerdown', 'keydown'].forEach((t) => window.addEventListener(t, unlock, { capture: true, passive: true }));

  function load() {
    if (worker) return;
    state = 'loading'; progress = 0; error = '';
    try { worker = new Worker(WORKER_URL, { type: 'module' }); } catch (e) { state = 'error'; error = String(e.message || e); return; }
    worker.onmessage = onMessage;
    worker.onerror = (e) => { state = 'error'; error = e.message || 'worker failed'; onChange(state); };
    worker.postMessage({ type: 'load', device: OPTS.device, dtype: OPTS.dtype });
  }

  function onMessage(e) {
    const m = e.data;
    if (m.type === 'progress') progress = m.total ? m.loaded / m.total : 0;
    else if (m.type === 'ready') { state = 'ready'; info = m; progress = 1; onChange(state); }
    else if (m.type === 'error') { if (state === 'loading') { state = 'error'; onChange(state); } error = m.message; console.warn('[tts]', m.message); }
    else if (m.type === 'chunk') {
      const sec = m.audio.length / m.rate;
      stats.push({ chars: m.text.length, ms: m.ms, sec, rtf: m.ms / 1000 / sec });
      if (stats.length > 30) stats.shift();
      if (m.id !== curId || !ctx) return;   // cancelled, or no user gesture yet
      const buf = ctx.createBuffer(1, m.audio.length, m.rate);
      buf.copyToChannel(m.audio, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(gain);
      const at = Math.max(ctx.currentTime + 0.03, playAt);
      src.start(at);
      playAt = at + buf.duration;
      sources.push(src);
      src.onended = () => { sources = sources.filter((s) => s !== src); };
    }
  }

  /** Turn speech on (loads the model) or off (stops and unloads it, giving
   *  the CPU and memory back). */
  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) load();
    else {
      stop();
      if (worker) { worker.terminate(); worker = null; }
      state = 'off'; progress = 0;
    }
    onChange(state);
  }

  /** Say this, cutting off whatever was being said (only while enabled). */
  function speak(text) {
    if (!text || !enabled) return;
    load();
    stop();
    curId++;
    worker.postMessage({ type: 'speak', id: curId, text, voice: OPTS.voice, speed: OPTS.speed });
  }
  function stop() {
    if (worker && curId) worker.postMessage({ type: 'stop', id: curId });
    curId++;
    for (const s of sources) { try { s.stop(); } catch (_) { /* already ended */ } }
    sources = []; playAt = 0;
  }

  window.Tts = {
    available: AVAILABLE, voices: VOICES, opts: OPTS,
    get enabled() { return enabled; }, setEnabled, onChange(fn) { onChange = fn; },
    speak, stop,
    setVoice(v) { OPTS.voice = v; },
    get state() { return state; }, get info() { return info; }, get progress() { return progress; },
    get error() { return error; }, get stats() { return stats; },
    get speaking() { return sources.length > 0; },
  };

})();
