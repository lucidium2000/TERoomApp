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
      skyOnNow = v;
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

    let quakeList = [];
    if (on.quakes) {
      let seen = null;
      const load = async () => {
        const d = await firstJson(['https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson']);
        if (!d || !Array.isArray(d.features)) return;
        const list = d.features.filter((f) => f.geometry && f.properties).map((f) => ({
          id: f.id, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], mag: f.properties.mag || 2.5,
          time: f.properties.time, place: f.properties.place || '', depth: f.geometry.coordinates[2],
        }));
        F.setQuakes(list); quakeList = list;
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

    // Satellites on the CPU too (hover cards, orbits, stations, "overhead"):
    // the same circular-orbit model the GPU flies them with.
    let names = [], stations = [], satCache = null;
    const gpRow = (s) => [Date.parse(s.EPOCH + 'Z') / 1000, s.MEAN_MOTION, s.ECCENTRICITY, s.INCLINATION, s.RA_OF_ASC_NODE, s.ARG_OF_PERICENTER, s.MEAN_ANOMALY, String(s.OBJECT_NAME || '').trim()];
    const posOf = (arr, k, ref, ms, du = 0) => {
      const t = ms / 1000 - ref, g = F.gmst(ms);
      const O = arr[k + 2] + arr[k + 3] * t - g, u = arr[k + 4] + arr[k + 5] * t + du, ci = Math.cos(arr[k + 1]), si = Math.sin(arr[k + 1]);
      const cO = Math.cos(O), sO = Math.sin(O), cu = Math.cos(u), su = Math.sin(u), r = arr[k + 6];
      return [r * (cO * cu - sO * su * ci), r * (sO * cu + cO * su * ci), r * su * si];
    };
    const litAt = (p, sun) => { const sd = p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]; return sd > 0 || Math.hypot(p[0] - sd * sun[0], p[1] - sd * sun[1], p[2] - sd * sun[2]) > 1; };
    const info = (arr, k, p, sun, name) => {
      const RE = 6378.137, r = arr[k + 6], n = arr[k];
      return { name, altKm: (r - 1) * RE, kmh: r * RE * n * 3600, incDeg: arr[k + 1] * 180 / Math.PI, periodMin: 2 * Math.PI / n / 60, lit: litAt(p, sun) };
    };
    const skyShown = () => skyOnNow && on.sats;
    let skyOnNow = false;

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
              d = { sats: all.filter((s) => s.MEAN_MOTION > 11 && s.MEAN_MOTION < 17 && s.ECCENTRICITY < 0.02).map(gpRow) };
              try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), d })); } catch (_) { /* too big or private mode */ }
            }
          }
        }
        if (d && Array.isArray(d.sats)) {
          F.setSats(d.sats);
          names = d.sats.map((r) => r[7] || '');
          satCache = null;
        }
        // The crewed stations: in the published file, else CelesTrak's stations group.
        let st = d && Array.isArray(d.stations) && d.stations.length ? d.stations : null;
        if (!st) {
          try { const c = JSON.parse(localStorage.getItem(KEY + '-st') || 'null'); if (c && Date.now() - c.at < 6 * 3600e3) st = c.st; } catch (_) { /* */ }
          if (!st) {
            const all = await firstJson(['https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json']);
            const pick = { 25544: 'ISS', 48274: 'Tiangong' };
            if (Array.isArray(all)) {
              st = all.filter((x) => pick[x.NORAD_CAT_ID]).map((x) => { const r = gpRow(x); r[7] = pick[x.NORAD_CAT_ID]; return r; });
              try { localStorage.setItem(KEY + '-st', JSON.stringify({ at: Date.now(), st })); } catch (_) { /* */ }
            }
          }
        }
        if (st && st.length) { const e = F.elements(st); stations = st.map((r, i) => ({ name: r[7], arr: e.arr.subarray(i * 8, i * 8 + 8), ref: e.ref })); }
      };
      lazy.sats = once(() => { load(); setInterval(load, 6 * 3600e3); });
    }
    setSky(sky && skyOn);

    return {
      /** Satellites shown right now? */
      skyOn: () => skyShown(),
      /** Every satellite's world position now (Earth radii), refreshed at most every 150 ms. */
      satPositions() {
        if (!skyShown()) return null;
        const e = F.satEls();
        if (!e.arr) return null;
        const t = performance.now();
        if (satCache && t - satCache.t < 150) return satCache.pos;
        const ms = Date.now(), pos = new Float32Array(e.n * 3);
        for (let i = 0; i < e.n; i++) { const p = posOf(e.arr, i * 8, e.ref, ms); pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; }
        satCache = { t, pos };
        return pos;
      },
      /** One satellite's card details. */
      satInfo(i, sun) { const e = F.satEls(); const p = posOf(e.arr, i * 8, e.ref, Date.now()); return info(e.arr, i * 8, p, sun, names[i] || 'Starlink satellite'); },
      /** Points around a satellite's whole orbit, as it is now. */
      satOrbit(i, N = 120) { const e = F.satEls(), ms = Date.now(), out = []; for (let j = 0; j <= N; j++) out.push(posOf(e.arr, i * 8, e.ref, ms, (j / N) * 2 * Math.PI)); return out; },
      /** The crewed stations: where they are, a trail of the last half orbit, and their details. */
      stations(sun) {
        if (!skyShown()) return [];
        const ms = Date.now();
        return stations.map((s) => {
          const pos = posOf(s.arr, 0, s.ref, ms), per = 2 * Math.PI / s.arr[0] * 1000;
          const trail = []; for (let j = 30; j >= 0; j--) trail.push(posOf(s.arr, 0, s.ref, ms - (j / 30) * per * 0.45));
          return { name: s.name, pos, trail, info: info(s.arr, 0, pos, sun, s.name), orbit: () => { const o = []; for (let j = 0; j <= 120; j++) o.push(posOf(s.arr, 0, s.ref, ms, (j / 120) * 2 * Math.PI)); return o; } };
        });
      },
      /** Starlink satellites at least minEl degrees above the horizon at a place (Starlink serves from 25 degrees up). */
      overhead(lat, lon, minEl = 25) {
        const pos = this.satPositions();
        if (!pos) return null;
        const g = uv(lon, lat), s = Math.sin(minEl * Math.PI / 180);
        let n = 0;
        for (let i = 0; i < pos.length; i += 3) {
          const dx = pos[i] - g[0], dy = pos[i + 1] - g[1], dz = pos[i + 2] - g[2];
          if ((dx * g[0] + dy * g[1] + dz * g[2]) / Math.hypot(dx, dy, dz) > s) n++;
        }
        return n;
      },
      /** Earthquakes on the globe now (for hover cards). */
      quakes: () => (on.quakes ? quakeList : []),
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
