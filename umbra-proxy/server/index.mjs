/**
 * UMBRA ORIGIN
 * Serves the shell (one browser history entry, forever) plus every Umbra wire
 * resource: documents, subresources, media, xhr, form posts, raw passthrough,
 * capsules, minting, search and the YouTube player.
 *
 * node:http/https only -- no runtime dependencies.
 */
import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  PFX, MODES, encodeToken, decodeToken, newSession, newTab, COOKIE_NAME, readSession,
  toUmbra, href, resolveRef, encodeMeta, displayHost,
} from './protocol.mjs';
import { upstream, readBody, outboundHeaders, CookieJar, UA } from './net.mjs';
import { rewriteHtml, rewriteCssUrls, injectShim, decodeHtml } from './html.mjs';
import { inspect as ytInspect, isYouTube, parseVideoId } from './youtube.mjs';
import { portalDoc, labIndexDoc, helpDoc, statsDoc, DOC_CSS } from './docs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, '..', 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.UMBRA_HOST || '0.0.0.0';
const DOC_HOPS = 6;
const SUB_HOPS = 8;
const MAX_DOC = 26 * 1024 * 1024;
const PORTAL = 'umbra://home/';

/* ==================================================== state ============ */
const sessions = new Map();

function session(id) {
  if (!id) return null;
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      gen: crypto.randomBytes(6).toString('hex'),
      cookieJar: new CookieJar(),
      tabs: new Map(),
      /* browser-like by default: redirects are followed transparently and the
         tab lands on the final document. Stricter holds ('same-host', 'none')
         are opt-in per session and pause on a review capsule instead. */
      policy: { follow: 'all', referrer: 'origin', ephemeral: 1 },
      created: Date.now(),
      bytes: 0,
      reqs: 0,
      held: 0,
      escapes: 0,
      chain: [],
    };
    sessions.set(id, s);
  }
  return s;
}
function tabOf(s, tabId) {
  let t = s.tabs.get(tabId);
  if (t) return t;
  t = { id: tabId, key: crypto.randomBytes(10).toString('hex'), url: PORTAL, title: '', born: Date.now() };
  s.tabs.set(tabId, t);
  return t;
}
setInterval(() => {
  const cutoff = Date.now() - 8 * 60 * 60 * 1000;
  for (const [k, v] of sessions) if (v.created < cutoff) sessions.delete(k);
}, 120000).unref();

/* =================================================== tiny utilities ===== */
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ji = (x) => JSON.stringify(x).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');

function send(res, status, headers, body) {
  if (res.writableEnded) return;
  const buf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...(buf ? { 'content-length': buf.length } : {}),
    ...headers,
    ...(isHtml(headers) && !headers['content-security-policy'] ? { 'content-security-policy': CSP_DOC } : {}),
  });
  res.end(buf);
}
const json = (res, obj, status = 200, headers = {}) =>
  send(res, status, { 'content-type': 'application/json; charset=utf-8', ...headers }, ji(obj));
const fail = (res, status, error, detail) => json(res, { error, detail }, status);
const metaHeaders = (meta) => ({ 'x-umbra-meta': encodeMeta(meta) });

/*
 * CLOAK POLICY — the structural guarantee, not a rewrite courtesy.
 *
 * Every proxied document is same-origin with the origin that served it, so a
 * Content-Security-Policy we attach applies to it *and* to every nested
 * about:blank / srcdoc child it spawns (policies inherit into those). Because
 * all legitimate references have been pulled onto /~umbra/, 'self' is all any
 * of them needs — so if some vector we never thought of (a new element, a
 * vendor-specific attribute, a speculative scanner) tries to reach a real host
 * directly, the browser refuses the request instead of sending it. Rewriting
 * makes Umbra work; this makes leaking impossible.
 */
const CSP_DOC = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: blob: data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'self' blob: data:",
  "manifest-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "report-uri /~umbra/csp-report",
].join('; ');
/* the outer shell may host a deliberately uncloaked tab (native mode), so it
   allows frames anywhere — documents inside cloaked frames do not */
const CSP_SHELL = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self' http: https: blob:",
  "form-action 'self'",
  "base-uri 'self'",
].join('; ');
const isHtml = (headers) => /text\/html/i.test(String((headers && headers['content-type']) || ''));

function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + (req.headers['x-forwarded-host'] || req.headers.host);
}

function readReq(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const cs = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); return reject(new Error('form body too large')); }
      cs.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(cs)));
    req.on('error', reject);
  });
}

/* ======================================================= capsules ====== */
const capsuleCss = `
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:radial-gradient(120% 90% at 12% -10%,#1d2334 0%,transparent 55%),
 radial-gradient(90% 70% at 100% 100%,#16202c 0%,transparent 60%),#0c1016;color:#dfe6f1;
 font:14px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
 min-height:100vh;display:grid;place-items:center;padding:26px}
main{max-width:720px;width:100%;background:rgba(19,24,34,.86);border:1px solid rgba(255,255,255,.09);
 border-radius:16px;padding:24px 26px;box-shadow:0 30px 70px -30px #000}
h1{font-size:17px;margin:0 0 10px}h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#93a4bb;margin:20px 0 8px}
.kicker{font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;
 color:#a9ecff;background:rgba(157,140,255,.11);border:1px solid rgba(157,140,255,.28);padding:6px 9px;
 border-radius:99px;display:inline-block;margin-bottom:14px}
u{display:block;text-decoration:none;font-family:ui-monospace,Menlo,monospace;font-size:12px;
 background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;
 color:#a9ecff;overflow-wrap:anywhere;margin:10px 0;word-break:break-all}
.row{display:flex;gap:9px;flex-wrap:wrap;margin-top:16px;align-items:center}
button,a.btn{font:inherit;font-size:13px;cursor:pointer;border-radius:10px;padding:9px 14px;
 border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#eaf1f8;text-decoration:none}
button:hover,a.btn:hover{background:rgba(255,255,255,.12)}
button.go{background:linear-gradient(180deg,#b3a8ff,#7c6cf0);border-color:#8f80f5;color:#0a0618;font-weight:600}
.warn{color:#ffcf8b}.muted{color:#8b9bb4}
pre{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:12px;
 overflow:auto;font-size:12px;color:#bccbe0;max-height:46vh}
code{font:12px ui-monospace,monospace;background:rgba(255,255,255,.07);padding:1px 5px;border-radius:5px;color:#c9c1ff}
ul{padding-left:19px}li{margin:5px 0}table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:1px solid rgba(255,255,255,.07);padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8fa2ba}
img{max-width:100%;height:auto;border-radius:10px;border:1px solid rgba(255,255,255,.1)}
video{width:100%;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:#05080c}
`;

/**
 * Locally authored Umbra document. `uplink` is the message the frame hands to
 * the shell; the same shape the injected shim uses, so the shell has one
 * router for both.
 */
