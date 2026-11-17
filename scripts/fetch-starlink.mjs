#!/usr/bin/env node
// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
// Starlink orbits for the FX preview (?fx=1): CelesTrak's current elements for
// every Starlink satellite, trimmed to what the globe needs to fly them.
// CelesTrak updates these a few times a day and asks callers not to fetch the
// same set more often than that, so the Action fetches it once per run.
//
// Usage: node scripts/fetch-starlink.mjs [outfile]   (default: data/starlink.json)
// Output: { generatedAt, source, sats: [[epochSec, revPerDay, ecc, incDeg, raanDeg, argpDeg, meanAnomDeg, name], ...],
//           stations: [same, for the ISS and Tiangong] }
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'data/starlink.json';
// The regular set, then the supplemental one (from SpaceX's own ephemerides),
// which has its own download allowance.
const URLS = [
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json',
  'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=json',
];
let all = null;
for (const u of URLS) {
  try {
    const res = await fetch(u, { headers: { 'User-Agent': 'TERoomApp (globe visual)' } });
    if (res.ok) { all = await res.json(); break; }
    console.warn('CelesTrak HTTP ' + res.status + ' for ' + u);
  } catch (e) { console.warn('CelesTrak: ' + e.message); }
}
if (!Array.isArray(all)) { console.error('no Starlink data; keeping the last copy'); process.exit(1); }
const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const row = (s) => [Math.round(Date.parse(s.EPOCH + 'Z') / 1000), r(s.MEAN_MOTION, 6), r(s.ECCENTRICITY, 6),
  r(s.INCLINATION, 4), r(s.RA_OF_ASC_NODE, 4), r(s.ARG_OF_PERICENTER, 4), r(s.MEAN_ANOMALY, 4), String(s.OBJECT_NAME || '').trim()];
const sats = all
  .filter((s) => s.MEAN_MOTION > 11 && s.MEAN_MOTION < 17 && s.ECCENTRICITY < 0.02)   // in orbit, not re-entering
  .map(row);
// The crewed stations: the ISS (25544) and China's Tiangong core module (48274).
let stations = [];
try {
  const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json', { headers: { 'User-Agent': 'TERoomApp (globe visual)' } });
  if (res.ok) {
    const st = await res.json();
    const pick = { 25544: 'ISS', 48274: 'Tiangong' };
    stations = st.filter((s) => pick[s.NORAD_CAT_ID]).map((s) => { const x = row(s); x[7] = pick[s.NORAD_CAT_ID]; return x; });
  } else console.warn('stations: HTTP ' + res.status);
} catch (e) { console.warn('stations: ' + e.message); }
if (sats.length < 1000) { console.error('only ' + sats.length + ' satellites; keeping the last copy'); process.exit(1); }
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: 'CelesTrak (celestrak.org)', sats, stations }));
console.log(`Wrote ${OUT}: ${sats.length} Starlink satellites, ${stations.length} stations`);
