#!/usr/bin/env node
// Pulls the public MassOutage live US power-outage map (CC BY 4.0) and writes
// a compact JSON file the globe can load. The page can also call MassOutage
// itself (CORS is open), but a RoomOS kiosk shares an IP with other devices
// and the unauthenticated cap is 5 requests / 5 minutes - so the GitHub
// Action publishes a copy next to outages.json as a fallback.
//
// Usage: node scripts/fetch-power.mjs [outfile]   (default: data/power.json)
// Node 18+ (uses global fetch). No dependencies.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const SRC = 'https://massoutage.com/api/v1/live/map';
const OUT = process.argv[2] || 'data/power.json';

async function main() {
  const res = await fetch(SRC, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'te-outage-globe; +https://github.com (MassOutage CC BY 4.0)',
    },
  });
  if (!res.ok) throw new Error(`GET ${SRC} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const data = json && json.data;
  if (!data || !data.counties || typeof data.counties !== 'object') {
    throw new Error('unexpected MassOutage map format');
  }
  const out = {
    generatedAt: new Date().toISOString(),
    asOf: data.generated_at || (json.meta && json.meta.live && json.meta.live.last_poll_ts) || null,
    source: { name: 'MassOutage', url: 'https://massoutage.com', license: 'CC BY 4.0' },
    counties: data.counties,
    states: data.states || {},
    meta: json.meta || null,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  const n = Object.keys(out.counties).length;
  console.log(`power: ${n} counties -> ${OUT}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
