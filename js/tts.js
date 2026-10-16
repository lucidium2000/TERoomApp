/* Spoken summaries with Kokoro (experimental). The model runs in
 * js/tts-worker.js; this side queues the audio it returns and plays it
 * through Web Audio, gap-free, as each sentence arrives.
 *
 * Off until the speaker button is pressed (so nothing big downloads on a
 * normal visit); turning it off unloads the model again. It never runs at
 * the same time as camera gestures (app.js switches one off for the other).
 *   tts=0          hide the speaker button
 *   ttsvoice=      a Kokoro voice (default af_heart; or pick one by holding the speaker button)
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
  function savedVoice() { try { return localStorage.getItem('te-tts-voice') || ''; } catch (_) { return ''; } }
  let enabled = false, onChange = () => {};
  const OPTS = {
    // URL first, then the last voice picked on this device, then the default.
    voice: qs.get('ttsvoice') || savedVoice() || 'af_heart',
    speed: Math.max(0.5, Math.min(2, parseFloat(qs.get('ttsspeed')) || 1)),
    device: qs.get('ttsdevice') || 'auto',
    dtype: qs.get('ttsdtype') || '',
  };
  // Kokoro's English voices: a = American, b = British; f / m = female / male.
  const VOICES = ['af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
    'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
    'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'];
  const WORKER_URL = new URL('tts-worker.js' + (new URL(document.currentScript.src).search || ''), document.currentScript.src).href;

  let worker = null, state = 'off', info = null, progress = 0, error = '';
  let ctx = null, gain = null, playAt = 0, curId = 0, sources = [];
  // Speech in progress: genT0 = when the current request started (0 = none
  // pending), chunkT0 = when the sentence now being made started.
  let genT0 = 0, chunkT0 = 0;
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
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach((t) => window.addEventListener(t, unlock, { capture: true, passive: true }));

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
    else if (m.type === 'error') {
      error = m.message; console.warn('[tts]', m.message);
      if (state === 'loading') { state = 'error'; onChange(state); }
      else if (m.id === curId) { genT0 = 0; onChange('speakerror'); }
    }
    else if (m.type === 'done') { if (m.id === curId) { genT0 = 0; onChange('activity'); } }
    else if (m.type === 'chunk') {
      if (m.id === curId) chunkT0 = performance.now();
      const sec = m.audio.length / m.rate;
      stats.push({ chars: m.text.length, ms: m.ms, sec, rtf: m.ms / 1000 / sec });
      if (stats.length > 30) stats.shift();
      if (m.id !== curId) return;   // cancelled
      if (!ctx) { error = 'audio is locked until the screen is tapped'; onChange('speakerror'); return; }
      if (ctx.state === 'suspended') ctx.resume();
      const buf = ctx.createBuffer(1, m.audio.length, m.rate);
      buf.copyToChannel(m.audio, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(gain);
      const at = Math.max(ctx.currentTime + 0.03, playAt);
      src.start(at);
      playAt = at + buf.duration;
      sources.push(src);
      onChange('activity');
      src.onended = () => { sources = sources.filter((s) => s !== src); onChange('activity'); };
    }
  }

  /** Turn speech on (loads the model) or off (stops and unloads it, giving
   *  the CPU and memory back). */
  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) { unlock(); load(); }   // turned on by a tap: the moment audio may be unlocked
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
    genT0 = chunkT0 = performance.now();
    worker.postMessage({ type: 'speak', id: curId, text, voice: OPTS.voice, speed: OPTS.speed });
    onChange('activity');
  }
  function stop() {
    if (worker && curId) worker.postMessage({ type: 'stop', id: curId });
    curId++;
    for (const s of sources) { try { s.stop(); } catch (_) { /* already ended */ } }
    sources = []; playAt = 0; genT0 = 0;
  }

  window.Tts = {
    available: AVAILABLE, voices: VOICES, opts: OPTS,
    get enabled() { return enabled; }, setEnabled, onChange(fn) { onChange = fn; }, unlock,
    speak, stop,
    setVoice(v) { OPTS.voice = v; try { localStorage.setItem('te-tts-voice', v); } catch (_) { /* private mode */ } },
    get state() { return state; }, get info() { return info; }, get progress() { return progress; },
    get error() { return error; }, get stats() { return stats; },
    get speaking() { return sources.length > 0; },
    /** Still making speech for the current request (nothing or not all of it audible yet). */
    get generating() { return genT0 > 0; },
    /** Making or playing speech - the tour waits for this. */
    get busy() { return genT0 > 0 || sources.length > 0; },
    /** How long the sentence now being made has taken so far (ms), or 0. */
    get waitMs() { return genT0 ? performance.now() - chunkT0 : 0; },
  };

})();
