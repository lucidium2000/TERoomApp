#!/usr/bin/env node
// Part of TERoomApp - created by Christopher Hunt (github.com/lucidium2000).
// Starlink orbits for the FX preview (?fx=1): CelesTrak's current elements for
// every Starlink satellite, trimmed to what the globe needs to fly them.
// CelesTrak updates these a few times a day and asks callers not to fetch the
// same set more often than that, so the Action fetches it once per run.
//
// Usage: node scripts/fetch-starlink.mjs [outfile]   (default: data/starlink.json)
// Output: { generatedAt, source, sats: [[epochSec, revPerDay, ecc, incDeg, raanDeg, argpDeg, meanAnomDeg], ...] }
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
const sats = all
  .filter((s) => s.MEAN_MOTION > 11 && s.MEAN_MOTION < 17 && s.ECCENTRICITY < 0.02)   // in orbit, not re-entering
  .map((s) => [Math.round(Date.parse(s.EPOCH + 'Z') / 1000), r(s.MEAN_MOTION, 6), r(s.ECCENTRICITY, 6),
    r(s.INCLINATION, 4), r(s.RA_OF_ASC_NODE, 4), r(s.ARG_OF_PERICENTER, 4), r(s.MEAN_ANOMALY, 4)]);
if (sats.length < 1000) { console.error('only ' + sats.length + ' satellites; keeping the last copy'); process.exit(1); }
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: 'CelesTrak (celestrak.org)', sats }));
console.log(`Wrote ${OUT}: ${sats.length} Starlink satellites`);
