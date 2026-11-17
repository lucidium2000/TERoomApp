// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
/* FX preview (?fx=1): extra eye candy on the globe, kept apart from the
 * regular view until it's approved. Nothing here runs without ?fx.
 *
 *   lights  - city lights on the night side (NASA Black Marble 2016, public domain)
 *   cables  - undersea internet cables with pulses of light; cables landing near
 *             an active outage turn orange (TeleGeography, CC BY-NC-SA 3.0)
 *   aurora  - the live aurora forecast (NOAA SWPC OVATION, every 30 min)
 *   quakes  - earthquakes M2.5+ in the last day as ripples (USGS, every 5 min)
 *   sats    - every Starlink satellite in its real orbit (CelesTrak)
 *   glint   - the sun's reflection on open water
 *   comets  - a streak from space when a new outage arrives
 *
 * ?fx=1 turns everything on; ?fx=lights,cables,aurora picks some.
 * The drawing is in js/glglobe.js (compiled only in this mode).
 */
(function () {
  'use strict';
  const ALL = ['lights', 'cables', 'aurora', 'quakes', 'sats', 'glint', 'comets'];
  const qs = new URLSearchParams(location.search);
  const raw = (qs.get('fx') || '').toLowerCase();
  const active = !!raw && raw !== '0' && raw !== 'off';
  // Everything by default (Satellites waits for its button); ?fx=lights,cables picks some.
  const pick = !active ? ALL : raw === '1' || raw === 'all' || raw === 'on' ? ALL : raw.split(',').filter((k) => ALL.includes(k));

  const CREDITS = [
    ['lights', 'City lights: NASA Black Marble'],
    ['cables', 'Cables: TeleGeography (CC BY-NC-SA)'],
    ['aurora', 'Aurora: NOAA SWPC'],
    ['quakes', 'Earthquakes: USGS'],
    ['sats', 'Starlink orbits: CelesTrak'],
  ];

  // The data branch this deployment publishes to (owner.github.io/repo).
  function dataBranch(file) {
    const h = location.hostname;
    if (!/\.github\.io$/.test(h)) return null;
    const repo = location.pathname.split('/').filter(Boolean)[0];
    return repo ? `https://raw.githubusercontent.com/${h.split('.')[0]}/${repo}/data/${file}` : null;
  }
  async function firstJson(urls) {
    for (const u of urls.filter(Boolean)) {
      try { const r = await fetch(u, { cache: 'no-cache' }); if (r.ok) return await r.json(); } catch (_) { /* next */ }
    }
    return null;
  }

  function start({ glr, toast, getOutages }) {
    const F = glr && glr.fx;
    if (!F || !F.available) { console.warn('[fx] not available on this device'); return null; }
    const on = Object.fromEntries(ALL.map((k) => [k, pick.includes(k)]));
    if (!F.textures) { on.lights = on.aurora = on.glint = false; }
    // Satellites and aurora share one button (under Power), remembered on the
    // device. Their data loads only once they're first turned on.
    const sky = on.sats || on.aurora;
    const skyOn = remembered('te-sky', active);   // ?fx=1 starts with them on, the regular view off
    const want = { sats: on.sats, aurora: on.aurora };
    const lazy = {};
    const once = (f) => { let done = false; return () => { if (!done) { done = true; f(); } }; };
    const setSky = (v) => {
      F.enable({ sats: want.sats && v, aurora: want.aurora && v });
      if (v) { if (want.sats && lazy.sats) lazy.sats(); if (want.aurora && lazy.aurora) lazy.aurora(); }
    };
    F.enable({ ...on, sats: false, aurora: false, cables: false });
    const skyBtn = sky ? toggleButton(document.getElementById('powerBtn'), 'sky-btn', 'sky', 'Satellites',
      'Starlink satellites and the aurora: tap to show or hide', skyOn, (v) => { setSky(v); remember('te-sky', v); }) : null;
    // Subsea cables: their own button, below Satellites; off until turned on.
    const cablesOn = remembered('te-cables', active);
    if (on.cables) toggleButton(skyBtn || document.getElementById('powerBtn'), 'cable-btn', 'cable', 'Subsea cables',
      'Undersea internet cables (orange where one lands near an active outage): tap to show or hide', cablesOn,
      (v) => { F.enable({ cables: v }); if (v) lazy.cables(); remember('te-cables', v); });
    if (active) chip(on);

    if (on.lights) {
      const img = new Image();
      img.onload = () => { try { F.setLights(img); } catch (e) { console.warn('[fx] lights', e); } };
      img.src = 'vendor/nightlights.jpg';
    }

    if (on.aurora) {
      const load = async () => {
        const d = await firstJson(['https://services.swpc.noaa.gov/json/ovation_aurora_latest.json']);
        if (!d || !Array.isArray(d.coordinates)) return;
        const b = new Uint8Array(360 * 181);
        for (const [lo, la, v] of d.coordinates) {
          const x = (Math.round(lo) + 180) % 360, y = 90 - Math.round(la);
          if (y >= 0 && y < 181) b[y * 360 + x] = Math.min(255, v * 9);   // values are 0-100; most auroras sit under 30
        }
        F.setAurora(b);
      };
      lazy.aurora = once(() => { load(); setInterval(load, 30 * 60000); });
    }

    if (on.quakes) {
      let seen = null;
      const load = async () => {
        const d = await firstJson(['https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson']);
        if (!d || !Array.isArray(d.features)) return;
        const list = d.features.filter((f) => f.geometry && f.properties).map((f) => ({
          id: f.id, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], mag: f.properties.mag || 2.5,
          time: f.properties.time, place: f.properties.place || '',
        }));
        F.setQuakes(list);
        // A strong new one gets a toast (not the ones already there at load).
        if (seen && toast) for (const q of list) if (!seen.has(q.id) && q.mag >= 6) toast(`M${q.mag.toFixed(1)} earthquake: ${q.place}`, 'quake');
        seen = new Set(list.map((q) => q.id));
      };
      load(); setInterval(load, 5 * 60000);
    }

    if (on.cables) lazy.cables = once(() => {
      let ends = [];
      fetch('vendor/cables.json').then((r) => r.json()).then((d) => {
        F.setCables(d.cables);
        // Each cable's landing points (the ends of its segments), as unit vectors.
        ends = d.cables.map(([, f]) => [[f[0], f[1]], [f[f.length - 2], f[f.length - 1]]].map(([lo, la]) => uv(lo, la)));
        hot();
      }).catch((e) => console.warn('[fx] cables', e));
      const NEAR = Math.cos(250 / 6371);   // a landing within ~250 km of an active outage
      const hot = () => {
        if (!ends.length || !getOutages) return;
        const pts = [];
        for (const o of getOutages() || []) if (o.active) for (const l of o.locations) pts.push(l.v || uv(l.lon, l.lat));
        const set = new Set();
        ends.forEach((e, i) => { if (e.some((a) => pts.some((b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > NEAR))) set.add(i); });
        F.setCableHot(set);
      };
      setInterval(hot, 60000);
    });
    if (on.cables && cablesOn) { F.enable({ cables: true }); lazy.cables(); }

    if (on.sats) {
      const KEY = 'te-fx-starlink';
      const load = async () => {
        let d = await firstJson([qs.get('starlink'), dataBranch('starlink.json')]);
        if (!d) {
          // CelesTrak directly, at most every few hours from this device (it rate-limits).
          try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c && Date.now() - c.at < 6 * 3600e3) d = c.d; } catch (_) { /* */ }
          if (!d) {
            const all = await firstJson(['https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=json']);
            if (Array.isArray(all)) {
              d = { sats: all.filter((s) => s.MEAN_MOTION > 11 && s.MEAN_MOTION < 17 && s.ECCENTRICITY < 0.02).map((s) => [Date.parse(s.EPOCH + 'Z') / 1000, s.MEAN_MOTION, s.ECCENTRICITY, s.INCLINATION, s.RA_OF_ASC_NODE, s.ARG_OF_PERICENTER, s.MEAN_ANOMALY]) };
              try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), d })); } catch (_) { /* too big or private mode */ }
            }
          }
        }
        if (d && Array.isArray(d.sats)) F.setSats(d.sats);
      };
      lazy.sats = once(() => { load(); setInterval(load, 6 * 3600e3); });
    }
    setSky(sky && skyOn);

    return {
      /** A new outage arrived: a streak onto its main location. */
      newOutage(o) {
        if (!on.comets || !o || !o.locations || !o.locations.length) return;
        const l = (o.byWeight || o.locations)[0];
        F.comet(l.lon, l.lat, o.kind === 'network' ? [1, 0.45, 0.2] : [0.25, 0.8, 1]);
      },
      comet: (lon, lat) => F.comet(lon, lat),
    };
  }

  function uv(lon, lat) {
    const l = lon * Math.PI / 180, p = lat * Math.PI / 180, c = Math.cos(p);
    return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
  }

  /** "Satellites: on/off" under the Power button: Starlink and the aurora together. */
  const ICON = {
    sky: '<path d="M4 12a8 8 0 0 1 16 0M7.5 12a4.5 4.5 0 0 1 9 0"/><circle cx="12" cy="12" r="1.6"/>',
    cable: '<path d="M3 15c3 0 3-4 6-4s3 4 6 4 3-4 6-4"/><circle cx="3" cy="15" r="1.4"/><circle cx="21" cy="11" r="1.4"/>',
  };
  /** A toggle in the column under Power: "<label>: on/off". */
  function toggleButton(after, cls, icon, label, title, initial, set) {
    if (!after) return null;
    const b = document.createElement('button');
    b.className = 'radar-btn power-btn ' + cls;
    b.title = title;
    b.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[icon]}</svg><span></span>`;
    const show = (v) => { b.setAttribute('aria-pressed', String(v)); b.querySelector('span').textContent = `${label}: ${v ? 'on' : 'off'}`; };
    let v = initial; show(v);
    b.addEventListener('click', (e) => { e.stopPropagation(); v = !v; show(v); set(v); });
    after.after(b);
    return b;
  }
  const remembered = (key, dflt) => { try { const v = localStorage.getItem(key); return v === null ? dflt : v === '1'; } catch (_) { return dflt; } };
  const remember = (key, v) => { try { localStorage.setItem(key, v ? '1' : '0'); } catch (_) { /* private mode */ } };

  /** A small "FX preview" chip, so it's clear which version this is; tap for credits. */
  function chip(on) {
    const el = document.createElement('button');
    el.className = 'fx-chip';
    el.innerHTML = '<b>FX</b> preview';
    const list = CREDITS.filter(([k]) => on[k]).map(([, t]) => t);
    el.title = list.join('\n');
    const pop = document.createElement('div');
    pop.className = 'fx-credits'; pop.hidden = true;
    pop.innerHTML = '<b>FX preview</b>' + list.map((t) => `<span>${t}</span>`).join('') + '<small>Regular view: remove ?fx from the address.</small>';
    el.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
    document.addEventListener('click', () => { pop.hidden = true; });
    document.body.append(el, pop);
  }

  window.FXMode = { active, start };
})();
