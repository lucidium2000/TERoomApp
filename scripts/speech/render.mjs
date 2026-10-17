#!/usr/bin/env node
// Renders the globe's narration to audio, for devices too slow to make speech
// themselves (a Cisco Desk Pro: no WebGPU, ~14x slower than real time on its
// CPU). Runs in the GitHub Action right after the outage data is fetched.
//
// It loads the app's own narration code (js/phrases.js, js/insights.js,
// js/narrate.js, js/roomnet.js) and says exactly what the app would - with the
// random phrase picks seeded by the data, so unchanged outages give unchanged
// words and their audio is reused from the previous run. Live parts (this
// room's checks, path trace numbers) are rendered as a fixed set of clips the
// device picks from.
//
// Usage: node render.mjs <outages.json> <outdir> [<previous speech dir>]
//   writes <outdir>/manifest.json and <outdir>/<hash>.mp3
// Env: SPEECH_VOICE (default af_heart), SPEECH_DTYPE (default q8: a quarter
// of the download and faster, near-identical for speech), SPEECH_BUDGET_S
// (default 600: stop rendering new lines after this long; what's done is
// published and the next run carries on - the most important lines go first).
// Deps: kokoro-js (Apache-2.0), @breezystack/lamejs (LGPL; build-time only).

import { readFile, writeFile, mkdir, readdir, copyFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { KokoroTTS } from 'kokoro-js';
import { Mp3Encoder } from '@breezystack/lamejs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS = resolve(HERE, '../../js');
const [, , DATA, OUT, PREV] = process.argv;
if (!DATA || !OUT) { console.error('usage: node render.mjs <outages.json> <outdir> [<previous speech dir>]'); process.exit(2); }
const VOICE = process.env.SPEECH_VOICE || 'af_heart';
const DTYPE = process.env.SPEECH_DTYPE || 'q8';
const BUDGET_MS = (parseInt(process.env.SPEECH_BUDGET_S, 10) || 600) * 1000;
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MAX = parseInt(process.env.SPEECH_MAX, 10) || 0;   // render at most this many new clips (testing)

// ── The app's narration code, run as-is in a sandbox ──────────────────────
const sandbox = { console, URLSearchParams, location: { search: '' }, performance, setTimeout, clearTimeout };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['phrases.js', 'insights.js', 'narrate.js', 'roomnet.js']) {
  vm.runInContext(await readFile(join(APP_JS, f), 'utf8'), sandbox, { filename: f });
}
const { PHRASES, Insights, Narrate, RoomNet } = sandbox;
const N = Narrate.create({ PH: PHRASES, Insights });
const SERVICES = RoomNet.probes.map((p) => p.name);   // Webex, Microsoft 365, Zoom, Google, AWS

// ── The data, as the app sees it ─────────────────────────────────────────
const json = JSON.parse(await readFile(DATA, 'utf8'));
const now = Date.parse(json.generatedAt) || Date.now();
const latest = json.latestRoundId || Math.floor(now / 1000);
const outages = [...json.network, ...json.application].map((o) => ({
  ...o,
  active: o.endRound >= latest - 300,
  locations: (o.locations || []).filter((l) => isFinite(l.lat) && isFinite(l.lon)).map((l) => ({ ...l, label: String(l.name).split(',')[0] })),
})).filter((o) => o.locations.length);

// ── What to say ────────────────────────────────────────────────────────────
// Each line: the text, and a seed that only changes when what it's about does.
const lines = [];   // { path: [...keys], text }
const say = (path, seed, make) => { N.seed(seed); lines.push({ path, text: N.sayAs(make()) }); };
// The tapped line says "about two hours ago": seed by that wording's bucket,
// so it only re-renders when the words would actually change.
const whenBucket = (ms) => { const m = (now - ms) / 60000; return m < 5 ? 'now' : m < 50 ? 'recent' : m < 360 ? 'h' + Math.round(m / 60) : 'today'; };
const state = outages.map((o) => `${o.id}:${o.active ? 1 : 0}`).sort().join(',');