function capsule({ kind, tab, title = 'Umbra', body, payload = {}, wide }) {
  const msg = ji({ umbra: 1, tab: tab || '', type: kind, ...payload });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${capsuleCss}</style></head>
<body><main${wide ? ' style="max-width:960px"' : ''}>${body}</main>
<script>(function(){
var msg=${msg};
function root(){try{var t=window.top;void t.location.href;return t}catch(e){try{return window.parent}catch(x){return null}}}
function send(m){var t=root();if(t&&t.__UMBRA_SHELL__){try{t.postMessage(m,'*');return 1}catch(e){}}return 0}
window.__umbraPost=function(type,p){return send(Object.assign({},msg,{type:type},p||{}))};
${kind === 'redirect' ? '/* a held hop waits for the reader: follow/open/keep above choose explicitly */' : 'send(msg);'}
})();</script></body></html>`;
}

function errPage(ctx, url, msg, chain) {
  const body = `<div class="kicker">umbra · wire</div>
<h1>Nothing could be delivered for <span class="muted">${esc(displayHost(url))}</span></h1>
<u>${esc(String(url).slice(0, 300))}</u>
<p class="warn">${esc(msg)}</p>
${chain && chain.length ? '<h2>hop log</h2><pre>' + chain.map((c) => esc(c.status + ' ' + c.url + (c.location ? ' -> ' + c.location : ''))).join('\n') + '</pre>' : ''}
<p class="muted">This capsule is an Umbra document: it lives in your tab strip, and your browser history still contains exactly one entry.</p>`;
  return capsule({ kind: 'noop', tab: ctx.tabId, title: 'Umbra · blocked', body });
}

const tt = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = (sec % 60);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s2, 2) + '.' + pad(Math.round((s2 % 1) * 1000), 3);
};

/* ==================================================== redirect policy == */
/**
 * One decision point for every 3xx, upstream-generated or synthetic.
 * Returns true when a capsule was written (redirect held), false when the
 * caller should silently continue to `next`.
 */
function holdRedirect(ctx, res, from, to, status, mode, chain) {
  let sameHost = false;
  try { sameHost = new URL(from).hostname === new URL(to).hostname; } catch {}
  const doc = mode === 'd' || mode === 'f';
  const policy = ctx.policy.follow;

  if (!doc) return false;                                     // subresources: follow
  if (policy === 'all') return false;                          // user asked to collapse
  if (sameHost && policy === 'same-host') return false;       // scheme/slash normalisation
  if (sameHost && policy === 'none' && false) return false;

  ctx.sessionObj && ctx.sessionObj.held++;
  const tok = encodeToken({ u: to, t: ctx.tabId, s: ctx.session, g: ctx.gen, m: 'd' });
  const followWire = `${PFX}d/${tok}/followed.html`;
  const body = `<div class="kicker">redirect held for review</div>
<h1>${esc(displayHost(from))} answered ${esc(status)} toward ${esc(displayHost(to))}</h1>
<p class="muted">Your redirect policy holds cross-host hops instead of following them. Nothing has moved yet —
not this frame, not your place in the tab strip, and nothing in your browser history. Choose where this hop lands.</p>
<u>${esc(toUmbra(from))} &nbsp;&#8594;&nbsp; ${esc(toUmbra(to))}</u>
<h2>held response</h2>
<pre>${esc(status + ' ' + (httpReason(status)))}</pre>
<div class="row">
  <a class="btn" href="${followWire}" onclick="__umbraPost('nav',{wire:this.getAttribute('href')});return false">load it in THIS tab anyway</a>
  <button class="go" onclick="__umbraPost('open',{url:${ji(toUmbra(to))}})">open in a new umbra tab</button>
  <button onclick="__umbraPost('restore',{})">keep this page</button>
</div>
${chain && chain.length > 1 ? '<h2>chain so far</h2><pre>' + chain.map((c) => esc(c.status + ' ' + c.url)).join('\n') + '</pre>' : ''}`;
  send(
    res,
    200,
    {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...metaHeaders({ kind: 'redirect-held', url: from, to, status, tab: ctx.tabId, policy }),
    },
    capsule({
      kind: 'redirect',
      tab: ctx.tabId,
      title: 'Redirect held',
      body,
      payload: { url: toUmbra(to), from: toUmbra(from), status, sameHost, holdHere: 1 },
    }),
  );
  return true;
}
const httpReason = (s) =>
  ({ 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 307: 'Temporary Redirect', 308: 'Permanent Redirect' }[s] || 'Redirect');

/* ====================================================== main pipeline == */
const SNIFF = (ct) => {
  if (/text\/html|application\/xhtml/.test(ct)) return 'html';
  if (/text\/css/.test(ct)) return 'css';
  if (/javascript|ecmascript/.test(ct)) return 'js';
  if (/^image\//.test(ct)) return 'image';
  if (/^font\/|application\/font/.test(ct)) return 'font';
  if (/^video|^audio/.test(ct)) return 'media';
  if (/json|xml|text\/plain/.test(ct)) return 'text';
  return 'other';
};

function guessType(u) {
  const ext = ((String(u).split('?')[0].match(/\.(\w{1,5})$/) || [])[1] || '').toLowerCase();
  return {
    js: 'application/javascript', mjs: 'application/javascript', css: 'text/css', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    svg: 'image/svg+xml', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    otf: 'font/otf', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', m4s: 'video/mp4',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', json: 'application/json',
    wasm: 'application/wasm', vtt: 'text/vtt', pdf: 'application/pdf', txt: 'text/plain',
  }[ext] || '';
}

/**
 * Rewrite + shim a locally authored document through the *real* pipeline, so
 * an Umbra-authored page and a proxied page are the same kind of object: same
 * mode d, same shim, same logical base, same tab bookkeeping.
 */
function localDoc(ctx, html, baseUrl, extraHead = '', logical = '') {
  const dirBase = baseUrl.replace(/[^/]*$/, '');
  const titleHint = ((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || 'umbra')
    .replace(/<[^>]*>/g, '').trim().slice(0, 70);
  const full = /<!doctype/i.test(html)
    ? html
    : `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titleHint)}</title>${extraHead}</head>${
        /^\s*<body/i.test(html) ? html : '<body>' + html + '</body>'
      }</html>`;
  const rewritten = rewriteHtml(full, { base: baseUrl, ctx, mode: 's' });
  const ctxObj = {
    url: logical || toUmbra(baseUrl),
    dir: logical ? logical.replace(/\/[^/]*$/, '/') : toUmbra(dirBase),
    tab: ctx.tabId,
    frame: 'top',
    key: ctx.key,
    session: ctx.session || '',
    origin: ctx.origin,
    ephemeral: ctx.policy.ephemeral ? 1 : 0,
    hops: [],
  };
  let out = injectShim(rewritten, ji(ctxObj), PFX + 'shim.js');
  out = out.replace(/<head[^>]*>/i, (m) => m + '<meta name="referrer" content="no-referrer"><meta name="umbra" content="local">');
  return out;
}

/**
 * @param {object} ctx  {url,tabId,session,key,policy,cookieJar,origin,sessionObj,referrer}
 */
async function serve(ctx, req, res, opts = {}) {
  const mode = opts.mode || ctx.mode || 's';
  const doc = mode === 'd' || mode === 'f';
  let url = /^umbra:\/\//.test(ctx.url) ? 'https://' + ctx.url.slice('umbra://'.length) : ctx.url;

  /* Umbra-authored surfaces have logical hosts of their own (umbra://lab/xhr,
     umbra://help, …). A relative ref inside one of those documents resolves to
     https://lab/… — normalize it back onto the virtual host so it is answered
     locally and never reaches a resolver. */
  {
    const hm = /^(https?:\/\/)([^/:]+)(:\d+)?(\/.*|)$/i.exec(url);
    if (hm && /^(lab|portal|help|stats|home)$/i.test(hm[2])) url = hm[1] + hm[2] + '.umbra' + (hm[3] || '') + hm[4];
  }
  if (/^https?:\/\/([a-z0-9-]+\.)?umbra\b/i.test(url) && !/^https?:\/\/(lab|portal|help|stats)\.umbra/i.test(url)) {
    return send(res, 404, { 'content-type': 'text/html; charset=utf-8', ...metaHeaders({ kind: 'umbra-404', url }) },
      errPage(ctx, url, 'no umbra resource at that logical address', []));
  }

  /* local fixtures: deterministic probes, never touch the network */
  if (/^https?:\/\/lab\.umbra\//.test(url)) {
    const key = (/^https?:\/\/lab\.umbra\/([\w-]+)/.exec(url) || [])[1] || 'index';
    if (key === 'index') {
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8', ...metaHeaders({ kind: 'lab', fixture: 'index' }) },
        localDoc(ctx, labIndexDoc(), 'https://lab.umbra/index', '<style>' + DOC_CSS + '</style>', 'umbra://lab/index'));
    }
    const fn = LAB[key];
    if (!fn) {
      /* a relative ref resolved against a lab document lands here; answer it so
         the fixture can prove logical-base resolution instead of erroring */
      const payload = JSON.stringify({ lab: true, path: new URL(url).pathname, base: toUmbra(url), note: 'resolved against the logical umbra base of the fixture' }, null, 2);
      if (doc) {
        return send(res, 200, { 'content-type': 'text/html; charset=utf-8', ...metaHeaders({ kind: 'lab', fixture: 'payload' }) },
          localDoc(ctx, `<div class="kicker">umbra lab payload</div><h1>${esc(new URL(url).pathname)}</h1><pre>${esc(payload)}</pre>`, url, '<style>' + capsuleCss + '</style>', toUmbra(url)));
      }
      return send(res, 200, { 'content-type': 'application/json; charset=utf-8', ...metaHeaders({ kind: 'lab-json' }) }, payload);
    }
    if (mode === 'd' || mode === 'f') {
      if (fn.direct) return fn.direct(ctx, res);
      const html = fn(ctx);
      return send(res, 200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        ...metaHeaders({ kind: 'lab', fixture: key, tab: ctx.tabId }),
      }, localDoc(ctx, html, 'https://lab.umbra/' + key, '<style>' + capsuleCss + '</style>', 'umbra://lab/' + key));
    }
    return send(res, 200, { 'content-type': 'text/css; charset=utf-8' }, 'body{background:#0c1016}');
  }
  if (/^https?:\/\/(portal|help|stats|home)\.umbra/i.test(url)) {
    const which = /stats/i.test(url) ? 'stats' : /help|protocol/i.test(url) ? 'help' : 'home';
    const bodyHtml = which === 'home' ? portalDoc() : which === 'help' ? helpDoc() : statsDoc(s);
    return send(res, 200, {
      'content-type': 'text/html; charset=utf-8', ...metaHeaders({ kind: 'umbra-doc', doc: which, tab: ctx.tabId }),
    }, localDoc(ctx, bodyHtml, 'https://portal.umbra/' + which, '<style>' + DOC_CSS + '</style>',
      which === 'home' ? 'umbra://home/' : which === 'help' ? 'umbra://protocol' : 'umbra://stats'));
  }
  const chain = [];
  /* The hop cap is loop protection only — hold-vs-follow is decided per hop by
     the policy in holdRedirect. Capping same-host chains at 1 would 508 any
     site whose canonicalisation takes two hops (http→https→www is common). */
  const maxHops = doc ? DOC_HOPS : SUB_HOPS;
  let up = null;
  /* API fidelity: XHR/fetch keep their method and body upstream (innertube
     RPCs are POSTs; dropping the body breaks every SPA that talks JSON). */
  let upMethod = opts.method || (mode === 'f' ? 'POST' : 'GET');
  let upBody = opts.body || null;
  let upCt = opts.ct || null;

  for (let hop = 0; hop <= maxHops; hop++) {
    const headers = {
      accept: doc
        ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.75'
        : mode === 's'
          ? '*/*'
          : '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': UA,
      'upgrade-insecure-requests': '1',
      dnt: '1',
      'sec-ch-ua': '"Chromium";v="124", "Not.A/Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': doc ? 'document' : mode === 'm' ? 'video' : 'empty',
      'sec-fetch-mode': doc ? 'navigate' : 'cors',
      'sec-fetch-site': 'none',
      cookie: ctx.cookieJar.header(url),
    };
    if (ctx.policy.referrer === 'full') headers.referer = ctx.referrer || undefined;
    else if (ctx.policy.referrer === 'origin') {
      try { headers.referer = new URL(ctx.referrer || url).origin + '/'; } catch {}
    }
    if (mode === 's') headers.referer = headers.referer || (() => { try { return new URL(url).origin + '/'; } catch { return undefined; } })();
    if (opts.range) headers.range = opts.range;
    if (upBody) {
      headers['content-type'] = upCt || 'application/x-www-form-urlencoded';
      headers['content-length'] = String(upBody.length);
    }

    for (const k of Object.keys(headers)) if (headers[k] == null || headers[k] === '') delete headers[k];

    try {
      up = await upstream(url, {
        method: upMethod,
        headers,
        body: upBody,
        stream: mode === 'm' || mode === 'r' || (doc === false && !['css', 'html', 'js', 'text'].includes(SNIFF(guessType(url)))),
      });
    } catch (e) {
      /* https-first with a loopback fallback (browsers do the same when https
         fails): umbra:// means https, but loopback services are usually plain
         http. Scoped to loopback on the first hop only, so nothing on the
         open web can ever be downgraded by it. */
      if (hop === 0 && /^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(url)) {
        const httpUrl = url.replace(/^https:\/\//i, 'http://');
        chain.push({ status: 0, url, location: httpUrl });
        url = httpUrl;
        continue;
      }
      return send(res, 502, { 'content-type': 'text/html; charset=utf-8', ...metaHeaders({ kind: 'error', url, error: String(e.message || e) }) },
        errPage(ctx, url, 'upstream refused: ' + (e.message || e), chain));
    }
    chain.push({ status: up.status, url: up.url, location: up.location || null });
    for (const sc of [].concat(up.res.headers['set-cookie'] || [])) ctx.cookieJar.store(sc, up.url);

    const st = up.status;
    const loc = up.location;
    if ([301, 302, 303, 307, 308].includes(st) && loc) {
      const next = resolveRef(loc, up.url);
      up.res.resume();
      if (!next) return send(res, 502, {}, errPage(ctx, up.url, 'unparseable redirect target: ' + String(loc).slice(0, 120), chain));
      if (holdRedirect(ctx, res, up.url, next, st, mode, chain)) return;
      /* 301/302 downgrade POST to GET, 303 downgrades everything but HEAD;
         307/308 replay the body untouched — exactly what fetch would do */
      if (((st === 301 || st === 302) && upMethod === 'POST') || (st === 303 && upMethod !== 'HEAD')) {
        upMethod = 'GET'; upBody = null; upCt = null;
      }
      url = next;
      if (hop === maxHops) return send(res, 508, {}, errPage(ctx, url, 'redirect limit reached', chain));
      continue;
    }
    break;
  }

  const h = up.res.headers;
  const status = up.status;
  const finalUrl = up.url;
  /* Trust the declared type; fall back to the extension only when the origin
     declared nothing (some CDNs omit it for Range-restricted hits). */
  const ct0 = String(h['content-type'] || '');
  const ct = ct0 || guessType(finalUrl);
  const kind = SNIFF(ct);
  if (ctx.sessionObj) ctx.sessionObj.reqs++;

  /* Only two things get buffered and rewritten: a document body, and a
     stylesheet asked for as a subresource. Everything else is piped. */
  const attachment = /attachment/i.test(String(h['content-disposition'] || '')) ||
    /\.(pdf|zip|dmg|exe|msi|pkg|apk|iso|gz|tgz|bz2|7z|rar|docx?|xlsx?|pptx?|csv|epub|key|numbers)([?#]|$)/i.test(finalUrl);
  const rewriteCssHere = !doc && mode === 's' && kind === 'css';
  const wantText = (doc && !attachment) || rewriteCssHere;

  let buf = null;
  if (wantText) {
    try {
      buf = await readBody(up.res, { limit: MAX_DOC });
    } catch (e) {
      return send(res, 502, {}, errPage(ctx, finalUrl, 'body unreadable: ' + (e.message || e), chain));
    }
    if (ctx.sessionObj) ctx.sessionObj.bytes += buf.length;
  }

  /* a document request that landed on a binary gets an Umbra viewer */
  if (doc && !attachment && kind === 'image') {
    const assetTok = encodeToken({ u: finalUrl, t: ctx.tabId, s: ctx.session, g: ctx.gen, m: 'm' });
    const body = `<div class="kicker">umbra viewer · image</div><h1>${esc(displayHost(finalUrl))}</h1>
