// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
/* Layers panel (MOCK-UP, only with ?layers=panel): the column of option
 * buttons at the top right (Radar, Power, Satellites, Subsea cables, Place
 * names, Holiday, Flights) folded into one "Layers" button that opens a panel
 * with an on/off switch per option. Each switch just presses the original
 * button (still in the page, hidden), so every option behaves as before. */
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  if (qs.get('layers') !== 'panel') return;
  document.body.classList.add('layers-panel');

  // Groups and short descriptions, by the original button's label.
  const INFO = {
    Radar: ['Weather', 'Rain and snow (NOAA, RainViewer)'],
    Power: ['Weather', 'US power outages by county'],
    Satellites: ['Globe', 'Crewed stations, Starlink and aurora'],
    'Subsea cables': ['Globe', 'Undersea internet cables'],
    'Place names': ['Globe', 'Country, state and province names'],
    Flights: ['Globe', 'Major airlines in flight worldwide'],
    Holiday: ['Fun', 'Santa, the North Star and snow'],
  };
  const ORDER = ['Weather', 'Globe', 'Fun'];

  const bar = document.querySelector('.wxbar');
  const anchor = document.getElementById('radarBtn') || bar.lastElementChild;
  const btn = document.createElement('button');
  btn.className = 'layers-btn';
  btn.setAttribute('aria-expanded', 'false');
  btn.title = 'Map layers and options';
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/></svg><span>Layers</span><b class="layers-n"></b>';
  anchor.before(btn);

  const panel = document.createElement('section');
  panel.className = 'layers-pop'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Map layers');
  document.body.appendChild(panel);

  // The original buttons, read fresh each time (Satellites and Subsea cables are added later).
  function sources() {
    return [...bar.querySelectorAll('.radar-btn')].filter((b) => !b.classList.contains('layers-btn') && b.style.display !== 'none' && !b.hasAttribute('data-gone'))
      .map((b) => {
        const label = (b.querySelector('span') ? b.querySelector('span').textContent : b.textContent).trim();
        const name = label.split(':')[0].trim();
        const on = b.getAttribute('aria-pressed') === 'true';
        return { b, name, label, on, icon: b.querySelector('svg') ? b.querySelector('svg').outerHTML : '', info: INFO[name] || ['Globe', b.title || ''] };
      })
      .filter((x) => !x.b.hidden || x.name);
  }

  function render() {
    const list = sources();
    const n = String(list.filter((x) => x.on).length || ''), badge = btn.querySelector('.layers-n');
    if (badge.textContent !== n) badge.textContent = n;
    if (panel.hidden) return;
    let html = '<header><b>Layers</b><button type="button" class="layers-x" aria-label="Close">&times;</button></header>';
    for (const g of ORDER) {
      const rows = list.filter((x) => x.info[0] === g);
      if (!rows.length) continue;
      html += `<h4>${g}</h4>`;
      for (const x of rows) {
        const i = list.indexOf(x);
        if (x.name === 'Radar' && window.TERadar) {
          const m = window.TERadar.get();
          html += `<div class="layers-row${m !== 'off' ? ' on' : ''}"><span class="li">${x.icon}</span><span class="lt"><b>Radar</b><small>${x.info[1]}</small></span>`
            + `<span class="seg" role="radiogroup" aria-label="Radar">${[['off', 'Off'], ['live', 'Live'], ['loop', 'Past hour']].map(([k, t]) => `<button type="button" role="radio" aria-checked="${m === k}" data-radar="${k}">${t}</button>`).join('')}</span></div>`;
          continue;
        }
        html += `<div class="layers-row${x.on ? ' on' : ''}"><span class="li">${x.icon}</span><span class="lt"><b>${x.name}</b><small>${x.info[1]}</small></span>`
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
    const r = e.target.closest('[data-radar]');
    if (r && window.TERadar) { window.TERadar.set(r.dataset.radar); setTimeout(render, 30); return; }
    const sw = e.target.closest('.sw');
    if (sw && panel._list) { const x = panel._list[+sw.dataset.i]; if (x) x.b.click(); setTimeout(render, 30); }
  });
  document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // Keep the count (and an open panel) in step when options change elsewhere.
  // (Only the buttons' pressed state and buttons being added - never this script's own badge.)
  let pending = 0;
  new MutationObserver(() => { if (!pending) pending = requestAnimationFrame(() => { pending = 0; render(); }); })
    .observe(bar, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  new MutationObserver(() => render()).observe(bar, { childList: true });
  addEventListener('resize', () => { if (!panel.hidden) place(); });
  render();
})();
