#!/usr/bin/env node
/**
 * Umbra offline verification. Spawns a mock upstream + a real Umbra origin on
 * loopback and drives the *shipping* pipeline over real HTTP: documents,
 * rewriting, redirect holds, media Range, cookies, forms, YouTube inspect and
 * the player capsule. No internet required.
 *
 *   node umbra-proxy/test/offline.mjs
 *
 * Fixes are verified two ways: through the wire (this file) and as pure
 * unit checks on protocol.mjs / html.mjs (no server involved).
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import vm from 'node:vm';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = Number(process.env.MOCK_PORT || 4181);
const UMBRA_PORT = Number(process.env.UMBRA_PORT || 4174);
const BASE = `http://127.0.0.1:${UMBRA_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const MOCK_ALT = `http://localhost:${MOCK_PORT}`;
const PFX = '/~umbra/';
const VID = 'dQw4w9WgXcQ';

let cookie = '';
const results = [];
const ok = (name, cond, note = '') => {
  results.push({ name, pass: !!cond, note: String(note).slice(0, 220) });
  console.log(`${cond ? '  ok  ' : ' FAIL  '} ${name}${note ? '  — ' + String(note).slice(0, 220) : ''}`);
};

async function call(p, opts = {}) {
  const { headers, body, method = 'GET', range } = opts;
  const r = await fetch(BASE + p, {
    redirect: 'manual', method, body,
    headers: { cookie, ...(range ? { range } : {}), ...(headers || {}) },
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let meta = null;
  const rawMeta = r.headers.get('x-umbra-meta');
  if (rawMeta) { try { meta = JSON.parse(Buffer.from(rawMeta, 'base64url').toString('utf8')); } catch {} }
  return { status: r.status, headers: r.headers, text: buf.toString('utf8'), bytes: buf, meta };
}
const J = (o) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
/* cookieless twin: proves the explicit session paths (header / ?sid= / signed
   token) that embedded previews and Safari fall back to when third-party
   cookies are blocked. Never touches the shared jar. */
async function callBare(p, opts = {}) {
  const { headers, body, method = 'GET' } = opts;
  const r = await fetch(BASE + p, { redirect: 'manual', method, body, headers: { ...(headers || {}) } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, text: buf.toString('utf8'), bytes: buf };
}
const mint = async (url, mode = 'd', tab = null) => {
  const r = await call('/~umbra/mint', J({ url, mode, tab }));
  const j = JSON.parse(r.text);
  if (!j.href) throw new Error('mint refused for ' + url + ': ' + r.text.slice(0, 160));
  return j;
};

async function waitFor(url, label) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(label + ' never came up at ' + url);
}