<u>${esc(toUmbra(finalUrl))}</u>
<img src="${PFX}m/${assetTok}/image" alt="proxied image" style="max-width:100%">
<p class="muted">${buf.length} bytes pulled through mode m as a same-origin response, so the image cannot be
blocked as mixed content and ${esc(displayHost(finalUrl))} sees the proxy, not you.</p>
<div class="row"><a class="btn" href="${PFX}r/${assetTok}/download">save raw bytes (mode r)</a></div>`;
    return send(res, 200, { 'content-type': 'text/html; charset=utf-8', ...metaHeaders({ kind: 'viewer', url: finalUrl, bytes: buf.length }) },
      localDoc(ctx, body, finalUrl, '<style>' + capsuleCss + '</style>', toUmbra(finalUrl)));
  }
  if (doc && !attachment && (kind === 'media' || kind === 'other' || kind === 'font')) {
    const assetTok = encodeToken({ u: finalUrl, t: ctx.tabId, s: ctx.session, g: ctx.gen, m: 'm' });
    const tag = kind === 'media' && /audio/.test(ct) ? 'audio' : 'video';
    const body = `<div class="kicker">umbra viewer · ${esc(tag)}</div><h1>${esc(displayHost(finalUrl))}</h1>
<u>${esc(toUmbra(finalUrl))}</u>
<${tag} controls preload="metadata" src="${PFX}m/${assetTok}/media"></${tag}>
<p class="muted">Range requests are copied through mode m, so seeking works without the file ever
touching your browser's network stack directly.</p>`;
    return send(res, 200, { 'content-type': 'text/html; charset=utf-8', ...metaHeaders({ kind: 'viewer', url: finalUrl }) },
      localDoc(ctx, body, finalUrl, '<style>' + capsuleCss + '</style>', toUmbra(finalUrl)));
  }

  if (!wantText) {
    const hdrs = outboundHeaders(up.res, {
      'accept-ranges': h['accept-ranges'] || 'bytes',
      'cache-control': 'private, max-age=300',
      'access-control-allow-origin': ctx.origin,
      'access-control-expose-headers': 'x-umbra-meta, content-range, accept-ranges, content-length, content-type',
      ...metaHeaders({ kind: mode === 'm' ? 'media' : mode === 'x' ? 'xhr' : 'asset', url: finalUrl, ct, status, tab: ctx.tabId }),
    });
    if (h['content-length']) hdrs['content-length'] = h['content-length'];
    if (h['content-range']) hdrs['content-range'] = h['content-range'];
    if (h['content-type']) hdrs['content-type'] = h['content-type'];
    if (/text\/html/i.test(String(h['content-type'] || ''))) hdrs['content-security-policy'] = CSP_DOC;
    res.writeHead(status || 200, hdrs);
    up.res.on('error', () => res.destroy());
    up.res.pipe(res);
    return;
  }

  /* ---------------------------- css ---------------------------- */
  if (kind === 'css') {
    const css = rewriteCssUrls(buf.toString('latin1'), finalUrl, ctx, 's').text;
    return send(res, status || 200, {
      'content-type': 'text/css; charset=utf-8',
      'access-control-allow-origin': ctx.origin,
      ...metaHeaders({ kind: 'css', url: finalUrl, tab: ctx.tabId }),
    }, css);
  }

  /* ---------------------------- html ---------------------------- */
  let html = kind === 'html' ? decodeHtml(buf) : '';
  if (kind !== 'html') {
    const asText = buf.toString('utf8').slice(0, 2 * 1024 * 1024);
    html = `<body><div class="kicker">umbra viewer · ${esc(kind)}</div><h1>${esc(displayHost(finalUrl))}</h1>
<u>${esc(toUmbra(finalUrl))}</u><h2>${esc(ct || 'unknown type')} · ${buf.length} bytes</h2>
<pre>${esc(asText)}</pre>
${/json/.test(ct) ? '<script>try{var j=JSON.parse(document.querySelector("pre").textContent);document.querySelector("pre").innerHTML=esc2(j)}catch(e){}function esc2(o){return o===null?"null":typeof o==="object"?JSON.stringify(o,null,2):String(o)}<\/script>' : ''}
<p class="muted">Served because this address is a document request; the raw bytes stay available through mode r.</p>
<div class="row"><a class="btn" href="${PFX}r/${encodeToken({ u: finalUrl, t: ctx.tabId, s: ctx.session, g: ctx.gen, m: 'r' })}/raw">raw passthrough</a></div>`;
  } else if (!/<(html|body|head|!doctype)/i.test(html)) {
    html = '<body><pre>' + esc(html) + '</pre></body>';
  }

  let baseUrl = finalUrl;
  const bm = /<base[^>]+href\s*=\s*["']([^"']+)["']/i.exec(html);
  if (bm) {
    const abs = resolveRef(bm[1], finalUrl);
    if (abs) baseUrl = abs;
  }
  const docCtx = { ...ctx, url: finalUrl };
  let docOut = rewriteHtml(html, { base: baseUrl, ctx: docCtx, mode: 's' });
  const ctxObj = {
    url: toUmbra(baseUrl),
    dir: toUmbra(baseUrl.replace(/[^/]*$/, '')),
    tab: ctx.tabId,
    frame: 'top',
    key: ctx.key,
    session: ctx.session || '',
    origin: ctx.origin,
    ephemeral: ctx.policy.ephemeral ? 1 : 0,
    /* the redirect chain that landed here, oldest hop first — the shell shows
       the final address in the bar and the hop count beside it. Synthetic
       status-0 entries (https→http loopback fallback) are wire diagnostics,
       not redirects, so they stay in the meta header but not in this list */
    hops: chain.filter((c) => c.status !== 0).map((c) => ({ status: c.status, url: toUmbra(c.url) })),
  };
  docOut = injectShim(docOut, ji(ctxObj), PFX + 'shim.js');
  docOut = docOut.replace(/<head[^>]*>/i, (m) => m + '<meta name="referrer" content="no-referrer"><meta name="umbra" content="v1">');
  if (isYouTube(finalUrl) && parseVideoId(finalUrl)) docOut = ytPill(ctx, parseVideoId(finalUrl)) + docOut;

  send(res, status || 200, {
    'content-type': 'text/html; charset=utf-8',
    'access-control-allow-origin': ctx.origin,
    'x-umbra-base': toUmbra(baseUrl),
    'cache-control': 'no-store',
    ...metaHeaders({
      kind: 'doc', url: finalUrl, umbra: toUmbra(baseUrl), status,
      hops: chain.length, redirected: chain.length > 1, tab: ctx.tabId,
      chain: chain.map((c) => c.status + ' ' + displayHost(c.url)),
    }),
  }, docOut);
}

