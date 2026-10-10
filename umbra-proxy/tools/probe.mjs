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
import * as local from '../server/piped-local.mjs';

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

const allNotes = [];

/* What a result is worth, said the same way everywhere: a format the page
   can actually hand to a <video> element. "27 formats" and "0 formats" are
   both HTTP 200s, and only one of them plays. */
function shape(data) {
  const v = ((data && data.videoStreams) || []).filter((f) => f && f.url);
  const a = ((data && data.audioStreams) || []).filter((f) => f && f.url);
  const hls = !!(data && data.hls);
  const host = (v[0] || a[0] || {}).url ? new URL((v[0] || a[0]).url).host : null;
  return { v: v.length, a: a.length, n: v.length + a.length, hls, host };
}
const describe = (sh) =>
  `${sh.n} formats (${sh.v}v ${sh.a}a)` + (sh.hls ? ' + hls' : '') + (sh.host ? ` · ${sh.host}` : '');

async function sweep(id) {
  const rows = [];
  for (const p of providers.ALL) {
    if (typeof p.getStreams !== 'function') continue;
    const t0 = Date.now();
    try {
      const s = await p.getStreams(id);
      const sh = shape(s && (s.data || s));
      rows.push(sh.n
        ? { p: p.id, state: 'works', note: describe(sh), t: ms(t0) }
        : { p: p.id, state: 'gated', note: sh.hls ? 'hls only, no formats the page can play' : 'answered, no urls', t: ms(t0) });
    } catch (e) {
      const note = String((e && e.message) || e);
      allNotes.push(note);
      for (const n of notesOf((e && e.tried) || [])) allNotes.push(n);
      rows.push({ p: p.id, state: 'failed', note: trunc(note), t: ms(t0),
        why: notesOf((e && e.tried) || []).slice(0, 3) });
    }
  }
  return rows;
}

function printRows(rows, w) {
  for (const r of rows) {
    const tag = r.state === 'works' ? C.g('works ') : r.state === 'gated' ? C.y('gated ') : C.r('failed');
    console.log(`  ${r.p.padEnd(w)}  ${tag}  ${String(r.t).padStart(7)}  ${C.dim(r.note)}`);
    /* "no instance answered" is a summary, not a reason. The reason is one
       level down, in what each instance actually said. */
    for (const n of (r.why || [])) console.log(`  ${' '.repeat(w)}          ${C.dim('· ' + trunc(n, 86))}`);
  }
}

/* --------------------------------------------------------------- why ----
 * When a video fails everywhere while another video works from the same
 * machine, the address is fine and the video is the variable: age gate,
 * region, licence, members-only. The local engine already walks every
 * client without short-circuiting, so ask it rather than guess. */
const whyNotes = [];
async function why(id) {
  try {
    const d = await local.diagnose(id);
    for (const c of (d.clients || [])) if (c.reason || c.error) whyNotes.push(String(c.reason || c.error));
    if (d.diagnosis) whyNotes.push(String(d.diagnosis));
    console.log(`  ${C.b('why')}  ${d.diagnosis || '(no diagnosis)'}`);
    for (const c of (d.clients || []).slice(0, 12)) {
      const st = c.error ? C.r(trunc(c.error, 44))
        : `${c.playability || '?'}${c.reason ? ' · ' + trunc(c.reason, 44) : ''} · ${c.formats || 0} formats, ${c.resolved || 0} usable${c.hls ? ', hls' : ''}`;
      console.log(`       ${String(c.client).padEnd(18)} ${C.dim(st)}`);
    }
  } catch (e) {
    console.log(`  ${C.b('why')}  ${C.dim('diagnosis unavailable: ' + trunc((e && e.message) || e, 70))}`);
  }
}

/* ---------------------------------------------------------- the server ---
 * The loop above asks each backend directly. The server does not: it goes
 * through the provider manager, which routes, scores and fails over. If
 * those two disagree, the bug is ours and it is in here — which is exactly
 * the case where a page says "every provider failed" while the backends are
 * demonstrably fine. */
async function viaManager(id) {
  try {
    const r = await pm.getStreams(id);
    const sh = shape(r && r.data);
    return (sh.n ? C.g('works ') : C.y('gated ')) + `  via ${r.provider}  ${describe(sh)}`;
  } catch (e) {
    const tried = ((e && e.tried) || []).map((t) => `${t.provider}: ${trunc(t.note, 60)}`);
    return `${C.r('failed')}  ${trunc((e && e.message) || e, 60)}` +
      (tried.length ? '\n' + tried.map((t) => '      ' + C.dim(t)).join('\n') : '');
  }
}

const rows = await sweep(VID);
const w = Math.max(...rows.map((r) => r.p.length), 19);
printRows(rows, w);
console.log(`\n  ${'through the manager'.padEnd(w)}  ${await viaManager(VID)}`);
console.log(C.dim('  (this is the exact call the watch page makes; if it disagrees with the rows'));
console.log(C.dim('   above, the fault is in Umbra\'s routing, not in YouTube)'));
if (!rows.some((r) => r.state === 'works')) await why(VID);

/* ------------------------------------------------------------ verdict --- */
const pot = potInspect();
const tried = [
  ...rows.filter((r) => r.state !== 'works').map((r) => ({ provider: r.p, note: r.note, instances: (r.why || []).map((n) => ({ note: n })) })),
  /* what the clients themselves said, so the verdict is not inferred from
     empty counts when YouTube supplied an actual reason */
  ...whyNotes.map((n) => ({ provider: 'diagnose', note: n })),
];
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
  console.log(`\n${C.b('video ' + extra)}`);
  const r2 = await sweep(extra);
  printRows(r2, w);
  console.log(`  ${'through the manager'.padEnd(w)}  ${await viaManager(extra)}`);
  if (!r2.some((r) => r.state === 'works')) await why(extra);
}
console.log('');