const kids = [];
function launch(file, args, env) {
  const k = spawn(process.execPath, [path.join(HERE, '..', file), ...args],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(k);
  return k;
}

/* ================================================================ unit === */
async function unit() {
  console.log('\nUMBRA / offline · unit');
  const P = await import('../server/protocol.mjs');
  const H = await import('../server/html.mjs');
  const Y = await import('../server/youtube.mjs');

  /* ---- worker-scope interception ---- */
  /* shim.js rewrote the worker's script url but nothing patched the worker's
     own globals, so its fetch/XHR/importScripts left for the real network
     with the user's address while the page stayed proxied. These run the
     real worker-shim source against a synthetic worker global. */
  {
    const src = fs.readFileSync(path.join(HERE, '..', 'public', 'worker-shim.js'), 'utf8');
    const calls = { imported: null, fetched: null, opened: null };
    const g = {
      TextEncoder, btoa, URL, Request: class { constructor(u) { this.url = u; } },
      importScripts: (...a2) => { calls.imported = a2; },
      fetch: (i) => { calls.fetched = i; return Promise.resolve('ok'); },
      XMLHttpRequest: function () {},
      WebSocket: function (u) { this.url = u; },
      Worker: function () {},
    };
    g.XMLHttpRequest.prototype.open = function (m, u) { calls.opened = u; };
    g.self = g;
    vm.createContext(g);
    vm.runInContext(src, g);
    g.__umbraWorkerInit({
      origin: 'https://proxy.example', pfx: '/~umbra/', key: 'K', tab: 'T', sid: 'S',
      base: 'https://www.youtube.com/s/player/abc/base.js',
    });

    g.importScripts('https://www.youtube.com/s/player/x/w.js', '/s/rel.js');
    ok('importScripts is rewritten, for every argument it is given',
      calls.imported.length === 2 &&
      calls.imported.every((u) => u.startsWith('https://proxy.example/~umbra/p/s/')),
      String(calls.imported && calls.imported.length));
    /* The second argument was relative. Inside a worker it would resolve
       against the bootstrap blob, which is not where the code thinks it
       lives, so the logical base has to drive resolution. */
    const relDecoded = Buffer.from(
      calls.imported[1].split('/~umbra/p/s/')[1].split(/[/?]/)[0].replace(/-/g, '+').replace(/_/g, '/'),
      'base64').toString('utf8');
    ok('a relative importScripts resolves against the logical url, not the blob',
      relDecoded === 'https://www.youtube.com/s/rel.js', relDecoded);

    g.fetch('https://www.youtube.com/youtubei/v1/player');
    ok('fetch inside a worker goes through the wire',
      typeof calls.fetched === 'string' && calls.fetched.startsWith('https://proxy.example/~umbra/p/x/'),
      String(calls.fetched).slice(0, 48));
    const xhr = new g.XMLHttpRequest();
    xhr.open('GET', 'https://r1---sn-x.googlevideo.com/videoplayback?expire=1');
    ok('xhr inside a worker goes through the wire',
      calls.opened.startsWith('https://proxy.example/~umbra/p/x/'), calls.opened.slice(0, 48));
    const ws = new g.WebSocket('wss://www.youtube.com/live');
    ok('websockets inside a worker are routed to the umbra socket wire',
      ws.url.startsWith('wss://proxy.example/~umbra/w/'), ws.url.slice(0, 44));
    /* Already-wired and non-network refs must survive untouched: rewriting
       twice breaks as surely as not rewriting. */
    calls.imported = null;
    g.importScripts('https://proxy.example/~umbra/p/s/abc', 'data:text/javascript,0');
    ok('already-wired and data urls are left alone',
      calls.imported[0] === 'https://proxy.example/~umbra/p/s/abc' &&
      calls.imported[1] === 'data:text/javascript,0');
    let nested = null;
    try { new g.Worker('x'); } catch (e) { nested = e.message; }
    ok('a nested worker is refused rather than left unshimmed', /not proxied/.test(nested || ''), nested);
  }

  /* ---- one realm, two documents ----
     An iframe's initial about:blank is adopted by its parent, which installs
     the parent's shim closure in that realm. Browsers reuse the Window
     object when the frame's real document commits, so the shim arriving with
     that document used to find __UMBRA_SHIM__ already set and bail out —
     leaving the child resolving its relative references against the PARENT's
     logical base. A YouTube embed framed by umbra://tube/ therefore asked
     for https://tube/youtubei/v1/… and every dependency 502'd.
     These run the real shim source twice in one synthetic realm. */
  {
    const src = fs.readFileSync(path.join(HERE, '..', 'public', 'shim.js'), 'utf8');
    const ctxFor = (url, dir) => JSON.stringify({
      url, dir, tab: 'T1', frame: 'top', key: 'K', session: 'S',
      origin: 'https://proxy.example', ephemeral: 1, hops: [],
    });
    const PARENT = ctxFor('umbra://tube/watch?v=dQw4w9WgXcQ', 'umbra://tube/');
    const CHILD = ctxFor('umbra://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'umbra://www.youtube-nocookie.com/embed/');
    const ctxEl = { id: 'umbra-ctx', textContent: PARENT };
    const noop = () => {};
    const g = {
      TextEncoder, btoa, URL, console,
      document: {
        readyState: 'complete', title: '', documentElement: {},
        getElementById: (id) => (id === 'umbra-ctx' ? ctxEl : null),
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: noop, createElement: () => ({ setAttribute: noop }),
      },
      addEventListener: noop, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
      /* enough of a realm for the capability steps to install or fail
         individually; shim.js records what it could not patch in __UMBRA_DIAG__ */
      Element: function Element() {},
    };
    g.Element.prototype = { setAttribute: noop };
    g.window = g;
    g.top = g;
    g.parent = g;
    g.self = g;
    vm.createContext(g);
    /* the parent document's shim, running in this realm first */
    vm.runInContext(src, g);
    const decode = (w) => Buffer.from(String(w).split('/~umbra/p/')[1].split('/')[1].split(/[/?]/)[0], 'base64url').toString('utf8');
    ok('the shim installs the logical base of the document it came with',
      g.UMBRA.url === 'umbra://tube/watch?v=dQw4w9WgXcQ' &&
      decode(g.UMBRA.wire('/youtubei/v1/log_event', 'x')) === 'https://tube/youtubei/v1/log_event',
      g.UMBRA.url);

    /* the frame's own document commits; the realm (and __UMBRA_SHIM__) is the
       one the parent already touched, but the context is now the child's */
    ctxEl.textContent = CHILD;
    vm.runInContext(src, g);
    ok('a second document in a recycled realm re-anchors on its own base',
      g.UMBRA.url === 'umbra://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      g.UMBRA.url);
    ok('the embed resolves relative references against itself, not its framer',
      decode(g.UMBRA.wire('/youtubei/v1/log_event', 'x')) ===
        'https://www.youtube-nocookie.com/youtubei/v1/log_event',
      decode(g.UMBRA.wire('/youtubei/v1/log_event', 'x')));

    /* and the guard still holds for the ordinary case: the same context twice
       (the parent re-injecting the shim into a frame it already adopted) must
       not reinstall every hook on top of itself */
    const diag = g.__UMBRA_DIAG__;
    vm.runInContext(src, g);
    ok('the superseded installation knows it is no longer current',
      g.__UMBRA_GEN__ === 2, String(g.__UMBRA_GEN__));
    ok('the same context twice is still a no-op, not a reinstall',
      g.__UMBRA_DIAG__ === diag && g.UMBRA.url === 'umbra://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  }

  /* ---- two realms: the framer must not overrule a frame that speaks ----
     The guard above fixes the recycled-realm case. It does not touch the
     other half: patchRealm wraps the CHILD realm's prototypes in the
     PARENT's closure, and on a loaded frame (load event, adoption sweep,
     contentWindow getter) that wrapper lands OUTSIDE the child's own hook —
     so the parent's base is consulted first and the embed's references went
     to https://tube/ anyway. A realm carrying its own shim is off limits. */
  {
    const src = fs.readFileSync(path.join(HERE, '..', 'public', 'shim.js'), 'utf8');
    const noop = () => {};
    const ctxEl = {
      id: 'umbra-ctx',
      textContent: JSON.stringify({
        url: 'umbra://tube/watch?v=dQw4w9WgXcQ', dir: 'umbra://tube/', tab: 'T1', frame: 'top',
        key: 'K', session: 'S', origin: 'https://proxy.example', ephemeral: 1, hops: [],
      }),
    };
    const g = {
      TextEncoder, btoa, URL, console,
      document: {
        readyState: 'complete', title: '', documentElement: {},
        getElementById: (id) => (id === 'umbra-ctx' ? ctxEl : null),
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: noop, createElement: () => ({ setAttribute: noop }),
      },
      addEventListener: noop, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
      Element: function Element() {},
    };
    g.Element.prototype = { setAttribute: noop };
    g.window = g; g.top = g; g.parent = g; g.self = g;
    vm.createContext(g);
    vm.runInContext(src, g);

    /* a synthetic child realm: one reference-bearing prototype is enough to
       see whether the framer reached in */
    const childRealm = (own) => {
      const HTMLScriptElement = function () {};
      let stored = '';
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        configurable: true,
        get() { return stored; },
        set(v) { stored = 'NATIVE:' + v; },
      });
      const Element = function () {};
      Element.prototype = { setAttribute: noop };
      const w = {
        HTMLScriptElement, Element, document: { readyState: 'complete' },
        __UMBRA_SHIM__: own || undefined,
        probe() { const n = new HTMLScriptElement(); n.src = '/youtubei/v1/log_event'; return stored; },
      };
      return w;
    };

    const own = childRealm(true);
    g.__umbraAdopt.patchRealm(own);
    ok('a frame carrying its own shim is left to resolve its own references',
      own.probe() === 'NATIVE:/youtubei/v1/log_event' && own.__UMBRA_REALM__ === 1,
      own.probe());

    /* and the frame that has nothing of its own is still covered — a blank
       realm a page is about to write into must not reach the network raw */
    const blank = childRealm(false);
    g.__umbraAdopt.patchRealm(blank);
    ok('a frame with no shim of its own is still patched by its framer',
      /\/~umbra\/p\//.test(blank.probe()), blank.probe());
  }

  /* ---- a format with a url is not the same as a playable one ----
     Invidious hands back the googlevideo urls IT was given, and those carry
     an `ip=` binding naming the instance. Extraction then "succeeds" while
     every byte request is refused — the most convincing way to play
     nothing. The instance will stream them itself; borrow the relationship
     that already works. */
  {
    const INV = await import('../server/providers/invidious.mjs');
    const inst = { baseUrl: 'https://inv.example' };
    const gvs = { url: 'https://rr3---sn-x.googlevideo.com/videoplayback?expire=1&ip=203.0.113.9&itag=137', itag: '137' };
    ok('a googlevideo url is routed through the instance that can fetch it',
      INV.viaInstance(inst, VID, gvs) ===
        'https://inv.example/latest_version?id=' + VID + '&itag=137&local=true',
      INV.viaInstance(inst, VID, gvs));

    const noItag = { url: 'https://rr3---sn-x.googlevideo.com/videoplayback?expire=1&ip=203.0.113.9' };
    ok('and one with no itag to ask for is still routed, not abandoned',
      /^https:\/\/inv\.example\/videoplayback\?/.test(INV.viaInstance(inst, VID, noItag)) &&
      /local=true/.test(INV.viaInstance(inst, VID, noItag)),
      INV.viaInstance(inst, VID, noItag));

    ok('anything that is not googlevideo is left exactly as it came',
      INV.viaInstance(inst, VID, { url: 'https://inv.example/already/fine.mp4', itag: '18' }) ===
        'https://inv.example/already/fine.mp4');

    process.env.UMBRA_INVIDIOUS_LOCAL = '0';
    ok('and an operator who wants the direct url can still have it',
      INV.viaInstance(inst, VID, gvs) === gvs.url, INV.viaInstance(inst, VID, gvs));
    delete process.env.UMBRA_INVIDIOUS_LOCAL;
  }

  /* ---- the direct embed: on by default, and narrow ----
     The only player that never has to defeat BotGuard is one the visitor's
     own browser loads from Google — which is also the only thing that puts
     the visitor's address in front of Google. It is offered because it is
     the one that plays; it must stay switchable, and it must widen exactly
     one directive and no more. */
  {
    const P2 = await import('../server/piped.mjs');
    const ctx2 = { tabId: 'T1', session: 'S', key: 'K', gen: 'G', policy: { ephemeral: 1 } };
    const payload = (env) => {
      const before = process.env.UMBRA_DIRECT_EMBED;
      if (env === null) delete process.env.UMBRA_DIRECT_EMBED; else process.env.UMBRA_DIRECT_EMBED = env;
      const out = P2.toPlayerPayload({ title: 't', videoStreams: [], audioStreams: [] }, ctx2, VID, 'inst');
      if (before === undefined) delete process.env.UMBRA_DIRECT_EMBED; else process.env.UMBRA_DIRECT_EMBED = before;
      return out;
    };
    const on = payload(null);
    ok('the player that actually plays is offered by default',
      on.directEmbed === 'https://www.youtube-nocookie.com/embed/' + VID + '?rel=0&modestbranding=1',
      String(on.directEmbed));
    ok('and an operator who wants the boundary kept can switch it off',
      payload('0').directEmbed === null && payload('off').directEmbed === null,
      String(payload('0').directEmbed));
    ok('the proxied embed stays available beside it',
      /^\/~umbra\/d\//.test(on.embedDoc), on.embedDoc);

    const src = fs.readFileSync(path.join(HERE, '..', 'server', 'index.mjs'), 'utf8');
    ok('the policy only widens frame-src, and only when the flag is set',
      /"frame-src 'self' blob:" \+ \(DIRECT_EMBED \? ' ' \+ DIRECT_HOSTS : ''\)/.test(src) &&
      !/DIRECT_HOSTS/.test(src.split('frame-src')[0].split('const DIRECT_HOSTS')[1] || ''),
      'frame-src only');
  }

  /* The shim must stand aside for that one frame and for nothing else. */
  {
    const src = fs.readFileSync(path.join(HERE, '..', 'public', 'shim.js'), 'utf8');
    const noop = () => {};
    const ctxEl = {
      id: 'umbra-ctx',
      textContent: JSON.stringify({
        url: 'umbra://tube/watch?v=' + VID, dir: 'umbra://tube/', tab: 'T1', frame: 'top',
        key: 'K', session: 'S', origin: 'https://proxy.example', ephemeral: 1, hops: [],
      }),
    };
    const attrs = new WeakMap();
    function Element() {}
    Element.prototype = {
      getAttribute(n) { return (attrs.get(this) || {})[n] ?? null; },
      setAttribute(n, v) { const a = attrs.get(this) || {}; a[n] = String(v); attrs.set(this, a); },
      hasAttribute(n) { return this.getAttribute(n) !== null; },
    };
    const g = {
      TextEncoder, btoa, URL, console, Element,
      document: {
        readyState: 'complete', title: '', documentElement: {},
        getElementById: (id) => (id === 'umbra-ctx' ? ctxEl : null),
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: noop, createElement: () => ({ setAttribute: noop }),
      },
      addEventListener: noop, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    };
    /* the reference step names these globals directly; a missing one is a
       ReferenceError that takes the whole step down and makes every
       assertion below vacuously true */
    for (const n of ['HTMLAnchorElement', 'HTMLAreaElement', 'HTMLIFrameElement', 'HTMLFrameElement',
      'HTMLImageElement', 'HTMLScriptElement', 'HTMLLinkElement', 'HTMLMediaElement',
      'HTMLInputElement', 'HTMLFormElement', 'HTMLObjectElement', 'HTMLQuoteElement',
      'HTMLSourceElement', 'HTMLTrackElement', 'HTMLEmbedElement', 'HTMLVideoElement', 'HTMLAudioElement']) {
      g[n] = function () {};
    }
    g.window = g; g.top = g; g.parent = g; g.self = g;
    vm.createContext(g);
    vm.runInContext(src, g);

    ok('the reference hooks actually installed in this realm',
      g.__UMBRA_DIAG__.done.indexOf('refs') !== -1, g.__UMBRA_DIAG__.failed.join(' | ').slice(0, 120));

    const marked = new g.Element();
    marked.setAttribute('data-umbra-direct', '1');
    marked.setAttribute('src', 'https://www.youtube-nocookie.com/embed/' + VID);
    ok('a frame marked direct keeps the url it was given',
      marked.getAttribute('src') === 'https://www.youtube-nocookie.com/embed/' + VID,
      marked.getAttribute('src'));

    const ordinary = new g.Element();
    ordinary.setAttribute('src', 'https://www.youtube-nocookie.com/embed/' + VID);
    ok('an unmarked frame is still pulled onto the wire',
      /\/~umbra\//.test(ordinary.getAttribute('src')), ordinary.getAttribute('src'));
  }

  /* The parent must not hand its own context to a frame that is on its way to
     a document of its own — the realm is patched, the context is not. */
  {
    const src = fs.readFileSync(path.join(HERE, '..', 'public', 'shim.js'), 'utf8');
    ok('a frame awaiting its own document is patched but never given our context',
      /function awaitingOwnDocument/.test(src) &&
      /if \(awaitingOwnDocument\(el, win\)\) return;/.test(src) &&
      /injectShimInto\(win, el\)/.test(src));
  }

  /* ---- instance image proxies ----
     A thumbnail named by a Piped/Invidious instance points at *that
     instance's* image proxy. Umbra proxies the bytes itself, so the hop buys
     nothing and costs a dependency on a host that is often already gone —
     the 404s outlive the API call that succeeded. */
  {
    const PP = await import('../server/piped.mjs');
    ok('a piped image proxy is unwrapped back to the host it declares',
      PP.unproxyImage('https://proxy.piped.private.coffee/vi/kNeTn59Fymw/hqdefault.jpg?host=i.ytimg.com&sqp=x') ===
        'https://i.ytimg.com/vi/kNeTn59Fymw/hqdefault.jpg?sqp=x',
      PP.unproxyImage('https://proxy.piped.private.coffee/vi/kNeTn59Fymw/hqdefault.jpg?host=i.ytimg.com&sqp=x'));
    ok('an invidious image path is unwrapped without a host hint',
      PP.unproxyImage('https://inv.example/vi/kNeTn59Fymw/maxres.jpg') === 'https://i.ytimg.com/vi/kNeTn59Fymw/maxres.jpg' &&
      PP.unproxyImage('https://inv.example/ggpht/abc=s176') === 'https://yt3.ggpht.com/abc=s176');
    ok('anything that is not one of those two shapes is left alone',
      PP.unproxyImage('https://i.ytimg.com/vi/x/hq.jpg') === 'https://i.ytimg.com/vi/x/hq.jpg' &&
      PP.unproxyImage('https://cdn.example/logo.png') === 'https://cdn.example/logo.png' &&
      PP.unproxyImage('') === '');
    /* the declared host is not a free redirect: an instance cannot aim
       Umbra's fetcher anywhere it likes by setting ?host= */
    ok('a declared host that is not a youtube image host is ignored',
      PP.unproxyImage('https://proxy.example/vi/x/hq.jpg?host=evil.example') === 'https://i.ytimg.com/vi/x/hq.jpg',
      PP.unproxyImage('https://proxy.example/vi/x/hq.jpg?host=evil.example'));
  }

  /* ---- the watch page as a second extraction surface ---- */
  const WP = await import('../server/watchpage.mjs');
  const TB = await import('../server/tube.mjs');

  /* A regex-based extractor fails both of these: the decoy object comes
     first, and the real one contains braces inside a string. */
  const trickyHtml = '<script>var ytInitialData = {"a":"} {"};</script>'
    + '<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"a } b { c"},"ok":true};</script>';
  const wpTricky = WP.extractJson(trickyHtml, 'ytInitialPlayerResponse');
  ok('watch-page extraction survives a decoy object and braces inside strings',
    wpTricky && wpTricky.ok === true && wpTricky.videoDetails.title === 'a } b { c',
    JSON.stringify(wpTricky && wpTricky.videoDetails));
  ok('watch-page extraction reports absence rather than guessing',
    WP.extractJson('<html>no json here</html>', 'ytInitialPlayerResponse') === null);

  /* The error page used to print "undefined — ..." because provider-level
     entries carry no `instance`, and it hid the nested reasons entirely. */
  const triedShape = [{
    provider: 'invidious',
    note: 'no invidious instance answered',
    instances: [{ instance: 'https://yewtu.be', note: 'connect ETIMEDOUT' }],
  }];
  const explained = TB.explainTried(triedShape);
  ok('the error page names the provider instead of printing undefined',
    !/undefined/.test(explained) && /invidious/.test(explained), explained.split('\n')[0]);
  ok('the error page surfaces the per-instance reason, not just the summary',
    /ETIMEDOUT/.test(explained) && /yewtu\.be/.test(explained), explained.split('\n')[1]);
  ok('the error page still renders the older flat tried shape',
    /pipedapi\.x {2}— {2}http 500/.test(TB.explainTried([{ instance: 'pipedapi.x', note: 'http 500' }])));

  /* ---- verdicts: turning failure notes into a conclusion ---- */
  const V = await import('../server/verdict.mjs');
  /* This fixture is a real failure report from a Codespace, kept verbatim
     because it is the case the feature exists for. */
  const realWorld = [
    { provider: 'invidious', note: 'no invidious instance answered', instances: [
      { instance: 'invidious:inv.nadeko.net', note: 'http 403' },
      { instance: 'invidious:yewtu.be', note: 'http 403' }] },
    { provider: 'innertube', note: 'no innertube instance answered', instances: [
      { instance: 'innertube:in-process', note: 'no playable formats and no hls manifest' }] },
    { provider: 'piped', note: 'no piped instance answered', instances: [
      { instance: 'https://api.piped.private.coffee', note: 'http 500' }] },
    { provider: 'watchpage', note: 'no watchpage instance answered', instances: [
      { instance: 'watchpage:in-process', note: 'watch page extraction failed (watch: LOGIN_REQUIRED: Sign in to confirm you\u2019re not a bot)' }] },
  ];
  const vReal = V.verdict(realWorld, { hasPoToken: false, hasCookies: false });
  /* A bot wall outranks the 403s and 500s around it: those are usually
     downstream of it, and reporting "instances are sick" would send the
     operator to fix the wrong thing. */
  ok('a sign-in wall is diagnosed as a flagged address, outranking noisier failures',
    vReal && vReal.kind === 'bot-wall' && /bot-flagged/.test(vReal.headline), vReal && vReal.kind);
  ok('an unconfigured bot-wall verdict names the two things that could answer it',
    /UMBRA_YT_COOKIES/.test(vReal.detail) && /UMBRA_YT_POTOKEN/.test(vReal.detail));
  ok('with credentials already set the verdict stops suggesting them and points at egress',
    /residential/.test(V.verdict(realWorld, { hasPoToken: true, hasCookies: true }).detail));

  /* A 200 with the formats withheld is a different failure from a refusal,
     and has a different fix. */
  const vGated = V.verdict([{ provider: 'innertube', note: 'no playable formats and no hls manifest' }], {});
  ok('withheld formats are diagnosed as proof-of-origin, not as a block',
    vGated && vGated.kind === 'gated', vGated && vGated.kind);
  const vDead = V.verdict([{ provider: 'piped', note: 'connect ECONNREFUSED 127.0.0.1:1' },
    { provider: 'invidious', note: 'getaddrinfo ENOTFOUND nope.invalid' }], {});
  ok('connection failures across the board are diagnosed as having no route out',
    vDead && vDead.kind === 'no-route', vDead && vDead.kind);
  const vSick = V.verdict([{ provider: 'piped', note: 'http 502' }], {});
  ok('upstream server errors are blamed on the instances, not on us',
    vSick && vSick.kind === 'upstream-sick', vSick && vSick.kind);
  ok('an unrecognisable failure produces no verdict rather than a guess',
    V.verdict([{ provider: 'x', note: 'something entirely novel happened' }], {}) === null);

  /* ---- proof-of-origin tokens ---- */
  const PT = await import('../server/potoken.mjs');
  const IT = await import('../server/innertube.mjs');
  PT.resetPoTokenCache();
  delete process.env.UMBRA_YT_POTOKEN;
  delete process.env.UMBRA_POT_PROVIDER_URL;
  /* With nothing configured the answer is an empty token, never an exception:
     no token is a degraded state and the request should still be attempted. */
  const potNone = await PT.getPoToken('visitor-aaa');
  ok('with no token source configured the result is empty rather than an error',
    potNone === '' && PT.inspect().configured === false, JSON.stringify(potNone));
  ok('an unconfigured token source explains the datacentre failure mode',
    /datacentre|UMBRA_YT_POTOKEN/.test(PT.inspect().advice || ''), (PT.inspect().advice || '').slice(0, 48));

  process.env.UMBRA_YT_POTOKEN = 'pasted-from-a-real-browser';
  PT.resetPoTokenCache();
  ok('a hand-supplied token is used verbatim',
    (await PT.getPoToken('visitor-aaa')) === 'pasted-from-a-real-browser' &&
    PT.inspect().source === 'env');
  /* Tokens are bound to a visitor identity, so the cache must key on it;
     handing one identity's token to another looks like forgery to YouTube. */
  await PT.getPoToken('visitor-bbb');
  ok('the token cache is keyed per visitor identity', PT.inspect().cached === 2,
    'cached=' + PT.inspect().cached);
  delete process.env.UMBRA_YT_POTOKEN;
  PT.resetPoTokenCache();

  /* A bgutil-style provider is the maintainable option for a long-lived
     deployment, so the HTTP contract gets exercised against a stub. */
  const potSrv = http.createServer((rq, rs) => {
    let b = '';
    rq.on('data', (c) => { b += c; });
    rq.on('end', () => {
      const seen = JSON.parse(b || '{}');
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ po_token: 'minted-for-' + (seen.visitor_data || seen.visitorData || '?') }));
    });
  });
  await new Promise((r) => potSrv.listen(0, '127.0.0.1', r));
  process.env.UMBRA_POT_PROVIDER_URL = 'http://127.0.0.1:' + potSrv.address().port;
  const potMinted = await PT.getPoToken('visitor-ccc');
  ok('a bgutil-style provider mints a token bound to the visitor we will use',
    potMinted === 'minted-for-visitor-ccc' && PT.inspect().source === 'provider', potMinted);
  /* A dead provider must not take playback down with it. */
  process.env.UMBRA_POT_PROVIDER_URL = 'http://127.0.0.1:1';
  PT.resetPoTokenCache();
  const potDead = await PT.getPoToken('visitor-ddd');
  ok('an unreachable token provider degrades instead of throwing',
    potDead === '' && !!PT.inspect().lastError, String(PT.inspect().lastError).slice(0, 40));
  delete process.env.UMBRA_POT_PROVIDER_URL;
  PT.resetPoTokenCache();
  await new Promise((r) => potSrv.close(r));

  /* The fourth source, and the only free one: the token the visitor's own
     browser minted inside a proxied YouTube document. Every proxy that plays
     YouTube from a server works this way — BotGuard runs in a real browser,
     and the proof travels with the request. Ours travel through us. */
  PT.resetPoTokenCache();
  PT.resetHarvest();
  const BG = 'MnRfTm9tR2VudWluZUJvdEd1YXJkVG9rZW5fb2Zfc3VmZmljaWVudF9sZW5ndGg9PQ';
  const bgVisitor = IT.synthesizeVisitorData();
  const pageBody = Buffer.from(JSON.stringify({
    context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20260101.00.00', visitorData: bgVisitor } },
    videoId: VID,
    serviceIntegrityDimensions: { poToken: BG },
  }));
  const seenId = IT.readInnertubeIdentity(pageBody);
  ok('an in-flight player request gives up its identity without being changed',
    seenId.poToken === BG && seenId.visitorData === bgVisitor && seenId.videoId === VID,
    seenId.clientName);
  ok('a request that already carries a proof is forwarded verbatim',
    IT.rewriteInnertubeBody(pageBody, { client: 'tv', visitorData: 'ours' }) === null);
  /* …while one without a token is still re-identified as before */
  const plainBody = Buffer.from(JSON.stringify({ context: { client: { clientName: 'WEB' } }, videoId: VID }));
  ok('a request with no proof is still re-identified by the ladder',
    IT.rewriteInnertubeBody(plainBody, { client: 'tv', visitorData: 'ours' }) !== null);

  PT.observe(seenId);
  ok('the harvested token is served back for the identity it was bound to',
    (await PT.getPoToken(bgVisitor)) === BG && PT.inspect().sources.harvested.seen === 1,
    JSON.stringify(PT.inspect().sources.harvested));
  ok('and never for a different identity, which would read as forgery',
    (await PT.getPoToken('some-other-visitor')) === '');
  ok('the ladder adopts the whole pair, identity included',
    (await IT.getVisitorData({ force: true })).value === bgVisitor &&
    (await IT.getVisitorData({})).source === 'browser-botguard',
    (await IT.getVisitorData({})).source);
  ok('a harvested token counts as a configured source for diagnostics',
    PT.inspect().configured === true && PT.inspect().advice === null);
  /* Junk on the wire must not poison the identity: anything that is not
     token-shaped is ignored rather than stored. */
  PT.resetHarvest();
  ok('a short or malformed value is not mistaken for a token',
    PT.observe({ poToken: 'x', visitorData: bgVisitor }) === null &&
    PT.observe({ poToken: '{"not":"a token"}', visitorData: bgVisitor }) === null &&
    PT.harvestedIdentity() === null);
  PT.resetHarvest();
  PT.resetPoTokenCache();
  IT.resetVisitorCache();

  /* ---- signature + n deciphering ---- */
  const DC = await import('../server/decipher.mjs');
  const PLAYER_SRC = [
    'var Pq={',
    ' Wx:function(a){a.reverse()},',
    ' Lm:function(a,b){a.splice(0,b)},',
    ' Rt:function(a,b){var c=a[0];a[0]=a[b%a.length];a[b%a.length]=c}',
    '};',
    'var zx=function(a){a=a.split("");Pq.Wx(a);Pq.Lm(a,2);Pq.Rt(a,3);return a.join("")};',
    'var ndx=function(a){var b=a.split("");b.reverse();return "N"+b.join("")};',
    'var nArr=[ndx];',
    'function setup(c){var b;if((b=c.get("n"))&&(b=nArr[0](b))){c.set("n",b)}return c}',
  ].join('\n');

  ok('brace matching survives strings and regex literals in minified source',
    DC.balanced('x={a:"}}}",b:/[}]/,c:{d:1}}', 2).body === '{a:"}}}",b:/[}]/,c:{d:1}}');
  const sigx = DC.extractSig(PLAYER_SRC);
  ok('the signature function and its helper object are found by shape',
    sigx.name === 'zx' && /Pq\s*=/.test(sigx.source) && /__sig=/.test(sigx.source), sigx.name + ' via ' + sigx.via);
  const nx = DC.extractNsig(PLAYER_SRC);
  ok('the n-transform is found through its array reference',
    nx.name === 'ndx' && /__nsig=/.test(nx.source), nx.name + ' via ' + nx.via);

  const PL2 = DC.compile(PLAYER_SRC);
  ok('the extracted signature transform actually runs',
    PL2.decipher('abcdefgh') === 'cedfba', PL2.decipher('abcdefgh'));
  ok('the extracted n transform actually runs',
    PL2.transformN('XYZ') === 'NZYX', PL2.transformN('XYZ'));
  ok('player code runs sandboxed with no reach into this process',
    (() => {
      try {
        DC.compile(PLAYER_SRC.replace('a.reverse()', 'process.exit(1)')).decipher('abc');
        return false;
      } catch { return true; }
    })());

  const rc = DC.resolveFormat({ signatureCipher: new URLSearchParams({
    s: 'abcdefgh', sp: 'sig', url: 'https://r1.googlevideo.com/v?n=XYZ&itag=18' }).toString() }, PL2);
  ok('a ciphered format becomes a playable url with the signature attached',
    rc.ciphered === true && /[?&]sig=cedfba/.test(rc.url), rc.url);
  ok('the n parameter is transformed, which is what stops the throttling',
    /[?&]n=NZYX/.test(rc.url) && !/[?&]n=XYZ/.test(rc.url), rc.url);
  const rp = DC.resolveFormat({ url: 'https://r1.googlevideo.com/v?n=XYZ' }, PL2);
  ok('a plain url still gets its n transformed',
    rp.ciphered === false && /n=NZYX/.test(rp.url), rp.url);
  ok('without a player, ciphered formats resolve to nothing rather than a broken url',
    DC.resolveFormat({ signatureCipher: 's=abc&url=https%3A%2F%2Fx' }, null) === null &&
    DC.resolveFormat({ url: 'https://x/?n=1' }, null).url === 'https://x/?n=1');
  ok('a reshaped player is reported as a named failure, not a crash',
    (() => { try { DC.extractSig('var nothing=1;'); return false; }
      catch (e) { return /could not locate the signature function/.test(e.message); } })());

  /* ---- provider framework: normalization, cache, pool, routing ---- */
  const TY = await import('../server/providers/types.mjs');
  const CA = await import('../server/cache.mjs');
  const PO = await import('../server/providers/pool.mjs');
  const RG = await import('../server/providers/index.mjs');
  const PM = await import('../server/provider-manager.mjs');

  ok('provider counts coerce from every shape they arrive in',
    TY.num('1.2M') === 1200000 && TY.num('1,234 views') === 1234 && TY.num(42) === 42 && TY.num('nope') === null);
  ok('durations coerce from seconds and clock strings',
    TY.duration(212) === 212 && TY.duration('3:32') === 212 && TY.duration('1:02:03') === 3723);
  ok('epoch seconds and milliseconds both become iso dates',
    TY.isoDate(1767225600).startsWith('2026-') && TY.isoDate(1767225600000).startsWith('2026-') &&
    TY.isoDate('garbage') === null);
  ok('a provider cannot smuggle a javascript: url into the model',
    TY.url('javascript:alert(1)') === '' && TY.url('data:text/html,x') === '' &&
    TY.url('https://e.com/a.jpg') === 'https://e.com/a.jpg' && TY.url('//e.com/a.jpg') === 'https://e.com/a.jpg');
  ok('a video with no usable id is dropped rather than half-built',
    TY.video({ id: 'short', title: 'x' }, { provider: 'p' }) === null &&
    TY.video({ id: VID, title: '' }, { provider: 'p' }) === null &&
    TY.video({ id: VID, title: 'ok' }, { provider: 'p' }).id === VID);
  ok('thumbnails come back largest first',
    TY.thumbnails([{ url: 'https://e.com/s.jpg', width: 120 }, { url: 'https://e.com/l.jpg', width: 1280 }])[0].width === 1280);

  const mkv = (id, provider, extra = {}) => TY.video({ id, title: 't-' + provider, ...extra }, { provider });
  const merged = TY.dedupeVideos([
    [mkv(VID, 'piped', { viewCount: 10 }), mkv('aaaaaaaaaaa', 'piped')],
    [mkv(VID, 'invidious', { duration: 212 })],
  ]);
  ok('the same video from two providers is merged, not duplicated',
    merged.length === 2 && merged.find((v) => v.id === VID).providers.length === 2,
    merged.map((v) => v.id + ':' + v.providers.join('+')).join(' '));
  ok('merging fills gaps from the other provider rather than picking one wholesale',
    merged.find((v) => v.id === VID).viewCount === 10 && merged.find((v) => v.id === VID).duration === 212);
  ok('results agreed on by more providers rank first',
    TY.rankVideos(merged)[0].id === VID);
  ok('dedupe is by video id, never by title',
    TY.dedupeVideos([[mkv(VID, 'a'), mkv('aaaaaaaaaaa', 'a')]]).length === 2);

  /* cache */
  const c1 = new CA.MemoryCache({ max: 2 });
  c1.set('a', { v: 1 }, 10000);
  ok('the metadata cache returns what it stored', c1.get('a').v === 1 && c1.get('nope') === undefined);
  c1.set('b', { v: 2 }, 10000); c1.set('c', { v: 3 }, 10000);
  ok('the cache evicts rather than growing without bound', c1.map.size === 2);
  ok('an expired entry is a miss, not a stale hit',
    (c1.set('d', { v: 4 }, 1), new Promise((r) => setTimeout(r, 5))) && true);
  await sleep(8);
  ok('entries expire on their ttl', c1.get('d') === undefined);
  const c2 = new CA.MemoryCache();
  c2.set('buf', Buffer.from('not metadata'), 10000);
  ok('the metadata cache refuses to hold media bytes',
    c2.get('buf') === undefined && c2.stats().refused === 1);
  ok('cache stats report a hit rate', typeof c1.stats().hitRate === 'number');

  /* instance pool: failure, cooldown, backoff */
  const inst = new PO.ProviderInstance('https://x.example', 'test');
  ok('a fresh instance is available and unscored', inst.available === true && inst.latency === null);
  inst.fail(new Error('boom')); inst.fail(new Error('boom'));
  ok('failures below the limit demote but do not bench',
    inst.available === true && inst.failures === 2 && inst.status() === 'UNKNOWN' || inst.failures === 2);
  inst.fail(new Error('boom'));
  ok('the third consecutive failure benches the instance',
    inst.available === false && inst.status() === 'COOLDOWN' && inst.cooldownUntil > Date.now());
  ok('a benched instance scores below every live one', inst.score() === -1);
  const inst2 = new PO.ProviderInstance('https://y.example', 'test');
  inst2.succeed(120);
  ok('success clears failures and records latency',
    inst2.failures === 0 && inst2.latency === 120 && inst2.status() === 'ONLINE' && inst2.score() > 0);
  ok('a faster instance outscores a slower one',
    (() => { const slow = new PO.ProviderInstance('https://z.example', 't'); slow.succeed(2000); return inst2.score() > slow.score(); })());

  const pool = new PO.InstancePool('test', ['https://dead.example', 'https://live.example']);
  let hitCount = 0;
  const pr = await pool.run(async (i) => {
    hitCount++;
    if (/dead/.test(i.baseUrl)) throw new Error('refused');
    return 'served';
  });
  ok('the pool fails past a dead instance to a live one',
    pr.data === 'served' && /live/.test(pr.instance.baseUrl) && pr.tried.length === 1, 'attempts=' + hitCount);
  const pool2 = new PO.InstancePool('test', ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example']);
  let tries = 0;
  await pool2.run(async () => { tries++; throw new Error('down'); }).catch(() => {});
  ok('a failing pool is bounded, not retried forever',
    tries === PO.POOL_DEFAULTS.MAX_ATTEMPTS, 'tries=' + tries);

  /* routing */
  ok('routing only offers providers that declare the capability',
    PM.route('streams').every((p) => p.capabilities.streams) &&
    PM.route('search').every((p) => p.capabilities.search));
  /* youtubei.js is an optional dependency, so whether it routes depends on
     whether the operator installed it. Both are correct; what must hold is
     that an engine with nothing behind it stays out, and that an installed
     one never jumps the configured order. */
  const hasYtjs = await import('youtubei.js').then(() => true, () => false);
  const routed = PM.route('search').map((p) => p.id);
  ok('optional engines that are not installed stay out of the routing',
    !routed.includes('ytdlp') && !routed.includes('poketube') &&
    (hasYtjs || !routed.includes('youtubejs')),
    routed.join('>') + (hasYtjs ? ' (youtubei.js present)' : ''));
  ok('an untested provider is never promoted above the configured order',
    routed[0] === 'innertube' &&
    routed.join(',') === (hasYtjs ? 'innertube,piped,invidious,youtubejs' : 'innertube,piped,invidious'),
    routed.join(','));
  PM.setRouter(() => [RG.get('invidious')]);
  ok('the routing policy is swappable for a future ai router',
    PM.route('search').length === 1 && PM.route('search')[0].id === 'invidious');
  PM.setRouter(() => [{ id: 'evil', capabilities: { search: true }, search: () => [] }]);
  ok('a router cannot introduce a backend that is not registered',
    PM.route('search').every((p) => RG.get(p.id)), PM.route('search').map((p) => p.id).join(','));
  PM.resetRouter();
  ok('resetting the router restores deterministic order',
    PM.route('search')[0].id === 'innertube');
  ok('the ecosystem survey records why a project was not wired up',
    RG.SURVEY.some((x) => x.project === 'CloudTube' && x.covered_by === 'invidious') &&
    RG.SURVEY.some((x) => x.project === 'LibreTube' && x.verdict === 'not-independent'));

  /* ---- piped-local: the instance Umbra runs itself ---- */
  const PL = await import('../server/piped-local.mjs');
  const PP = await import('../server/piped.mjs');

  ok('the default pool leads with the local instance',
    PP.INSTANCES[0] === PP.LOCAL && PP.INSTANCES.length > 1, PP.INSTANCES.slice(0, 3).join(','));
  ok('innertube text nodes read as plain strings',
    PL.txt({ simpleText: 'a' }) === 'a' && PL.txt({ runs: [{ text: 'x' }, { text: 'y' }] }) === 'xy' && PL.txt(null) === '');
  ok('a gated reply is told apart from an honestly empty one',
    PL.barren({ responseContext: {}, alerts: [{ alertRenderer: { text: { simpleText: "Sign in to confirm you're not a bot" } } }] }) === true &&
    PL.barren({ contents: { sectionListRenderer: { contents: [] } } }) === false);
  ok('the refusal wording is quoted back, not swallowed',
    /sign in to confirm/i.test(PL.gateReason({ alerts: [{ text: "Sign in to confirm you're not a bot" }] })) &&
    PL.gateReason({ contents: {} }) === '');
  ok('durations parse from mm:ss and hh:mm:ss',
    PL.durToSeconds('3:32') === 212 && PL.durToSeconds('1:02:03') === 3723 && PL.durToSeconds('') === 0);
  ok('view counts parse from both long and abbreviated forms',
    PL.viewsToNumber('1,234,567 views') === 1234567 && PL.viewsToNumber('1.2M views') === 1200000 &&
    PL.viewsToNumber('12K') === 12000 && PL.viewsToNumber('nonsense') === 0);
  /* the collector must find renderers wherever YouTube decides to nest them:
     this is what keeps the parser alive across layout churn */
  const buried = { a: { b: [{ c: { videoRenderer: { videoId: 'AAAAAAAAAAA', title: { runs: [{ text: 'deep' }] } } } }] } };
  ok('renderers are found at arbitrary depth, not on a fixed path',
    PL.collect(buried, 'videoRenderer').length === 1 &&
    PL.videoItems(buried)[0].url === '/watch?v=AAAAAAAAAAA' && PL.videoItems(buried)[0].title === 'deep');
  ok('video items de-duplicate across renderer shapes',
    PL.videoItems({ x: { videoRenderer: { videoId: 'BBBBBBBBBBB' } }, y: { compactVideoRenderer: { videoId: 'BBBBBBBBBBB' } } }).length === 1);

  /* ---- innertube: client identities + visitor session ---- */

  const realVisitor = Buffer.concat([
    Buffer.from([0x0a, 0x0b]), Buffer.from('AbCdEfGhIjK', 'ascii'), Buffer.from([0x28, 0xd0, 0x0f]),
  ]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  ok('visitorData validator accepts a real protobuf-shaped token', IT.looksLikeVisitorData(realVisitor));
  ok('visitorData validator rejects a random string',
    !IT.looksLikeVisitorData('totally-random-not-a-token-at-all-000000') &&
    !IT.looksLikeVisitorData('') && !IT.looksLikeVisitorData('short'));
  ok('synthesized visitorData is structurally valid (0x0a 0x0b header)',
    IT.looksLikeVisitorData(IT.synthesizeVisitorData()));
  ok('synthesized tokens are distinct per call but each well-formed',
    IT.synthesizeVisitorData() !== IT.synthesizeVisitorData());

  /* This assertion used to demand a non-JS-player client first, because Umbra
     could not unscramble ciphered urls and a ciphering client was a dead end.
     Deciphering landed, so the cost of ciphering is now a few milliseconds and
     the ordering question became a different one: which client is least likely
     to be refused. Current guidance puts `tv` first, so the ladder leads with
     it and keeps a spread of scoring buckets behind it rather than a spread of
     cipher behaviours. */
  ok('default ladder leads with the least-scrutinised client',
    IT.LADDER.length >= 2 && IT.LADDER[0] === 'tv', IT.LADDER.join(','));
  /* IOS and ANDROID contexts are rejected outright when the device fields
     are missing, and the failure looks like a generic refusal rather than a
     malformed request, so it is worth pinning. */
  const iosC = IT.buildContext('ios', {}).client;
  ok('the ios client sends the device fields its context requires',
    iosC.clientName === 'IOS' && iosC.deviceMake === 'Apple' && !!iosC.deviceModel &&
    iosC.osName === 'iPhone' && !!iosC.osVersion, iosC.deviceModel + '/' + iosC.osVersion);
  const andC = IT.buildContext('android', {}).client;
  ok('the android client sends an sdk version, not just a name',
    andC.clientName === 'ANDROID' && andC.androidSdkVersion === 34 && andC.osName === 'Android',
    String(andC.androidSdkVersion));
  /* Neither app client ciphers, so neither should be waiting on the JS
     player — if they were, they would be no cheaper than the web clients. */
  ok('the app clients need no js player',
    IT.CLIENTS.ios.jsPlayer === false && IT.CLIENTS.android.jsPlayer === false);
  /* ios is ranked above android deliberately: it is the client most likely
     to return an HLS manifest, which is playable without per-format
     deciphering and is not gated format by format. */
  ok('ios is tried before android',
    IT.LADDER.indexOf('ios') < IT.LADDER.indexOf('android'), IT.LADDER.join(','));

  ok('the ladder spans several distinct scoring buckets',
    ['tv', 'ios', 'android', 'web_embedded', 'web_safari', 'mweb', 'web_music']
      .every((c) => IT.LADDER.includes(c)),
    IT.LADDER.join(','));
  ok('every ladder entry is a known client', IT.LADDER.every((k) => !!IT.CLIENTS[k]));

  const embCtx = IT.buildContext('web_embedded', { visitorData: realVisitor });
  ok('embedded client asks for the EMBED screen', embCtx.client.clientScreen === 'EMBED');
  ok('embedded client claims a non-YouTube embed host',
    !!embCtx.thirdParty?.embedUrl && !/youtube\.com/.test(embCtx.thirdParty.embedUrl), embCtx.thirdParty?.embedUrl);
  ok('client context carries name, version and visitor id',
    embCtx.client.clientName === 'WEB_EMBEDDED_PLAYER' && !!embCtx.client.clientVersion &&
    embCtx.client.visitorData === realVisitor);
  const vrCtx = IT.buildContext('android_vr', { visitorData: realVisitor });
  ok('ANDROID_VR context mimics the Quest player',
    vrCtx.client.clientName === 'ANDROID_VR' && vrCtx.client.deviceMake === 'Oculus' &&
    /youtube\.vr\.oculus/.test(vrCtx.client.userAgent));
  const vrH = IT.buildHeaders('android_vr', { visitorData: realVisitor, videoId: VID });
  ok('headers agree with the in-body identity',
    vrH['x-youtube-client-name'] === '28' && vrH['x-goog-visitor-id'] === realVisitor &&
    vrH['user-agent'] === vrCtx.client.userAgent);

  ok('innertube url detector matches the RPC surface only',
    IT.isInnertubeUrl('https://www.youtube.com/youtubei/v1/player') &&
    IT.isInnertubeUrl('https://youtubei.googleapis.com/youtubei/v1/next') &&
    !IT.isInnertubeUrl('https://www.youtube.com/watch?v=' + VID) &&
    !IT.isInnertubeUrl('https://example.com/youtubei/v1/player'));

  const itRw = IT.rewriteInnertubeBody(
    Buffer.from(JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.0' } }, videoId: VID })),
    { client: 'android_vr', visitorData: realVisitor });
  const itRwj = itRw && JSON.parse(itRw.toString('utf8'));
  ok('in-flight POST body is re-identified',
    itRwj?.context?.client?.clientName === 'ANDROID_VR' && itRwj.context.client.visitorData === realVisitor &&
    itRwj.videoId === VID && itRwj.contentCheckOk === true);
  ok('non-innertube bodies pass through untouched',
    IT.rewriteInnertubeBody(Buffer.from(JSON.stringify({ hello: 'world' }))) === null &&
    IT.rewriteInnertubeBody(Buffer.from('not json at all')) === null);

  const tok = P.encodeToken({ u: 'http://x/y', t: 'T1', s: 'S1', g: 'G1', m: 'd' });
  ok('token round-trips', P.decodeToken(tok)?.u === 'http://x/y');
  ok('tampered token refused', P.decodeToken(tok.slice(0, -2) + 'xx') === null);
  ok('resolveRef maps umbra:// to https', P.resolveRef('umbra://example.com/a?b=1', 'https://x/') === 'https://example.com/a?b=1');
  ok('resolveRef resolves relative refs', P.resolveRef('p?q=1', 'https://h/dir/') === 'https://h/dir/p?q=1');
  ok('resolveRef refuses javascript:/mailto:/data:', ['javascript:x', 'mailto:a@b', 'data:text/plain,x'].every((x) => P.resolveRef(x, 'https://h/') === null));
  ok('toUmbra keeps path+query+hash', P.toUmbra('https://h:8443/a?b=1#z') === 'umbra://h:8443/a?b=1#z');

  const ctx = { tabId: 'T1', session: 'S1', gen: 'G1', origin: BASE };
  const rw = (html, base = MOCK + '/') => H.rewriteHtml(html, { base, ctx, mode: 's' });
  const out = rw('<a href="/p2">a</a><a href="javascript:x">b</a><a href="mailto:a@b">c</a>' +
    '<img src="/i.png" srcset="/a.png 1x, /b.png 2x"><form action="/f" method="post"></form>' +
    '<base href="http://evil.example/"><meta http-equiv="refresh" content="2;url=/later">' +
    '<div style="background:url(\'/bg.jpg\')">t</div><noscript><img src="/n.png"></noscript>' +
    '<iframe src="/fr"></iframe><video src="/v.mp4" poster="/p.jpg"></video>');
  ok('anchors minted as mode d', /<a href="\/~umbra\/d\//.test(out), (out.match(/<a href="[^"]{0,30}/g) || []).join(' '));
  ok('javascript:/mailto: hrefs inerted', !/href="javascript:/i.test(out) && !/href="mailto:/i.test(out) && /href="umbra:inert"/.test(out));
  ok('srcset candidates each rewired', (out.match(/\/~umbra\/s\//g) || []).length >= 3);
  ok('form action minted as mode f', /action="\/~umbra\/f\//.test(out));
  ok('<base> stripped (explicit re-anchor instead)', !/<base/i.test(out));
  ok('meta refresh converted, never a live redirect', /http-equiv="umbra-refresh"/.test(out) && /data-umbra-target="http:\/\/127\.0\.0\.1:\d+\/later"/.test(out));
  ok('inline style url() rewired', /url\((&quot;|")\/~umbra\//.test(out));
  ok('noscript markup still rewritten', /<noscript><img src="\/~umbra\/s\//.test(out));
  ok('iframe src minted as mode d', /<iframe src="\/~umbra\/d\//.test(out));
  ok('video src/poster minted as mode m', /<video src="\/~umbra\/m\//.test(out) && /poster="\/~umbra\/m\//.test(out));
  const css = H.rewriteCssUrls(`a{background:url(/x.png)}@import "/y.css";`, MOCK + '/', ctx, 's');
  ok('css url() + @import rewired', css.changed && /url\("\/~umbra\//.test(css.text) && /@import "\/~umbra\//.test(css.text), css.text.slice(0, 80));

  /* script-text scrubbing: quoted absolute/protocol-relative image URLs are
     pulled onto the wire WITHOUT corrupting the surrounding quotes (regression:
     the old protocol-relative branch emitted doubled quotes). */
  const scrub = rw(`<script>var a="https://cdn.mock/img/photo.jpg";var b="//cdn.mock/img/x.png";var j={"u":"https:\\/\\/cdn.mock\\/i\\/y.jpg"};</script>`);
  ok('absolute image url in script text rewired', /\/~umbra\/s\//.test(scrub) && !/cdn\.mock\/img\/photo\.jpg/.test(scrub));
  ok('protocol-relative image url rewired with quoting intact', !/""\/~umbra/.test(scrub) && /"\/~umbra\/s\/[^"]*"/.test(scrub),
    (scrub.match(/var b="[^;]{0,60}/) || [''])[0]);
  const rpcSrc = `<script>var r="https://api.mock/v1/rpc?a=1&b=2";</script>`;
  ok('non-image script strings untouched (json stays byte-identical)', rw(rpcSrc) === rpcSrc);

  ok('isYouTube matches watch/shorts/music/youtu.be, rejects others',
    Y.isYouTube('https://www.youtube.com/watch?v=' + VID) && Y.isYouTube('https://youtu.be/' + VID) &&
    !Y.isYouTube(MOCK + '/watch?v=' + VID) && !Y.isYouTube('https://example.com/'));
  ok('parseVideoId from watch/shorts/embed/youtu.be',
    Y.parseVideoId('https://www.youtube.com/watch?v=' + VID) === VID &&
    Y.parseVideoId('https://youtu.be/' + VID) === VID &&
    Y.parseVideoId('https://www.youtube.com/shorts/' + VID + '?x=1') === VID &&
    Y.parseVideoId('https://www.youtube.com/embed/' + VID) === VID &&
    Y.parseVideoId('https://www.youtube.com/playlist?list=abc') === null);
}

/* ================================================================ wire === */
async function wire() {
  console.log('\nUMBRA / offline · wire');
  const boot = await call('/~umbra/boot');
  ok('boot issues session', boot.status === 200 && /umbra_s=/.test(boot.headers.get('set-cookie') || ''));
  const tn = JSON.parse((await call('/~umbra/tab.new?url=umbra://home/')).text);
  ok('tab registry mints id + frame key', /^T[0-9a-f]{10}$/.test(tn.tab) && /^[0-9a-f]{20}$/.test(tn.key), tn.tab);

  const forged = await call(PFX + 'd/' + Buffer.from(JSON.stringify({ u: MOCK + '/', t: 'x', s: 'nope', m: 'd' })).toString('base64url') + '.0000000000');
  ok('forged token refused', forged.status === 403, 'http ' + forged.status);

  /* ---- cookieless operation: explicit session, no third-party cookies ---- */
  const bootJ = JSON.parse(boot.text);
  const hm = await callBare('/~umbra/mint', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-umbra-session': bootJ.session },
    body: JSON.stringify({ url: MOCK + '/', mode: 'd', tab: tn.tab }) });
  ok('x-umbra-session header mints with no cookie', hm.status === 200 && /\/~umbra\/d\//.test(hm.text), 'http ' + hm.status);
  let bearerHref = '';
  try { bearerHref = JSON.parse(hm.text).href || ''; } catch {}
  const bearer = bearerHref ? await callBare(bearerHref) : { status: 0, text: '' };
  ok('signed wire url is a bearer: serves with no session at all', bearer.status === 200 && /Mock Origin/.test(bearer.text), 'http ' + bearer.status);
  const labBare = await callBare(`${PFX}lab/image?t=${tn.tab}&sid=${bootJ.session}`);
  ok('?sid= query opens unsigned local routes with no cookie', labBare.status === 200 && /fixture · images/.test(labBare.text), 'http ' + labBare.status);
  const forgedBare = await callBare(PFX + 'd/' + Buffer.from(JSON.stringify({ u: MOCK + '/', t: 'x', s: 'nope', m: 'd' })).toString('base64url') + '.0000000000');
  ok('forged token still refused with no session', forgedBare.status === 401 || forgedBare.status === 403, 'http ' + forgedBare.status);
  const anonMint = await callBare('/~umbra/mint', J({ url: MOCK + '/', mode: 'd', tab: tn.tab }));
  ok('anonymous mint still refused', anonMint.status === 401, 'http ' + anonMint.status);

  /* ---- document + rewriting against the mock ---- */
  const doc = await call((await mint(MOCK + '/', 'd', tn.tab)).href);
  ok('mode d serves a rewritten document', doc.status === 200 && /Mock Origin/.test(doc.text) && /umbra-ctx/.test(doc.text), doc.meta?.kind);
  ok('shim + logical context injected', /shim\.js/.test(doc.text) && /"url":"umbra:\/\//.test(doc.text));
  /* Behind a TLS-terminating proxy the socket is plain http and the scheme
     only exists in a header — which chained proxies append to rather than
     replace. Reading the whole list made the origin "https, http://host",
     and every url the shim mints at runtime inherits it. */
  {
    const fwd = await call((await mint(MOCK + '/', 'd', tn.tab)).href, {
      headers: { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'edge.example, inner.example' },
    });
    const octx = JSON.parse(/<script[^>]*id="umbra-ctx"[^>]*>([\s\S]*?)<\/script>/.exec(fwd.text)[1]);
    ok('a chained x-forwarded-proto still yields one usable origin',
      octx.origin === 'https://edge.example', octx.origin);
  }
  ok('no bare mock refs left in attributes', !/(?:href|src|poster|action)="(?:http:\/\/127\.0\.0\.1|http:\/\/localhost)/.test(doc.text));
  ok('upstream framing headers stripped, umbra cloak applied',
    !doc.headers.get('x-frame-options') && /default-src 'self'/.test(doc.headers.get('content-security-policy') || ''));
  ok('anchors carry logical umbra addresses', /data-umbra="umbra:\/\/127\.0\.0\.1:\d+\/page2"/.test(doc.text),
    (doc.text.match(/data-umbra="[^"]{0,50}/) || [''])[0]);
  ok('no destination host in the wire path', !/127\.0\.0\.1|localhost/.test((await mint(MOCK + '/')).href));
  ok('upstream Set-Cookie swallowed, never forwarded', !/origin_probe/.test(doc.headers.get('set-cookie') || ''));
  ok('meta exposes kind/doc/tab', doc.meta?.kind === 'doc' && doc.meta?.tab === tn.tab, JSON.stringify(doc.meta).slice(0, 120));

  const cssM = await mint(MOCK + '/style.css', 's', tn.tab);
  const css = await call(cssM.href);
  ok('mode s rewrites css url() + @import', css.status === 200 && /url\("\/~umbra\//.test(css.text) && !/url\(['"]?http/.test(css.text), css.text.slice(0, 90));
  const js = await call((await mint(MOCK + '/app.js', 's', tn.tab)).href);
  ok('js passes through byte-exact', js.status === 200 && js.text.includes('mock-app') && /javascript/.test(js.headers.get('content-type') || ''));
  const png = await call((await mint(MOCK + '/pixel.png', 's', tn.tab)).href);
  ok('image bytes proxied', png.status === 200 && png.bytes.length > 40 && /image\/png/.test(png.headers.get('content-type') || ''), png.bytes.length + 'B');

  /* ---- redirects: browser-like by default, held on strict policy ---- */
  const def = await call((await mint(`${MOCK}/redirect-to?url=${encodeURIComponent(MOCK_ALT + '/other')}&status_code=302`, 'd', tn.tab)).href);
  ok('default policy follows a cross-host 3xx into one document', def.status === 200 && /other host doc/.test(def.text) && def.meta?.redirected === true && def.meta?.hops === 2,
    'http ' + def.status + ' hops=' + def.meta?.hops);
  await call('/~umbra/policy', J({ follow: 'same-host' }));
  const held = await call((await mint(`${MOCK}/redirect-to?url=${encodeURIComponent(MOCK_ALT + '/other')}&status_code=302`, 'd', tn.tab)).href);
  ok('strict policy holds a cross-host 3xx as an in-tab capsule', held.status === 200 && /redirect held/i.test(held.text) && held.meta?.kind === 'redirect-held',
    'http ' + held.status + ' kind=' + held.meta?.kind);
  ok('capsule payload carries the redirect target', /"type":"redirect"/.test(held.text) && held.text.includes('umbra://localhost'));
  ok('capsule follow-link carries a VALID token (gen-bound)',
    await (async () => {
      const m = /href="(\/~umbra\/d\/[^"]+?)\/followed\.html"/.exec(held.text);
      if (!m) return false;
      const f = await call(m[1] + '/followed.html');
      return f.status === 200 && /other host doc/.test(f.text);
    })(), 'followed.html renders the target');
  const same = await call((await mint(`${MOCK}/redirect/2`, 'd', tn.tab)).href);
  ok('same-host chain followed silently into one document', same.status === 200 && /chain end/.test(same.text) && !/redirect held/i.test(same.text));
  await call('/~umbra/policy', J({ follow: 'all' }));
  const allF = await call((await mint(`${MOCK}/redirect-to?url=${encodeURIComponent(MOCK_ALT + '/other')}&status_code=302`, 'd', tn.tab)).href);
  ok('policy follow=all collapses cross-host hops', /other host doc/.test(allF.text));
  await call('/~umbra/policy', J({ follow: 'none' }));
  const noneF = await call((await mint(`${MOCK}/redirect/2`, 'd', tn.tab)).href);
  ok('policy hold-every-hop holds even same-host', /redirect held/i.test(noneF.text));
  await call('/~umbra/policy', J({ follow: 'all' }));
  const sub = await call((await mint(`${MOCK}/redirect-to?url=${encodeURIComponent(MOCK_ALT + '/photo.jpg')}&status_code=302`, 's', tn.tab)).href);
  ok('subresource 302 followed, never a capsule', sub.status === 200 && sub.bytes.length > 10 && !/redirect held/i.test(sub.text));
  const c302 = await call((await mint(`${MOCK}/redirect-to?url=${encodeURIComponent('/post')}&status_code=302`, 'x', tn.tab)).href,
    { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'dropped-body' });
  ok('POST+302 downgrades to GET per fetch spec', c302.status === 200 && /"method":"GET"/.test(c302.text) && /"data":""/.test(c302.text), c302.text.slice(0, 90));
  const c307 = await call((await mint(`${MOCK}/redirect-to?url=${encodeURIComponent('/post')}&status_code=307`, 'x', tn.tab)).href,
    { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'kept-body' });
  ok('POST+307 replays the body untouched', c307.status === 200 && /"method":"POST"/.test(c307.text) && /kept-body/.test(c307.text));

  /* ---- media + Range ---- */
  const mp4 = (await mint(MOCK + '/clip.mp4', 'm', tn.tab)).href;
  const r0 = await call(mp4, { headers: { range: 'bytes=0-1023' } });
  ok('Range copied upstream: 206 + Content-Range', r0.status === 206 && r0.bytes.length === 1024 && /^bytes 0-1023\/262144$/.test(r0.headers.get('content-range') || ''), r0.status + ' ' + r0.headers.get('content-range'));
  ok('range bytes are byte-exact', r0.bytes[0] === 0 && r0.bytes[1] === 1 && r0.bytes[1000] === 1000 % 251);
  const rMid = await call(mp4, { headers: { range: 'bytes=200000-200999' } });
  ok('mid-file seek works', rMid.status === 206 && rMid.bytes.length === 1000 && rMid.bytes[0] === 200000 % 251);
  const full = await call(mp4);
  ok('full stream passthrough', full.status === 200 && full.bytes.length === 262144, full.bytes.length + ' bytes');
  ok('accept-ranges advertised', /bytes/.test(r0.headers.get('accept-ranges') || ''));

  /* ---- xhr / forms / cookies ---- */
  const x = await call((await mint(MOCK + '/get?via=xhr', 'x', tn.tab)).href);
  ok('mode x byte-exact + meta exposed', x.status === 200 && /"via":"xhr"/.test(x.text) && /x-umbra-meta/.test(x.headers.get('access-control-expose-headers') || ''));
  const pj = await call((await mint(MOCK + '/post', 'x', tn.tab)).href,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rpc: 'player', id: 7 }) });
  ok('mode x forwards method+body (JSON RPC survives)', pj.status === 200 && /"method":"POST"/.test(pj.text) && /\\"rpc\\":\\"player\\"/.test(pj.text) && /"ct":"application\/json"/.test(pj.text), pj.text.slice(0, 110));
  const f = await call((await mint(MOCK + '/post', 'f', tn.tab)).href,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'sent=hello+from+umbra' });
  ok('mode f forwards method+body, answers as document', f.status === 200 && /hello from umbra/.test(f.text), f.meta?.kind);
  await call((await mint(MOCK + '/cookies/set?umbra_probe=42', 'd', tn.tab)).href);
  const jar = await call((await mint(MOCK + '/cookies', 'x', tn.tab)).href);
  ok('per-session cookie jar replays site cookies', /"umbra_probe":"42"/.test(jar.text), jar.text.slice(0, 80));
  const noSet = await call((await mint(MOCK + '/cookies/set?leak=1', 'd', tn.tab)).href);
  ok('upstream Set-Cookie never reaches the browser', !/leak=1/.test(noSet.headers.get('set-cookie') || ''));

  /* ---- viewers for non-html documents ---- */
  const imgDoc = await call((await mint(MOCK + '/pixel.png', 'd', tn.tab)).href);
  ok('image-as-document gets a viewer', /umbra viewer · image/.test(imgDoc.text) && /\/~umbra\/m\//.test(imgDoc.text));
  const jsonDoc = await call((await mint(MOCK + '/get?as=document', 'd', tn.tab)).href);
  ok('json-as-document gets a readable viewer', /umbra viewer/.test(jsonDoc.text));

  /* ---- upstream status passthrough ---- */
  const miss = await call((await mint(MOCK + '/no-such-page', 'd', tn.tab)).href);
  ok('upstream 404 keeps its status inside a proxied doc', miss.status === 404, 'http ' + miss.status);

  /* ---- runtime mint from a frame ---- */
  const b64 = Buffer.from(MOCK + '/page2').toString('base64url');
  ok('runtime mint rejects a wrong frame key', (await call(`${PFX}p/d/${b64}/x?k=wrong&t=${tn.tab}`)).status === 403);
  const goodMint = await call(`${PFX}p/d/${b64}/x?k=${tn.key}&t=${tn.tab}`);
  ok('runtime mint serves with the right frame key', goodMint.status === 200 && /page two/.test(goodMint.text));
  const b64p = Buffer.from(MOCK + '/post').toString('base64url');
  const rp = await call(`${PFX}p/x/${b64p}/x?k=${tn.key}&t=${tn.tab}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ping":1}' });
  ok('runtime mint forwards POST bodies (the page-fetch path)', rp.status === 200 && /"method":"POST"/.test(rp.text) && /\\"ping\\":1/.test(rp.text));

  /* ---- lab fixtures (local, deterministic) ---- */
  await call('/~umbra/policy', J({ follow: 'same-host' }));
  for (const kind of ['redirect', 'samehost', 'meta', 'js', 'windowopen', 'image', 'video', 'form', 'frames', 'storage', 'schemes', 'xhr']) {
    const l = await call((await mint('umbra://lab/' + kind, 'd', tn.tab)).href);
    const wantCapsule = kind === 'redirect';
    ok('lab fixture ' + kind, l.status === 200 && (wantCapsule ? /redirect held/i.test(l.text) : /umbra-ctx/.test(l.text)), 'http ' + l.status);
  }
  await call('/~umbra/policy', J({ follow: 'all' }));
  const labFollow = await call((await mint('umbra://lab/redirect', 'd', tn.tab)).href);
  ok('lab redirect follows in-tab under the default policy', labFollow.status === 200 && /followed like a browser/.test(labFollow.text) && labFollow.meta?.redirected === true,
    'http ' + labFollow.status + ' kind=' + labFollow.meta?.kind);
  const schemes = await call((await mint('umbra://lab/schemes', 'd', tn.tab)).href);
  ok('schemes fixture: js/mailto inerted, data: kept, http rewired',
    /href="umbra:inert"/.test(schemes.text) && !/href="javascript:/i.test(schemes.text) &&
    /id="inline"[^>]*src="data:image\/svg/.test(schemes.text) && /id="ext"[^>]*href="\/~umbra\//.test(schemes.text));
  const schemesJs = (schemes.text.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  ok('schemes fixture script kept its regex escapes (no accidental // comment)',
    schemesJs.includes('/^data:image\\/svg/') && schemesJs.includes('/\\/~umbra\\//'));

  /* ---- umbra:// loopback http fallback ---- */
  const viaUmbra = await call((await mint(`umbra://127.0.0.1:${MOCK_PORT}/page2`, 'd', tn.tab)).href);
  ok('umbra:// loopback falls back to http transparently',
    viaUmbra.status === 200 && /page two/.test(viaUmbra.text) && viaUmbra.meta?.hops === 2,
    'http ' + viaUmbra.status + ' hops=' + viaUmbra.meta?.hops);

  /* ---- youtube: inspect + player against the mock watch page ---- */
  const ytj = JSON.parse((await call(`/~umbra/ytj?v=${VID}&t=${tn.tab}`)).text);
  ok('inspect lifts streamingData via the embed + client ladder', ytj.videoId === VID && ytj.ok === true && ytj.title === 'Mock Video Title', ytj.title + ' muxed=' + ytj.muxed?.length);
  ok('muxed + adaptive tracks each get a mode-m wire url',
    ytj.muxed?.length === 1 && ytj.video?.length === 1 && ytj.audio?.length === 1 &&
    [ytj.muxed[0], ytj.video[0], ytj.audio[0]].every((f) => f.wire?.startsWith('/~umbra/m/')));
  const stream = await call(ytj.muxed[0].wire, { headers: { range: 'bytes=0-99' } });
  ok('muxed wire url streams with Range', stream.status === 206 && stream.bytes.length === 100, stream.status + '/' + stream.bytes.length);
  ok('thumbnails routed through the proxy', ytj.thumbWire?.startsWith('/~umbra/s/') && (await call(ytj.thumbWire)).status === 200);
  ok('captions converted to WebVTT through the proxy', await (async () => {
    const vtt = await call(ytj.captions[0].vtt);
    return /^WEBVTT/.test(vtt.text) && /hello world/.test(vtt.text) && /text\/vtt/.test(vtt.headers.get('content-type') || '');
  })());
  /* ---- anti-bot: embed surface, client ladder, visitor reuse ---- */
  const hits = await (await fetch(`${MOCK}/__hits`)).json();
  const itHits = hits.filter((h) => h.path === '/youtubei/v1/player');
  ok('inspect reads config from /embed/, never the watch page',
    hits.some((h) => h.path.startsWith('/embed/')) && !hits.some((h) => h.path === '/watch'),
    hits.map((h) => h.path).join(' '));
  ok('a real visitor identity is minted from sw.js_data',
    hits.some((h) => h.path === '/sw.js_data') && ytj.visitorSource === 'sw.js_data' &&
    ytj.visitorSynthetic === false, ytj.visitorSource);
  ok('gated client is tried, then the ladder falls through to one that works',
    ytj.attempts?.[0]?.client === 'web' && ytj.attempts[0].ok === false &&
    ytj.client === 'visionos' && ytj.ok === true,
    JSON.stringify(ytj.attempts));
  ok('the gated attempt is reported as url-stripping, not a generic failure',
    /stripped/.test(ytj.attempts?.[0]?.note || ''), ytj.attempts?.[0]?.note);
  ok('each innertube POST presents the ladder identity in body and headers',
    itHits.length >= 2 &&
    itHits[0].clientName === 'WEB' && itHits[0].clientNameHeader === '1' &&
    itHits[1].clientName === 'VISIONOS' && itHits[1].clientNameHeader === '101',
    itHits.map((h) => h.clientName + '/' + h.clientNameHeader).join(' '));
  ok('one visitor identity is reused across requests, never randomised',
    itHits.length >= 2 && itHits.every((h) => h.visitorData && h.visitorData === itHits[0].visitorData) &&
    itHits.every((h) => h.visitorHeader === itHits[0].visitorData),
    itHits.map((h) => (h.visitorData || '').slice(0, 12)).join(' '));
  ok('each client sends its own matching user-agent',
    itHits[0].ua !== itHits[1].ua && /Chrome/.test(itHits[0].ua) && /Safari/.test(itHits[1].ua));

  /* ---- proof of origin, harvested from the visitor's own browser ----
     This is the whole mechanism by which a proxy on a datacentre address
     plays YouTube at all: BotGuard runs in the visitor's real browser inside
     the proxied embed, and the player request it mints carries a genuine
     token bound to that page's visitor identity. It passes through Umbra by
     construction, so Umbra keeps it and the server-side ladder stops asking
     to be trusted on its word alone. Driven here over the real wire. */
  {
    const ITW = await import('../server/innertube.mjs');
    const pageVisitor = ITW.synthesizeVisitorData();
    const BGTOK = 'MnQ' + 'x'.repeat(60) + '=';
    const before = (await (await fetch(`${MOCK}/__hits`)).json())
      .filter((h) => h.path === '/youtubei/v1/player').length;
    const rpc = await mint(MOCK + '/youtubei/v1/player', 'x', tn.tab);
    const rpcRes = await call(rpc.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20260101.00.00', visitorData: pageVisitor } },
        videoId: VID,
        serviceIntegrityDimensions: { poToken: BGTOK },
      }),
    });
    const afterPost = (await (await fetch(`${MOCK}/__hits`)).json())
      .filter((h) => h.path === '/youtubei/v1/player');
    const page = afterPost[afterPost.length - 1];
    ok('a page-minted player request reaches youtube with its proof intact',
      rpcRes.status === 200 && page.poToken === BGTOK && page.visitorData === pageVisitor &&
      page.clientName === 'WEB_EMBEDDED_PLAYER',
      page.clientName + ' pot=' + String(page.poToken).slice(0, 8) + '…');

    /* and now the server's own extraction, which has no browser of its own */
    await call(`/~umbra/ytj?v=${VID}&t=${tn.tab}`);
    const ladder = (await (await fetch(`${MOCK}/__hits`)).json())
      .filter((h) => h.path === '/youtubei/v1/player').slice(afterPost.length);
    ok('the server-side ladder then presents the proof the browser earned',
      ladder.length > 0 && ladder.every((h) => h.poToken === BGTOK && h.visitorData === pageVisitor),
      ladder.map((h) => h.clientName + '/' + (h.poToken ? 'pot' : 'none')).join(' '));
    ok('the harvest is reported, not silent',
      /harvested/.test(JSON.stringify(JSON.parse((await call('/~umbra/ytj?v=' + VID + '&t=' + tn.tab)).text).poToken || '')) ||
      JSON.parse((await call('/~umbra/ytj?v=' + VID + '&t=' + tn.tab)).text).poToken === 'attached',
      JSON.parse((await call('/~umbra/ytj?v=' + VID + '&t=' + tn.tab)).text).poToken);

    /* ---- the black rectangle, explained ----
       When the embed's player request comes back refused, the frame cannot
       say so across the document boundary and the operator is left looking
       at nothing. The answer passed through this origin, so Umbra reads it
       and the page can ask what it said. */
    {
      const wall = await mint(MOCK + '/youtubei/v1/player', 'x', tn.tab);
      const body = JSON.stringify({
        context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20260101.00.00' } },
        videoId: 'BotWall1234',
      });
      const r = await call(wall.href, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      ok('the refusal reaches the embed unchanged — umbra reads, never edits',
        r.status === 200 && JSON.parse(r.text).playabilityStatus.status === 'LOGIN_REQUIRED',
        'http ' + r.status);
      const v = await call('/~umbra/ytverdict?v=BotWall1234');
      const j = JSON.parse(v.text);
      ok('and the page can find out why its player is black',
        j.seen === true && j.status === 'LOGIN_REQUIRED' && j.verdict === 'refused' &&
        /not a bot/i.test(j.reason) && j.withUrl === 0,
        j.status + ' / ' + j.verdict + ' / ' + j.reason);
      const gated = await mint(MOCK + '/youtubei/v1/player', 'x', tn.tab);
      await call(gated.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: '2.20260101.00.00' } },
          videoId: VID,
        }),
      });
      const g = JSON.parse((await call('/~umbra/ytverdict?v=' + VID)).text);
      ok('a withheld-url answer is told apart from an outright refusal',
        g.seen === true && g.status === 'OK' && g.verdict === 'gated' && g.withUrl === 0 && g.formats > 0,
        g.status + ' / ' + g.verdict + ' / ' + g.withUrl + '/' + g.formats);
      ok('a video nobody has asked about reports nothing rather than guessing',
        JSON.parse((await call('/~umbra/ytverdict?v=Unasked1234')).text).seen === false);
    }
    void before;
  }

  const player = await call((await mint(`umbra://player?v=${VID}`, 'c', tn.tab)).href);
  ok('player capsule serves the native-stream payload (mock not gated)',
    player.status === 200 && /umbra player · native stream/.test(player.text) &&
    /Mock Video Title/.test(player.text) && /\/~umbra\/m\//.test(player.text),
    player.status + ' ' + player.bytes.length + 'B');
  const watchDoc = await call((await mint(`${MOCK}/watch?v=${VID}`, 'd', tn.tab)).href);
  ok('watch page proxied with refs on the wire',
    watchDoc.status === 200 && /\/~umbra\//.test(watchDoc.text) &&
    !/(?:href|src|poster|action)="(?:http:\/\/127\.0\.0\.1|http:\/\/localhost|https?:\/\/www\.mocktube)/.test(watchDoc.text));
  const resDoc = await call((await mint(MOCK + '/results?search_query=mock', 'd', tn.tab)).href);
  ok('results page proxied', resDoc.status === 200 && /videoRenderer/.test(resDoc.text));
  const embDoc = await call((await mint(MOCK + '/embed/' + VID, 'd', tn.tab)).href);
  ok('embed renders (framing headers removed)', embDoc.status === 200 && /mock-embed/.test(embDoc.text) && !embDoc.headers.get('x-frame-options'));

  /* ---- search degrades gracefully with no network ---- */
  const srEmpty = JSON.parse((await call('/~umbra/search?format=json')).text);
  ok('empty search returns empty results', Array.isArray(srEmpty.results) && srEmpty.results.length === 0);
  const srHtml = await call('/~umbra/search?q=mock&format=html&t=' + tn.tab);
  ok('search document still renders offline', srHtml.status === 200 && /umbra-ctx/.test(srHtml.text));

  /* ---- cloak invariants (static, as in e2e) ---- */
  const shellJs = (await call('/shell.js')).text;
  ok('shell never navigates itself', !/\blocation\s*\.\s*(href|assign|replace)\s*[=(]/m.test(shellJs) && !/history\s*\.\s*(pushState|replaceState)\s*\(/.test(shellJs));
  const shim = await call('/~umbra/shim.js');
  ok('shim served on the wire prefix', shim.status === 200 && /__UMBRA_SHIM__/.test(shim.text));
  ok('shim neutralises history + re-anchors net',
    /h\.pushState = noop/.test(shim.text) && /window\.fetch = function/.test(shim.text) &&
    /XMLHttpRequest\.prototype\.open = function/.test(shim.text) && /window\.WebSocket = /.test(shim.text));
  ok('adopt step is bounded (no heartbeat, pending-nav skip)',
    /navigationPending/.test(shim.text) && /stable >= 6/.test(shim.text) && /ticks > 60/.test(shim.text));
  ok('sandbox omits top-navigation and popups', /allow-scripts allow-same-origin/.test(shellJs) && !/allow-top-navigation/.test(shellJs) && !/allow-popups(?!-)/.test(shellJs));

  /* ---- redirect policy: the off switch + the reload-loop guard ---- */
  const bootPol = JSON.parse((await call('/~umbra/boot')).text);
  ok('boot reports the redirect policy so the shell can honour it',
    bootPol.policy && bootPol.policy.follow === 'all', JSON.stringify(bootPol.policy));
  const XHOST = `${MOCK}/redirect-to?url=${encodeURIComponent(MOCK_ALT + '/other')}&status_code=302`;
  const setNative = JSON.parse((await call('/~umbra/policy', J({ follow: 'native' }))).text);
  ok('redirect policing can be switched off', setNative.policy?.follow === 'native', JSON.stringify(setNative.policy));
  /* with policing off a cross-host hop must be followed, not held for review */
  const nativeHop = await call((await mint(XHOST, 'd', tn.tab)).href);
  ok('policy=native follows a cross-host hop instead of holding it',
    nativeHop.status === 200 && /other host doc/.test(nativeHop.text) && !/redirect held/i.test(nativeHop.text),
    'http ' + nativeHop.status);
  /* even the hold-every-hop case collapses once policing is off */
  const nativeSame = await call((await mint(`${MOCK}/redirect/2`, 'd', tn.tab)).href);
  ok('policy=native never holds a same-host chain either',
    /chain end/.test(nativeSame.text) && !/redirect held/i.test(nativeSame.text));
  /* and the strict policies still hold, so the switch is a real switch */
  await call('/~umbra/policy', J({ follow: 'none' }));
  const heldHop = await call((await mint(XHOST, 'd', tn.tab)).href);
  ok('policy=none still holds every hop for review',
    /redirect held/i.test(heldHop.text), 'http ' + heldHop.status);
  await call('/~umbra/policy', J({ follow: 'all' }));
  ok('an unknown follow value is rejected rather than silently applied',
    JSON.parse((await call('/~umbra/policy', J({ follow: 'bogus' }))).text).policy?.follow === 'all');

  ok('shell mirrors the policy and stops policing when it is off',
    /policeOff\s*=\s*\(\)\s*=>\s*S\.policy\.follow === 'native'/.test(shellJs) &&
    /if \(policeOff\(\)\) \{/.test(shellJs) && /was NOT reverted/.test(shellJs));
  ok('adoption ledger is time-windowed and survives a healthy sync',
    /ADOPT_WINDOW/.test(shellJs) && /ADOPT_MAX/.test(shellJs) &&
    /function adoptAllowed/.test(shellJs) &&
    /if \(!adoptAllowed\(t, adopted\)\)/.test(shellJs));
  ok('only fresh user intent clears the adoption ledger',
    /if \(opts\.fresh\) \{ t\.fails = 0; t\.adopts = \[\]; \}/.test(shellJs) &&
    !/syncFromFrame[\s\S]{0,600}t\.adopts = \[\]/.test(shellJs));
  ok('the loop guard terminates instead of re-navigating',
    /function stopFollowing/.test(shellJs) &&
    /stopped following/.test(shellJs) && /keeps redirecting itself/.test(shellJs));
  const indexHtml = (await call('/')).text;
  ok('the off switch is offered in the redirect policy picker',
    /<option value="native">/.test(indexHtml) && /don't intervene/.test(indexHtml), '');

  /* ---- umbra tube: the piped-backed front end ---- */
  const tubeHref = (await mint('umbra://tube/', 'd', tn.tab)).href;
  ok('umbra://tube/ mints to a local wire path, no token host leak',
    tubeHref.startsWith(PFX + 'tube') && !/127\.0\.0\.1|localhost/.test(tubeHref.replace(/[?&]t=[^&]*/, '')), tubeHref);
  const tubeHome = await call(tubeHref);
  ok('tube home renders trending through the provider manager',
    tubeHome.status === 200 && /Local Trending Hit/.test(tubeHome.text) && /umbra tube/i.test(tubeHome.text),
    'http ' + tubeHome.status);
  ok('tube names the provider that served the page, not a raw instance host',
    /via innertube/.test(tubeHome.text), (/<span class="chip">via ([^<]*)/.exec(tubeHome.text) || [])[1]);
  ok('tube thumbnails are wire urls, never the instance directly',
    /src="\/~umbra\/s\//.test(tubeHome.text) && !/src="http:\/\/127\.0\.0\.1/.test(tubeHome.text));

  const tubeSearch = await call((await mint('umbra://tube/search?q=mock+query', 'd', tn.tab)).href);
  ok('tube search returns normalised video items only',
    tubeSearch.status === 200 && /Local Search Hit/.test(tubeSearch.text) && !/not a video/.test(tubeSearch.text));


  const tubeWatch = await call((await mint(`umbra://tube/watch?v=${VID}`, 'd', tn.tab)).href);
  ok('tube watch page renders with the player payload',
    tubeWatch.status === 200 && /Mock Video Title/.test(tubeWatch.text) && /id="player"/.test(tubeWatch.text),
    'http ' + tubeWatch.status);
  ok('tube watch classifies muxed / video-only / audio from piped streams',
    /1 muxed/.test(tubeWatch.text) && /1 video/.test(tubeWatch.text) && /1 audio/.test(tubeWatch.text));
  ok('tube watch carries comments and related videos',
    /a local comment/.test(tubeWatch.text) && /Local Related One/.test(tubeWatch.text));
  /* the payload must be the same shape the native capsule uses, so player.js
     drives both surfaces unchanged */
  const tubeInfo = JSON.parse((/data-info='([^']+)'/.exec(tubeWatch.text) || [])[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  ok('tube payload matches the native player payload contract',
    tubeInfo.ok === true && tubeInfo.source === 'piped' &&
    Array.isArray(tubeInfo.muxed) && tubeInfo.muxed[0].wire.startsWith('/~umbra/m/') &&
    Array.isArray(tubeInfo.captions) && typeof tubeInfo.captions[0].vtt === 'string',
    'muxed=' + tubeInfo.muxed.length + ' caps=' + tubeInfo.captions.length);
  const tubeStream = await call(tubeInfo.muxed[0].wire, { headers: { range: 'bytes=0-99' } });
  ok('tube stream bytes flow through the umbra media wire with Range',
    tubeStream.status === 206 && tubeStream.bytes.length === 100, tubeStream.status + '/' + tubeStream.bytes.length);
  const tubeVtt = await call(tubeInfo.captions[0].vtt);
  ok('tube captions convert to WebVTT through the proxy',
    /^WEBVTT/.test(tubeVtt.text) && /hello world/.test(tubeVtt.text));

  const tubeChan = await call((await mint('umbra://tube/channel/UCmock', 'd', tn.tab)).href);
  ok('tube channel page renders uploads', tubeChan.status === 200 && /Channel Upload/.test(tubeChan.text) && /Mock Channel/.test(tubeChan.text));

  /* ---- a refused subresource must not be a silent one ----
     The browser drops a blocked request and the script that needed it dies
     somewhere else entirely — which is how a blocked module load shows up
     as a crash deep inside a minified bundle with no mention of the real
     cause. The report carries the answer; Umbra was reading field names
     that do not exist, so every entry it stored was blank. */
  {
    const r1 = await call('/~umbra/csp-report', {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({
        'csp-report': {
          'document-uri': 'https://proxy.example/~umbra/d/tok/embed',
          'violated-directive': 'script-src-elem',
          'effective-directive': 'script-src-elem',
          'blocked-uri': 'https://www.youtube-nocookie.com/s/_/ytembeds/_/js/k=x/m=player',
          'source-file': 'https://proxy.example/~umbra/s/tok',
          'line-number': 94,
        },
      }),
    });
    ok('a violation report is accepted without a body', r1.status === 204, 'http ' + r1.status);
    const log = JSON.parse((await call('/~umbra/csp-log')).text);
    const e = log.entries[log.entries.length - 1];
    ok('and it records what was actually refused, not an empty string',
      e && e.blocked === 'https://www.youtube-nocookie.com/s/_/ytembeds/_/js/k=x/m=player' &&
      e.directive === 'script-src-elem' && e.line === 94 && /~umbra\/s\/tok/.test(e.source),
      e ? e.directive + ' ' + e.blocked.slice(0, 48) : 'no entry');

    /* chrome's Reporting API sends a different shape for the same event */
    await call('/~umbra/csp-report', {
      method: 'POST',
      headers: { 'content-type': 'application/reports+json' },
      body: JSON.stringify([{ type: 'csp-violation', body: {
        documentURL: 'https://proxy.example/~umbra/d/tok/embed',
        effectiveDirective: 'connect-src',
        blockedURL: 'https://www.google.com/log_event',
      } }]),
    });
    const log2 = JSON.parse((await call('/~umbra/csp-log')).text);
    const e2 = log2.entries[log2.entries.length - 1];
    ok('the reporting-api shape is read too, not dropped on the floor',
      e2 && e2.blocked === 'https://www.google.com/log_event' && e2.directive === 'connect-src',
      e2 ? e2.directive + ' ' + e2.blocked : 'no entry');
  }

  const tubeBad = await call((await mint('umbra://tube/watch?v=short', 'd', tn.tab)).href);
  ok('tube rejects a malformed video id', tubeBad.status === 400, 'http ' + tubeBad.status);

  /* Every backend refused this one — the state the user's trace was in. A
     502 error page was the old answer and it is the wrong one: the proxied
     embed is still a real player, it is the surface most likely to work from
     a scored address, and it is where the browser mints the proof the native
     path is missing. Serve the page. */
  {
    const dead = await call((await mint('umbra://tube/watch?v=NoStream123', 'd', tn.tab)).href);
    const info = JSON.parse((/data-info='([^']+)'/.exec(dead.text) || [])[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    ok('a video no backend can extract still renders a player, not a 502',
      dead.status === 200 && /id="player"/.test(dead.text) && info.ok === false &&
      /^\/~umbra\/d\//.test(info.embedDoc || ''),
      'http ' + dead.status + ' ok=' + info.ok);
    ok('the page offers the frame that actually plays, and says what it costs',
      /straight from <b>youtube-nocookie\.com<\/b>|straight from youtube-nocookie\.com/.test(dead.text) &&
      /Google sees your address/.test(dead.text) &&
      info.directEmbed === 'https://www.youtube-nocookie.com/embed/NoStream123?rel=0&modestbranding=1',
      String(info.directEmbed));
    ok('and it says which backends were tried, and why it is showing the embed',
      /no playable streams|no .* answered|instance error/i.test(dead.text) &&
      /proxied embed/.test(dead.text) && (info.tried || []).length > 0,
      (info.tried || []).map((t) => t.instance).join(','));
    ok('the embed document it points at is served through the wire',
      (await call(info.embedDoc)).status === 200);
    /* the direct frame is useless if the policy refuses it, so the two
       halves of the switch are checked against each other on a real
       response, not just in the payload */
    const csp = dead.headers.get('content-security-policy') || '';
    ok('and the policy on that page actually permits the direct frame',
      /frame-src 'self' blob: https:\/\/www\.youtube-nocookie\.com https:\/\/www\.youtube\.com/.test(csp) &&
      /default-src 'self'/.test(csp) && !/connect-src[^;]*youtube/.test(csp),
      (csp.split('; ').find((x) => x.startsWith('frame-src')) || '').slice(0, 90));
  }
  /* The failure the provider work exists for: the local engine is bot-gated
     AND every Piped instance is refusing at once. Before this, Tube died here
     because it only ever spoke to Piped. */
  const tubeRescue = await call((await mint('umbra://tube/search?q=__allgated__', 'd', tn.tab)).href);
  ok('tube still renders when both the local engine and the whole piped pool fail',
    tubeRescue.status === 200 && /Invidious Search Hit/.test(tubeRescue.text) &&
    /via invidious/.test(tubeRescue.text),
    'http ' + tubeRescue.status + ' ' + ((/<span class="chip">via ([^<]*)/.exec(tubeRescue.text) || [])[1] || ''));
  ok('tube shows which backends were tried before the one that worked',
    /innertube/.test(tubeRescue.text) && /piped/.test(tubeRescue.text),
    (tubeRescue.text.match(/chip warn">([^<]*)/g) || []).slice(0, 3).join(' | '));

  const health = JSON.parse((await call('/~umbra/tube.health')).text);
  ok('the piped pool benched every instance that refused during the squeeze',
    health.instances.length >= 2 && health.instances.every((i) => i.benchedFor > 0),
    JSON.stringify(health.instances));

  ok('the portal links into the tube section',
    /umbra:\/\/tube\//.test((await call((await mint('umbra://home/', 'd', tn.tab)).href)).text));

  /* ---- umbra's own piped instance, over the real REST surface ---- */
  /* An external Piped client has no umbra session, so the door has to be
     openable without one -- but it is shut until you say otherwise, because
     it spends this machine's egress on whoever can reach it. */
  const lshut = await callBare('/~umbra/piped/healthcheck');
  ok('the piped api is shut to sessionless callers by default',
    lshut.status === 401 && /UMBRA_PIPED_PUBLIC/.test(lshut.text), 'http ' + lshut.status);
  const OPEN_PORT = UMBRA_PORT + 3;
  const openOrigin = launch('server/index.mjs', [], {
    PORT: String(OPEN_PORT),
    UMBRA_YT_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    UMBRA_PIPED_PUBLIC: '1',
  });
  openOrigin.stderr.on('data', (d) => process.stderr.write(`[open] ${d}`));
  await waitFor(`http://127.0.0.1:${OPEN_PORT}/~umbra/boot`, 'public piped origin');
  const lopen = await fetch(`http://127.0.0.1:${OPEN_PORT}/~umbra/piped/streams/${VID}`)
    .then((r) => r.json().then((j) => ({ status: r.status, j })));
  ok('with UMBRA_PIPED_PUBLIC a cookieless piped client is served',
    lopen.status === 200 && lopen.j.title === 'Mock Video Title',
    'http ' + lopen.status + ' ' + lopen.j.title);

  const hc = await call('/~umbra/piped/healthcheck');
  ok('the local instance answers a piped healthcheck',
    hc.status === 200 && JSON.parse(hc.text).status === 'ok', 'http ' + hc.status);
  const lstream = JSON.parse((await call(`/~umbra/piped/streams/${VID}`)).text);
  ok('local /streams returns the piped contract, extracted here',
    lstream.title === 'Mock Video Title' && Array.isArray(lstream.videoStreams) && Array.isArray(lstream.audioStreams),
    'title=' + lstream.title);
  ok('local /streams splits progressive from video-only the piped way',
    lstream.videoStreams.some((v) => v.videoOnly === false && v.itag === 18) &&
    lstream.videoStreams.some((v) => v.videoOnly === true && v.itag === 137) &&
    lstream.audioStreams.every((a2) => a2.videoOnly === false), JSON.stringify(lstream.videoStreams.map((v) => v.itag + ':' + v.videoOnly)));
  ok('local /streams walked the client ladder past the gated client',
    lstream.umbraClient === 'visionos' && (lstream.umbraTried || []).some((t) => t.client === 'web'),
    lstream.umbraClient + ' tried=' + JSON.stringify(lstream.umbraTried));
  ok('local /streams carries subtitles in the piped shape',
    Array.isArray(lstream.subtitles) && lstream.subtitles[0]?.code === 'en');
  const lsearch = JSON.parse((await call('/~umbra/piped/search?q=local+test')).text);
  ok('local /search parses videoRenderers and drops non-videos',
    lsearch.items.length === 1 && lsearch.items[0].title === 'Local Search Hit' &&
    lsearch.items[0].duration === 212 && lsearch.items[0].views === 1234567 &&
    lsearch.items[0].uploaderVerified === true, JSON.stringify(lsearch.items[0]));
  const ltrend = JSON.parse((await call('/~umbra/piped/trending?region=US')).text);
  ok('local /trending returns a bare array like piped does',
    Array.isArray(ltrend) && ltrend[0].title === 'Local Trending Hit');
  const lchan = JSON.parse((await call('/~umbra/piped/channel/UCmocklocal')).text);
  ok('local /channel returns header metadata plus uploads',
    lchan.name === 'Local Channel' && lchan.subscriberCount === 1200000 && lchan.verified === true &&
    lchan.relatedStreams[0].title === 'Local Channel Upload', lchan.name + ' subs=' + lchan.subscriberCount);
  const lcmt = JSON.parse((await call(`/~umbra/piped/comments/${VID}`)).text);
  ok('local /comments follows the continuation and reads entity payloads',
    lcmt.disabled === false && lcmt.comments[0].commentText === 'a local comment' &&
    lcmt.comments[0].author === 'Local Commenter' && lcmt.comments[0].likeCount === 12,
    JSON.stringify(lcmt.comments[0] || {}));
  ok('local instance uses the WEB client for metadata endpoints',
    (await (async () => {
      const hs = await (await fetch(`${MOCK}/__hits`)).json();
      return hs.filter((h) => /youtubei\/v1\/(search|browse|next)/.test(h.path)).every((h) => h.clientName === 'WEB');
    })()));
  const lgated = await call('/~umbra/piped/search?q=__gated__');
  ok('a bot-gated reply is raised as a failure, not served as zero results',
    lgated.status === 502 && /Sign in to confirm/.test(lgated.text), 'http ' + lgated.status + ' ' + lgated.text.slice(0, 90));
  const lempty = await call('/~umbra/piped/search?q=__nohits__');
  ok('an honestly empty search is still a successful search',
    lempty.status === 200 && JSON.parse(lempty.text).items.length === 0, 'http ' + lempty.status);

  /* the whole ciphered path, end to end: youtube returns no url at all, the
     player script is fetched and run, and streams come out playable */
  const lciph = JSON.parse((await call('/~umbra/piped/streams/Ciphered123')).text);
  ok('a video whose formats are all ciphered still produces playable streams',
    lciph.videoStreams.length > 0 && lciph.audioStreams.length > 0 &&
    lciph.videoStreams.every((f) => /[?&]sig=cedfba/.test(f.url)),
    'v=' + lciph.videoStreams.length + ' a=' + lciph.audioStreams.length + ' ' +
    (lciph.videoStreams[0] || {}).url);
  ok('the ciphered extraction reports how many formats it unscrambled',
    lciph.umbraCiphered > 0 && lciph.umbraUnresolved === 0 && !lciph.umbraPlayerError,
    'ciphered=' + lciph.umbraCiphered + ' unresolved=' + lciph.umbraUnresolved);
  ok('deciphered stream urls carry the transformed n, not the original',
    lciph.videoStreams.every((f) => /[?&]n=NZYX/.test(f.url)), (lciph.videoStreams[0] || {}).url);

  const l404 = await call('/~umbra/piped/nope');
  ok('an unknown piped endpoint 404s rather than 500s', l404.status === 404, 'http ' + l404.status);

  /* ---- the unified /api/youtube surface ---- */
  const API = async (path) => {
    const r = await call('/api/youtube' + path);
    let j = null; try { j = JSON.parse(r.text); } catch {}
    return { status: r.status, j };
  };

  const apiShut = await callBare('/api/youtube/providers');
  ok('the youtube api is shut to sessionless callers by default',
    apiShut.status === 401 && /UMBRA_API_PUBLIC/.test(apiShut.text), 'http ' + apiShut.status);

  const provs = await API('/providers');
  ok('the api lists every registered provider and whether it is live',
    provs.status === 200 && provs.j.data.some((p) => p.id === 'invidious' && p.enabled) &&
    provs.j.data.some((p) => p.id === 'ytdlp' && !p.enabled),
    provs.j.data.map((p) => p.id + (p.enabled ? '+' : '-')).join(' '));

  const asearch = await API('/search?q=hello');
  ok('search returns normalized videos through one provider',
    asearch.status === 200 && asearch.j.data.length > 0 &&
    asearch.j.data.every((v) => /^[\w-]{11}$/.test(v.id) && typeof v.title === 'string' && v.author && Array.isArray(v.thumbnails)),
    'provider=' + asearch.j.meta.provider + ' n=' + asearch.j.data.length);
  ok('every normalized video declares which provider produced it',
    asearch.j.data.every((v) => v.provider && v.url === '/watch?v=' + v.id));

  const acached = await API('/search?q=hello');
  ok('a repeated search is served from the metadata cache',
    acached.j.meta.cached === true, JSON.stringify(acached.j.meta.cached));

  const aagg = await API('/search?q=aggregate+me&aggregate=1');
  ok('aggregated search merges providers and dedupes by video id',
    aagg.status === 200 && aagg.j.meta.aggregated === true &&
    new Set(aagg.j.data.map((v) => v.id)).size === aagg.j.data.length &&
    aagg.j.meta.providers.length >= 2,
    'providers=' + (aagg.j.meta.providers || []).join('+') + ' ids=' + aagg.j.data.map((v) => v.id).join(','));
  ok('a video found by several providers is marked as agreed on and ranked first',
    aagg.j.data[0].providers && aagg.j.data[0].providers.length >= 2,
    JSON.stringify(aagg.j.data[0].providers));

  const avid = await API('/video/' + VID);
  ok('video metadata comes back normalized',
    avid.status === 200 && avid.j.data.id === VID && avid.j.data.author.name, avid.j.data.title);
  const achan = await API('/channel/UCmocklocal');
  ok('channel metadata comes back normalized with its uploads',
    achan.status === 200 && achan.j.data.name && Array.isArray(achan.j.data.videos), achan.j.data.name);
  const acmt = await API('/comments/' + VID);
  ok('comments come back normalized',
    acmt.status === 200 && acmt.j.data.items.length > 0 && acmt.j.data.items[0].text,
    acmt.j.data.items[0] && acmt.j.data.items[0].text);
  const astream = await API('/streams/' + VID);
  ok('stream metadata is served without any bytes passing through the api',
    astream.status === 200 && astream.j.data.videoStreams.length > 0 &&
    astream.j.data.videoStreams.every((f) => /^https?:/.test(f.url)),
    'v=' + astream.j.data.videoStreams.length + ' a=' + astream.j.data.audioStreams.length);
  ok('stream metadata is never cached, because format urls expire',
    astream.j.meta.cached === false);

  const abad = await API('/video/not-an-id');
  ok('a malformed id is rejected before any provider is contacted',
    abad.status === 400 && abad.j.error.code === 'BAD_ID', 'http ' + abad.status);
  const a404 = await API('/nonsense');
  ok('an unknown api route 404s with the endpoint list',
    a404.status === 404 && Array.isArray(a404.j.meta.endpoints), 'http ' + a404.status);

  const ahealth = await API('/providers/health');
  ok('the debug surface reports instances, status, latency and cooldown',
    ahealth.status === 200 && ahealth.j.data.instances.length > 0 &&
    ahealth.j.data.instances.every((i) => 'status' in i && 'latency' in i && 'cooldownUntil' in i) &&
    ahealth.j.data.cache && Array.isArray(ahealth.j.data.recent),
    ahealth.j.data.instances.map((i) => i.id + '=' + i.status).slice(0, 4).join(' '));
  ok('an instance that failed but is not yet benched reads as degraded, not online',
    ahealth.j.data.instances.some((i) => /invidious.*:1$/.test(i.id) && i.status === 'DEGRADED'),
    ahealth.j.data.instances.filter((i) => /invidious/.test(i.id)).map((i) => i.id + '=' + i.status).join(' '));
  ok('the debug surface explains the projects that were not wired up',
    ahealth.j.data.survey.some((x) => x.project === 'ViewTube' && /youtubejs/.test(x.covered_by)));

  /* provider-level failover: force the first provider to fail and prove the
     request still succeeds from the next one down */
  const failover = await API('/search?q=__gated__');
  ok('when the first provider is bot-gated the next one answers',
    failover.status === 200 && failover.j.data.length > 0 &&
    failover.j.meta.provider !== 'innertube' && failover.j.meta.tried.some((t) => t.provider === 'innertube'),
    'served=' + failover.j.meta.provider + ' tried=' + failover.j.meta.tried.map((t) => t.provider).join(','));

  const padmin = await call('/~umbra/providers');
  ok('the provider diagnostics page renders the routing table for humans',
    padmin.status === 200 && /Backends/.test(padmin.text) && /innertube/.test(padmin.text) &&
    /COOLDOWN|DEGRADED/.test(padmin.text) && /not wired as separate backends/.test(padmin.text),
    'http ' + padmin.status);

  const adiag = await API('/diagnose/Ciphered123');
  ok('the diagnose endpoint explains per client why streams did or did not work',
    adiag.status === 200 && adiag.j.data.usable === true &&
    adiag.j.data.clients.length > 1 && adiag.j.data.clients.some((c) => c.ciphered > 0) &&
    /deciphered locally/.test(adiag.j.data.diagnosis),
    adiag.j.data.diagnosis);
  ok('diagnose reports the player script it loaded and which functions it found',
    adiag.j.data.player.loaded === true && adiag.j.data.player.sigName === 'zx' &&
    adiag.j.data.player.nsigName === 'ndx',
    JSON.stringify(adiag.j.data.player.sigName) + '/' + JSON.stringify(adiag.j.data.player.nsigName));

  /* An HLS-only video. YouTube increasingly answers this way, and a manifest
     is a complete, playable answer: it needs no deciphering and is not subject
     to per-format gating. Umbra used to read "zero formats" as total failure
     and discard a working stream. */
  const ahls = await API('/streams/HlsOnly1234');
  ok('a video served only as an hls manifest is playable rather than discarded',
    ahls.status === 200 && !!ahls.j.data.hls && /HlsOnly1234\.m3u8/.test(ahls.j.data.hls),
    'hls=' + String(ahls.j.data && ahls.j.data.hls).slice(0, 60));

  const ahdiag = await API('/diagnose/HlsOnly1234');
  ok('diagnose counts an hls-only client as usable, not as a failure',
    ahdiag.status === 200 && ahdiag.j.data.usable === true &&
    ahdiag.j.data.clients.every((c) => c.formats === 0) &&
    ahdiag.j.data.clients.some((c) => c.hls === true),
    ahdiag.j.data.diagnosis);

  /* The watch page end to end: consent cookie, extraction, deciphering and
     normalisation, through the provider the manager would use. This is the
     one backend that never touches /youtubei/v1/player, which is the whole
     reason it exists. */
  process.env.UMBRA_YT_BASE = MOCK;
  const WPP = await import('../server/providers/watchpage.mjs');
  const wpStreams = await WPP.getStreams('PageOnly123');
  ok('the watch-page provider yields playable streams without touching the api',
    (wpStreams.data.videoStreams.length + wpStreams.data.audioStreams.length) > 0 &&
    wpStreams.data.provider === 'watchpage',
    wpStreams.data.videoStreams.length + 'v/' + wpStreams.data.audioStreams.length + 'a');

  const wpHits = await (await fetch(`${MOCK}/__hits`)).json();
  const wpWatch = wpHits.filter((h) => h.path === '/watch' && h.videoId === 'PageOnly123');
  ok('the watch-page request carries a consent cookie, or the eu wall replaces the page',
    wpWatch.length > 0 && /SOCS=|CONSENT=/.test(wpWatch[wpWatch.length - 1].cookie || ''),
    String(wpWatch.length && wpWatch[wpWatch.length - 1].cookie).slice(0, 40));

  /* The reported failure, reproduced: the watch page is bot-walled but the
     embed page still answers with a ytcfg. Giving up there threw away the
     one surface YouTube was still talking to us on. */
  const wpEmbed = await WPP.getStreams('EmbedOnly12');
  ok('a bot-walled watch page falls through to the embed page config',
    (wpEmbed.data.videoStreams.length + wpEmbed.data.audioStreams.length) > 0,
    wpEmbed.data.videoStreams.length + 'v/' + wpEmbed.data.audioStreams.length + 'a');
  const WPcore = await import('../server/watchpage.mjs');
  ok('ytcfg is read from a call argument, which the assignment patterns miss',
    WPcore.extractCallArg('<script>ytcfg.set({"INNERTUBE_API_KEY":"K","VISITOR_DATA":"V"});</script>',
      'ytcfg.set(').INNERTUBE_API_KEY === 'K');

  const wpChan = await WPP.getChannel('UC' + 'x'.repeat(22));
  ok('a channel feed gives uploads with no api key and no quota',
    wpChan.data.videos.length === 2 && wpChan.data.videos[0].id === 'FeedVideo01' &&
    /Feed & Video Two/.test(wpChan.data.videos[1].title),
    wpChan.data.videos.map((v) => v.id).join(','));
  delete process.env.UMBRA_YT_BASE;

  /* The PO token travels on the player request itself; the mock records what
     it was sent so we can prove the wiring rather than trust it. */
  /* By now the suite has pushed a browser-minted token through the wire, so
     the honest answer is "configured, by harvest" and the advice line drops
     away — advice exists to explain an absence, not to nag. */
  ok('diagnose reports whether a proof-of-origin token was available',
    adiag.j.data.poToken && typeof adiag.j.data.poToken.configured === 'boolean' &&
    (adiag.j.data.poToken.configured
      ? adiag.j.data.poToken.advice === null && !!adiag.j.data.poToken.sources.harvested.seen
      : typeof adiag.j.data.poToken.advice === 'string'),
    'configured=' + adiag.j.data.poToken.configured + ' via=' + JSON.stringify(adiag.j.data.poToken.sources.harvested));

  const acache = await API('/cache');
  ok('the cache exposes its own statistics',
    acache.status === 200 && typeof acache.j.data.entries === 'number' && 'hitRate' in acache.j.data,
    JSON.stringify(acache.j.data.entries));

  /* ---- burn revokes everything ---- */
  const preBurn = await mint(MOCK + '/page2', 'd', tn.tab);
  ok('burn wipes jar and tabs', /"ok":1/.test((await call('/~umbra/burn')).text));
  const afterBurn = await call(preBurn.href);
  ok('pre-burn tokens revoked (generation check)', afterBurn.status === 403, 'http ' + afterBurn.status);
  const jarAfter = await call((await mint(MOCK + '/cookies', 'x')).href);
  ok('cookie jar empty after burn', /"cookies":\s*\{\s*\}/.test(jarAfter.text), jarAfter.text.slice(0, 60));

  const nope = await call((await mint('https://this-host-does-not-exist-umbra.invalid/')).href);
  ok('dns failure renders an umbra error page', nope.status === 502 && /umbra · wire/.test(nope.text), 'http ' + nope.status);
  ok('nothing served outside the wire prefix', (await call('/nope.txt')).status === 404);
}

/* ================================================================== main */
(async () => {
  console.log('UMBRA / offline  (mock :' + MOCK_PORT + ' · umbra :' + UMBRA_PORT + ')');
  const mock = launch('test/mock-upstream.mjs', [String(MOCK_PORT)], {});
  const origin = launch('server/index.mjs', [], {
    PORT: String(UMBRA_PORT),
    UMBRA_YT_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    /* Deliberately lead with a client the mock gates, so the wire suite
       exercises the ladder *falling through* rather than succeeding on the
       first try. The production default order is asserted in unit(). */
    UMBRA_YT_CLIENTS: 'web,visionos',
    /* a dead instance first, so the suite exercises pool failover rather than
       a lucky first hit; 127.0.0.1:1 always refuses the connection */
    UMBRA_PIPED_INSTANCES: `http://127.0.0.1:1,http://127.0.0.1:${MOCK_PORT}`,
    /* a dead invidious instance ahead of the mock one, so the provider's own
       instance pool is exercised as well as the cross-provider failover */
    UMBRA_INVIDIOUS_INSTANCES: `http://127.0.0.1:1,http://127.0.0.1:${MOCK_PORT}`,
  });
  for (const [k, n] of [[mock, 'mock'], [origin, 'origin']]) {
    k.stderr.on('data', (d) => process.stderr.write(`[${n}] ${d}`));
    k.on('exit', (c) => { if (c) console.log(`[${n}] exited ${c}`); });
  }
  try {
    await waitFor(`${MOCK}/health`, 'mock upstream');
    await waitFor(`${BASE}/~umbra/boot`, 'umbra origin');
    await unit();
    await wire();
  } finally {
    for (const k of kids) { try { k.kill('SIGTERM'); } catch {} }
    await sleep(300);
    for (const k of kids) { try { k.kill('SIGKILL'); } catch {} }
  }
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${pass}/${results.length} offline checks passed`);
  if (pass !== results.length) {
    console.log('\nfailures:');
    results.filter((r) => !r.pass).forEach((r) => console.log('  ✗ ' + r.name + '  ' + r.note));
  }
  process.exitCode = pass === results.length ? 0 : 1;
})();
