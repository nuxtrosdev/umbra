#!/usr/bin/env node
/**
 * UMBRA · YOUTUBE REACHABILITY PROBE
 *
 *   node umbra-proxy/tools/probe.mjs [videoId]
 *
 * Every backend in Umbra fails the same way when the machine's address is
 * the problem, and from inside a browser that is indistinguishable from the
 * proxy being broken. This asks each one directly, from this machine, and
 * prints a verdict instead of a stack trace.
 *
 * It starts no server, writes nothing, and needs no session: it is the
 * answer to "is it us or is it the address".
 */
import * as providers from '../server/providers/index.mjs';
import * as pm from '../server/provider-manager.mjs';
import { verdict, notesOf } from '../server/verdict.mjs';
import { inspect as potInspect } from '../server/potoken.mjs';

/* A provider failing late, after its pool has already answered, rejects a
   promise nobody is awaiting any more. That killed the whole probe on the
   last line of its output. Report and carry on. */
const late = [];
process.on('unhandledRejection', (e) => late.push(String((e && e.message) || e).slice(0, 160)));

const IDS = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const VID = IDS[0] || 'dQw4w9WgXcQ';
const ms = (t) => `${Date.now() - t}ms`;
const trunc = (s, n = 96) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

const C = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
      g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` }
  : { dim: (s) => s, b: (s) => s, g: (s) => s, r: (s) => s, y: (s) => s };

console.log(`\n${C.b('umbra · youtube reachability')}  video ${VID}  ·  node ${process.version}  ·  ${new Date().toISOString()}`);
console.log(C.dim('asking every backend from this machine, which is the address YouTube judges\n'));

const rows = [];
const allNotes = [];

for (const p of providers.ALL) {
  if (typeof p.getStreams !== 'function') continue;
  const t0 = Date.now();
  try {
    const s = await p.getStreams(VID);
    const data = s && (s.data || s);
    const v = [...((data && data.videoStreams) || [])];
    const a = [...((data && data.audioStreams) || [])];
    const withUrl = [...v, ...a].filter((f) => f && f.url).length;
    const hls = !!(data && data.hls);
    if (withUrl || hls) {
      rows.push({ p: p.id, state: 'works', note: `${withUrl} formats` + (hls ? ' + hls' : ''), t: ms(t0) });
    } else {
      rows.push({ p: p.id, state: 'gated', note: 'answered, no urls', t: ms(t0) });
    }
  } catch (e) {
    const note = String((e && e.message) || e);
    allNotes.push(note);
    for (const n of notesOf((e && e.tried) || [])) allNotes.push(n);
    rows.push({ p: p.id, state: 'failed', note: trunc(note), t: ms(t0) });
  }
}

const w = Math.max(...rows.map((r) => r.p.length), 9);
for (const r of rows) {
  const tag = r.state === 'works' ? C.g('works ') : r.state === 'gated' ? C.y('gated ') : C.r('failed');
  console.log(`  ${r.p.padEnd(w)}  ${tag}  ${String(r.t).padStart(7)}  ${C.dim(r.note)}`);
}

/* ---------------------------------------------------------- the server ---
 * The loop above asks each backend directly. The server does not: it goes
 * through the provider manager, which routes, scores and fails over. If
 * those two disagree, the bug is ours and it is in here — which is exactly
 * the case where a page says "every provider failed" while the backends are
 * demonstrably fine. */
let managerLine;
try {
  const r = await pm.getStreams(VID);
  const d = r && r.data;
  const n = [...((d && d.videoStreams) || []), ...((d && d.audioStreams) || [])].filter((f) => f && f.url).length;
  managerLine = `${C.g('works ')}  via ${r.provider}  ${n} formats` + (d && d.hls ? ' + hls' : '');
} catch (e) {
  const tried = ((e && e.tried) || []).map((t) => `${t.provider}: ${trunc(t.note, 60)}`);
  managerLine = `${C.r('failed')}  ${trunc((e && e.message) || e, 60)}` +
    (tried.length ? '\n' + tried.map((t) => '      ' + C.dim(t)).join('\n') : '');
}
console.log(`\n  ${'through the manager'.padEnd(w)}  ${managerLine}`);
console.log(C.dim('  (this is the exact call the watch page makes; if it disagrees with the rows'));
console.log(C.dim('   above, the fault is in Umbra\'s routing, not in YouTube)'));

/* ------------------------------------------------------------ verdict --- */
const pot = potInspect();
const tried = rows.filter((r) => r.state !== 'works').map((r) => ({ provider: r.p, note: r.note }));
const vd = verdict(tried, { hasPoToken: !!pot.configured, hasCookies: !!process.env.UMBRA_YT_COOKIES });
const worked = rows.filter((r) => r.state === 'works');
const gated = rows.filter((r) => r.state === 'gated');
const wall = /sign ?in to confirm|not a bot|LOGIN_REQUIRED|CONSENT_WALL/i.test(allNotes.join(' '));

console.log('');
if (worked.length) {
  console.log(`${C.b('verdict')}  ${C.g('this address can still extract')} — via ${worked.map((r) => r.p).join(', ')}.`);
  console.log(C.dim('  If the player is still empty, the fault is on our side of the wire, not YouTube\'s.'));
} else if (wall) {
  console.log(`${C.b('verdict')}  ${C.r('bot wall')} — YouTube named this address.`);
  console.log(C.dim('  A proof-of-origin token will not lift this on its own. What helps, in order:'));
  console.log(C.dim('   1. instance-proxied streams (on by default: UMBRA_INVIDIOUS_LOCAL)'));
  console.log(C.dim('   2. egress from somewhere else entirely'));
  console.log(C.dim('   3. the direct embed, which uses the visitor\'s address instead (UMBRA_DIRECT_EMBED)'));
} else if (gated.length) {
  console.log(`${C.b('verdict')}  ${C.y('gated')} — answers come back with the urls withheld.`);
  console.log(C.dim('  This is the case a proof-of-origin token actually fixes:'));
  console.log(C.dim('   npx -y bgutil-ytdlp-pot-provider  (or the docker image), then'));
  console.log(C.dim('   UMBRA_POT_PROVIDER_URL=http://127.0.0.1:4416 npm start'));
} else {
  console.log(`${C.b('verdict')}  ${vd && vd.label ? vd.label : 'no backend answered'}`);
  if (vd && vd.detail) console.log(C.dim('  ' + vd.detail));
  console.log(C.dim('  Nothing here looks like a bot wall, so check egress first: can this machine'));
  console.log(C.dim('  reach the public internet at all?'));
}

console.log(`\n${C.dim('proof-of-origin')}  ${pot.configured ? C.g('available') : C.r('none')}` +
  `  ${C.dim(JSON.stringify(pot.sources || {}))}`);
console.log(`${C.dim('provider order')}  ${providers.order().map((p) => p.id).join(' → ')}`);
console.log(`${C.dim('routed for streams')}  ${pm.route('streams').map((p) => p.id).join(' → ') || '(none)'}`);
if (late.length) console.log(`${C.dim('late failures')}  ${late.slice(0, 4).join(' · ')}`);

/* more than one id: restrictions are per video, and "it works for Rick
   Astley" has never meant "it works for yours" */
for (const extra of IDS.slice(1)) {
  try {
    const r = await pm.getStreams(extra);
    const d = r && r.data;
    const n = [...((d && d.videoStreams) || []), ...((d && d.audioStreams) || [])].filter((f) => f && f.url).length;
    console.log(`${C.dim('also')}  ${extra}  ${C.g('works')} via ${r.provider} · ${n} formats`);
  } catch (e) {
    console.log(`${C.dim('also')}  ${extra}  ${C.r('failed')} · ${trunc((e && e.message) || e, 70)}`);
    for (const t of ((e && e.tried) || [])) console.log('        ' + C.dim(`${t.provider}: ${trunc(t.note, 70)}`));
  }
}
console.log('');
