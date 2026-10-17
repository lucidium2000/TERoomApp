/* Narration: turns outages (and, live, this room's checks) into the lines
 * the voice says. Shared by the browser (live speech) and the GitHub Action
 * (scripts/render-speech.mjs), which renders the same lines to audio files
 * for devices too slow to synthesise speech themselves.
 *
 * Narrate.create({ PH, Insights, rand }) -> narrator
 *   PH        phrase library (js/phrases.js)
 *   Insights  the analyst (js/insights.js)
 *   rand      random source; the server passes a seeded one (narrator.seed)
 *             so the same outages give the same words, and audio is reused.
 * Room-dependent parts are separate functions, so the server can pre-render
 * every variant of them once and the device picks the right one live.
 */
(function (root) {
  'use strict';

  // How some names should be said (the voice would read "365" as a number).
  const SAY_AS = [
    [/\bOffice\s?365\b/gi, 'Office three six five'],
    [/\b(Microsoft|M)\s?365\b/gi, '$1 three six five'],
    [/\bO365\b/gi, 'O three six five'],
  ];
  const sayAs = (text) => SAY_AS.reduce((t, [re, to]) => t.replace(re, to), text);

  /** A small seedable random (mulberry32), seeded from any string. */
  function seeded(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const NUMW = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const numW = (n) => (n >= 0 && n < NUMW.length ? NUMW[n] : String(n));
  const COUNTRY = { US: 'the US', GB: 'the UK', UK: 'the UK', NL: 'the Netherlands', AE: 'the UAE', DE: 'Germany', FR: 'France', JP: 'Japan', IN: 'India', BR: 'Brazil', CA: 'Canada', AU: 'Australia', SG: 'Singapore', IE: 'Ireland', ES: 'Spain', IT: 'Italy', SE: 'Sweden', ZA: 'South Africa', MX: 'Mexico', KR: 'South Korea', HK: 'Hong Kong' };
  // "Ashburn, Virginia, US" -> Ashburn; a bare country ("US") isn't a city.
  const cityOf = (l) => { const parts = l && l.name ? l.name.split(',') : []; return parts.length > 1 ? parts[0].trim() : ''; };
  const countryOf = (l) => { const parts = (l && l.name ? l.name.split(',') : []).map((q) => q.trim()); const c = parts[parts.length - 1] || ''; return COUNTRY[c] || c; };
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  // Company names as people say them: no "Inc." / "LLC" (and no "Inc..").
  const nameOf = (o) => o.name.replace(/,?\s*\b(Inc|LLC|Ltd|Limited|Corp|Corporation|Co|GmbH|S\.?A)\.?$/i, '').trim();
  const sentenceCase = (text) => text.replace(/(^|[.!?]\s+)([a-z])/g, (m, a, c) => a + c.toUpperCase());

  function create({ PH = {}, Insights = null, rand = Math.random } = {}) {
    let rnd = rand;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    // A line from the phrase library, placeholders filled, first letter capitalised.
    const fill = (pool, v = {}) => pick(PH[pool] || ['']).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : ''));
    const say = (pool, v) => cap(fill(pool, v));

    // Less is more: a line or two, the way someone glancing at the screen
    // would put it - who, where, how it's going. Few numbers, no lists.
    const spokenWhen = (ms, now) => {
      const m = Math.max(0, Math.round((now - ms) / 60000)), h = Math.round(m / 60);
      return m < 5 ? 'just now' : m < 50 ? 'a little while ago' : h <= 1 ? 'about an hour ago' : h < 6 ? `about ${numW(h)} hours ago` : 'earlier today';
    };
    const spokenFor = (sec) => {
      const m = Math.round(sec / 60), h = Math.round(m / 60);
      return m < 15 ? 'a few minutes' : m < 45 ? 'about half an hour' : h <= 1 ? 'about an hour' : `about ${numW(h)} hours`;
    };
    const where = (o) => { const top = o.locations.slice().sort((a, b) => b.n - a.n)[0]; return cityOf(top) || countryOf(top) || ''; };
    const hubFactLine = (hub) => { const facts = (PH.HUB_FACTS || {})[hub]; return facts ? say('hubFact', { hub, fact: pick(facts) }) : ''; };

    /** A sentence or two about the day as a whole (Insights.context): the
     *  strongest feature, and a second, different one when there is one. */
    function dayContext(outages, now) {
      if (!Insights || !Insights.context) return '';
      const feats = Insights.context(outages, { now });
      if (!feats.length) return '';
      const line = (f) => (f.kind === 'hub' ? say('hubLead', f.vars) + ' ' + hubFactLine(f.vars.hub) : say(f.kind, f.vars));
      const first = feats.length > 1 && rnd() < 0.35 ? feats[1] : feats[0];
      const second = feats.find((f) => f !== first && f.kind !== first.kind && f.kind !== 'hub');
      const a = line(first);
      if (!second) return a;
      // Don't open both with the same lead-in ("Looking at the day as a whole").
      const lead = (t) => t.split(/[,.:]/)[0].toLowerCase();
      let b = line(second);
      for (let i = 0; i < 5 && lead(b) === lead(a); i++) b = line(second);
      return a + ' ' + b;
    }

    return {
      sayAs, nameOf,
      /** Server: make the words depend only on this string from now on. */
      seed(str) { rnd = seeded(str); },
      unseed() { rnd = rand; },

      /** The tour's synopsis without the room: health, the worst-hit
       *  services, and one sentence about the day. */
      overviewCore(outages, now) {
        const act = outages.filter((q) => q.active).length;
        const one = act === 1, few = one ? 'one outage' : 'two outages', fewIs = one ? 'one outage is' : 'two outages are';
        const health = act === 0 ? say('healthCalm') : act <= 2 ? say('healthFew', { few, fewIs }) : say('healthBusy', { n: numW(act) });
        const by = new Map();
        for (const q of outages) {
          const k = nameOf(q), g = by.get(k) || { name: k, n: 0, active: false, spread: 0, kind: q.kind };
          g.n++; g.active = g.active || q.active; g.spread += q.locations.length;
          by.set(k, g);
        }
        const top = [...by.values()].sort((a, b) => (b.active - a.active) || (b.n - a.n) || (b.spread - a.spread)).slice(0, 3);
        let worst = '';
        if (top.length) {
          const t = top[0], N = t.name;
          worst = say(t.active ? (t.n > 2 ? 'worstActiveRepeat' : 'worstActiveOne') : (t.n > 2 ? 'worstPastRepeat' : 'worstPastOne'), { N });
          // A second entry from the same company is named by what it is.
          const said = new Set([N.split(' ')[0]]);
          const rest = top.slice(1).map((g) => {
            const first = g.name.split(' ')[0], dup = said.has(first);
            said.add(first);
            return dup ? `${first}'s ${g.kind === 'network' ? 'network' : 'other services'}` : g.name;
          });
          if (rest.length) worst += ` ${rest.join(' and ')} had ${fill('restTail')}.`;
        }
        return [health, worst, dayContext(outages, now)].filter(Boolean).join(' ');
      },

      /** The local weather rundown (js/wxbrief.js): a lead-in, the forecast
       *  as the weather service words it, what comes next, any alert. */
      weather(w, cityFallback) {
        if (!w || !w.now || !w.now.text) return '';
        const city = w.city || cityFallback || 'the area';
        const low = (t) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : t);
        const parts = [say('wxLead', { city }), say('wxNow', { period: w.now.name, period_l: low(w.now.name), text: w.now.text, text_l: low(w.now.text) })];
        if (w.next && w.next.short && w.next.temp != null) {
          // The NWS writes short forecasts in title case ("Mostly Clear").
          const short = w.next.short.toLowerCase();
          parts.push(say('wxNext', { period: w.next.name, period_l: low(w.next.name), short, short_l: short,
            hilo: w.next.isDay ? 'a high near' : 'a low around', temp: `${w.next.temp} degrees` }));
        }
        for (const event of (w.alerts || []).slice(0, 1)) parts.push(say('wxAlert', { event }));
        return parts.join(' ').replace(/\.\./g, '.').replace(/\s+/g, ' ').trim();
      },

      /** The synopsis's closing line about this room. probes: [{name, status}].
       *  With only `bad` given (no others), it's the variant for one service. */
      overviewRoom(probes) {
        const seen = probes.filter((p) => p.status !== 'pending');
        if (!seen.length) return '';
        const bad = seen.filter((p) => ['down', 'slow', 'warn'].includes(p.status));
        if (!bad.length) return say('overviewRoomFine');
        const down = bad[0].status === 'down';
        const others = bad.length > 1 ? (down ? `, and neither ${bad.length === 2 ? 'is ' + bad[1].name : 'are a couple of others'}` : `, and so ${bad.length === 2 ? 'is ' + bad[1].name : 'are a couple of others'}`) : '';
        return say(down ? 'overviewRoomDown' : 'overviewRoomSlow', { svc: bad[0].name, others });
      },

      /** The analyst's findings, best first. */
      findings(outages, now, opts = {}) { return Insights ? Insights.analyze(outages, { now, ...opts }) : []; },

      /** One finding as a sentence or three, without the room part (see
       *  insightRoom). What's known about who runs on what decides how a
       *  network/app overlap is told. */
      insight(f, first) {
        const v = f.vars, likely = f.score > 0.8 ? 'very likely' : f.score > 0.6 ? 'likely' : 'possibly';
        let pool = {
          sameCompany: v.together ? (v.first ? 'sameCompanyFirst' : 'sameCompanyTogether') : 'sameCompanyApart',
          netApp: v.first ? 'netAppFirst' : v.together ? 'netAppTogether' : 'netAppPlain',
          cluster: 'cluster', sharedHosting: v.separate ? 'sameCityApart' : 'sharedHosting', sameMinute: 'sameMinute',
          repeat: v.active ? 'repeatActive' : 'repeatPast', wide: v.net ? 'wideNet' : 'wideApp', maintenance: 'maintenance',
          chain: 'chain', aftershock: 'aftershock', workday: 'workday',
        }[f.rule];
        if (f.rule === 'netApp' && v.rel === 'unlikely') pool = 'relUnlikely';
        const vars = { ...v, likely, n: typeof v.n === 'number' ? numW(v.n) : v.n };
        let text = fill(first ? 'insightFirst' : 'insightNext', vars) + ' ' + fill(pool, vars);
        let note = '';
        if (f.rule === 'netApp' && v.rel === 'known') note = fill('relKnown', vars);
        else if (f.rule === 'netApp' && v.rel !== 'unlikely') note = fill({ edge: 'netTypeEdge', transit: 'netTypeTransit', cloud: 'netTypeCloud' }[v.type] || 'netTypeNetwork', vars);
        else if (f.rule === 'cluster' || f.rule === 'chain') note = fill(rnd() < 0.7 ? 'causeFiber' : 'causeRouting', vars);
        else if (f.rule === 'sameMinute') note = fill('causeShared', vars);
        else if (f.rule === 'wide' && !v.net) note = fill('causeCentral', vars);
        else if (f.rule === 'wide' && v.net) note = fill('causeRouting', vars);
        // A finding that gets a note doesn't also need a generic closing line.
        if (note) text = text.replace(/ (Worth keeping in mind|Something to watch|Make of that what you will|Food for thought)\.$/, '');
        text += note;
        if (v.hub && !note && rnd() < 0.6) text += ' ' + hubFactLine(v.hub);
        return sentenceCase(text);
      },
      /** "...and Zoom is slow from this room, which may be why." */
      insightRoom(room, down) { return sentenceCase(fill(down ? 'insightRoomDown' : 'insightRoomSlow', { room, likely: 'likely' })).trim(); },

      /** A tapped outage, without the room part (see roomTie). */
      tapped(o, now) {
        const nm = nameOf(o), at = where(o);
        const others = o.locations.length > 1 ? ` and ${o.locations.length > 4 ? 'a few' : 'a couple of'} other places` : '';
        const net = o.kind === 'network';
        if (o.active) {
          const what = fill(net ? 'whatNetNow' : 'whatAppNow');
          return say('tappedActive', { nm, what, What: cap(what), place: at ? `, mostly around ${at}${others}` : '' });
        }
        const what = fill(net ? 'whatNetThen' : 'whatAppThen'), when = spokenWhen(o.start, now);
        return say('tappedCleared', { nm, what, What: cap(what), when, When: cap(when), place: at ? ` around ${at}${others}` : '', dur: spokenFor(o.durationS || 0) });
      },
      /** This room's view of a tapped, active outage's service. */
      roomTie(status) { return say(status === 'down' ? 'roomDown' : status === 'fine' ? 'roomFine' : 'roomSlow'); },
      headsUp(o) { const at = where(o); return say('headsUp', { nm: nameOf(o), at: at ? ' around ' + at : '' }); },

      pathStart(svc) { return say('pathStart', { svc }); },
      pathResult(svc, ms, slowAt, lossAt) {
        return say('pathLead', { svc, ms }) + ' '
          + (slowAt != null ? say('pathSlow', { at: slowAt }) : lossAt != null ? say('pathLoss', { at: lossAt }) : say('pathClean'));
      },
      pathNoAnswer(svc) { return say('pathNoAnswer', { svc }); },
      voiceHello(v) { return say('voiceHello', { v }); },
      speedSample() { return say('speedSample'); },
      fill, say, pick,
    };
  }

  root.Narrate = { create, sayAs, seeded };
})(typeof window !== 'undefined' ? window : globalThis);
