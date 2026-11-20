// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
/* Layers panel: the option buttons at the top right (Power, Satellites, Subsea
 * cables, Place names, Holiday, Flights) folded into one "Layers" button that
 * opens a panel with an on/off switch per layer. Radar keeps its own button.
 * Each switch just presses the original button (still in the page, hidden), so
 * every layer behaves as before.
 *
 * Layers start fresh (their default) on every load unless "Keep" is ticked
 * beside the switch. This script loads before the others, so it can forget a
 * layer's saved state before that layer reads it. */
(function () {
  'use strict';
  // Each layer's own saved-state key (written by its script), by button label.
  const KEYS = {
    Power: 'te-power-on', Satellites: 'te-sky', 'Subsea cables': 'te-cables',
    'Place names': 'te-places', Holiday: 'te-holiday', Flights: 'te-flights',
  };
  const KEEP_KEY = 'te-layers-keep';
  let keep = new Set();
  try { keep = new Set(JSON.parse(localStorage.getItem(KEEP_KEY) || '[]')); } catch (_) { /* none */ }
  try { for (const [name, key] of Object.entries(KEYS)) if (!keep.has(name)) localStorage.removeItem(key); } catch (_) { /* private mode */ }
  function setKeep(name, on) {
    if (on) keep.add(name); else keep.delete(name);
    try { localStorage.setItem(KEEP_KEY, JSON.stringify([...keep])); } catch (_) { /* private mode */ }
  }

  // Groups and short descriptions, by the original button's label.
  const INFO = {
    Power: ['Weather', 'US power outages by county'],
    Satellites: ['Globe', 'Crewed stations, Starlink and aurora'],
    'Subsea cables': ['Globe', 'Undersea internet cables'],
    'Place names': ['Globe', 'Country, state and province names'],
    Flights: ['Globe', 'Major airlines in flight worldwide'],
    Holiday: ['Fun', 'Santa, the North Star and snow'],
  };
  const ORDER = ['Weather', 'Globe', 'Fun'];

  const bar = document.querySelector('.wxbar');
  if (!bar) return;
  document.body.classList.add('layers-panel');
  const radar = document.getElementById('radarBtn');
  const btn = document.createElement('button');
  btn.className = 'layers-btn';
  btn.setAttribute('aria-expanded', 'false');
  btn.title = 'Map layers';
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/></svg><span>Layers</span><b class="layers-n"></b>';
  if (radar) radar.after(btn); else bar.appendChild(btn);

  const panel = document.createElement('section');
  panel.className = 'layers-pop'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Map layers');
  document.body.appendChild(panel);

  // The original buttons, read fresh each time (Satellites and Subsea cables are added later).
  function sources() {
    return [...bar.querySelectorAll('.radar-btn')].filter((b) => b !== radar && !b.classList.contains('layers-btn') && !b.hasAttribute('data-gone'))
      .map((b) => {
        const label = (b.querySelector('span') ? b.querySelector('span').textContent : b.textContent).trim();
        const name = label.split(':')[0].trim();
        const on = b.getAttribute('aria-pressed') === 'true';
        return { b, name, on, icon: b.querySelector('svg') ? b.querySelector('svg').outerHTML : '', info: INFO[name] || ['Globe', b.title || ''] };
      })
      .filter((x) => x.name);
  }

  function render() {
    const list = sources();
    const n = String(list.filter((x) => x.on).length || ''), badge = btn.querySelector('.layers-n');
    if (badge.textContent !== n) badge.textContent = n;
    if (panel.hidden) return;
    let html = '<header><b>Layers</b><button type="button" class="layers-x" aria-label="Close">&times;</button></header>'
      + '<p class="layers-note">Layers reset when the page reloads. Tick <b>Keep</b> to remember one.</p>';
    for (const g of ORDER) {
      const rows = list.filter((x) => x.info[0] === g);
      if (!rows.length) continue;
      html += `<h4>${g}</h4>`;
      for (const x of rows) {
        const i = list.indexOf(x), k = KEYS[x.name] ? keep.has(x.name) : null;
        html += `<div class="layers-row${x.on ? ' on' : ''}"><span class="li">${x.icon}</span><span class="lt"><b>${x.name}</b><small>${x.info[1]}</small></span>`
          + (k === null ? '' : `<button type="button" class="keep" role="checkbox" aria-checked="${k}" aria-label="Keep ${x.name} after reload" data-keep="${x.name}"><i></i>Keep</button>`)
          + `<button type="button" class="sw" role="switch" aria-checked="${x.on}" aria-label="${x.name}" data-i="${i}"><i></i></button></div>`;
      }
    }
    panel.innerHTML = html;
    panel._list = list;
  }

  function place() {
    const r = btn.getBoundingClientRect();
    panel.style.top = Math.round(r.bottom + 8) + 'px';
    panel.style.right = Math.round(Math.max(8, innerWidth - r.right)) + 'px';
  }
  const open = () => { panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); place(); render(); };
  const close = () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };

  btn.addEventListener('click', (e) => { e.stopPropagation(); if (panel.hidden) open(); else close(); });
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  panel.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.layers-x')) { close(); return; }
    const kb = e.target.closest('.keep');
    if (kb) {
      const name = kb.dataset.keep, on = kb.getAttribute('aria-checked') !== 'true';
      setKeep(name, on);
      // Ticking Keep saves the layer as it is now (it may have been switched before the tick).
      const x = panel._list && panel._list.find((y) => y.name === name);
      if (on && x) { try { localStorage.setItem(KEYS[name], x.on ? '1' : '0'); } catch (_) { /* */ } }
      render(); return;
    }
    const sw = e.target.closest('.sw');
    if (sw && panel._list) { const x = panel._list[+sw.dataset.i]; if (x) x.b.click(); setTimeout(render, 30); }
  });
  document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // Keep the count (and an open panel) in step when layers change elsewhere
  // (only the buttons' pressed state and buttons being added - never the badge).
  let pending = 0;
  new MutationObserver(() => { if (!pending) pending = requestAnimationFrame(() => { pending = 0; render(); }); })
    .observe(bar, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  new MutationObserver(() => render()).observe(bar, { childList: true });
  addEventListener('resize', () => { if (!panel.hidden) place(); });
  // Once every script has added its button, show the starting count.
  addEventListener('load', render);
  setTimeout(render, 0);
})();
