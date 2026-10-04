/**
 * Signature and `n` deciphering — running YouTube's own player script.
 *
 * This is the thing whose absence caused "no playable streams". For most
 * videos YouTube does not hand back a usable `url`; it hands back a
 * `signatureCipher` whose signature has been scrambled by a function that
 * only exists inside base.js, the obfuscated player bundle. Until now Umbra
 * filtered those formats out, which on a ciphered video means filtering out
 * all of them.
 *
 * There is a second, quieter trap. Even an un-ciphered URL carries an `n`
 * query parameter, and if it is not put through a *different* transform from
 * the same bundle, YouTube serves the video at roughly dial-up speed. A
 * player that appears to work but buffers forever is usually an untransformed
 * `n`.
 *
 * So: fetch base.js, locate the two functions by shape, and run them in a
 * locked-down `node:vm` context. The extracted source is YouTube's, it is
 * minified, and it is hostile input, so it never touches this realm — the
 * sandbox has no require, no process, no network, no timers, and every call
 * is wall-clock bounded.
 *
 * The extraction patterns are the fragile part: YouTube reshapes this bundle
 * regularly. They are therefore written as an ordered list of candidates
 * rather than one clever regex, every failure says which stage failed, and
 * `inspect()` reports what matched so a breakage is diagnosable without a
 * debugger.
 */

import vm from 'node:vm';
import { upstream, readBody } from './net.mjs';

const PLAYER_TTL = Number(process.env.UMBRA_PLAYER_TTL || 6 * 3600 * 1000);
const EXEC_TIMEOUT = Number(process.env.UMBRA_PLAYER_EXEC_TIMEOUT || 1000);
const YT = () => (process.env.UMBRA_YT_BASE || 'https://www.youtube.com').replace(/\/+$/, '');

/* ------------------------------------------------------- source helpers */

/**
 * Read a balanced {...} or (...) block starting at `open`.
 * Regexes cannot match nested braces, and minified player code nests heavily,
 * so the body of an extracted function has to be walked rather than matched.
 * String and regex literals are skipped so a brace inside one cannot end the
 * block early.
 */
export function balanced(src, open, pair = '{}') {
  const [L, R] = pair;
  let i = src.indexOf(L, open);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    /* a regex literal, distinguished from division by what precedes it */
    if (c === '/' && /[=(,:[!&|?{};\n]\s*$/.test(src.slice(Math.max(0, i - 2), i))) {
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '/') break;
        if (src[i] === '\n') break;
      }
      continue;
    }
    if (c === L) depth++;
    else if (c === R) { depth--; if (depth === 0) return { start, end: i + 1, body: src.slice(start, i + 1) }; }
  }
  return null;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------- signature extraction */

/* Each entry captures the name of the function that unscrambles `s`. YouTube
   renames it every release, so these match on shape, not identifier. */