function ytPill(ctx, vid) {
  const tok = encodeToken({ u: 'umbra://player/youtube', v: vid, t: ctx.tabId, s: ctx.session, g: ctx.gen, m: 'c' });
  return `<div id="umbra-pill" style="position:fixed;right:14px;bottom:14px;z-index:2147483647;display:flex;gap:8px;
 align-items:center;font:500 13px/1 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;background:#10161f;color:#e8f0f8;
 border:1px solid rgba(143,214,200,.35);border-radius:999px;padding:8px 10px 8px 12px;box-shadow:0 14px 34px -14px #000">
 <span style="letter-spacing:.12em;text-transform:uppercase;font-size:10px;color:#8fd6c8">umbra</span>
 <a href="${PFX}c/${tok}/player.html" style="color:#eaf7f2;text-decoration:none;border:1px solid rgba(255,255,255,.18);
  border-radius:999px;padding:6px 11px">play in the umbra player</a>
 <button onclick="this.parentNode.remove()" style="all:unset;cursor:pointer;color:#93a4bb;padding:0 4px" aria-label="dismiss">&times;</button></div>`;
}

/* ------------------------------------------- local umbra addresses -------
   Umbra-authored documents are addressable in the same scheme as remote ones,
   so the shell has exactly one code path for "go somewhere". */
