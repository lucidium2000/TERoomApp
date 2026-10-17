/* A spoken weather rundown for a place, from free public services - no key.
 *
 * US: the National Weather Service (api.weather.gov, US government, public
 * domain): its forecast already comes as plain sentences ("Mostly cloudy,
 * with a high near 57. North wind around 15 mph."), plus any active alerts
 * (a Flood Watch, a Heat Advisory) for the point.
 * Elsewhere (or if the NWS doesn't answer): Open-Meteo, turned into a short
 * sentence here.
 *
 * Shared by the browser (live speech) and the GitHub Action
 * (scripts/speech/render.mjs), which passes its own fetch.
 *
 * WxBrief.get(lat, lon, { fetch, ua, fahrenheit }) ->
 *   { source, city, now: {name, text}, next: {name, short, temp, isDay}, alerts: [event] } or null
 */
(function (root) {
  'use strict';

  /** Forecast text as it should be read aloud. */
  function speakable(text) {
    return String(text || '')
      .replace(/\b(\d+)\s?(am|pm)\b/gi, (m, h, ap) => `${h} ${ap.toUpperCase()}`)
      .replace(/\bmph\b/gi, 'miles per hour')
      .replace(/\bkm\/h\b/gi, 'kilometers per hour')
      .replace(/(\d+)\s?%/g, '$1 percent')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // WMO weather codes (Open-Meteo) in words.
  const WMO = {
    0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy',
    51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
    71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
    80: 'rain showers', 81: 'rain showers', 82: 'heavy showers', 85: 'snow showers', 86: 'heavy snow showers',
    95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'severe thunderstorms with hail',
  };

  /** A forecast's words -> a WMO-style code, for the same icons the globe uses. */
  function codeOf(t) {
    t = String(t || '').toLowerCase();
    if (/thunder|t-storm/.test(t)) return 95;
    if (/snow|flurr|sleet|ice|wintry/.test(t)) return 73;
    if (/shower/.test(t)) return 80;
    if (/rain/.test(t)) return 63;
    if (/drizzle/.test(t)) return 53;
    if (/fog|haze|smoke|mist/.test(t)) return 45;
    if (/partly|mostly sunny|mostly clear/.test(t)) return 2;
    if (/cloudy|overcast/.test(t)) return 3;
    return /sunny|clear/.test(t) ? 0 : 2;
  }

  async function nws(lat, lon, f, headers) {
    const j = async (url) => { const r = await f(url, { headers }); if (!r.ok) throw new Error('nws ' + r.status); return r.json(); };
    const pt = await j(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    const p = pt.properties || {};
    const [fc, al] = await Promise.all([
      j(p.forecast),
      j(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`).catch(() => null),
    ]);
    const periods = (fc.properties && fc.properties.periods) || [];
    if (!periods.length) throw new Error('nws: no periods');
    const a = periods[0], b = periods[1];
    // Only what's in effect, most serious first, each event once.
    const order = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
    const alerts = [...new Set(((al && al.features) || []).map((x) => x.properties)
      .filter((q) => q && q.event && q.status === 'Actual')
      .sort((x, y) => (order[x.severity] ?? 4) - (order[y.severity] ?? 4))
      .map((q) => q.event))].slice(0, 2);
    const city = p.relativeLocation && p.relativeLocation.properties ? p.relativeLocation.properties.city : '';
    // The next few periods, for the forecast card.
    const list = periods.slice(0, 8).map((q) => ({
      name: q.name, temp: q.temperature, isDay: q.isDaytime, short: q.shortForecast, detailed: q.detailedForecast,
      pop: q.probabilityOfPrecipitation && q.probabilityOfPrecipitation.value != null ? q.probabilityOfPrecipitation.value : null,
      wind: [q.windDirection, q.windSpeed].filter(Boolean).join(' '), code: codeOf(q.shortForecast),
    }));
    const headlines = ((al && al.features) || []).map((x) => x.properties).filter((q) => q && q.event && q.status === 'Actual')
      .map((q) => ({ event: q.event, headline: q.headline || '', severity: q.severity || '' }));
    return {
      source: 'nws', city, periods: list, alertInfo: headlines.slice(0, 3),
      now: { name: a.name, text: speakable(a.detailedForecast || a.shortForecast), short: speakable(a.shortForecast), temp: a.temperature, isDay: a.isDaytime },
      next: b ? { name: b.name, short: speakable(b.shortForecast), temp: b.temperature, isDay: b.isDaytime } : null,
      alerts,
    };
  }

  async function openMeteo(lat, lon, f, fahrenheit) {
    const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3)
      + '&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&forecast_days=5&timezone=auto' + (fahrenheit ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '');
    const r = await f(u);
    if (!r.ok) throw new Error('open-meteo ' + r.status);
    const d = await r.json(), c = d.current, dy = d.daily;
    if (!c || !dy) throw new Error('open-meteo: no data');
    const deg = (t) => `${Math.round(t)} degrees`;
    const rain = dy.precipitation_probability_max && dy.precipitation_probability_max[0];
    const wind = Math.round(c.wind_speed_10m);
    const text = `Currently ${WMO[c.weather_code] || 'mixed'} and ${deg(c.temperature_2m)}, with a high of ${deg(dy.temperature_2m_max[0])} `
      + `and a low of ${deg(dy.temperature_2m_min[0])}.`
      + (rain >= 30 ? ` Chance of rain is ${rain} percent.` : '')
      + (wind >= 20 ? ` Breezy, with wind around ${wind} ${fahrenheit ? 'miles' : 'kilometers'} per hour.` : '');
    const day = (i) => new Date(dy.time[i] + 'T12:00').toLocaleDateString([], { weekday: 'long' });
    const periods = dy.time.map((_, i) => ({
      name: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : day(i), temp: Math.round(dy.temperature_2m_max[i]), low: Math.round(dy.temperature_2m_min[i]),
      isDay: true, short: (WMO[dy.weather_code[i]] || 'mixed').replace(/^./, (x) => x.toUpperCase()), detailed: '',
      pop: dy.precipitation_probability_max ? dy.precipitation_probability_max[i] : null, wind: '', code: dy.weather_code[i],
    }));
    return {
      source: 'open-meteo', city: '', periods, alertInfo: [],
      now: { name: 'Today', text, short: WMO[c.weather_code] || 'mixed', temp: Math.round(dy.temperature_2m_max[0]), isDay: true },
      next: dy.weather_code[1] != null ? { name: 'Tomorrow', short: WMO[dy.weather_code[1]] || 'mixed', temp: Math.round(dy.temperature_2m_max[1]), isDay: true } : null,
      alerts: [],
    };
  }

  /** The rundown for a point: the NWS in the US, Open-Meteo otherwise. */
  async function get(lat, lon, opts = {}) {
    const f = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f || !isFinite(lat) || !isFinite(lon)) return null;
    const headers = opts.ua ? { 'User-Agent': opts.ua, Accept: 'application/geo+json' } : { Accept: 'application/geo+json' };
    // The NWS covers the US and its territories; its points call says so.
    const usish = lat > 17 && lat < 72 && lon > -180 && lon < -64;
    if (usish) { try { return await nws(lat, lon, f, headers); } catch (_) { /* fall back */ } }
    try { return await openMeteo(lat, lon, f, opts.fahrenheit !== false); } catch (_) { return null; }
  }

  root.WxBrief = { get, speakable, codeOf, WMO };
})(typeof window !== 'undefined' ? window : globalThis);
