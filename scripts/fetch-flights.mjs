// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
// Live aircraft over and around the US from the OpenSky Network
// (https://opensky-network.org), trimmed for the globe's Flights button.
// OpenSky sends no CORS header for other sites, so the browser can't ask it
// directly; the Action publishes this file to the `flights` branch instead.
//
//   node scripts/fetch-flights.mjs out/flights.json
//
// Optional OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET (an OpenSky API client)
// raise the daily allowance from 400 to 4000 credits; a US-wide request costs 4.
// Output: { t, src, n, f: [[icao, callsign, lon, lat, altM, speedMs, trackDeg, vrateMs], ...] }
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || 'flights.json';
const BOX = { lamin: 17, lomin: -135, lamax: 55, lomax: -60 };   // the US with its neighbours' edges

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

const tok = await token().catch((e) => { console.warn(String(e), '- trying anonymously'); return null; });
const url = 'https://opensky-network.org/api/states/all?' + new URLSearchParams(BOX);
const r = await fetch(url, { headers: tok ? { Authorization: 'Bearer ' + tok } : {}, signal: AbortSignal.timeout(60000) });
console.log('OpenSky', r.status, 'credits left:', r.headers.get('x-rate-limit-remaining'), tok ? '(client)' : '(anonymous)');
if (!r.ok) { console.error('OpenSky: HTTP ' + r.status); process.exit(1); }
const j = await r.json();
const r1 = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
// state vector: 0 icao24, 1 callsign, 2 country, 3 time_position, 4 last_contact, 5 lon, 6 lat,
// 7 baro_alt, 8 on_ground, 9 velocity, 10 true_track, 11 vertical_rate, 12 sensors, 13 geo_alt, ...
const f = (j.states || [])
  .filter((s) => !s[8] && s[5] != null && s[6] != null && s[9] != null && s[10] != null && j.time - (s[3] || 0) < 120)
  .map((s) => [s[0], (s[1] || '').trim(), r1(s[5], 4), r1(s[6], 4), Math.round(s[13] ?? s[7] ?? 0), r1(s[9], 1), r1(s[10], 1), r1(s[11] || 0, 1)]);
writeFileSync(out, JSON.stringify({ t: j.time, src: 'OpenSky Network', n: f.length, f }));
console.log(`flights: ${f.length} airborne of ${(j.states || []).length} -> ${out}`);