function localAddressToUrl(raw) {
  const s = String(raw || '');
  if (/^umbra:\/\/(portal|home)\//.test(s)) return 'https://portal.umbra/home';
  if (/^umbra:\/\/help(\/|\?|$)/i.test(s)) return 'https://portal.umbra/help';
  if (/^umbra:\/\/stats(\/|\?|$)/i.test(s)) return 'https://portal.umbra/stats';
  if (/^umbra:\/\/protocol(\/|\?|$)/i.test(s)) return 'https://portal.umbra/help';
  if (/^umbra:\/\/(portal|home)(\/|\?|$)/i.test(s)) return 'https://portal.umbra/home';
  if (/^umbra:\/\/lab/.test(s)) return 'https://lab.umbra/' + s.slice('umbra://lab'.length).replace(/^\//, '');
  if (/^umbra:\/\/search\//.test(s)) {
    const q = new URL(s.replace('umbra://search/', 'https://search.umbra/')).searchParams.get('q');
    return 'https://portal.umbra/search?q=' + encodeURIComponent(q || '');
  }
  return null;
}
function localHrefFor(raw, tabId, sid) {
  const u = localAddressToUrl(raw);
  if (!u) return null;
  /* unsigned local URLs carry the session explicitly: a frame navigation
     cannot set headers, and its cookies may be blocked as third-party. */
  const tail = '?t=' + encodeURIComponent(tabId) + (sid ? '&sid=' + encodeURIComponent(sid) : '');
  if (u.startsWith('https://lab.umbra/')) {
    const key = /^https:\/\/lab\.umbra\/([\w-]+)/.exec(u)[1];
    return PFX + 'lab/' + key + tail;
  }
  if (u.startsWith('https://portal.umbra/search')) {
    const qs = u.slice(u.indexOf('?'));
    return PFX + 'search' + qs + '&format=html&t=' + encodeURIComponent(tabId) + (sid ? '&sid=' + encodeURIComponent(sid) : '');
  }
  const which = /help/.test(u) ? 'help' : /stats/.test(u) ? 'stats' : 'home';
  return PFX + 'doc/' + which + tail;
}

/* ======================================================== lab fixtures = */
/* Deterministic probes so every guarantee in the spec can be exercised
   without depending on a third party changing its behaviour. */
const LAB = {
  redirect: Object.assign(() => `<body><div class="kicker">fixture · synthetic 302</div>
<h1>This document answered with a redirect that was never sent to you</h1>
<p class="muted">Umbra synthesised <code>302 -&gt; umbra://example.com/</code> here and ran it through the
same policy code as a real upstream hop: strict policies hold it for review, the default
follows it the way a browser would.</p>
<pre>GET umbra://lab/redirect
&lt; 302 Found   Location: umbra://example.com/</pre></body>`,
    { direct: (ctx, res) => {
        const to = 'https://example.com/';
        const from = 'https://lab.umbra/redirect';
        // pretend upstream answered 302; let the shared policy code decide
        const stayed = holdRedirect({ ...ctx, policy: { ...ctx.policy, follow: ctx.policy.follow } }, res, from, to, 302, 'd', [{ status: 302, url: from, location: to }]);
        if (!stayed) {
          /* the policy says follow: land on the synthetic target the way the
             pipeline would after a real 302, chain and all */
          send(res, 200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            ...metaHeaders({ kind: 'doc', url: to, umbra: toUmbra(to), status: 200, hops: 2, redirected: true, tab: ctx.tabId, chain: ['302 lab.umbra', '200 example.com'] }),
          }, localDoc({ ...ctx, url: to }, `<body><div class="kicker">fixture · followed 302</div>
<h1>One hop, followed like a browser</h1>
<p class="muted">The synthetic <code>302 -&gt; umbra://example.com/</code> was followed in this tab.
The address bar shows where you landed, not where you started.</p>
<pre>GET umbra://lab/redirect
&lt; 302 Found   Location: umbra://example.com/
GET umbra://example.com/  (synthetic landing document)</pre></body>`, to, '', toUmbra(to)));
        }
      } }),
  samehost: Object.assign(() => `<body></body>`, { direct: (ctx, res) => {
      // same-host 301 must be followed silently: one document, zero new tabs
      const from = 'https://lab.umbra/samehost';
      const held = holdRedirect(ctx, res, from, 'https://lab.umbra/samehost-target', 301, 'd', []);
      if (held) return;
      const html = `<div class="kicker">fixture · same-host 301</div>
<h1>One hop, silently followed</h1>
<p class="muted">A same-host redirect is a URL detail, not a navigation: it was resolved inside this tab,
no new tab was created, and this text came back from the target path.</p>
<pre>${esc(from)} -> https://lab.umbra/samehost-target (301, followed)</pre>`;
      send(res, 200, { 'content-type': 'text/html; charset=utf-8', ...metaHeaders({ kind: 'lab', fixture: 'samehost' }) }, localDoc(ctx, html, from, '<style>' + capsuleCss + '</style>', 'umbra://lab/samehost-target'));
    } }),
  meta: (ctx) => `<body><div class="kicker">fixture · meta refresh</div>
<h1>This page declares <code>&lt;meta http-equiv=refresh&gt;</code></h1>
<p>In three seconds this document asks to move to <code>umbra://en.wikipedia.org/Web_proxy</code>.
Umbra converts it into a redirect event: the wiki opens as a new tab, this page stays.</p>
<meta http-equiv="refresh" content="3;url=https://en.wikipedia.org/wiki/Web_proxy">
<pre id="t">3</pre>
<script>var n=3;setInterval(function(){n--;var e=document.getElementById('t');if(e)e.textContent=n>0?n+'s until the meta refresh fires (held in tab)':'refresh fired'},1000)</script></body>`,
  js: (ctx) => `<body><div class="kicker">fixture · scripted navigation</div>
<h1>Run <code>location.href = 'https://example.com'</code></h1>
<p>The frame is sandboxed without <code>allow-top-navigation</code> and <code>window.open</code> is
overridden, so a script cannot move your browser tab. If it pushes the <i>frame</i> off the Umbra
origin, the shell notices on load, reverts it, and re-routes the target into a tab.</p>
<div class="row"><button class="go" onclick="location.href='https://example.com/'">location.href = off-origin</button>
<button onclick="location.replace('https://httpbin.org/get?replaced=1')">location.replace()</button>
<button onclick="window.location.assign('umbra://en.wikipedia.org/wiki/URL_redirector')">location.assign(umbra)</button></div></body>`,
  windowopen: (ctx) => `<body><div class="kicker">fixture · window.open</div>
<h1>Popups become Umbra tabs</h1>
<div class="row"><button class="go" onclick="window.open('https://example.com','_blank')">window.open('example.com')</button>
<button onclick="window.open('https://httpbin.org/html','boom','width=300,height=200')">window.open(w=300,h=200)</button>
<button onclick="var a=document.createElement('a');a.href='https://httpbin.org/get?created=1';a.target='_blank';a.textContent='dynamically created link';document.body.appendChild(a)">create &lt;a target=_blank&gt;</button></div>
<p class="muted">No new browser window should ever appear; the shell logs each one as a tab.</p></body>`,
  image: (ctx) => `<body><div class="kicker">fixture · images</div>
<h1>Images, including a 302 and a lazy one</h1>
<img src="https://httpbin.org/image/png" width="200" alt="png">
<img src="https://picsum.photos/seed/umbra/420/200" alt="picsum (302 -> fastly, followed silently)">
<img src="https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png" width="180" alt="a real logo asset with @2x semantics in its path">
<p>preload hint (a fetch the browser issues before any script runs):</p>
<link rel="preload" as="image" imagesrcset="https://picsum.photos/seed/preload/200/120 1x, https://picsum.photos/seed/preload2/400/240 2x">
<span id="preloaded">watch the network log</span>
<p>srcset list:</p>
<img alt="srcset" srcset="https://picsum.photos/seed/a/160/100 160w, https://picsum.photos/seed/b/320/200 320w" sizes="320px" src="https://picsum.photos/seed/a/160/100">
<p class="muted">Every image request is issued against this same origin, so a mixed-content or
hotlink-referrer block never happens, and the destination sees the proxy, not you.</p></body>`,
  video: (ctx) => `<body><div class="kicker">fixture · html5 media + Range</div>
<h1>10s clip streamed through mode m</h1>
<video controls preload="metadata" poster="https://picsum.photos/seed/poster/640/360"
 src="https://test-videos.co.uk/vids/bigbuckbunny/webm/vp8/360/Big_Buck_Bunny_360_10s_1MB.webm"></video>
<p class="muted">VP8/WebM so the clip decodes in any Chromium build, including codec-stripped
headless ones; the MP4 source below is served identically.</p>
<video controls preload="metadata"
 src="https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"></video>
<h2>audio</h2>
<audio controls src="https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"></audio>
<h2>what to look at</h2>
<pre id="d">the seek bar works only if Range survived the proxy: mode m copies Range up
and Content-Range / 206 back down, without buffering the file</pre>
<script>var v=document.querySelector('video');v.addEventListener('progress',function(){document.getElementById('d').textContent='buffered: '+v.buffered.length+' range(s); seekable: '+(v.seekable.length?v.seekable.end(v.seekable.length-1)|0:0)+'s'})</script></body>`,
  form: (ctx) => `<body><div class="kicker">fixture · forms</div>
<h1>GET and POST through mode f</h1>
<form method="get" action="https://httpbin.org/get">
 <label>search-ish text <input name="q" value="umbra"></label>
 <label>number <input name="n" value="42"></label>
 <button>submit GET (shell serialises, no frame nav)</button>
</form>
<form method="post" action="https://httpbin.org/post">
 <label>body field <input name="sent" value="hello from umbra"></label>
 <button>submit POST (mode f forwards bytes)</button>
</form>
<h2>the results below are live</h2>
<iframe style="width:100%;height:190px;border:1px solid #333;border-radius:10px"
 src="https://httpbin.org/get?nested=1"></iframe></body>`,
  frames: (ctx) => `<body><div class="kicker">fixture · nested frames</div>
<h1>Two proxied documents inside this proxied document</h1>
<iframe src="https://example.com" style="width:100%;height:150px;border:1px solid #333;border-radius:10px"></iframe>
<iframe src="https://httpbin.org/html" style="width:100%;height:150px;border:1px solid #333;border-radius:10px;margin-top:8px"></iframe>
<p class="muted">Each child got the Umbra shim too, so links clicked inside them still route to the shell.</p></body>`,
  storage: (ctx) => `<body><div class="kicker">fixture · ephemeral storage</div>
<h1>localStorage on an origin that isn't yours</h1>
<p>Proxied sites normally write storage into <i>your</i> profile under the proxy origin. Umbra hands the
frame an in-memory shim instead, so writes die with the tab.</p>
<div class="row"><button class="go" onclick="localStorage.setItem('umbra-probe','written at '+new Date().toISOString());document.getElementById('o').textContent=localStorage.getItem('umbra-probe')+'  (memory only)'">write + read</button>
<button onclick="document.cookie='umbra_site_probe=1; path=/';document.getElementById('o').textContent='document.cookie -> '+document.cookie">try document.cookie</button></div>
<pre id="o">nothing yet</pre></body>`,
  schemes: (ctx) => `<body><div class="kicker">fixture · scheme policy</div>
<h1>data:, blob: and friendless schemes</h1>
<p>An inline image must survive (it never touches the network); a scheme that hands
control to another program must not survive.</p>
<img id="inline" width="40" height="40" alt="inline data uri" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23e0457b'/%3E%3C/svg%3E">
<img id="blobish" width="40" height="40" alt="blob url built at runtime" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">
<p>
  <a id="js" href="javascript:document.title='pwned'">javascript: link</a>
  <a id="mail" href="mailto:nobody@example.invalid">mailto: link</a>
  <a id="tel" href="tel:+10000000000">tel: link</a>
  <a id="ext" href="https://example.com/">external http link</a>
</p>
<pre id="out">checking…</pre>
<script>
  try {
    var cv = document.getElementById('blobish');
    cv.src = URL.createObjectURL(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])], { type: 'image/png' }));
  } catch (e) { document.getElementById('out').textContent = 'blob: ' + e.message; }
  document.getElementById('out').textContent =
    'js href=' + JSON.stringify(document.getElementById('js').getAttribute('href')) +
    ' · data src kept=' + /^data:image\\/svg/.test(document.getElementById('inline').getAttribute('src')) +
    ' · ext href on wire=' + /\\/~umbra\\//.test(document.getElementById('ext').getAttribute('href'));
</script>`,
  xhr: (ctx) => `<body><div class="kicker">fixture · fetch / xhr / beacon</div>
<h1>Runtime-built requests are re-anchored by the shim</h1>
<pre id="o">running…</pre>
<script>
(async function(){
  var out=[];
  try{var r=await fetch('https://httpbin.org/get?via=fetch');var j=await r.json();out.push('fetch → '+r.status+' '+JSON.stringify(j.args))}catch(e){out.push('fetch failed: '+e)}
  try{var rp=await fetch('https://httpbin.org/post',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rpc:'player'})});var jp=await rp.json();out.push('fetch POST → '+rp.status+' '+(jp.data||'').slice(0,40))}catch(e){out.push('fetch POST failed: '+e)}
  try{var x=new XMLHttpRequest();x.open('GET','/relative-xhr.json');x.send();x.onloadend=function(){out.push('XHR relative → '+x.status)}}catch(e){out.push('xhr '+e)}
  try{var r2=await fetch('https://httpbin.org/headers');var j2=await r2.json();out.push('headers seen by origin: '+Object.keys(j2.headers).join(', '))}catch(e){}
  document.getElementById('o').textContent=out.join('\\n')
})();
</script>
<p class="muted">Relative requests resolve against the <b>logical</b> umbra base, not the wire path.</p></body>`,
};

/* ======================================================== search ======= */
const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;|&#39;/g, "'");
}
const SEARCH_ENGINES = [
  {
    name: 'bing',
    url: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&count=20&setlang=en&cc=us',
    parse(html) {
      const out = [];
      const re = /<li class="b_algo[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>([\s\S]*?)<\/li>/g;
      let m;
      while ((m = re.exec(html)) && out.length < 20) {
        const snip = (/<p[^>]*>([\s\S]*?)<\/p>/.exec(m[3]) || [])[1] || '';
        out.push({ url: decodeEntities(m[1]), title: stripTags(m[2]), snippet: stripTags(snip).slice(0, 260) });
      }
      return out;
    },
  },
  {
    name: 'ddg-lite',
    url: (q) => 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q),
    parse(html) {
      const out = [];
      const re = /<a[^>]*rel="nofollow[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/td>[\s\S]*?<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
      let m;
      while ((m = re.exec(html)) && out.length < 20) {
        out.push({ url: decodeEntities(m[1]), title: stripTags(m[2]), snippet: stripTags(m[3]) });
      }
      return out;
    },
  },
];
/** bing wraps results in /ck/a?u=a1<base64url(dest)>; Umbra wants the real host */
function unwrapBing(url) {
  try {
    const u = new URL(url);
    if (!/bing\.com$/.test(u.hostname) && !u.hostname.endsWith('.bing.com')) return url;
    if (!/^\/ck\/a/.test(u.pathname)) return url;
    const p = u.searchParams.get('u');
    if (!p) return url;
    const cand = Buffer.from(p.replace(/^a[01]/, ''), 'base64url').toString('utf8');
    return /^https?:\/\//.test(cand) ? cand : url;
  } catch {
    return url;
  }
}

