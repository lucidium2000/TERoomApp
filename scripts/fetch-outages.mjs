#!/usr/bin/env node
// Pulls the public ThousandEyes Internet Insights outage feed (the same data
// behind https://www.thousandeyes.com/outages/) and writes a compact JSON file
// the globe can load. The feed has no CORS headers, so browsers on a RoomOS
// device can't call it directly - a GitHub Action runs this on a schedule and
// publishes the result instead.
//
// Usage: node scripts/fetch-outages.mjs [outfile]   (default: data/outages.json)
// Node 18+ (uses global fetch). No dependencies.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const BASE = 'https://intoverview.share.thousandeyes.com/namespace/internet-insights';
const OUT = process.argv[2] || 'data/outages.json';
const WINDOW_S = 24 * 3600;
const PAGE_VERSION = 'NETWORK_AND_APPLICATION_OUTAGE';
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (te-outage-globe; +https://github.com)',
};

async function getJson(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function main() {
  const config = await getJson('/ajax/config').catch(() => null);
  const minDur = config?.publicOverviewConfig?.minimumOutageDurationSeconds ?? 200;

  // Rounds are 5-minute buckets. Ask from the last completed one.
  const now = Math.floor(Date.now() / 1000);
  const latestRoundId = Math.floor(now / 300) * 300 - 300;
  const body = JSON.stringify({
    latestRoundId,
    outageScope: 'AFFECTED_TEST_OR_IN_CATALOG',
    latestSeconds: WINDOW_S,
    filters: [],
    minimumOutageDurationSeconds: minDur,
    pageVersion: PAGE_VERSION,
  });

  const [net, app, logos] = await Promise.all([
    getJson('/overview/outage-events', { method: 'POST', body }),
    getJson('/overview/application-outage-events', { method: 'POST', body }),
    getJson(`/overview/application-outage-events/application-logos?pageVersion=${PAGE_VERSION}`).catch(() => ({})),
  ]);

  const network = (net || []).map((o) => ({
    id: o.id,
    kind: 'network',
    name: o.as?.shortName || o.as?.asName || `AS${o.as?.asn}`,
    fullName: o.as?.asName || null,
    asn: o.as?.asn ?? null,
    start: o.startTimestamp,
    durationS: o.durationSeconds,
    endRound: o.endRoundId,
    interfaces: (o.interfaces || []).length,
    locations: Object.values(o.locations || {}).map((l) => ({
      name: l.locName, lat: l.lat, lon: l.lon, n: l.affectedInterfaces ?? 1,
    })),
  }));

  const usedApps = new Set();
  const application = (app || []).map((o) => {
    const appId = o.application?.applicationId;
    if (appId) usedApps.add(appId);
    // Count affected servers per location so markers can be sized.
    const perLoc = {};
    for (const s of o.servers || []) perLoc[s.geonameId] = (perLoc[s.geonameId] || 0) + 1;
    return {
      id: o.id,
      kind: 'application',
      name: o.application?.name || appId,
      appId,
      start: o.startTimestamp,
      durationS: o.durationSeconds,
      endRound: o.endRoundId,
      servers: (o.servers || []).length,
      domains: o.domainTags || [],
      locations: Object.entries(o.locations || {}).map(([gid, l]) => ({
        name: l.name, lat: l.latitude, lon: l.longitude, n: perLoc[gid] || 1,
      })),
    };
  });

  // Only ship logos for apps that actually appear - the full set is large.
  const appLogos = {};
  for (const id of usedApps) {
    const src = logos?.[id]?.imageSource;
    if (src && src.startsWith('data:image/')) appLogos[id] = src;
  }

  const out = {
    source: 'ThousandEyes Internet Insights (public outage map)',
    generatedAt: new Date().toISOString(),
    windowSeconds: WINDOW_S,
    latestRoundId,
    network,
    application,
    appLogos,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT}: ${network.length} network, ${application.length} application outages`);
}

main().catch((e) => { console.error(e); process.exit(1); });