const SIG_NAME = [
  /\b([a-zA-Z0-9$_]{2,})\s*=\s*function\(\s*\w\s*\)\s*\{\s*\w\s*=\s*\w\.split\(\s*(?:""|'')\s*\)\s*;/,
  /\bfunction\s+([a-zA-Z0-9$_]{2,})\s*\(\s*\w\s*\)\s*\{\s*\w\s*=\s*\w\.split\(\s*(?:""|'')\s*\)\s*;/,
  /\b([a-zA-Z0-9$_]{2,})\s*=\s*function\(\s*\w\s*\)\s*\{\s*\w\s*=\s*\w\.split\(\s*(?:""|'')\s*\)/,
  /\bm=([a-zA-Z0-9$_]{2,})\(decodeURIComponent\(h\.s\)\)/,
  /\bc&&\(c=([a-zA-Z0-9$_]{2,})\(decodeURIComponent\(c\)\)/,
];

/**
 * Pull the signature function and the helper object it delegates to.
 * The function body is a list of calls into a small object of primitive
 * transforms (reverse / splice / swap), so both halves are needed.
 */
export function extractSig(src) {
  let name = null;
  let via = null;
  for (let i = 0; i < SIG_NAME.length; i++) {
    const m = SIG_NAME[i].exec(src);
    if (m) { name = m[1]; via = 'sig#' + i; break; }
  }
  if (!name) throw new Error('could not locate the signature function in base.js');

  /* the declaration may be `name=function(a){`, `function name(a){` or
     `var name=function(a){` — find the brace that opens its body */
  const decl = new RegExp(`(?:function\\s+${esc(name)}\\s*\\(|${esc(name)}\\s*=\\s*function\\s*\\()`).exec(src);
  if (!decl) throw new Error('found the signature name but not its declaration');
  const argsEnd = src.indexOf(')', decl.index);
  const block = balanced(src, argsEnd);
  if (!block) throw new Error('signature function body is unbalanced');
  const body = block.body;

  /* the helper object is whatever the body calls methods on */
  const helperName = (/([a-zA-Z0-9$_]{2,})\s*\.\s*[a-zA-Z0-9$_]{1,}\s*\(\s*\w\s*,/.exec(body) || [])[1];
  let helper = '';
  if (helperName) {
    const hDecl = new RegExp(`var\\s+${esc(helperName)}\\s*=\\s*\\{`).exec(src)
      || new RegExp(`${esc(helperName)}\\s*=\\s*\\{`).exec(src);
    if (!hDecl) throw new Error('signature helper object ' + helperName + ' not found');
    const hBlock = balanced(src, hDecl.index + hDecl[0].length - 1);
    if (!hBlock) throw new Error('signature helper object is unbalanced');
    helper = `var ${helperName}=${hBlock.body};`;
  }
  return { name, via, source: `${helper}var __sig=function(${srcArgs(src, decl.index)})${body};` };
}

function srcArgs(src, at) {
  const o = src.indexOf('(', at);
  const c = src.indexOf(')', o);
  return src.slice(o + 1, c);
}

/* --------------------------------------------------- nsig extraction */

/* The `n` transform is referenced from the playback path; find the reference
   first, because the function itself has no distinguishing name. */
const NSIG_NAME = [
  /\.get\(\s*"n"\s*\)\s*\)\s*&&\s*\(\s*\w+\s*=\s*([a-zA-Z0-9$_]+)(?:\[(\d+)\])?\s*\(/,
  /\(\s*\w+\s*=\s*([a-zA-Z0-9$_]+)(?:\[(\d+)\])?\s*\(\s*\w+\s*\)\s*,\s*\w+\.set\(\s*"n"/,
  /\bb\s*=\s*([a-zA-Z0-9$_]+)(?:\[(\d+)\])?\s*\(\s*b\s*\)\s*;.{0,80}?\.set\(\s*"n"/s,
];

export function extractNsig(src) {
  let name = null;
  let idx = null;
  let via = null;
  for (let i = 0; i < NSIG_NAME.length; i++) {
    const m = NSIG_NAME[i].exec(src);
    if (m) { name = m[1]; idx = m[2]; via = 'nsig#' + i; break; }
  }
  if (!name) throw new Error('could not locate the n-transform reference in base.js');

  /* the reference is often into an array: `var Xq=[Zp];` then `Xq[0](n)` */
  if (idx !== undefined && idx !== null) {
    const arr = new RegExp(`var\\s+${esc(name)}\\s*=\\s*\\[`).exec(src);
    if (arr) {
      const block = balanced(src, arr.index + arr[0].length - 1, '[]');
      if (block) {
        const members = block.body.slice(1, -1).split(',').map((x) => x.trim());
        name = members[Number(idx)] || members[0] || name;
      }
    }
  }

  const decl = new RegExp(`(?:function\\s+${esc(name)}\\s*\\(|(?:var\\s+)?${esc(name)}\\s*=\\s*function\\s*\\()`).exec(src);
  if (!decl) throw new Error('found the n-transform name ' + name + ' but not its declaration');
  const argsEnd = src.indexOf(')', decl.index);
  const block = balanced(src, argsEnd);
  if (!block) throw new Error('n-transform body is unbalanced');

  /* When the transform bails it returns the input unchanged, often guarded by
     a thrown "enhanced_except" marker. Leaving that in means a silent
     passthrough that looks like success but throttles, so the guard is cut. */
  let body = block.body.replace(
    /;\s*if\s*\(\s*typeof\s+[a-zA-Z0-9$_]+\s*===?\s*"undefined"\s*\)\s*return\s+\w+\s*;/,
    ';');

  return { name, via, source: `var __nsig=function(${srcArgs(src, decl.index)})${body};` };
}

/* ------------------------------------------------------------- runtime */

/**
 * Compile both functions into one throwaway context.
 *
 * The context is bare: an object literal with nothing on it. Minified player
 * code only needs String/Array/Math, which are intrinsics of the new realm,
 * so there is nothing here for hostile code to reach for.
 */
export function compile(playerSource) {
  const sig = extractSig(playerSource);
  let nsig = null;
  let nsigError = null;
  try { nsig = extractNsig(playerSource); } catch (e) { nsigError = String(e.message || e); }

  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  try {
    new vm.Script(sig.source + (nsig ? nsig.source : ''), { filename: 'base.js' })
      .runInContext(ctx, { timeout: EXEC_TIMEOUT });
  } catch (e) {
    throw new Error('extracted player code failed to compile: ' + String(e.message || e).slice(0, 160));
  }

  const callers = {
    sigName: sig.name,
    sigVia: sig.via,
    nsigName: nsig && nsig.name,
    nsigVia: nsig && nsig.via,
    nsigError,
    decipher(s) {
      return String(vm.runInContext(`__sig(${JSON.stringify(String(s))})`, ctx, { timeout: EXEC_TIMEOUT }));
    },
    transformN(n) {
      if (!nsig) return n;
      try {
        const out = vm.runInContext(`__nsig(${JSON.stringify(String(n))})`, ctx, { timeout: EXEC_TIMEOUT });
        /* a transform that returns nothing, or echoes its input, has failed
           closed; using it would throttle silently */
        return out && typeof out === 'string' && out !== n ? out : n;
      } catch { return n; }
    },
  };
  return callers;
}

/* ------------------------------------------------------- player source */

let cached = null; /* { url, player, at, source } */

/** Find the base.js URL the way the page itself does. */
export async function playerUrl() {
  if (process.env.UMBRA_PLAYER_JS_URL) return process.env.UMBRA_PLAYER_JS_URL;
  const res = await upstream(YT() + '/iframe_api', { timeout: 8000, headers: { accept: '*/*' } });
  if (res.status !== 200) { res.res.resume(); throw new Error('iframe_api http ' + res.status); }
  const body = (await readBody(res.res, { limit: 2 * 1024 * 1024 })).toString('utf8');
  /* iframe_api embeds the player revision rather than the script path */
  const rev = (/player\\?\/([0-9a-fA-F]{8})\\?\//.exec(body) || /\/player\/([0-9a-fA-F]{8})\//.exec(body) || [])[1];
  if (rev) return `${YT()}/s/player/${rev}/player_ias.vflset/en_US/base.js`;
  const direct = (/"(\/s\/player\/[^"]+\/base\.js)"/.exec(body) || [])[1];
  if (direct) return YT() + direct;
  throw new Error('could not find the player revision in iframe_api');
}

export async function fetchPlayer(url) {
  const res = await upstream(url, { timeout: 15000, headers: { accept: '*/*' } });
  if (res.status !== 200) { res.res.resume(); throw new Error('base.js http ' + res.status); }
  return (await readBody(res.res, { limit: 12 * 1024 * 1024 })).toString('utf8');
}

/**
 * The compiled player, cached by URL. base.js is multiple megabytes and the
 * extraction is not free, so this is fetched once per revision rather than
 * once per video.
 */
export async function getPlayer({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < PLAYER_TTL) return cached.player;
  const url = await playerUrl();
  if (!force && cached && cached.url === url && Date.now() - cached.at < PLAYER_TTL) return cached.player;
  const source = await fetchPlayer(url);
  const player = compile(source);
  cached = { url, player, at: Date.now(), bytes: source.length };
  return player;
}

export function resetPlayerCache() { cached = null; }

export function inspect() {
  if (!cached) return { loaded: false };
  return {
    loaded: true,
    url: cached.url,
    bytes: cached.bytes,
    ageMs: Date.now() - cached.at,
    sigName: cached.player.sigName,
    sigVia: cached.player.sigVia,
    nsigName: cached.player.nsigName,
    nsigVia: cached.player.nsigVia,
    nsigError: cached.player.nsigError,
  };
}

/* --------------------------------------------------------- application */

/** Put `n` through the transform, leaving everything else about the URL alone. */
export function applyN(rawUrl, player) {
  try {
    const u = new URL(rawUrl);
    const n = u.searchParams.get('n');
    if (!n) return rawUrl;
    const out = player.transformN(n);
    if (out === n) return rawUrl;
    u.searchParams.set('n', out);
    return u.toString();
  } catch { return rawUrl; }
}

/**
 * Turn one streamingData format into a playable URL.
 *
 * Three shapes show up: a plain `url`, a `signatureCipher` query string, and
 * the older `cipher`. All of them still need the `n` transform afterwards.
 *
 * @returns {{url:string, ciphered:boolean}|null}
 */
export function resolveFormat(f, player) {
  const packed = f.signatureCipher || f.cipher;
  if (!packed && f.url) {
    return { url: player ? applyN(f.url, player) : f.url, ciphered: false };
  }
  if (!packed) return null;
  if (!player) return null;

  const q = new URLSearchParams(packed);
  const base = q.get('url');
  const s = q.get('s');
  if (!base) return null;
  if (!s) return { url: applyN(base, player), ciphered: false };

  let sig;
  try { sig = player.decipher(s); } catch { return null; }
  const param = q.get('sp') || 'signature';
  let out;
  try {
    const u = new URL(base);
    u.searchParams.set(param, sig);
    out = u.toString();
  } catch { return null; }
  return { url: applyN(out, player), ciphered: true };
}
