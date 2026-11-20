// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
// Flight route lookup - a Cloudflare Worker.
//
// The globe's flight card asks this Worker "where is DAL802 flying from and to
// today?". It asks AirLabs (airlabs.co) with the API key kept as a Worker
// secret, so the key never reaches the public page. Answers are cached for a
// few hours at Cloudflare's edge, so each flight costs at most a handful of
// AirLabs calls a day (the free plan is about 1,000 calls a month).
//
//   GET /route?cs=DAL802   ->  { from: {code, city, name}, to: {...}, airline, status, src }
//                              or { none: true } when AirLabs doesn't know the flight
//
// Deploy (from this folder):
//   npx wrangler deploy
//   npx wrangler secret put AIRLABS_KEY      (paste the key when asked)

const OFFICIAL_ORIGIN = 'https://lucidium2000.github.io';
const CACHE_S = 3 * 3600;        // a found route: 3 hours
const MISS_CACHE_S = 6 * 3600;   // an unknown flight: don't ask again for 6 hours

function allowedOrigin(o) {
  if (!o) return false;
  if (o === OFFICIAL_ORIGIN) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;   // local dev
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigin(origin) ? origin : OFFICIAL_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const json = (body, status = 200, maxAge = 0) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
    });

    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/route') return json({ error: 'not found' }, 404);
    // Only browsers on the app's own pages (keeps casual use of the quota down).
    if (!allowedOrigin(origin)) return json({ error: 'origin not allowed' }, 403);
    const cs = (url.searchParams.get('cs') || '').toUpperCase().trim();
    if (!/^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/.test(cs)) return json({ error: 'bad callsign' }, 400);
    if (!env.AIRLABS_KEY) return json({ error: 'AIRLABS_KEY secret not set' }, 503);

    // Edge cache, keyed by callsign only (never the key).
    const cache = caches.default;
    const cacheKey = new Request(`https://te-flight-route.cache/route/${cs}`);
    const hit = await cache.match(cacheKey);
    if (hit) { const r = new Response(hit.body, hit); for (const [k, v] of Object.entries(cors)) r.headers.set(k, v); return r; }

    let body, ttl;
    try {
      const r = await fetch(`https://airlabs.co/api/v9/flight?flight_icao=${encodeURIComponent(cs)}&api_key=${encodeURIComponent(env.AIRLABS_KEY)}`, { cf: { cacheTtl: 0 } });
      const j = r.ok ? await r.json() : null;
      if (j && j.error) return json({ error: 'airlabs: ' + (j.error.message || j.error.code || 'error') }, 502);   // e.g. quota used up: not cached
      const f = j && j.response;
      if (f && (f.dep_iata || f.dep_icao) && (f.arr_iata || f.arr_icao)) {
        const ap = (p) => ({ code: f[p + '_iata'] || f[p + '_icao'], city: f[p + '_city'] || '', name: f[p + '_name'] || '' });
        body = { from: ap('dep'), to: ap('arr'), airline: f.airline_name || '', status: f.status || '', src: 'AirLabs' };
        ttl = CACHE_S;
      } else { body = { none: true }; ttl = MISS_CACHE_S; }
    } catch (e) {
      return json({ error: 'lookup failed' }, 502);
    }
    const res = json(body, 200, ttl);
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
