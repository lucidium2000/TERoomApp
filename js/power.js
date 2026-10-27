/* Live US power outages as named markers (not a weather-like heatmap).
 * County customers-out from MassOutage (massoutage.com, CC BY 4.0,
 * CORS open, no key). Credit is shown in the header while the map is on.
 *
 * There is no single free global customer-outage feed the way RainViewer is
 * for rain. This is the NOAA equivalent: dense, live, US. The GitHub Action
 * also publishes data/power.json so a RoomOS device can keep going if the
 * public API rate-limits the building's IP (5 requests / 5 minutes).
 *
 * Every 10 minutes (MassOutage asks for no more than every 5): read the
 * county map and hand named outages to app.js as labeled markers. MassOutage
 * is an unofficial aggregate: data older than 30 minutes is flagged stale, and
 * a "delayed" feed's own notice is passed on (summary.stale / .notice).
 * Off until the Power button turns it on (remembered); power=0 hides it.
 *
 * Merged from a contributor's version.
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const EVERY = 10 * 60e3;
  const CENTS_URL = 'vendor/us-county-centroids.json';
  const LIVE = 'https://massoutage.com/api/v1/live/map';

  let cents = null, timer = 0, running = false, gen = 0, frameTime = 0;
  let onUpdate = () => {};
  let lastKey = '';

  function dataFallbacks() {
    const urls = [];
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (m) {
      const owner = m[1];
      const seg = location.pathname.split('/').filter(Boolean)[0];
      const repo = seg && !/\.html?$/.test(seg) ? seg : `${owner}.github.io`;
      urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/data/power.json`);
    }
    urls.push('data/power.json');
    return urls;
  }

  async function loadCents() {
    if (cents) return cents;
    const r = await fetch(CENTS_URL);
    if (!r.ok) throw new Error('centroids ' + r.status);
    cents = await r.json();
    return cents;
  }

  async function loadMap() {
    const urls = [LIVE, ...dataFallbacks()];
    let lastErr;
    for (const u of urls) {
      try {
        const r = await fetch(u + (u.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
        if (!r.ok) throw new Error(u + ' HTTP ' + r.status);
        const json = await r.json();
        const counties = (json.data && json.data.counties) || json.counties;
        if (!counties || typeof counties !== 'object') throw new Error(u + ': no counties');
        const asOf = (json.data && json.data.generated_at) || json.asOf
          || (json.meta && json.meta.live && json.meta.live.last_poll_ts) || null;
        const states = (json.data && json.data.states) || json.states || {};
        const live = (json.meta && json.meta.live) || {};
        return { counties, states, asOf, from: u === LIVE ? 'live' : 'cache', delayed: live.status === 'delayed', notice: live.notice || '' };
      } catch (e) {
        lastErr = e;
        console.warn('[power]', e.message || e);
      }
    }
    throw lastErr || new Error('no power data');
  }

  function summarise(counties, states, asOf) {
    const areas = [];
    let customers = 0, lit = 0;
    for (const fips of Object.keys(counties)) {
      const row = counties[fips];
      const out = +row[0] || 0;
      if (out <= 0) continue;
      customers += out; lit++;
      const loc = cents[fips];
      if (!loc) continue;
      areas.push({
        fips, lat: loc[0], lon: loc[1], name: loc[2], state: loc[3],
        out, pct: +row[1] || 0,
      });
    }
    areas.sort((a, b) => b.out - a.out);
    const stateRows = Object.keys(states).map((id) => {
      const row = states[id];
      return { id, out: +row[0] || 0, pct: +row[1] || 0 };
    }).filter((s) => s.out > 0).sort((a, b) => b.out - a.out);
    return {
      areas,
      // Named pins on the globe: skip tiny blips so the map reads as outages.
      markers: areas.filter((a) => a.out >= 100 || a.pct >= 1).slice(0, 50),
      national: { customers, counties: lit, states: stateRows.length, top: stateRows.slice(0, 8) },
      asOf,
    };
  }

  async function update() {
    if (document.hidden) return;
    const mine = ++gen;
    try {
      await loadCents();
      const map = await loadMap();
      if (!running || mine !== gen) return;
      const key = map.asOf || JSON.stringify(Object.keys(map.counties).slice(0, 20));
      if (key === lastKey) return;
      lastKey = key;
      frameTime = map.asOf ? Date.parse(map.asOf) : Date.now();
      const snap = summarise(map.counties, map.states, map.asOf);
      snap.stale = Date.now() - frameTime > 30 * 60e3;
      snap.delayed = map.delayed; snap.notice = map.notice; snap.from = map.from;
      onUpdate(snap);
    } catch (e) {
      console.warn('[power]', e.message || e);
    }
  }

  window.Power = {
    enabled: qs.get('power') !== '0',
    start(fn) {
      if (fn) onUpdate = fn;
      if (running) return;
      running = true; lastKey = '';
      update();
      timer = setInterval(update, EVERY);
    },
    stop() { running = false; clearInterval(timer); timer = 0; },
    get time() { return frameTime; },
  };
})();