async function webSearch(q) {
  for (const eng of SEARCH_ENGINES) {
    try {
      const r = await upstream(eng.url(q), { headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' }, timeout: 12000 });
      const html = (await readBody(r.res, { limit: 14 * 1024 * 1024 })).toString('utf8');
      const results = eng.parse(html)
        .map((x) => ({ ...x, url: unwrapBing(x.url) }))
        .filter((x) => /^https?:/.test(x.url) && !/bing\.com|duckduckgo\.com\/(lite)?\/?$/.test(x.url));
      if (results.length) return { engine: eng.name, query: q, results };
    } catch { /* next */ }
  }
  return { engine: 'none', query: q, results: [] };
}

/* ======================================================== the player === */
/* Caption tracks ship with a ready-to-use same-origin WebVTT url, so both the
   player capsule and /ytj consumers get playable subtitles without minting. */
function withVtt(payload, ctx) {
  if (!payload || !payload.captions) return payload;
  return {
    ...payload,
    captions: payload.captions.map((c) => ({
      ...c,
      vtt: PFX + 'vtt/' + encodeToken({ u: c.raw, t: ctx.tabId, s: ctx.session, g: ctx.gen, m: 's' }) + '/captions.vtt',
    })),
  };
}
async function servePlayer(req, res, ctx, t) {
  let payload;
  try {
    payload = await ytInspect('https://www.youtube.com/watch?v=' + t.v, ctx);
  } catch (e) {
    payload = { videoId: t.v, ok: false, reason: 'inspect threw: ' + (e.message || e) };
  }
  if (!payload) payload = { videoId: t.v, ok: false, reason: 'not a youtube video url' };
  payload = {
    ...withVtt(payload, ctx),
    ctx: { origin: ctx.origin, tab: ctx.tabId, key: ctx.key },
  };
  const body = `<div class="kicker">umbra player · ${payload.ok ? 'native stream' : 'fallback'}</div>
<h1>${esc(payload.title || payload.videoId)}</h1>
<p class="muted">${esc(payload.channel || payload.author || '')}${payload.duration ? ' · ' + fmtDur(payload.duration) : ''} · playability ${esc(payload.playability || '?')}</p>
${payload.ok
    ? `<p><span class="kicker" style="margin:0 8px 0 0">${payload.muxed.length} muxed</span>
       <span class="kicker" style="margin:0 8px 0 0">${payload.video.length} video tracks</span>
       <span class="kicker" style="margin:0 8px 0 0">${payload.audio.length} audio tracks</span>
       <span class="kicker" style="margin:0 8px 0 0">${payload.captions.length} caption track(s)</span></p>`
    : `<p class="warn">Upstream delivered formats with the stream URLs removed (${esc(payload.reason || 'blocked')}),
       which is Google's bot gate on this egress address. Umbra therefore falls back to the proxied embed document.
       On a residential egress IP the native path is used automatically.</p>`}
<div id="player" data-info='${ji(payload).replace(/'/g, '&#39;')}'></div>`;
  const script = fs.readFileSync(path.join(PUB, 'player.js'), 'utf8');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>umbra player · ${esc(payload.title || payload.videoId)}</title><style>${capsuleCss}
#player{margin-top:12px}
.ctl{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
select{font:inherit;font-size:12px;background:rgba(255,255,255,.07);color:#eaf1f8;border:1px solid rgba(255,255,255,.16);border-radius:9px;padding:7px 9px}
iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:12px;background:#000}
</style></head><body><main style="max-width:960px;width:100%">${body}</main>
<script>window.__UMBRA_CTX__=${ji({ umbraCtx: 1 })};<\/script><script>${script}<\/script></body></html>`;
  send(res, 200, { 'content-type': 'text/html; charset=utf-8', ...metaHeaders({ kind: 'player', videoId: t.v, ok: !!payload.ok }) }, html);
}
function fmtDur(s) {
  s = s | 0;
  const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, x = s % 60;
  return (h ? h + ':' : '') + (m < 10 && h ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
}

/* ============================================================ static ==== */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/shell.css': ['shell.css', 'text/css; charset=utf-8'],
  '/shell.js': ['shell.js', 'application/javascript; charset=utf-8'],
  '/~umbra/shim.js': ['shim.js', 'application/javascript; charset=utf-8'],
  '/~umbra/player.js': ['player.js', 'application/javascript; charset=utf-8'],
};
function serveStatic(res, key) {
  const [file, ct] = STATIC[key];
  let body;
  try { body = fs.readFileSync(path.join(PUB, file)); } catch { return notFound(res, key); }
  /* the shell document is the one thing that may host an uncloaked native tab,
     so it gets its own (looser frame-src) policy instead of the document one */
  const csp = key === '/' ? { 'content-security-policy': CSP_SHELL } : {};
  send(res, 200, { 'content-type': ct, 'cache-control': 'no-cache', 'x-umbra-shell': '1', ...csp }, body);
}
function notFound(res, url) {
  send(res, 404, { 'content-type': 'text/html; charset=utf-8' }, `<!doctype html><meta charset=utf-8><title>umbra · 404</title>
<body style="background:#0c1016;color:#dfe6f1;font:15px ui-sans-serif,system-ui;padding:44px;max-width:640px;margin:auto">
<div style="font:10px/1 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:#8fd6c8">umbra/1 · no route</div>
<h1 style="font-size:19px;margin:10px 0">Nothing is served outside <code style="color:#a8e3d6">/~umbra/</code></h1>
<p style="color:#8b9bb4">Requested <code>${esc(String(url).slice(0, 160))}</code>. The shell lives at <code>/</code>; wire resources are <code>/~umbra/&lt;mode&gt;/&lt;token&gt;</code>.</p>
</body>`);
}

/* ============================================================= router === */
const server = http.createServer(async (req, res) => {
  try { await route(req, res); } catch (e) {
    console.error('umbra route error:', (e && e.stack || e).split('\n').slice(0, 4).join(' | '));
    if (!res.headersSent) send(res, 500, { 'content-type': 'text/html; charset=utf-8' }, errPage({ tabId: '', session: '', policy: s0(), cookieJar: new CookieJar(), origin: originOf(req) }, req.url, 'origin fault: ' + (e.message || e), []));
    else try { res.end(); } catch {}
  }
});

function s0() { return { follow: 'all', referrer: 'origin', ephemeral: 1 }; }

async function route(req, res) {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { return notFound(res, req.url); }
  const p = decodeURIComponent(u.pathname);
  const origin = originOf(req);

  if (!p.startsWith(PFX)) {
    if (STATIC[p] && req.method === 'GET') return serveStatic(res, p);
    return notFound(res, p);
  }

  // origin assets live under the wire prefix so nothing else is reachable
  if (STATIC[p] && req.method === 'GET') return serveStatic(res, p);

  const sid = readSession(req);
  const seg = p.slice(PFX.length).split('/');
  const head = seg[0];
  /* A signed wire token names its own session: decodeToken already verified
     the HMAC, so a cookie-less request (blocked third-party cookies, curl) is
     still fully authorized by the bearer it carries. Unsigned routes (p, lab,
     doc, search) resolve through ?sid= / header / cookie instead. */
  let s = session(sid);
  if (!s && seg[1]) {
    try {
      const t0 = decodeToken(seg[1]);
      if (t0 && t0.s) s = session(t0.s);
    } catch {}
  }

  if (head === 'boot') {
    let id = sid && sessions.has(sid) ? sid : newSession();
    session(id);
    res.setHeader('set-cookie', `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
    return json(res, { session: id, protocol: 'umbra/1', modes: [...MODES], portal: PORTAL, ts: Date.now() });
  }
  if (!s) return fail(res, 401, 'no umbra session', 'GET /~umbra/boot first');

  const mkCtx = (url, mode, tabId) => {
    const t = tabId ? tabOf(s, tabId) : null;
    return {
      session: s.id, sessionObj: s, gen: s.gen,
      tabId: t ? t.id : 'shell', key: t ? t.key : '',
      mode, url, title: t ? t.title : '', policy: s.policy, cookieJar: s.cookieJar,
      origin, res, referrer: t && /^https?:/.test(t.url || '') ? t.url : null,
    };
  };

  /* ---- tab registry ---- */
  if (head === 'tab.new') {
    const id = newTab();
    const t = tabOf(s, id);
    t.url = u.searchParams.get('url') || PORTAL;
    return json(res, { tab: t.id, key: t.key, url: t.url });
  }
  if (head === 'tab.close') {
    const t = s.tabs.get(u.searchParams.get('t'));
    if (t) t.closed = Date.now();
    return json(res, { ok: 1 });
  }
  if (head === 'burn') {
    // bumping the generation invalidates every token minted before the burn,
    // so "panic" really does strand anything already handed to a frame
    s.gen = crypto.randomBytes(6).toString('hex');
    s.tabs.clear();
    s.cookieJar = new CookieJar();
    s.chain = [];
    s.bytes = 0; s.reqs = 0; s.held = 0;
    return json(res, { ok: 1, note: 'tab registry, cookie jar and hop log wiped from memory' });
  }
  if (head === 'policy') {
    const body = req.method === 'POST' ? JSON.parse((await readReq(req)).toString('utf8') || '{}') : {};
    if (['same-host', 'all', 'none'].includes(body.follow)) s.policy.follow = body.follow;
    if (['none', 'origin', 'full'].includes(body.referrer)) s.policy.referrer = body.referrer;
    if (typeof body.ephemeral === 'number') s.policy.ephemeral = body.ephemeral ? 1 : 0;
    return json(res, { policy: s.policy });
  }
  if (head === 'tabs') {
    return json(res, {
      tabs: [...s.tabs.values()].map((t) => ({ id: t.id, url: t.url, title: t.title })),
      stats: { reqs: s.reqs, bytes: s.bytes, held: s.held, cspBlocked: s.csp || 0, policy: s.policy },
    });
  }
  if (head === 'stats') {
    return json(res, { sessions: sessions.size, tabs: s.tabs.size, reqs: s.reqs, bytes: s.bytes, held: s.held, escapes: s.escapes, cspBlocked: s.csp || 0, cspLog: (s.cspLog || []).slice(-12), policy: s.policy, chain: s.chain.slice(-24) });
  }

  /* ---- cloak enforcement telemetry ----
     the browser posts here whenever a document inside Umbra tries to touch a
     real host directly and its own policy refuses. A non-empty count means a
     rewrite vector we have not covered exists — it is a self-audit channel. */
  if (head === 'csp-report') {
    let rep = {};
    try { rep = JSON.parse((await readReq(req)).toString('utf8') || '{}'); } catch { rep = {}; }
    const r = rep['csp-report'] || rep;
    s.csp = (s.csp || 0) + 1;
    s.cspLog = (s.cspLog || []).slice(-24);
    s.cspLog.push({ at: Date.now(), blocked: r['blocked-url'] || r['violated-url'] || '', doc: (r['document-uri'] || '').slice(0, 120), directive: r['violated-directive'] || '' });
    return send(res, 204, {}, null);
  }

  /* ---- mint ---- */
  if (head === 'mint') {
    const body = req.method === 'POST'
      ? JSON.parse((await readReq(req)).toString('utf8') || '{}')
      : Object.fromEntries(u.searchParams);
    const raw = String(body.url || '');
    /* umbra://player?v=<id> mints a capsule token directly: the player is
       Umbra-authored, so there is no upstream URL to resolve. */
    if (/^umbra:\/\/player(\/|\?|$)/i.test(raw)) {
      const vid = (/[?&]v=([\w-]{11})/.exec(raw) || [])[1] || '';
      if (!vid) return fail(res, 400, 'player needs a video id', 'umbra://player?v=<11 chars>');
      const tabId = body.tab ? tabOf(s, body.tab).id : 'shell';
      const tok = encodeToken({ u: 'umbra://player/youtube', v: vid, t: tabId, s: s.id, g: s.gen, m: 'c' });
      return json(res, { umbra: raw, href: PFX + 'c/' + tok + '/player.html' });
    }
    const abs = localAddressToUrl(raw) || resolveRef(raw, 'https://invalid.umbra/');
    const localHref = /^umbra:\/\/(portal|home|help|stats|protocol|lab|search)(\/|\?|$)/i.test(raw)
      ? localHrefFor(raw, tabOf(s, body.tab || 'shell').id, s.id) : null;
    if (localHref) return json(res, { umbra: raw, href: localHref });
    if (!abs) return fail(res, 400, 'unmappable address', raw.slice(0, 160));
    const tabId = body.tab ? tabOf(s, body.tab).id : null;
    const mode = MODES.has(body.mode) ? body.mode : 'd';
    return json(res, {
      umbra: toUmbra(abs),
      href: href({ tabId: tabId || 'shell', session: s.id, gen: s.gen, url: abs }, abs, mode),
    });
  }

  /* ---- search: HTML document mode (a results page is an Umbra doc) ---- */
  if (head === 'search' && (u.searchParams.get('format') === 'html' || /text\/html/.test(req.headers.accept || ''))) {
    const q = String(u.searchParams.get('q') || '').slice(0, 220);
    const out = q ? await webSearch(q) : { results: [], query: '', engine: 'none' };
    const ctx = mkCtx('https://search/', 'd', u.searchParams.get('t'));
    const rows = out.results.map((r) => `<li>
        <a href="${esc(toUmbra(r.url))}">${esc(r.title || displayHost(r.url))}</a>
        <div class="from">${esc(toUmbra(r.url))}</div>
        <p>${esc((r.snippet || '').slice(0, 240))}</p></li>`).join('');
    const html = `<header><span class="kicker">umbra · search</span><h1>${esc(q)}</h1>
      <p class="muted">${out.results.length} result${out.results.length === 1 ? '' : 's'} via ${esc(out.engine)} — retrieved by the Umbra origin, so your browser asked ${esc(displayHost('https://www.bing.com/'))} once and nothing else. Every link below opens in this tab strip.</p>
      <form method="get" action="umbra://search/"><input name="q" value="${esc(q)}" placeholder="search again"><button>search</button></form></header>
      ${rows ? `<ol class="res">${rows}</ol>` : '<p class="warn">nothing parseable came back. Full addresses work regardless — try <code>umbra://example.com</code>.</p>'}`;
    return send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...metaHeaders({ kind: 'search-doc', engine: out.engine, n: out.results.length }) },
      localDoc(ctx, html, 'https://search/?q=' + encodeURIComponent(q), '<style>' + DOC_CSS + '</style>', 'umbra://search/?q=' + encodeURIComponent(q)));
  }

  /* ---- search ---- */
  if (head === 'search') {
    const q = String(u.searchParams.get('q') || '').slice(0, 220);
    if (!q) return json(res, { results: [], query: '', engine: 'none' });
    const out = await webSearch(q);
    const ctx = mkCtx('https://search/', 's', null);
    out.results = out.results.map((r) => ({
      ...r,
      umbra: toUmbra(r.url),
      wire: href({ tabId: 'shell', session: s.id, gen: s.gen, url: r.url }, r.url, 'd'),
    }));
    return json(res, out, 200, metaHeaders({ kind: 'search', engine: out.engine, n: out.results.length }));
  }

  /* ---- youtube inspect ---- */
  if (head === 'ytj') {
    const vid = String(u.searchParams.get('v') || '').slice(0, 20);
    if (!/^[\w-]{11}$/.test(vid)) return fail(res, 400, 'bad video id', vid);
    const ctx = mkCtx('https://www.youtube.com/watch?v=' + vid, 'c', u.searchParams.get('t'));
    try { return json(res, withVtt(await ytInspect(ctx.url, ctx), ctx), 200, metaHeaders({ kind: 'ytj', videoId: vid })); }
    catch (e) { return fail(res, 502, 'inspect failed', String(e.message || e)); }
  }

  /* ---- capsule docs ---- */
  if (head === 'c') {
    const t = decodeToken(seg[1]);
    if (!t || t.s !== s.id || t.g !== s.gen) return fail(res, 403, 'stale or forged capsule token', 'signature, session or generation mismatch');
    const ctx = mkCtx(t.u, 'c', t.t);
    if (t.u === 'umbra://player/youtube') return servePlayer(req, res, ctx, t);
    return send(res, 404, { 'content-type': 'text/html; charset=utf-8' }, errPage(ctx, 'umbra://capsule/unknown', 'no such capsule', []));
  }

  /* ---- umbra-authored documents ---- */
  if (head === 'doc') {
    const which = seg[1] === 'home' || seg[1] === 'help' || seg[1] === 'stats' ? seg[1] : 'home';
    const ctx = mkCtx('https://portal.umbra/' + which, 'd', u.searchParams.get('t'));
    const bodyHtml = which === 'home' ? portalDoc() : which === 'help' ? helpDoc() : statsDoc(s);
    return send(res, 200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      ...metaHeaders({ kind: 'umbra-doc', doc: which, tab: ctx.tabId }),
    }, localDoc(ctx, bodyHtml, 'https://portal.umbra/' + which, '<style>' + DOC_CSS + '</style>',
      which === 'home' ? 'umbra://home/' : which === 'help' ? 'umbra://protocol' : 'umbra://stats'));
  }

  /* ---- lab fixtures, addressed without a token ---- */
  if (head === 'lab') {
    const key = /^[\w-]+$/.test(seg[1] || '') ? seg[1] : 'index';
    return serve(mkCtx('https://lab.umbra/' + key, 'd', u.searchParams.get('t')), req, res, { mode: 'd' });
  }

  /* ---- proxied documents and form posts ---- */
  if (head === 'd' || head === 'f') {
    const t = decodeToken(seg[1]);
    if (!t || t.s !== s.id || t.g !== s.gen) {
      const ctx = mkCtx('umbra://invalid', 'd', null);
      return send(res, 403, { 'content-type': 'text/html; charset=utf-8' },
        errPage(ctx, t ? t.u : 'unsigned', 'token failed signature or session check', []));
    }
    const ctx = mkCtx(t.u, head, t.t);
    const opts = { mode: head };
    if (head === 'f') {
      opts.body = await readReq(req);
      opts.ct = req.headers['content-type'] || 'application/x-www-form-urlencoded';
    }
    return serve(ctx, req, res, opts);
  }

  /* ---- other signed modes ---- */
  if (MODES.has(head)) {
    const t = decodeToken(seg[1]);
    if (!t || t.s !== s.id || t.g !== s.gen) return fail(res, 403, 'bad token', 'signature, session or generation mismatch');
    const ctx = mkCtx(t.u, head, t.t);
    const mopts = { mode: head, range: req.headers.range || null };
    if (req.method && !/^(GET|HEAD)$/i.test(req.method)) {
      /* fetch/XHR with a payload (JSON RPCs, uploads): the body rode the
         browser→origin leg untouched — forward it, don't drop it */
      try { mopts.body = await readReq(req, 64 * 1024 * 1024); }
      catch (e) { return fail(res, 413, 'request body too large', 'xhr payloads cap at 64 MB'); }
      mopts.method = req.method.toUpperCase();
      mopts.ct = req.headers['content-type'] || null;
    }
    return serve(ctx, req, res, mopts);
  }

  /* ---- caption conversion: json3 -> WebVTT, same-origin bytes ---- */
  if (head === 'vtt') {
    const t = decodeToken(seg[1]);
    if (!t || t.s !== s.id || t.g !== s.gen) return fail(res, 403, 'bad token', 'caption request refused');
    const ctx = mkCtx(t.u, 's', t.t);
    try {
      const up = await upstream(t.u, { headers: { accept: '*/*', cookie: s.cookieJar.header(t.u), 'user-agent': UA } });
      const raw = (await readBody(up.res, { limit: 8 * 1024 * 1024 })).toString('utf8');
      let vtt = 'WEBVTT\n\n';
      const asJson = (() => { try { return JSON.parse(raw); } catch { return null; } })();
      if (asJson && asJson.events) {
        for (const ev of asJson.events) {
          const segs = (ev.segs || []).map((x) => (x.utf8 || '').replace(/\n/g, ' ')).join('').trim();
          if (!segs || segs === '\n') continue;
          const st = (ev.tStartMs || 0) / 1000, du = (ev.dDurationMs || 1200) / 1000;
          vtt += tt(st) + ' --> ' + tt(st + du) + '\n' + segs + '\n\n';
        }
      } else {
        for (const line of raw.split('\n')) {
          const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?):?(.*)$/.exec(line.trim());
          if (m && m[3]) vtt += tt(+m[1]) + ' --> ' + tt(+m[1] + +m[2]) + '\n' + m[3].replace(/<[^>]*>/g, '') + '\n\n';
        }
      }
      return send(res, 200, { 'content-type': 'text/vtt; charset=utf-8', 'access-control-allow-origin': origin, ...metaHeaders({ kind: 'captions', url: t.u }) }, vtt);
    } catch (e) {
      return send(res, 200, { 'content-type': 'text/vtt; charset=utf-8' }, 'WEBVTT\n\n');
    }
  }

  /* ---- runtime mint from a live frame ---- */
  if (head === 'p') {
    const mode = MODES.has(seg[1]) ? seg[1] : 's';
    let raw = null;
    try { raw = Buffer.from(seg[2], 'base64url').toString('utf8'); } catch {}
    const tabId = u.searchParams.get('t');
    const key = u.searchParams.get('k');
    const t = tabId ? s.tabs.get(tabId) : null;
    if (!raw || !t || t.key !== key) return fail(res, 403, 'frame key rejected', 'runtime mint refused');
    let abs = raw;
    const echo = u.searchParams.get('echo');
    if (echo) {
      try { abs = new URL(decodeURIComponent(echo) + (u.search || ''), raw.replace(/[^/]*$/, '')).href; } catch {}
    }
    const ctx = mkCtx(abs, mode, tabId);
    ctx.referrer = /^https?:/.test(t.url || '') ? t.url : null;
    const popts = { mode, range: req.headers.range || null };
    if (req.method && !/^(GET|HEAD)$/i.test(req.method)) {
      try { popts.body = await readReq(req, 64 * 1024 * 1024); }
      catch (e) { return fail(res, 413, 'request body too large', 'xhr payloads cap at 64 MB'); }
      popts.method = req.method.toUpperCase();
      popts.ct = req.headers['content-type'] || null;
    }
    return serve(ctx, req, res, popts);
  }

  return notFound(res, p);
}

