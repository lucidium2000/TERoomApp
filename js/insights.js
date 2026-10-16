/* Insights: a small, rule-based "analyst" for Internet Insights outages.
 *
 * It looks at the last 24 hours the way an engineer would - which outages
 * overlap in time and place, which providers belong together, which
 * failures came first - scores each pattern, and hands the strongest few to
 * the voice. No model, no network calls: plain rules over the outage list,
 * O(n^2) on a few dozen outages, recomputed only when the data changes.
 *
 * Grounded in how ThousandEyes Internet Insights defines outages:
 *  - network outage: 100% packet loss on interfaces inside one network (AS),
 *    seen across many vantage points; we get the provider, ASN, interface
 *    count and the interfaces' locations;
 *  - application outage: many vantage points can't reach an app's servers
 *    or get errors back; we get the app, server count, locations and domains.
 * So "network outage near an app outage, a little earlier" is a fair sign
 * of cause and effect, and the same company failing on both layers is a
 * strong one.
 *
 * Insights.analyze(outages, { now, watch, probes }) -> [{
 *   rule, score 0..1, focus (outage to show), outages, vars (for the phrases) }]
 * best first, at most one per rule, preferring different outages.
 */
(function () {
  'use strict';

  const MIN = 60e3;
  const NEAR_KM = 160;            // same metro
  const SLACK_MS = 10 * MIN;      // "at the same time", with this much slack

  // Companies that run both a network (AS) and applications - including
  // what they own (GitHub and LinkedIn are Microsoft, YouTube is Google...).
  const FAMILY = [
    { co: 'Microsoft', net: /microsoft/i, app: /office ?365|o365|microsoft|teams|outlook|azure|onedrive|sharepoint|xbox|linkedin|bing|github/i },
    { co: 'Google', net: /google/i, app: /google|gmail|youtube|gcp|workspace|meet/i },
    { co: 'Amazon', net: /amazon|aws/i, app: /aws|amazon|prime video|twitch|audible/i },
    { co: 'Meta', net: /facebook|meta platforms/i, app: /facebook|instagram|whatsapp|\bmeta\b/i },
    { co: 'Salesforce', net: /salesforce/i, app: /salesforce|slack|tableau/i },
    { co: 'Cisco', net: /cisco|webex/i, app: /webex|cisco/i },
    { co: 'Zoom', net: /zoom/i, app: /zoom/i },
    { co: 'Apple', net: /apple/i, app: /apple|icloud/i },
    { co: 'Oracle', net: /oracle/i, app: /oracle|netsuite/i },
    { co: 'Cloudflare', net: /cloudflare/i, app: /cloudflare/i },
    { co: 'Akamai', net: /akamai|linode/i, app: /akamai/i },
  ];
  // What kind of network a provider is: it changes what a failure means.
  const NET_TYPE = [
    ['edge', /cloudflare|akamai|fastly|edgecast|edgio|limelight|cdn77|stackpath|imperva|zscaler|incapsula/i],
    ['cloud', /amazon|aws|google|microsoft|oracle|alibaba|digitalocean|ovh|hetzner|linode|ibm|tencent/i],
    ['transit', /lumen|level ?3|centurylink|cogent|zayo|gtt|telia|arelion|ntt|tata|hurricane|pccw|telxius|sparkle|orange|vodafone|verizon|at&t|comcast|charter|spectrum|cox|telekom|liberty|singtel|china telecom|china unicom|telstra|bt\b|sprint|windstream|frontier/i],
  ];
  const netType = (o) => { for (const [t, re] of NET_TYPE) if (re.test(o.name)) return t; return 'network'; };
  const familyOf = (o) => FAMILY.find((f) => (o.kind === 'network' ? f.net : f.app).test(o.kind === 'network' ? o.name : `${o.name} ${o.appId || ''}`)) || null;
  const nameOf = (o) => o.name.replace(/,?\s*\b(Inc|LLC|Ltd|Limited|Corp|Corporation|Co|GmbH|S\.?A)\.?$/i, '').trim();

  const rad = Math.PI / 180;
  const km = (a, b) => {
    const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad), y = (b.lat - a.lat) * rad;
    return Math.sqrt(x * x + y * y) * 6371;
  };
  // City-level points only: a bare country ("US") is too vague to match on.
  const cityPts = (o) => o.locations.filter((l) => l.name && l.name.includes(',') && isFinite(l.lat) && isFinite(l.lon));
  const cityName = (l) => l.name.split(',')[0].trim();
  const countryOf = (l) => { const p = l.name.split(',').map((q) => q.trim()); return p[p.length - 1]; };
  /** Cities two outages share (within NEAR_KM), heaviest first. */
  function sharedCities(a, b) {
    const out = [];
    for (const p of cityPts(a)) for (const q of cityPts(b)) if (km(p, q) <= NEAR_KM) out.push({ name: cityName(p), w: p.n + q.n });
    out.sort((x, y) => y.w - x.w);
    return [...new Set(out.map((c) => c.name))];
  }

  function analyze(outages, opts = {}) {
    const now = opts.now || Date.now();
    const list = outages.map((o) => ({ o, s: o.start, e: o.active ? now : o.start + (o.durationS || 0) * 1000 }));
    const overlap = (a, b, slack = SLACK_MS) => a.s <= b.e + slack && b.s <= a.e + slack;
    const nets = list.filter((x) => x.o.kind === 'network'), apps = list.filter((x) => x.o.kind !== 'network');
    const found = [];
    const add = (f) => { f.score = Math.max(0, Math.min(1, f.score)); found.push(f); };

    // 1. Same company failing on both layers: its network and its app.
    for (const a of apps) {
      const fam = familyOf(a.o);
      if (!fam) continue;
      for (const n of nets) {
        if (familyOf(n.o) !== fam) continue;
        const together = overlap(a, n, 30 * MIN);
        const lead = Math.round((a.s - n.s) / MIN), first = together && lead >= 1 && lead <= 15;
        add({ rule: 'sameCompany', score: together ? 0.9 + (first ? 0.05 : 0) : 0.45, focus: a.o, outages: [a.o, n.o],
          vars: { co: fam.co, app: nameOf(a.o), net: nameOf(n.o), together, first, lead } });
      }
    }

    // 2. A network outage and an app outage in the same place at the same time
    //    (different companies). Network first, then the app = likely cause.
    for (const a of apps) {
      for (const n of nets) {
        if (familyOf(n.o) && familyOf(n.o) === familyOf(a.o)) continue;   // rule 1's case
        if (!overlap(a, n)) continue;
        const cities = sharedCities(a.o, n.o);
        if (!cities.length) continue;
        const leadMin = Math.round((a.s - n.s) / MIN);
        const first = leadMin >= 1 && leadMin <= 15;
        const together = Math.abs(a.e - n.e) <= 5 * MIN && !a.o.active && !n.o.active;   // recovered together
        const type = netType(n.o);
        add({ rule: 'netApp', score: 0.5 + (cities.length > 1 ? 0.15 : 0) + (first ? 0.15 : 0) + (together ? 0.12 : 0) + (type === 'edge' ? 0.06 : 0),
          focus: a.o, outages: [a.o, n.o],
          vars: { app: nameOf(a.o), net: nameOf(n.o), city: cities[0], lead: leadMin, first, together, type } });
      }
    }

    // 3. A regional cluster: three or more providers failing in one metro
    //    within 45 minutes - a fiber cut, power, an exchange point.
    {
      const seen = new Set();
      for (const x of list) {
        for (const p of cityPts(x.o)) {
          const group = list.filter((y) => Math.abs(y.s - x.s) <= 45 * MIN && cityPts(y.o).some((q) => km(p, q) <= NEAR_KM));
          const providers = [...new Set(group.map((y) => nameOf(y.o)))];
          const key = cityName(p) + '|' + providers.sort().join(',');
          if (providers.length < 3 || seen.has(key)) continue;
          seen.add(key);
          const focus = group.slice().sort((u, v) => v.o.locations.length - u.o.locations.length)[0].o;
          add({ rule: 'cluster', score: Math.min(0.9, 0.45 + 0.1 * (providers.length - 3)), focus, outages: group.map((y) => y.o),
            vars: { city: cityName(p), n: providers.length, a: providers[0], b: providers[1] } });
        }
      }
    }

    // 4. Several apps down in the same city at once: shared hosting or upstream.
    for (let i = 0; i < apps.length; i++) {
      for (let j = i + 1; j < apps.length; j++) {
        const a = apps[i], b = apps[j];
        if (nameOf(a.o) === nameOf(b.o) || !overlap(a, b)) continue;
        const cities = sharedCities(a.o, b.o);
        if (!cities.length) continue;
        add({ rule: 'sharedHosting', score: 0.55 + (cities.length > 1 ? 0.1 : 0), focus: a.o, outages: [a.o, b.o],
          vars: { a: nameOf(a.o), b: nameOf(b.o), city: cities[0] } });
      }
    }

    // 5. Starting at once on different continents: coincidence, or a shared
    //    dependency (DNS, a CDN, an identity provider).
    {
      const sorted = list.slice().sort((u, v) => u.s - v.s);
      for (let i = 0; i < sorted.length; i++) {
        const group = sorted.filter((y) => y.s >= sorted[i].s && y.s - sorted[i].s <= 5 * MIN);
        const providers = [...new Set(group.map((y) => nameOf(y.o)))];
        const lons = group.flatMap((y) => cityPts(y.o).map((l) => l.lon));
        const spread = lons.length ? Math.max(...lons) - Math.min(...lons) : 0;
        if (providers.length >= 3 && spread > 60) {
          add({ rule: 'sameMinute', score: 0.42, focus: group[0].o, outages: group.map((y) => y.o), vars: { n: providers.length, a: providers[0], b: providers[1] } });
          i += group.length - 1;
        }
      }
    }

    // 6. Repeat offenders.
    {
      const by = new Map();
      for (const x of list) { const k = nameOf(x.o); (by.get(k) || by.set(k, []).get(k)).push(x); }
      for (const [name, xs] of by) {
        if (xs.length < 3) continue;
        xs.sort((u, v) => u.s - v.s);
        const active = xs.some((x) => x.o.active);
        add({ rule: 'repeat', score: Math.min(0.85, 0.35 + 0.08 * (xs.length - 3) + (active ? 0.15 : 0)),
          focus: xs[xs.length - 1].o, outages: xs.map((x) => x.o), vars: { N: name, n: xs.length, active } });
      }
    }

    // 7. A wide blast radius from one outage.
    for (const x of list) {
      const countries = new Set(cityPts(x.o).map(countryOf));
      if (countries.size < 3 && x.o.locations.length < 10) continue;
      add({ rule: 'wide', score: 0.4 + Math.min(0.3, countries.size * 0.04) + (x.o.active ? 0.1 : 0), focus: x.o, outages: [x.o],
        vars: { N: nameOf(x.o), n: Math.max(countries.size, 2), net: x.o.kind === 'network', active: x.o.active } });
    }

    // 8. Short overnight network outages look like planned maintenance
    //    (local time estimated from longitude).
    for (const n of nets) {
      if (n.o.active || (n.o.durationS || 0) > 60 * 60) continue;
      const lons = cityPts(n.o).map((l) => l.lon);
      if (!lons.length) continue;
      const lon = lons.reduce((u, v) => u + v, 0) / lons.length;
      const hour = ((new Date(n.s).getUTCHours() + new Date(n.s).getUTCMinutes() / 60 + lon / 15) % 24 + 24) % 24;
      if (hour >= 0 && hour < 5) {
        add({ rule: 'maintenance', score: 0.33, focus: n.o, outages: [n.o], vars: { N: nameOf(n.o), city: cityName(cityPts(n.o)[0]) } });
      }
    }

    // 9. This room: a pattern touching a service the room uses, while the
    //    room's own probe says it's slow or down, matters most here.
    const watched = (opts.watch || []);
    for (const f of found) {
      const hit = watched.find((w) => f.outages.some((o) => w.match(o)));
      if (!hit) continue;
      const p = (opts.probes || []).find((q) => q.term === hit.term);
      if (p && ['down', 'slow', 'warn'].includes(p.status)) { f.score = Math.min(1, f.score + 0.3); f.vars.room = hit.label; f.vars.roomDown = p.status === 'down'; }
    }

    // Best first; one per rule; skip ones about the very same outages.
    found.sort((a, b) => b.score - a.score);
    const out = [], usedRules = new Set(), usedSets = [];
    for (const f of found) {
      if (usedRules.has(f.rule)) continue;
      const ids = new Set(f.outages.map((o) => o.id));
      if (usedSets.some((s) => [...ids].every((id) => s.has(id)))) continue;
      out.push(f); usedRules.add(f.rule); usedSets.push(ids);
    }
    return out;
  }

  window.Insights = { analyze, familyOf, netType };
})();
