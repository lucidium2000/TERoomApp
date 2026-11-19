// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
/* Holiday mode (the Holiday button, or ?santa=1): Santa's sleigh and team
 * circle the globe, a North Star marks true north above the pole, light snow
 * falls, and a tagline sits at the top. Off by default; easy to remove (this
 * file, the button in index.html, one call in app.js's drawGlobe). */
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const btn = document.getElementById('holidayBtn');
  let on = false;
  try { on = localStorage.getItem('te-holiday') === '1'; } catch (_) { /* private mode */ }
  if (qs.has('santa')) on = qs.get('santa') !== '0';

  // ── Tagline ───────────────────────────────────────────────────────────
  const banner = document.createElement('div');
  banner.className = 'holiday-banner';
  banner.hidden = true;
  banner.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5l2.2 7.3 7.3 2.2-7.3 2.2L12 20.5l-2.2-7.3L2.5 11l7.3-2.2z"/></svg>'
    + '<p>Santa keeps watch while you sleep this December&hellip;<br><b>but ThousandEyes is your true north for visibility.</b></p>';
  document.body.appendChild(banner);

  function show() {
    banner.hidden = !on;
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('span').textContent = on ? 'Holiday: on' : 'Holiday: off';
  }
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      on = !on;
      try { localStorage.setItem('te-holiday', on ? '1' : '0'); } catch (_) { /* */ }
      try { if (window.Sfx) window.Sfx.play('tap'); } catch (_) { /* */ }
      show();
    });
  }
  show();

  // ── The sleigh and team, pre-drawn: 6 gallop frames ───────────────────
  const SW = 250, SH = 92, OX = 52, OY = 58, SC = 3;   // sprite size, sleigh centre, pixel scale
  const FRAMES = 6;
  let sprites = null;
  // The ThousandEyes logo on the side of the sleigh (sprites are rebuilt once it loads).
  const logo = new Image();
  logo.onload = () => { sprites = null; };
  logo.src = 'assets/te-logo.png';

  function reindeer(g, bx, by, ph, lead) {
    const leg = (x0, y0, a, col) => { g.strokeStyle = col; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + 10 * Math.cos(a), y0 + 10 * Math.sin(a)); g.stroke(); };
    g.lineCap = 'round'; g.lineWidth = 2.1;
    const s = Math.sin(ph);
    // far legs (darker), then body, then near legs
    leg(bx + 7, by + 3, 0.55 + 0.4 * Math.sin(ph + 0.6), '#5b3412');
    leg(bx - 8, by + 3, Math.PI - 0.55 - 0.4 * Math.sin(ph + 0.6 + Math.PI), '#5b3412');
    g.fillStyle = '#8a5523';
    g.beginPath(); g.ellipse(bx, by, 13, 6, -0.05, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#8a5523'; g.lineWidth = 4.2;   // neck
    g.beginPath(); g.moveTo(bx + 8, by - 2); g.lineTo(bx + 15, by - 11); g.stroke();
    g.beginPath(); g.ellipse(bx + 19, by - 12.5, 5.4, 3.2, 0.25, 0, Math.PI * 2); g.fill();   // head
    g.fillStyle = '#f8fafc'; g.beginPath(); g.arc(bx - 12.5, by - 2.5, 1.8, 0, Math.PI * 2); g.fill();   // tail
    g.fillStyle = lead ? '#fde047' : '#2b1608'; g.beginPath(); g.arc(bx + 24, by - 11.6, lead ? 1.6 : 1.1, 0, Math.PI * 2); g.fill();   // nose
    // antlers
    g.strokeStyle = '#e8cfa0'; g.lineWidth = 1.3;
    g.beginPath();
    g.moveTo(bx + 16, by - 15); g.lineTo(bx + 12, by - 24); g.moveTo(bx + 14, by - 19); g.lineTo(bx + 9, by - 21);
    g.moveTo(bx + 13, by - 22); g.lineTo(bx + 15, by - 27); g.moveTo(bx + 18, by - 15); g.lineTo(bx + 17, by - 23); g.moveTo(bx + 17, by - 20); g.lineTo(bx + 21, by - 23);
    g.stroke();
    g.lineWidth = 2.1;
    leg(bx + 9, by + 3, 0.45 + 0.4 * s, '#7a481c');
    leg(bx - 9, by + 3, Math.PI - 0.45 - 0.4 * Math.sin(ph + Math.PI), '#7a481c');
    // harness with a bell
    g.strokeStyle = '#b91c1c'; g.lineWidth = 2.2; g.beginPath(); g.moveTo(bx + 6, by - 5); g.lineTo(bx + 9, by + 4); g.stroke();
    g.fillStyle = '#facc15'; g.beginPath(); g.arc(bx + 9.5, by + 1, 1.5, 0, Math.PI * 2); g.fill();
  }

  function team(g, f) {
    const ph0 = (f / FRAMES) * Math.PI * 2;
    const deer = [72, 104, 136, 168].map((x, i) => ({ x, y: -6 - i * 3 + 1.6 * Math.sin(ph0 + i * 0.9), ph: ph0 + i * 0.9 }));
    // traces: sleigh front to each deer
    g.strokeStyle = 'rgba(250,204,21,.85)'; g.lineWidth = 1.1;
    g.beginPath(); g.moveTo(33, -1);
    deer.forEach((d) => { g.lineTo(d.x - 12, d.y + 1); g.moveTo(d.x + 7, d.y - 1); });
    g.stroke();
    // reins from Santa's hands
    g.strokeStyle = 'rgba(120,53,15,.9)'; g.lineWidth = 0.9;
    g.beginPath(); deer.forEach((d) => { g.moveTo(9, -15); g.quadraticCurveTo((9 + d.x) / 2, -18, d.x + 14, d.y - 9); }); g.stroke();
    deer.forEach((d, i) => reindeer(g, d.x, d.y, d.ph, i === 3));
    // the load: a ThousandEyes-orange sack and a couple of presents
    g.fillStyle = '#f15e22';
    g.beginPath(); g.ellipse(-25, -15, 10, 9.5, -0.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#c2410c'; g.beginPath(); g.ellipse(-28, -24.5, 3.5, 2.4, -0.3, 0, Math.PI * 2); g.fill();
    const gift = (x, y, sz, col, rib) => {
      g.fillStyle = col; g.fillRect(x, y, sz, sz);
      g.fillStyle = rib; g.fillRect(x + sz / 2 - 0.9, y, 1.8, sz); g.fillRect(x, y + sz / 2 - 0.9, sz, 1.8);
      g.strokeStyle = rib; g.lineWidth = 1.1; g.beginPath(); g.ellipse(x + sz / 2 - 2, y - 1.2, 2, 1.2, 0.4, 0, 6.3); g.ellipse(x + sz / 2 + 2, y - 1.2, 2, 1.2, -0.4, 0, 6.3); g.stroke();
    };
    gift(-35, -14, 9, '#16a34a', '#fde047');
    gift(-21, -12, 7, '#2563eb', '#f8fafc');
    // Santa, a size up: waving with one hand, reins in the other
    const wave = ph0;
    g.save(); g.translate(-2, -6); g.scale(1.35, 1.35); g.translate(2, 6);
    const arm = (x0, y0, x1, y1) => {
      g.strokeStyle = '#dc2626'; g.lineWidth = 3.4; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.fillStyle = '#1f2937'; g.beginPath(); g.arc(x1, y1, 1.9, 0, Math.PI * 2); g.fill();
    };
    const wa = -2.0 + 0.45 * Math.sin(wave);   // waving arm angle
    arm(-5, -20, -5 + 9 * Math.cos(wa), -20 + 9 * Math.sin(wa));
    g.fillStyle = '#dc2626'; g.beginPath(); g.ellipse(-2, -14, 9.5, 10.5, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f8fafc'; g.fillRect(5.2, -22, 2.2, 16);   // coat trim
    g.fillStyle = '#111827'; g.fillRect(-11, -11.5, 19, 3);   // belt
    g.strokeStyle = '#facc15'; g.lineWidth = 1; g.strokeRect(1.5, -12.3, 4, 4.6);   // buckle
    arm(3, -17, 10, -15);   // reins hand
    g.fillStyle = '#fde2c8'; g.beginPath(); g.arc(1.5, -26.5, 4.4, 0, Math.PI * 2); g.fill();   // face
    g.fillStyle = 'rgba(244,114,182,.75)'; g.beginPath(); g.arc(4, -25.3, 1.4, 0, Math.PI * 2); g.fill();   // rosy cheek
    g.fillStyle = '#f8fafc';
    g.beginPath(); g.moveTo(-2.5, -25); g.quadraticCurveTo(1, -23, 7, -24); g.quadraticCurveTo(7, -17, 2, -15.5); g.quadraticCurveTo(-3, -18, -2.5, -25); g.fill();   // beard
    g.beginPath(); g.ellipse(4.6, -24.4, 2.4, 1.1, -0.2, 0, Math.PI * 2); g.fill();   // moustache
    g.fillStyle = '#1f2937'; g.beginPath(); g.arc(3.4, -27.6, 0.75, 0, Math.PI * 2); g.fill();   // eye
    g.fillStyle = '#f8fafc'; g.fillRect(2.2, -29.4, 2.6, 0.8);   // eyebrow
    g.fillStyle = '#f87171'; g.beginPath(); g.arc(6, -26, 1.1, 0, Math.PI * 2); g.fill();   // nose
    const bob = 1.2 * Math.sin(wave + 1);
    g.fillStyle = '#dc2626'; g.beginPath(); g.moveTo(-4, -30); g.lineTo(6.5, -30.5); g.quadraticCurveTo(0, -39, -11, -35 + bob); g.closePath(); g.fill();   // hat
    g.fillStyle = '#f8fafc';
    if (g.roundRect) { g.beginPath(); g.roundRect(-4.8, -31.8, 12, 3.2, 1.5); g.fill(); } else g.fillRect(-4.8, -31.8, 12, 3.2);
    g.beginPath(); g.arc(-11.5, -34.5 + bob, 2.5, 0, Math.PI * 2); g.fill();   // pompom
    g.restore();
    // sleigh body
    g.fillStyle = '#b91c1c';
    g.beginPath();
    g.moveTo(-38, -16); g.quadraticCurveTo(-42, -1, -32, 8); g.lineTo(18, 8);
    g.quadraticCurveTo(32, 7, 31, -6); g.quadraticCurveTo(30, -11, 24, -9); g.lineTo(-24, -6);
    g.quadraticCurveTo(-26, -17, -38, -16); g.closePath(); g.fill();
    g.strokeStyle = '#facc15'; g.lineWidth = 1.4; g.stroke();
    g.lineWidth = 1; g.beginPath(); g.arc(-33, -9, 3, 0.3, Math.PI * 1.8); g.stroke();   // scroll on the back
    // runners
    g.strokeStyle = '#facc15'; g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(-36, 15); g.lineTo(26, 15); g.quadraticCurveTo(41, 15, 39, 5); g.quadraticCurveTo(37, -1, 32, 1);
    g.moveTo(-22, 8); g.lineTo(-22, 15); g.moveTo(12, 8); g.lineTo(12, 15);
    g.stroke();
  }

  function buildSprites() {
    // Right-facing and left-facing sets; mirrored by hand so the "TE" on the
    // sleigh still reads the right way round.
    sprites = { R: [], L: [] };
    for (const dir of ['R', 'L']) {
      for (let f = 0; f < FRAMES; f++) {
        const tmp = document.createElement('canvas'); tmp.width = SW * SC; tmp.height = SH * SC;
        const t = tmp.getContext('2d');
        if (dir === 'L') { t.translate(SW * SC, 0); t.scale(-SC, SC); } else t.scale(SC, SC);
        t.translate(OX, OY); team(t, f);
        t.setTransform(SC, 0, 0, SC, 0, 0);
        // Logo plaque, never mirrored so it always reads the right way round.
        const cx = dir === 'L' ? SW - OX + 1 : OX - 1, pw = 38, ph = 8.5;
        t.fillStyle = '#0b1424'; t.strokeStyle = '#facc15'; t.lineWidth = 0.7;
        t.beginPath();
        if (t.roundRect) t.roundRect(cx - pw / 2, OY - 2.5, pw, ph, 2.5); else t.rect(cx - pw / 2, OY - 2.5, pw, ph);
        t.fill(); t.stroke();
        if (logo.complete && logo.naturalWidth) {
          const lw = pw - 3.5, lh = lw * logo.naturalHeight / logo.naturalWidth;
          t.drawImage(logo, cx - lw / 2, OY - 2.5 + (ph - lh) / 2, lw, lh);
        }
        const c = document.createElement('canvas'); c.width = SW * SC; c.height = SH * SC;
        const g = c.getContext('2d');
        g.shadowColor = 'rgba(253,230,138,.55)'; g.shadowBlur = 10 * SC;   // soft glow, baked in
        g.drawImage(tmp, 0, 0);
        sprites[dir].push(c);
      }
    }
  }

  // ── Per-frame drawing on the overlay ──────────────────────────────────
  const PERIOD = 32000;   // ms per lap; half of it is behind the globe
  const sparks = [];
  let flakes = null;

  function snow(ctx, w, h, t) {
    if (!flakes) flakes = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.6, v: 0.012 + Math.random() * 0.02, ph: Math.random() * 6.28 }));
    ctx.fillStyle = 'rgba(241,245,249,.55)';
    ctx.beginPath();
    for (const f of flakes) {
      const y = ((f.y + (t / 1000) * f.v) % 1) * (h + 20) - 10;
      const x = (f.x * w + Math.sin(t / 1700 + f.ph) * 14 + w) % w;
      ctx.moveTo(x + f.r, y); ctx.arc(x, y, f.r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  function northStar(ctx, proj3, k, t) {
    const p = proj3([0, 0, 1.1]);
    if (!p) return;
    const pole = proj3([0, 0, 1.0]);
    if (pole) {
      const gr = ctx.createLinearGradient(p[0], p[1], pole[0], pole[1]);
      gr.addColorStop(0, 'rgba(253,230,138,.55)'); gr.addColorStop(1, 'rgba(253,230,138,0)');
      ctx.strokeStyle = gr; ctx.lineWidth = 1.4 * k; ctx.setLineDash([3 * k, 4 * k]);
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(pole[0], pole[1]); ctx.stroke(); ctx.setLineDash([]);
    }
    const tw = 0.85 + 0.15 * Math.sin(t / 420), R = 15 * k * tw;
    const gl = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], R * 2.2);
    gl.addColorStop(0, 'rgba(255,251,235,.9)'); gl.addColorStop(0.25, 'rgba(253,230,138,.35)'); gl.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(p[0], p[1], R * 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fffbeb';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? R * 0.18 : (i % 4 ? R * 0.6 : R);
      ctx[i ? 'lineTo' : 'moveTo'](p[0] + r * Math.cos(a), p[1] + r * Math.sin(a));
    }
    ctx.closePath(); ctx.fill();
    ctx.font = `800 ${Math.round(9 * k)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(1.6 * k).toFixed(1)}px`;
    ctx.fillStyle = 'rgba(253,230,138,.9)';
    ctx.fillText('TRUE NORTH', p[0] + R * 0.9, p[1] + R * 0.55);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  function sleigh(ctx, cam, proj3, k, t, w, h) {
    if (!sprites) buildSprites();
    const th = ((t % PERIOD) / PERIOD) * Math.PI * 2, tilt = 0.32, r = 1.32;
    const at = (a) => {
      const ca = Math.cos(a), sa = Math.sin(a);
      const w = [0, 1, 2].map((j) => r * (ca * cam.e[j] + sa * (Math.cos(tilt) * cam.c[j] + Math.sin(tilt) * cam.n[j])) + 0.12 * cam.n[j]);
      return proj3(w);
    };
    // Zoomed out: lap the globe (behind it half the time). Zoomed in, a lap
    // would be off-screen, so cross the top of the screen instead.
    let p, q;
    const orbit = cam.Rw * r < 0.62 * Math.min(w, h);
    if (orbit) { p = at(th); q = at(th + 0.03); }
    else {
      const u = (t % PERIOD) / (PERIOD * 0.55);   // crossing takes 55% of a lap, then a gap
      const xy = (v) => [w + 220 * k - v * (w + 440 * k), h * (0.34 - 0.09 * Math.sin(v * Math.PI))];
      if (u <= 1) { p = xy(u); q = xy(u + 0.002); }
    }
    const now = performance.now();
    drawTrail(ctx, k, now);
    if (!p || !q) { ribbon.length = 0; return; }
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const flip = dx < 0;
    const ang = (flip ? -1 : 1) * Math.atan2(dy, Math.abs(dx)) * 0.6;   // bank a little, never nose-dive
    const s = k * (orbit ? 0.78 + 0.37 * Math.sin(th) : 1.1);   // bigger as it comes toward you
    const f = Math.floor(now / 85) % FRAMES;
    const x = p[0], y = p[1] + Math.sin(now / 320) * 2.5 * k;   // a gentle bob
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const toScreen = (lx, ly) => [x + (flip ? -lx : lx) * s * cs - ly * s * sn, y + (flip ? -lx : lx) * s * sn + ly * s * cs];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.drawImage(sprites[flip ? 'L' : 'R'][f], -(flip ? SW - OX : OX) * s, -OY * s, SW * s, SH * s);
    ctx.restore();
    // trail from the back of the runners: a glowing ribbon plus sparkles
    const [ex, ey] = toScreen(-38, 15);
    ribbon.push({ x: ex, y: ey, t: now });
    const COLS = ['253,224,71', '255,255,255', '253,224,71', '248,113,113', '74,222,128', '125,211,252'];
    for (let i = 0; i < 3; i++) {
      sparks.push({ x: ex + (Math.random() - 0.5) * 8 * k, y: ey + (Math.random() - 0.5) * 6 * k, t: now, c: COLS[(Math.random() * COLS.length) | 0], star: Math.random() < 0.12, vy: 4 + Math.random() * 14 });
    }
    if (sparks.length > 260) sparks.splice(0, sparks.length - 260);
    // "Ho ho ho!" once a lap, while he's out in front
    const u = (t % PERIOD) / PERIOD, say = orbit ? u > 0.17 && u < 0.3 : u > 0.2 && u < 0.33;
    if (say) {
      const age = (u - (orbit ? 0.17 : 0.2)) * PERIOD, pop = Math.min(1, age / 220);
      const [hx, hy] = toScreen(2, -52);
      hoHoHo(ctx, hx, hy, k * (0.6 + 0.4 * pop) * (pop < 1 ? 1 + 0.15 * Math.sin(pop * Math.PI) : 1), Math.min(1, (0.13 * PERIOD - age) / 300));
    }
  }

  const ribbon = [];
  function drawTrail(ctx, k, now) {
    while (sparks.length && now - sparks[0].t > 1800) sparks.shift();
    while (ribbon.length && now - ribbon[0].t > 900) ribbon.shift();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = 1; i < ribbon.length; i++) {
      const a = 1 - (now - ribbon[i].t) / 900;
      ctx.strokeStyle = `rgba(253,224,71,${(0.35 * a).toFixed(3)})`;
      ctx.lineWidth = (1 + 5 * a) * k;
      ctx.beginPath(); ctx.moveTo(ribbon[i - 1].x, ribbon[i - 1].y); ctx.lineTo(ribbon[i].x, ribbon[i].y); ctx.stroke();
    }
    for (const sp of sparks) {
      const a = 1 - (now - sp.t) / 1800;
      const px = sp.x, py = sp.y + (1 - a) * sp.vy * k;
      ctx.fillStyle = `rgba(${sp.c},${(0.85 * a).toFixed(3)})`;
      if (sp.star) {
        const R = (2 + 3.5 * a) * k * (0.7 + 0.3 * Math.sin(now / 90 + sp.x));
        ctx.beginPath();
        for (let j = 0; j < 8; j++) { const an = (j / 8) * Math.PI * 2, rr = j % 2 ? R * 0.22 : R; ctx[j ? 'lineTo' : 'moveTo'](px + rr * Math.cos(an), py + rr * Math.sin(an)); }
        ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(px, py, (0.5 + 1.5 * a) * k, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  function hoHoHo(ctx, x, y, k, alpha) {
    if (alpha <= 0) return;
    const txt = 'Ho ho ho!';
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `800 ${Math.round(13 * k)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    const w = ctx.measureText(txt).width + 16 * k, h = 22 * k;
    ctx.fillStyle = '#fffbeb'; ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h, w, h, 10 * k); else ctx.rect(x - w / 2, y - h, w, h);
    ctx.moveTo(x - 4 * k, y); ctx.lineTo(x + 1 * k, y + 7 * k); ctx.lineTo(x + 5 * k, y);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#b91c1c'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, x, y - h / 2 + 0.5 * k);
    ctx.restore();
  }

  window.Santa = {
    get on() { return on; },
    /** Called by app.js after the other overlay layers (WebGL globe only). */
    draw(ctx, cam, proj3, k, w, h) {
      if (!on || !cam) return;
      const t = this.at != null ? this.at : performance.now();   // .at: freeze for screenshots
      try {
        ctx.save();
        snow(ctx, w, h, t);
        northStar(ctx, proj3, k, t);
        sleigh(ctx, cam, proj3, k, t, w, h);
        ctx.restore();
      } catch (e) {
        if (!this.warned) { this.warned = true; console.warn('[holiday]', e); }
      }
    },
  };
})();
