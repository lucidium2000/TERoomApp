/* Interface sounds: short, soft synthesized tones (Web Audio, no files).
 *
 * window.Sfx.play(name) - see SOUNDS below for the names.
 * Browsers only allow audio after a user gesture, so the context is created
 * on the first touch/click/key; until then play() is a silent no-op (a signage
 * screen nobody has touched stays quiet).
 *
 * URL: sound=0 mutes everything; volume=<0..2> scales it (default 1).
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const MUTED = qs.get('sound') === '0';
  const VOLUME = Math.max(0, Math.min(2, parseFloat(qs.get('volume')) || 1));
  const MASTER = 0.18 * VOLUME;          // keep it tasteful: everything sits low

  let ctx = null, master = null;
  function unlock() {
    if (MUTED || ctx) { if (ctx && ctx.state === 'suspended') ctx.resume(); return; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = MASTER;
      // A gentle low-pass takes the edge off every tone.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 6000;
      master.connect(lp).connect(ctx.destination);
    } catch (_) { ctx = null; }
  }
  ['pointerdown', 'keydown'].forEach((t) => window.addEventListener(t, unlock, { capture: true, passive: true }));

  /** One tone: soft attack, exponential release, optional pitch glide. */
  function tone(freq, dur, o = {}) {
    if (!ctx) return;
    const t0 = ctx.currentTime + (o.delay || 0);
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    const v = o.vol == null ? 1 : o.vol, a = o.attack || 0.006;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  /** Band-passed noise with a sweeping centre: a soft whoosh. */
  function whoosh(dur, from, to, vol) {
    if (!ctx) return;
    const t0 = ctx.currentTime, n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(from, t0); bp.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(master);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  const SOUNDS = {
    tap:      () => tone(1800, 0.035, { vol: 0.35 }),
    on:       () => { tone(660, 0.09, { vol: 0.5 }); tone(990, 0.12, { vol: 0.5, delay: 0.07 }); },
    off:      () => { tone(880, 0.09, { vol: 0.45 }); tone(587, 0.12, { vol: 0.45, delay: 0.07 }); },
    toggle:   () => { tone(740, 0.06, { vol: 0.4, type: 'triangle' }); tone(988, 0.07, { vol: 0.35, type: 'triangle', delay: 0.05 }); },
    select:   () => tone(420, 0.22, { to: 760, vol: 0.45, type: 'triangle', attack: 0.02 }),
    alert:    () => { tone(1760, 0.4, { vol: 0.4 }); tone(1318, 0.55, { vol: 0.4, delay: 0.22 }); },
    camOn:    () => { tone(523, 0.1, { vol: 0.45 }); tone(784, 0.1, { vol: 0.45, delay: 0.08 }); tone(1046, 0.16, { vol: 0.4, delay: 0.16 }); },
    camOff:   () => { tone(784, 0.1, { vol: 0.4 }); tone(523, 0.16, { vol: 0.4, delay: 0.08 }); },
    error:    () => { tone(180, 0.12, { vol: 0.35, type: 'square' }); tone(160, 0.16, { vol: 0.35, type: 'square', delay: 0.15 }); },
    ready:    () => { tone(1046, 0.12, { vol: 0.45 }); tone(1568, 0.25, { vol: 0.45, delay: 0.09 }); },
    pause:    () => tone(700, 0.14, { to: 420, vol: 0.25 }),
    grab:     () => tone(220, 0.06, { vol: 0.6, type: 'triangle' }),
    release:  () => tone(440, 0.05, { vol: 0.35, type: 'triangle' }),
    next:     () => tone(880, 0.08, { to: 1175, vol: 0.4 }),
    prev:     () => tone(880, 0.08, { to: 660, vol: 0.4 }),
    whoosh:   () => whoosh(0.45, 400, 2400, 0.55),
    open:     () => tone(520, 0.1, { to: 880, vol: 0.35 }),
    close:    () => tone(700, 0.08, { to: 440, vol: 0.3 }),
    reset:    () => tone(900, 0.25, { to: 450, vol: 0.3, type: 'triangle' }),
    zoom:     () => tone(500, 0.12, { to: 900, vol: 0.3, type: 'triangle' }),
  };

  // Rate limit per sound so bursts (e.g. many list re-renders) never stack up.
  const lastPlayed = {};
  window.Sfx = {
    play(name) {
      if (MUTED || !ctx || !SOUNDS[name]) return;
      if (ctx.state === 'suspended') ctx.resume();
      const now = performance.now();
      if (now - (lastPlayed[name] || 0) < 80) return;
      lastPlayed[name] = now;
      try { SOUNDS[name](); } catch (_) { /* never let sound break the UI */ }
    },
    get muted() { return MUTED; },
  };
})();