/* ------------------------------------------- websocket byte tunnel ----- */
server.on('upgrade', (req, socket) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith(PFX + 'w/')) return socket.destroy();
    const raw = Buffer.from(u.pathname.slice((PFX + 'w/').length).split('/')[0], 'base64url').toString('utf8');
    const target = new URL(raw);
    if (!/^wss?:$/.test(target.protocol)) return socket.destroy();
    const s = session(readSession(req));
    const tab = u.searchParams.get('t');
    if (!s || !tab || tabOf(s, tab).key !== u.searchParams.get('k')) return socket.destroy();
    const secure = target.protocol === 'wss:';
    const up = (secure ? tls : net).connect(
      { host: target.hostname, port: target.port || (secure ? 443 : 80), servername: secure ? target.hostname : undefined, rejectUnauthorized: false },
      () => {
        const keep = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];
        const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, `Origin: ${target.origin}`];
        for (const k of keep) if (req.headers[k]) lines.push(`${k}: ${req.headers[k]}`);
        const ck = s.cookieJar.header(target.href.replace(/^ws/, 'http'));
        if (ck) lines.push('Cookie: ' + ck);
        lines.push('Connection: Upgrade', 'Upgrade: websocket', '', '');
        up.write(lines.join('\r\n'));
        up.pipe(socket);
        socket.pipe(up);
      },
    );
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  } catch {
    socket.destroy();
  }
});
server.listen(PORT, HOST, () => {
  console.log(`umbra/1 origin listening on http://${HOST}:${PORT}  ·  shell at /  ·  wire at ${PFX}<mode>/<token>`);
  console.log(`  modes: ${[...MODES].join(' ')}   session store: memory   egress UA: ${UA.slice(0, 38)}…`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('uncaughtException', (e) => console.error('umbra:', e && e.stack));
process.on('unhandledRejection', (e) => console.error('umbra:', e && e.stack && e.stack.split('\n').slice(0, 3).join(' | ')));
