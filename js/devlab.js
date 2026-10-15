/* Device Lab: what can a web page actually use on this device?
 *
 * Shown alongside the camera debug view (hold the camera button, or
 * ?camdebug=1). Read-only except for two opt-in buttons (microphone, camera
 * zoom test). The only network traffic is the small timing requests in the
 * Network section.
 *
 * Sections: Room (people, distance, light, motion - live), Sound (mic level,
 * noise floor, speech, pitch - opt-in), Camera (settings, capabilities incl.
 * PTZ, devices), Network (browser estimate + measured RTTs), Device (CPU,
 * memory, screen, GPU/WebGPU/WebNN, speech recognition, permissions).
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const HFOV = parseFloat(qs.get('hfov')) || 71;   // camera horizontal field of view (deg), assumed
  const FACE_W = 0.15;                              // average face width in metres

  let panel = null, timer = 0, sampleC = null, sampleG = null, prevLuma = null;
  const mic = { on: false, ctx: null, an: null, buf: null, fbuf: null, stream: null, peak: -100, floorHist: [], last: {} };
  const net = { running: false, results: null };
  let staticInfo = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = (k, v, cls) => `<div class="dl-row"><span>${esc(k)}</span><b class="${cls || ''}">${v}</b></div>`;

  // ── Room ────────────────────────────────────────────────────────────────
  function room() {
    const G = window.Glass;
    const fresh = G && performance.now() - (G.facesT || 0) < 2500;
    const faces = fresh ? (G.faces || []) : [];
    let html = row('people (faces)', `${faces.length}${faces.length ? '' : ' <i>(none in view)</i>'}`);
    if (faces.length) {
      const near = faces.reduce((a, b) => (b.w > a.w ? b : a));
      const d = (FACE_W / 2) / (near.w * Math.tan((HFOV * Math.PI / 180) / 2));
      html += row('nearest distance', `${d.toFixed(2)} m <i>(~${Math.round(d * 3.28)} ft, assumes ${HFOV}&deg; FOV)</i>`);
      html += row('all distances', faces.map((f) => ((FACE_W / 2) / (f.w * Math.tan((HFOV * Math.PI / 180) / 2))).toFixed(1) + 'm').join(' '));
      const pos = near.x < 0.33 ? 'their right' : near.x > 0.67 ? 'their left' : 'centre';
      html += row('nearest position', `${pos} <i>(x ${near.x.toFixed(2)}, y ${near.y.toFixed(2)})</i>`);
    }
    // Light and motion from a tiny copy of the camera frame.
    const v = G && G.video;
    if (v && v.videoWidth) {
      if (!sampleC) { sampleC = document.createElement('canvas'); sampleC.width = 32; sampleC.height = 18; sampleG = sampleC.getContext('2d', { willReadFrequently: true }); }
      sampleG.drawImage(v, 0, 0, 32, 18);
      const px = sampleG.getImageData(0, 0, 32, 18).data;
      const n = 32 * 18, luma = new Float32Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) { luma[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]; sum += luma[i]; }
      const mean = sum / n;
      let varSum = 0, diff = 0;
      for (let i = 0; i < n; i++) { varSum += (luma[i] - mean) ** 2; if (prevLuma) diff += Math.abs(luma[i] - prevLuma[i]); }
      prevLuma = luma;
      const light = Math.round((mean / 255) * 100);
      html += row('light level', `${light}% ${bar(light)} <i>${light < 20 ? 'dim - tracking may suffer' : light > 75 ? 'bright' : 'ok'}</i>`);
      html += row('contrast', `${Math.round(Math.sqrt(varSum / n))}`);
      html += row('motion', `${Math.round((diff / n / 255) * 1000) / 10}%`);
    } else html += row('camera', '<i>off</i>');
    return html;
  }

  const bar = (pct) => `<span class="dl-bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></span>`;

  // ── Sound ───────────────────────────────────────────────────────────────
  async function startMic() {
    try {
      mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      mic.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = mic.ctx.createMediaStreamSource(mic.stream);
      mic.an = mic.ctx.createAnalyser(); mic.an.fftSize = 2048; mic.an.smoothingTimeConstant = 0.3;
      src.connect(mic.an);
      mic.buf = new Float32Array(mic.an.fftSize); mic.fbuf = new Float32Array(mic.an.frequencyBinCount);
      mic.on = true; mic.err = null;
    } catch (e) { mic.err = e.name || String(e); }
    render();
  }
  function stopMic() {
    if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop());
    if (mic.ctx) mic.ctx.close();
    Object.assign(mic, { on: false, ctx: null, an: null, stream: null, peak: -100, floorHist: [] });
  }
  function sound() {
    if (!mic.on) {
      return row('microphone', mic.err ? `<span class="dl-bad">${esc(mic.err)}</span>` : '<i>off - tap Enable mic</i>');
    }
    mic.an.getFloatTimeDomainData(mic.buf);
    let rms = 0, pk = 0;
    for (const x of mic.buf) { rms += x * x; pk = Math.max(pk, Math.abs(x)); }
    rms = Math.sqrt(rms / mic.buf.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-6)), pkDb = 20 * Math.log10(Math.max(pk, 1e-6));
    mic.peak = Math.max(mic.peak - 1.5, pkDb);
    const now = performance.now();
    mic.floorHist.push({ t: now, db }); mic.floorHist = mic.floorHist.filter((h) => now - h.t < 15000);
    const floor = Math.min(...mic.floorHist.map((h) => h.db));
    mic.an.getFloatFrequencyData(mic.fbuf);
    const hz = mic.ctx.sampleRate / mic.an.fftSize;
    let best = -1, bestDb = -Infinity, voice = 0, all = 0;
    for (let i = 1; i < mic.fbuf.length; i++) {
      const p = 10 ** (mic.fbuf[i] / 10), f = i * hz;
      all += p; if (f >= 300 && f <= 3400) voice += p;
      if (f > 60 && f < 4000 && mic.fbuf[i] > bestDb) { bestDb = mic.fbuf[i]; best = f; }
    }
    const speaking = db > floor + 10 && voice / all > 0.6;
    const s = mic.stream.getAudioTracks()[0].getSettings();
    return row('level', `${db.toFixed(1)} dBFS ${bar((db + 70) / 70 * 100)}`)
      + row('peak (hold)', `${mic.peak.toFixed(1)} dBFS`)
      + row('noise floor (15 s)', `${floor.toFixed(1)} dBFS`)
      + row('voice activity', speaking ? '<span class="dl-ok">talking</span>' : 'quiet')
      + row('dominant pitch', best > 0 && db > floor + 6 ? `${Math.round(best)} Hz` : '-')
      + row('mic settings', `${s.sampleRate || mic.ctx.sampleRate} Hz, ${s.channelCount || '?'} ch, AEC ${s.echoCancellation ? 'on' : 'off'}`);
  }

  // ── Camera ──────────────────────────────────────────────────────────────
  function camera() {
    const G = window.Glass, tr = G && G.track;
    let html = '';
    if (tr) {
      const st = tr.getSettings ? tr.getSettings() : {};
      const cap = tr.getCapabilities ? tr.getCapabilities() : {};
      html += row('label', esc(tr.label || '?'));
      html += row('delivering', `${st.width}x${st.height} @ ${st.frameRate ? Math.round(st.frameRate) : '?'} fps, ${st.facingMode || 'facing ?'}`);
      if (cap.width) html += row('max', `${cap.width.max}x${cap.height ? cap.height.max : '?'} @ ${cap.frameRate ? Math.round(cap.frameRate.max) : '?'} fps`);
      const ptz = ['pan', 'tilt', 'zoom'].filter((k) => cap[k]);
      html += row('PTZ', ptz.length ? `<span class="dl-ok">${ptz.map((k) => `${k} ${cap[k].min}..${cap[k].max}`).join(', ')}</span>` : 'not exposed');
      const modes = ['exposureMode', 'focusMode', 'whiteBalanceMode'].filter((k) => cap[k]).map((k) => `${k.replace('Mode', '')}: ${cap[k].join('/')}`);
      html += row('controls', modes.length ? esc(modes.join(' | ')) : 'none exposed');
      const others = Object.keys(cap).filter((k) => !['width', 'height', 'frameRate', 'aspectRatio', 'facingMode', 'deviceId', 'groupId', 'resizeMode', 'pan', 'tilt', 'zoom', 'exposureMode', 'focusMode', 'whiteBalanceMode'].includes(k));
      if (others.length) html += row('other caps', esc(others.join(', ')));

    } else html += row('camera', '<i>off</i>');
    if (staticInfo && staticInfo.devices) html += row('devices', esc(staticInfo.devices));
    return html;
  }
  async function zoomStep(dir) {
    const tr = window.Glass && window.Glass.track;
    if (!tr) return;
    const cap = tr.getCapabilities(), st = tr.getSettings();
    const step = (cap.zoom.max - cap.zoom.min) / 6 || 1;
    const z = Math.max(cap.zoom.min, Math.min(cap.zoom.max, (st.zoom || cap.zoom.min) + dir * step));
    try { await tr.applyConstraints({ advanced: [{ zoom: z }] }); } catch (e) { /* not allowed */ }
  }

  // ── Network ─────────────────────────────────────────────────────────────
  async function runNet() {
    if (net.running) return;
    net.running = true; render();
    const targets = [
      ['data (GitHub raw)', 'https://raw.githubusercontent.com/'],
      ['app (GitHub Pages)', location.origin + '/'],
      ['thousandeyes.com', 'https://www.thousandeyes.com/favicon.ico'],
      ['webex.com', 'https://www.webex.com/favicon.ico'],
    ];
    const out = [];
    for (const [name, url] of targets) {
      const times = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        try { await fetch(url + (url.includes('?') ? '&' : '?') + 'rtt=' + Date.now() + i, { mode: 'no-cors', cache: 'no-store' }); times.push(performance.now() - t0); }
        catch (e) { times.push(null); }
      }
      const ok = times.filter((t) => t != null).sort((a, b) => a - b);
      out.push([name, ok.length ? `min ${Math.round(ok[0])} ms, median ${Math.round(ok[Math.floor(ok.length / 2)])} ms` : '<span class="dl-bad">failed</span>']);
    }
    net.results = out; net.running = false; render();
  }
  function network() {
    const c = navigator.connection;
    let html = row('online', navigator.onLine ? 'yes' : '<span class="dl-bad">no</span>');
    html += row('browser estimate', c ? `${c.effectiveType || '?'}${c.type ? ' / ' + c.type : ''}, ~${c.downlink ?? '?'} Mbps, rtt ~${c.rtt ?? '?'} ms` : 'not exposed');
    if (net.results) for (const [k, v] of net.results) html += row(k, v);
    return html;
  }

  // ── Device (collected once) ─────────────────────────────────────────────
  async function collectStatic() {
    const ua = navigator.userAgent;
    const info = {
      roomos: (ua.match(/RoomOS[ /]?([\w.]+)?/) || [])[0] || (/(Cisco|Webex)/i.test(ua) ? 'Cisco UA' : 'no'),
      chrome: (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '?',
      cores: navigator.hardwareConcurrency || '?',
      memory: navigator.deviceMemory ? navigator.deviceMemory + ' GB (bucketed)' : 'not exposed',
      screen: `${screen.width}x${screen.height} @${devicePixelRatio}x, viewport ${innerWidth}x${innerHeight}`,
      touch: navigator.maxTouchPoints,
      speech: (window.SpeechRecognition || window.webkitSpeechRecognition) ? 'API present' : 'no',
      webnn: navigator.ml ? 'yes' : 'no',
      wakeLock: 'wakeLock' in navigator ? 'yes' : 'no',
    };
    try {
      const g = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
      const d = g && g.getExtension('WEBGL_debug_renderer_info');
      info.webgl = g ? `${g instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1'}: ${d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)} (max tex ${g.getParameter(g.MAX_TEXTURE_SIZE)})` : 'none';
    } catch (_) { info.webgl = 'error'; }
    if (navigator.gpu) {
      try {
        const a = await navigator.gpu.requestAdapter();
        const ai = a && (a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null));
        info.webgpu = a ? `${ai ? [ai.vendor, ai.architecture, ai.device, ai.description].filter(Boolean).join(' / ') || 'adapter ok' : 'adapter ok'} (max buffer ${Math.round(a.limits.maxBufferSize / 1048576)} MB)` : 'no adapter';
      } catch (e) { info.webgpu = 'error: ' + (e.message || e); }
    } else info.webgpu = 'no';
    try {
      const est = await navigator.storage.estimate();
      info.storage = `${Math.round(est.quota / 1048576)} MB quota`;
    } catch (_) { info.storage = '?'; }
    const perms = [];
    for (const name of ['camera', 'microphone', 'geolocation', 'notifications']) {
      try { const p = await navigator.permissions.query({ name }); perms.push(`${name} ${p.state}`); } catch (_) { perms.push(`${name} ?`); }
    }
    info.perms = perms.join(', ');
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const by = (k) => devs.filter((d) => d.kind === k);
      const names = (k) => by(k).map((d) => d.label || '(unlabelled)').join('; ');
      info.devices = `${by('videoinput').length} cam [${names('videoinput')}], ${by('audioinput').length} mic, ${by('audiooutput').length} speaker`;
    } catch (_) { info.devices = '?'; }
    staticInfo = info;
    render();
  }
  function device() {
    const i = staticInfo;
    if (!i) return row('collecting', '...');
    return row('RoomOS', esc(i.roomos)) + row('Chrome', esc(i.chrome)) + row('CPU cores', esc(i.cores))
      + row('memory', esc(i.memory)) + row('screen', esc(i.screen)) + row('touch points', esc(i.touch))
      + row('WebGL', esc(i.webgl)) + row('WebGPU', esc(i.webgpu)) + row('WebNN', esc(i.webnn))
      + row('speech recognition', esc(i.speech)) + row('wake lock', esc(i.wakeLock))
      + row('storage', esc(i.storage)) + row('permissions', esc(i.perms));
  }

  // ── Panel ───────────────────────────────────────────────────────────────
  function render() {
    if (!panel) return;
    // Buttons live in static bars (re-rendering them would eat taps); only labels/visibility change.
    const micBtn = panel.querySelector('[data-act="mic"]');
    micBtn.textContent = mic.on ? 'Stop mic' : 'Enable mic';
    panel.querySelector('[data-act="net"]').textContent = net.running ? 'Testing\u2026' : 'Run RTT test';
    const tr = window.Glass && window.Glass.track, cap = tr && tr.getCapabilities ? tr.getCapabilities() : {};
    panel.querySelector('[data-a="camera"]').hidden = !cap.zoom;
    panel.querySelector('[data-s="room"]').innerHTML = room();
    panel.querySelector('[data-s="sound"]').innerHTML = sound();
    panel.querySelector('[data-s="camera"]').innerHTML = camera();
    panel.querySelector('[data-s="net"]').innerHTML = network();
    panel.querySelector('[data-s="device"]').innerHTML = device();
  }
  function open() {
    if (panel) return;
    panel = document.createElement('section');
    panel.className = 'devlab';
    panel.innerHTML = '<h3>Device Lab</h3>'
      + ['Room|room|', 'Sound|sound|<button class="dl-btn" data-act="mic">Enable mic</button>',
        'Camera|camera|<button class="dl-btn" data-act="zoomin">Zoom +</button><button class="dl-btn" data-act="zoomout">Zoom -</button>',
        'Network|net|<button class="dl-btn" data-act="net">Run RTT test</button>', 'Device|device|']
        .map((x) => { const [t, k, acts] = x.split('|'); return `<h4>${t}</h4><div data-s="${k}"></div>${acts ? `<div class="dl-acts" data-a="${k}">${acts}</div>` : ''}`; }).join('');
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'mic') { if (mic.on) { stopMic(); render(); } else startMic(); }
      else if (a === 'net') runNet(); else if (a === 'zoomin') zoomStep(1); else if (a === 'zoomout') zoomStep(-1);
    });
    document.body.appendChild(panel);
    if (!staticInfo) collectStatic();
    render();
    timer = setInterval(render, 500);
  }
  function close() {
    if (!panel) return;
    clearInterval(timer); panel.remove(); panel = null; stopMic(); prevLuma = null;
  }

  // Follow the camera debug view.
  setInterval(() => {
    const G = window.Glass;
    if (G && G.on && G.debug) open(); else close();
  }, 500);
})();
