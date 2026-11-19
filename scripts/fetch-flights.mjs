// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
// Major airlines' flights at cruise, worldwide, from the OpenSky Network
// (https://opensky-network.org), trimmed for the globe's Flights button.
// OpenSky sends no CORS header for other sites, so the browser can't ask it
// directly; the Action publishes this file to the `flights` branch instead.
//
//   node scripts/fetch-flights.mjs out/flights.json
//
// If the output file already exists (the previous snapshot), each plane keeps
// its known path: the positions it was seen at over the last HIST_S seconds.
//
// Optional OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET (an OpenSky API client)
// raise the daily allowance from 400 to 4000 credits; a worldwide request costs 4.
// Output: { t, src, n, hist, f: [[icao, callsign, lon, lat, altM, speedMs, trackDeg, vrateMs, path], ...] }
//   path: flat [secondsBeforeT, lon, lat, ...], oldest first (may be empty)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const out = process.argv[2] || 'flights.json';
// Major airlines (ICAO codes): the US majors, then flag and big international carriers.
const MAJOR = new Set(('AAL DAL UAL ASA JBU ACA WJA AMX BAW VIR EIN AFR KLM DLH SWR AUA SAS FIN IBE TAP ITY THY ' +
  'UAE QTR ETD SVA ETH SAA SIA CPA QFA ANZ VOZ ANA JAL KAL AAR CCA CES CSN CAL EVA THA MAS GIA AIC TAM LAN AVA CMP').split(' '));
const CRUISE_M = 6000;   // about 20,000 ft
const HIST_S = 60 * 60;    // keep an hour of known path
const MIN_GAP = 150;       // s: don't keep path points closer together than this
const MAX_MS = 360;        // m/s: a jump faster than this is a different flight (or bad data), start afresh

async function token() {
  const id = process.env.OPENSKY_CLIENT_ID, secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!r.ok) throw new Error('OpenSky token: HTTP ' + r.status);
  return (await r.json()).access_token;
}

// The previous snapshot, for each plane's path so far.
let prev = null;
try { if (existsSync(out)) prev = JSON.parse(readFileSync(out, 'utf8')); } catch (e) { console.warn('previous snapshot unreadable:', String(e)); }

const tok = await token().catch((e) => { console.warn(String(e), '- trying anonymously'); return null; });
const url = 'https://opensky-network.org/api/states/all';
const r = await fetch(url, { headers: tok ? { Authorization: 'Bearer ' + tok } : {}, signal: AbortSignal.timeout(60000) });
console.log('OpenSky', r.status, 'credits left:', r.headers.get('x-rate-limit-remaining'), tok ? '(client)' : '(anonymous)');
if (!r.ok) { console.error('OpenSky: HTTP ' + r.status); process.exit(1); }
const j = await r.json();
const r1 = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const RAD = Math.PI / 180;
const dist = (lo1, la1, lo2, la2) => {   // metres, great circle
  const a = Math.sin((la2 - la1) * RAD / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin((lo2 - lo1) * RAD / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
};

// Previous paths by aircraft, as absolute [time, lon, lat] points (the previous fix included).
const before = new Map();
if (prev && prev.f && prev.t && j.time - prev.t < HIST_S) {
  for (const p of prev.f) {
    const pts = [], h = p[8] || [];
    for (let i = 0; i + 2 < h.length; i += 3) pts.push([prev.t - h[i], h[i + 1], h[i + 2]]);
    pts.push([prev.t, p[2], p[3]]);
    before.set(p[0], pts);
  }
}

// state vector: 0 icao24, 1 callsign, 2 country, 3 time_position, 4 last_contact, 5 lon, 6 lat,
// 7 baro_alt, 8 on_ground, 9 velocity, 10 true_track, 11 vertical_rate, 12 sensors, 13 geo_alt, ...
let withPath = 0;
const f = (j.states || [])
  .filter((s) => !s[8] && s[5] != null && s[6] != null && s[9] != null && s[10] != null && j.time - (s[3] || 0) < 120)
  .filter((s) => (s[13] ?? s[7] ?? 0) >= CRUISE_M && MAJOR.has((s[1] || '').trim().slice(0, 3)))
  .map((s) => {
    // Walk back from now through the known points; stop at a gap that's too old or too fast to be this flight.
    const path = [];
    const pts = before.get(s[0]);
    if (pts) {
      let lt = j.time, llo = s[5], lla = s[6];
      for (let i = pts.length - 1; i >= 0; i--) {
        const [t, lo, la] = pts[i], age = j.time - t, gap = lt - t;
        if (age > HIST_S || gap <= 0) break;
        if (dist(lo, la, llo, lla) / gap > MAX_MS) break;
        if (gap < MIN_GAP && lt !== j.time) continue;   // thin out dense points (keep the newest)
        path.unshift(Math.round(age), r1(lo, 3), r1(la, 3));
        lt = t; llo = lo; lla = la;
      }
    }
    if (path.length) withPath++;
    return [s[0], (s[1] || '').trim(), r1(s[5], 4), r1(s[6], 4), Math.round(s[13] ?? s[7] ?? 0), r1(s[9], 1), r1(s[10], 1), r1(s[11] || 0, 1), path];
  });
writeFileSync(out, JSON.stringify({ t: j.time, src: 'OpenSky Network', n: f.length, hist: HIST_S, f }));
console.log(`flights: ${f.length} major airliners at cruise of ${(j.states || []).length}, ${withPath} with a known path -> ${out}`);