say(['overview'], 'overview|' + state + '|' + Math.floor(now / 3600e3), () => N.overviewCore(outages, now));
const findings = N.findings(outages, now, {}).slice(0, 3);
const insights = findings.map((f, i) => {
  say(['insights', i], `insight|${i}|${f.rule}|${f.outages.map((o) => o.id).join(',')}`, () => N.insight(f, i === 0));
  return { rule: f.rule, score: Math.round(f.score * 100) / 100, focus: f.focus.id, outages: f.outages.map((o) => o.id) };
});
for (const o of outages.slice().sort((a, b) => (b.active - a.active) || (b.start - a.start))) {
  say(['outages', o.id, 'tap'], `tap|${o.id}|${o.active ? 1 : 0}|${o.active ? '' : whenBucket(o.start)}`, () => N.tapped(o, now));
  say(['outages', o.id, 'new'], `new|${o.id}`, () => N.headsUp(o));
}
// Live parts: a fixed set of variants, rendered once and reused forever.
const variants = (path, n, seed, make) => { for (let k = 0; k < n; k++) say([...path, k], `${seed}|${k}`, make); };
variants(['room', 'overviewFine'], 6, 'room-fine', () => N.overviewRoom([{ name: 'x', status: 'ok' }]));
for (const svc of SERVICES) {
  variants(['room', 'overviewSlow', svc], 2, 'room-slow|' + svc, () => N.overviewRoom([{ name: svc, status: 'slow' }]));
  variants(['room', 'overviewDown', svc], 2, 'room-down|' + svc, () => N.overviewRoom([{ name: svc, status: 'down' }]));
  variants(['room', 'insightSlow', svc], 2, 'ins-slow|' + svc, () => N.insightRoom(svc, false));
  variants(['room', 'insightDown', svc], 2, 'ins-down|' + svc, () => N.insightRoom(svc, true));
  variants(['path', 'start', svc], 3, 'path-start|' + svc, () => N.pathStart(svc));
  variants(['path', 'noAnswer', svc], 2, 'path-none|' + svc, () => N.pathNoAnswer(svc));
  // "Zoom is about" + <number> + "milliseconds away." (the device picks the number)
  ['is about', 'is roughly', 'is somewhere around'].forEach((w, k) => lines.push({ path: ['path', 'lead', svc, k], text: N.sayAs(`${svc} ${w}`) }));
}
for (const st of ['fine', 'slow', 'down']) variants(['room', 'tie', st], 4, 'tie|' + st, () => N.roomTie(st));
['milliseconds away.', 'milliseconds out.'].forEach((t, k) => lines.push({ path: ['path', 'ms', k], text: t }));
variants(['path', 'clean'], 4, 'path-clean', () => N.say('pathClean'));
variants(['path', 'slow'], 3, 'path-slow', () => N.say('pathSlow', { at: '' }));
variants(['path', 'loss'], 3, 'path-loss', () => N.say('pathLoss', { at: '' }));
for (let n = 1; n <= 500; n += n < 100 ? 1 : 10) lines.push({ path: ['num', String(n)], text: String(n) });

// Most important first, in case the time budget runs out: the synopsis and
// findings, the live clips, numbers, then outages (newest first, as added).
const rank = (l) => ({ overview: 0, insights: 1, room: 2, path: 3, num: 4, outages: 5 }[l.path[0]] ?? 6);
lines.sort((a, b) => rank(a) - rank(b));

// ── Render what's new; reuse what isn't ───────────────────────────────────
await mkdir(OUT, { recursive: true });
const fileFor = (text) => createHash('sha1').update(`${VOICE}|${DTYPE}|${text}`).digest('hex').slice(0, 16) + '.mp3';
const exists = (p) => access(p).then(() => true, () => false);
let tts = null, rendered = 0, reused = 0, skipped = 0, seconds = 0;
const t0 = Date.now();
const manifest = { generatedAt: json.generatedAt, voice: VOICE, insights };
const setPath = (obj, path, val) => { let x = obj; path.slice(0, -1).forEach((k, i) => { x = x[k] ?? (x[k] = typeof path[i + 1] === 'number' ? [] : {}); }); x[path[path.length - 1]] = val; };

for (const line of lines) {
  const file = fileFor(line.text), dest = join(OUT, file);
  if (await exists(dest)) reused++;
  else if (PREV && await exists(join(PREV, file))) { await copyFile(join(PREV, file), dest); reused++; }
  else if ((MAX && rendered >= MAX) || Date.now() - t0 > BUDGET_MS) { skipped++; continue; }   // next run carries on
  else {
    if (!tts) tts = await KokoroTTS.from_pretrained(MODEL, { dtype: DTYPE, device: 'cpu' });
    const pcm = await speak(tts, line.text);
    seconds += pcm.length / 24000;
    await writeFile(dest, mp3(pcm, 24000));
    rendered++;
  }
  // Insights carry their own entry ({rule, focus, ...}) - add the file to it.
  if (line.path[0] === 'insights') manifest.insights[line.path[1]].file = file;
  else setPath(manifest, line.path, file);
}
await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest));
const files = (await readdir(OUT)).filter((f) => f.endsWith('.mp3'));
console.log(`speech: ${lines.length} lines, ${rendered} rendered (${seconds.toFixed(0)} s of audio), ${reused} reused, ${skipped} left for the next run, ${files.length} files, ${((Date.now() - t0) / 1000).toFixed(0)} s`);

/** Sentence by sentence (Kokoro sounds best that way), joined with short pauses. */
async function speak(model, text) {
  const parts = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks = [];
  for (const p of parts) {
    const out = await model.generate(p, { voice: VOICE });
    chunks.push(out.audio, new Float32Array(Math.round(24000 * 0.12)));
  }
  const len = chunks.reduce((a, c) => a + c.length, 0), pcm = new Float32Array(len);
  let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; }
  return pcm;
}
/** Float PCM -> mono MP3 at 48 kbps (small; plenty for speech). */
function mp3(pcm, rate) {
  const enc = new Mp3Encoder(1, rate, 48), block = 1152, out = [];
  const i16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
  for (let i = 0; i < i16.length; i += block) { const b = enc.encodeBuffer(i16.subarray(i, i + block)); if (b.length) out.push(Buffer.from(b)); }
  const end = enc.flush(); if (end.length) out.push(Buffer.from(end));
  return Buffer.concat(out);
}
