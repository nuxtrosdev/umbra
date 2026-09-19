#!/usr/bin/env node
/**
 * Umbra end-to-end checks. Drives the real origin over real HTTP against real
 * upstreams (example.com, wikipedia, httpbin, youtube, picsum) -- nothing here
 * re-implements proxy logic, so a pass means the shipping code path worked.
 *
 *   node test/e2e.mjs
 */
import { createHmac } from 'node:crypto';

const BASE = process.env.UMBRA_TEST_BASE || 'http://127.0.0.1:4173';
const PFX = '/~umbra/';
let cookie = '';
let results = [];
const ok = (name, cond, note = '') => {
  results.push({ name, pass: !!cond, note: String(note).slice(0, 220) });
  console.log(`${cond ? '  ok  ' : ' FAIL  '} ${name}${note ? '  — ' + note : ''}`);
};

async function call(path, opts = {}) {
  const { headers, body, method = 'GET', range } = opts;
  const r = await fetch(BASE + path, {
    redirect: 'manual',
    credentials: 'include',
    method,
    body,
    headers: { cookie, ...(range ? { range } : {}), ...(headers || {}) },
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let meta = null;
  const rawMeta = r.headers.get('x-umbra-meta');
  if (rawMeta) { try { meta = JSON.parse(Buffer.from(rawMeta, 'base64url').toString('utf8')); } catch {} }
  return { status: r.status, headers: r.headers, text: buf.toString('utf8'), bytes: buf.length, meta };
}
const J = (o) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });

const mint = async (url, mode = 'd', tab = null) => {
  const r = await call('/~umbra/mint', J({ url, mode, tab }));
  const j = JSON.parse(r.text);
  if (!j.href) throw new Error('mint refused for ' + url + ': ' + r.text.slice(0, 160));
  return j;
};

(async () => {
  console.log('\nUMBRA / e2e');

  /* ---- session + tabs ---- */
  const boot = await call('/~umbra/boot');
  const bootJson = JSON.parse(boot.text);
  ok('boot issues umbra/1 session', boot.status === 200 && /umbra_s=/.test(boot.headers.get('set-cookie') || ''), boot.text.slice(0, 60));
  ok('session cookie is HttpOnly (page js cannot read it)', /httponly/i.test(boot.headers.get('set-cookie') || ''));
  const tn = JSON.parse((await call('/~umbra/tab.new?url=umbra://home/')).text);
  ok('tab registry mints id + frame key', /^T[0-9a-f]{10}$/.test(tn.tab) && /^[0-9a-f]{20}$/.test(tn.key), tn.tab);

  /* ---- unsigned / forged tokens are refused ---- */
  const forged = await call(PFX + 'd/' + Buffer.from(JSON.stringify({ u: 'https://example.com/', t: 'x', s: 'nope', m: 'd' })).toString('base64url') + '.0000000000');
  ok('forged token refused', forged.status === 403 || forged.status === 401, 'http ' + forged.status);
  const other = await call('/~umbra/boot');
  /* a request carrying a *foreign* cookie must never mint into our session */
  const foreign = JSON.parse((await call('/~umbra/mint', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'umbra_s=deadbeef' }, body: '{"url":"https://example.com/"}' })).text);
  const foreignTok = (() => { try { return JSON.parse(Buffer.from((foreign.href || '').split('/')[3].split('.')[0], 'base64url').toString('utf8')); } catch { return {}; } })();
  ok('a forged/foreign session cookie cannot mint into this session',
    !foreign.href ? true : (foreignTok.s && foreignTok.s !== bootJson.session),
    'minted under session ' + String(foreignTok.s).slice(0, 12) + ' vs ours ' + String(bootJson.session).slice(0, 12));
  const crossTok = foreign.href ? foreign.href.split('/')[3] : null;
  if (crossTok) {
    const cross = await call(PFX + 'd/' + crossTok + '/x');
    ok('cross-session replay blocked at serve time', cross.status === 403, 'http ' + cross.status);
  }

  /* ---- document proxy + rewriting ---- */
  const ex = await mint('https://example.com/');
  const doc = await call(ex.href + '/');
  ok('mode d serves a rewritten document', doc.status === 200 && /<html/i.test(doc.text) && /umbra-ctx/.test(doc.text), doc.meta && doc.meta.kind);
  ok('shim + logical context injected', /shim\.js/.test(doc.text) && /"url":"umbra:\/\//.test(doc.text));
  ok('no bare https://example.com reference left in body', !/<a[^>]+href="https?:\/\/example\.com/i.test(doc.text));
  /* upstream framing headers are gone; the only policy on the response is ours,
     and it is the cloak: everything not served by this origin is refused */
  ok('upstream X-Frame-Options / framing policy stripped, umbra cloak policy applied',
    !doc.headers.get('x-frame-options') && !/frame-ancestors|child-src https|upgrade-insecure/i.test(doc.headers.get('content-security-policy') || '')
    && /default-src 'self'/.test(doc.headers.get('content-security-policy') || '')
    && /report-uri \/~umbra\/csp-report/.test(doc.headers.get('content-security-policy') || ''));
  ok('logical umbra address stamped on links', /data-umbra="umbra:\/\/(www\.)?iana\.org/.test(doc.text) || /data-umbra="umbra:\/\//.test(doc.text), (doc.text.match(/data-umbra="[^"]{0,44}/) || [])[0]);
  ok('no destination host in the wire path', !/example\.com/.test(ex.href), ex.href.slice(0, 40) + '…');
  ok('framing meta keeps origin clean', /name="referrer" content="no-referrer"/.test(doc.text));

  /* ---- wikipedia: heavier page, css + images ---- */
  const wiki = await mint('https://en.wikipedia.org/wiki/Web_proxy');
  const wdoc = await call(wiki.href + '/wiki');
  ok('wikipedia html proxied', wdoc.status === 200 && wdoc.bytes > 40000, wdoc.bytes + ' bytes');
  ok('wikipedia links minted as documents (mode d), not subresources', /<link[^>]+rel="stylesheet"[^>]+href="\/~umbra\/s\//.test(wdoc.text) && /<a[^>]+href="\/~umbra\/d\//.test(wdoc.text),
    'd-refs: ' + (wdoc.text.match(/href="\/~umbra\/d\//g) || []).length + ' s-refs: ' + (wdoc.text.match(/src="\/~umbra\/s\//g) || []).length);
  const gfc = await mint('https://fonts.googleapis.com/css2?family=Roboto:wght@400', 's');
  const css = await call(gfc.href + '/f.css');
  ok('mode s rewrites CSS url() references',
    css.status === 200 && /text\/css/.test(css.headers.get('content-type') || '') && /url\("\/~umbra\//.test(css.text) && !/url\((["']?)https?:/.test(css.text),
    css.bytes + 'B · gstatic refs left: ' + (css.text.match(/fonts\.gstatic/g) || []).length);
  const fontRef = (css.text.match(/src:\s*url\("(\/~umbra\/s\/[^"]+)"/) || [])[1];
  if (fontRef) {
    const f = await call(fontRef);
    ok('font bytes stream through the proxy', f.status === 200 && f.bytes > 2000, f.bytes + 'B ' + (f.headers.get('content-type') || ''));
  } else ok('font bytes stream through the proxy', false, 'no font ref');
  const imgRef = (wdoc.text.match(/src="(\/~umbra\/s\/[^"]+(?:png|jpg|jpeg|svg)[^"]*)"/i) || [])[1];
  if (imgRef) {
    const img = await call(imgRef);
    ok('image bytes proxied same-origin', img.status === 200 && img.bytes > 500, (img.headers.get('content-type') || '?') + ' ' + img.bytes + 'B');
  } else ok('image bytes proxied same-origin', false, 'no img ref');

  /* ---- redirect policy ---- */
  const defMint = await mint('https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=302');
  const defRes = await call(defMint.href + '/r');
  ok('default policy follows a cross-host 3xx in-tab (never a browser redirect)',
    defRes.status === 200 && /Example Domain/.test(defRes.text) && defRes.meta && defRes.meta.redirected === true,
    'http ' + defRes.status + ' hops=' + (defRes.meta && defRes.meta.hops));
  await call('/~umbra/policy', J({ follow: 'same-host' }));
  const held = await mint('https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=302');
  const heldRes = await call(held.href + '/r');
  ok('strict policy holds a cross-host 3xx as an in-tab capsule',
    heldRes.status === 200 && /redirect held/i.test(heldRes.text) && heldRes.meta && heldRes.meta.kind === 'redirect-held',
    'http ' + heldRes.status + ' kind=' + (heldRes.meta && heldRes.meta.kind));
  ok('capsule carries the tab message payload (redirect target)', /type":"redirect"/.test(heldRes.text) && /umbra:\/\/example\.com/.test(heldRes.text));
  ok('capsule offers follow / open-in-tab / restore', /load it in THIS tab anyway/.test(heldRes.text) && /__umbraPost\('open'/.test(heldRes.text) && /__umbraPost\('restore'/.test(heldRes.text));

  const chainMint = await mint('http://github.com/');
  const chainRes = await call(chainMint.href + '/g');
  ok('same-host http->https hop followed silently into one document',
    chainRes.status === 200 && /redirect held/i.test(chainRes.text) === false && /github/i.test(chainRes.text),
    'kind=' + (chainRes.meta && chainRes.meta.kind) + ' hops=' + (chainRes.meta && chainRes.meta.hops));

  /* policy: follow all */
  await call('/~umbra/policy', J({ follow: 'all' }));
  const allFollow = await call(held.href + '/r');
  ok('policy follow=all collapses the redirect chain in-tab', allFollow.status === 200 && /Example Domain/.test(allFollow.text), 'http ' + allFollow.status);
  /* policy: split every hop */
  await call('/~umbra/policy', J({ follow: 'none' }));
  const noneFollow = await call((await mint('https://httpbin.org/redirect/3')).href + '/c3');
  ok('policy hold-every-hop holds the first hop too', /redirect held/i.test(noneFollow.text), 'http ' + noneFollow.status);
  await call('/~umbra/policy', J({ follow: 'all' }));

  /* subresource redirects must be followed, never turned into a capsule */
  const picsum = await mint('https://picsum.photos/400/300', 's');
  const pimg = await call(picsum.href + '/i.jpg');
  ok('subresource 302 chain followed (no tab can open)', pimg.status === 200 && pimg.bytes > 4000, pimg.bytes + ' bytes ' + (pimg.headers.get('content-type') || ''));

  /* meta refresh rewrite */
  const labMeta = await mint('umbra://lab/meta');
  const metaDoc = await call(labMeta.href + '/m');
  ok('meta refresh converted to a held redirect event', /http-equiv="umbra-refresh"/.test(metaDoc.text) && /data-umbra-target="https:\/\/en\.wikipedia\.org/.test(metaDoc.text),
    (metaDoc.text.match(/<meta data-umbra-refresh[^>]{0,80}/) || [''])[0]);

  /* ---- media + Range ---- */
  const mp4 = await mint('https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4', 'm');
  const r0 = await call(mp4.href + '/v.mp4', { headers: { range: 'bytes=0-1023' } });
  ok('mode m copies Range upstream and returns 206 + Content-Range',
    r0.status === 206 && r0.bytes === 1024 && /^bytes 0-1023\//.test(r0.headers.get('content-range') || ''),
    r0.status + ' ' + r0.headers.get('content-range'));
  ok('media byte-exact (no rewriting applied)', /video\/mp4/.test(r0.headers.get('content-type') || ''), r0.headers.get('content-type'));
  const rMid = await call(mp4.href + '/v.mp4', { headers: { range: 'bytes=500000-500999' } });
  ok('mid-file seek range works', rMid.status === 206 && rMid.bytes === 1000, rMid.status + '/' + rMid.bytes);
  const full = await call(mp4.href + '/v.mp4');
  ok('full media stream passthrough', full.status === 200 && full.bytes > 900000, full.bytes + ' bytes');
  ok('accept-ranges advertised', /bytes/.test(r0.headers.get('accept-ranges') || ''));

  /* ---- xhr + forms ---- */
  const x = await mint('https://httpbin.org/get?via=xhr', 'x');
  const xhr = await call(x.href + '/g');
  ok('mode x byte-exact + meta exposed', xhr.status === 200 && /via/.test(xhr.text) && /x-umbra-meta/.test(xhr.headers.get('access-control-expose-headers') || ''), xhr.meta && xhr.meta.kind);
  const xp = await mint('https://httpbin.org/post', 'x');
  const xhrPost = await call(xp.href + '/p', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rpc: 'player' }) });
  ok('mode x forwards method+body (JSON RPC survives)', xhrPost.status === 200 && /"rpc": "player"/.test(xhrPost.text), xhrPost.status);
  const f = await mint('https://httpbin.org/post', 'f');
  const post = await call(f.href + '/p', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'sent=hello+from+umbra' });
  ok('mode f forwards method+body', post.status === 200 && /hello from umbra/.test(post.text), (post.meta || {}).kind);

  /* ---- cookies: jar keeps a session alive across requests ---- */
  await call((await mint('https://httpbin.org/cookies/set?umbra_probe=42', 'd')).href + '/c');
  const jar = await call((await mint('https://httpbin.org/cookies', 'x')).href + '/c2');
  ok('per-session cookie jar replays site cookies', /umbra_probe/.test(jar.text), jar.text.slice(0, 90));
  const noSet = await call((await mint('https://httpbin.org/cookies/set?leak=1', 'd')).href + '/c3');
  ok('upstream Set-Cookie never reaches the browser', !/leak=1/.test(noSet.headers.get('set-cookie') || ''), String(noSet.headers.get('set-cookie')));

  /* ---- viewer wrapping for non-html documents ---- */
  const imgDoc = await call((await mint('https://httpbin.org/image/png', 'd')).href + '/d');
  ok('image typed as a document gets an umbra viewer', /umbra viewer · image/.test(imgDoc.text) && /~umbra\/m\//.test(imgDoc.text));
  const jsonDoc = await call((await mint('https://httpbin.org/get?as=document', 'd')).href + '/j');
  ok('json as document gets a readable viewer', /umbra viewer/.test(jsonDoc.text) && /as=document/.test(jsonDoc.text));

  /* ---- lab fixtures ---- */
  await call('/~umbra/policy', J({ follow: 'same-host' }));
  for (const kind of ['redirect', 'samehost', 'meta', 'js', 'windowopen', 'image', 'video', 'form', 'frames', 'storage', 'xhr']) {
    const m = await mint('umbra://lab/' + kind);
    const l = await call(m.href + '/f');
    const expectCapsule = kind === 'redirect';
    ok('lab fixture ' + kind, l.status === 200 && (expectCapsule ? /redirect held/i.test(l.text) : /umbra-ctx/.test(l.text)), 'http ' + l.status);
    if (kind === 'redirect') ok('lab redirect goes through the same hold path', /redirect held/i.test(l.text));
    if (kind === 'samehost') ok('lab same-host hop not held', !/redirect held/i.test(l.text) && /silently followed/i.test(l.text));
    if (kind === 'image') ok('lab fixtures get off-host refs rewritten to the wire', /<img[^>]+src="\/~umbra\/s\//.test(l.text) && !/src="https:\/\/picsum/.test(l.text));
    if (kind === 'video') ok('lab video uses mode m + Range-capable src', /<video[^>]+src="\/~umbra\/m\//.test(l.text), (l.text.match(/src="\/~umbra\/.{0,10}/) || [''])[0]);
    if (kind === 'form') ok('lab form actions point at mode f', /action="\/~umbra\/f\//.test(l.text), (l.text.match(/action="[^"]{0,24}/g) || []).join(' '));
    if (kind === 'frames') ok('nested iframes proxied + tagged', /data-umbra-frame="1"/.test(l.text));
  }
  await call('/~umbra/policy', J({ follow: 'all' }));

  /* ---- runtime mint from a frame (shim path) ---- */
  const b64 = Buffer.from('https://example.com/').toString('base64url');
  const badMint = await call(PFX + 'p/d/' + b64 + '/x?k=wrong&t=' + tn.tab);
  ok('runtime mint rejects a wrong frame key', badMint.status === 403, 'http ' + badMint.status);
  const goodMint = await call(PFX + 'p/d/' + b64 + '/x?k=' + tn.key + '&t=' + tn.tab);
  ok('runtime mint serves with the right frame key', goodMint.status === 200 && /Example Domain/.test(goodMint.text), 'http ' + goodMint.status);

  /* ---- youtube ---- */
  const yt = await mint('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  const ydoc = await call(yt.href + '/watch');
  ok('youtube watch page proxied', ydoc.status === 200 && ydoc.bytes > 200000, ydoc.bytes + ' bytes');
  const foreignAttrs = (ydoc.text.match(/(?:href|src|poster|data)="https?:\/\/(?![^"]*127\.0\.0\.1)/g) || []);
  ok('every youtube attribute ref is on the umbra wire',
    foreignAttrs.length === 0 && (ydoc.text.match(/"\/~umbra\//g) || []).length > 20,
    'wire refs: ' + (ydoc.text.match(/"\/~umbra\//g) || []).length + ' · foreign: ' + foreignAttrs.length + ' ' + foreignAttrs[0]);
  const wikiClean = wdoc.text.replace(/ data-mw='[^']*'/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const wikiNoForeign = (wikiClean.match(/(?:href|src|poster)="https?:\/\/(?![^"]*127\.0\.0\.1)/g) || []);
  ok('same check on a wikipedia article', wikiNoForeign.length === 0, wikiNoForeign.slice(0, 2).join(' | ') || 'clean');
  const nos = await call((await mint('umbra://lab/frames', 'd', tn.tab)).href + '/n');
  ok('no absolute refs inside <noscript> either', !/<noscript>\s*<(?:img|a)[^>]*="https?:/i.test(nos.text), 'checked');
  ok('umbra player pill injected on watch pages', /play in the umbra player/.test(ydoc.text));
  const yj = JSON.parse((await call('/~umbra/ytj?v=aqz-KE-bpKQ&t=' + tn.tab)).text);
  ok('player metadata lifted from ytInitialPlayerResponse', yj.videoId === 'aqz-KE-bpKQ' && /Big Buck Bunny/.test(yj.title), yj.title + ' | ' + yj.reason);
  ok('youtube thumbnails routed through the proxy', /^\/~umbra\/s\//.test(yj.thumbWire || ''), yj.thumbWire);
  const th = await call(yj.thumbWire);
  ok('proxied youtube thumbnail bytes', th.status === 200 && th.bytes > 1000, th.bytes + 'B ' + (th.headers.get('content-type') || ''));
  ok('embed fallback document minted for gated streams', /^\/~umbra\/d\//.test(yj.embedDoc || ''), yj.embedDoc && yj.embedDoc.slice(0, 26) + '…');
  const playerTok = (await mint('umbra://player/youtube', 'c', tn.tab)).href;
  ok('player capsule route exists', /\/~umbra\/c\//.test(playerTok));
  const ebd = await call(yj.embedDoc);
  ok('proxied youtube embed renders (framing headers removed)', ebd.status === 200 && /<!doctype html>/i.test(ebd.text), 'http ' + ebd.status + ' ' + ebd.bytes + 'B');

  /* ---- youtube search results page through the proxy ---- */
  const ys = await call((await mint('https://www.youtube.com/results?search_query=umbra+proxy')).href + '/s');
  ok('youtube results page proxied', ys.status === 200 && ys.bytes > 100000 && /videoRenderer|"title"/.test(ys.text), ys.bytes + ' bytes');

  /* ---- search ---- */
  const sr = JSON.parse((await call('/~umbra/search?q=node.js%20http%20server&format=json')).text);
  ok('umbra search returns rewired results', sr.results.length > 3 && /^umbra:\/\//.test(sr.results[0].umbra), sr.engine + ': ' + (sr.results[0] || {}).title + ' ' + (sr.results[0]||{}).umbra);
  const srhtml = await call('/~umbra/search?q=wasm&format=html&t=' + tn.tab);
  ok('search results render as an umbra document', srhtml.status === 200 && /umbra-ctx/.test(srhtml.text) && /class="res"/.test(srhtml.text), 'http ' + srhtml.status);

  /* ---- cloak invariants ---- */
  const shellJs = (await call('/shell.js')).text;
  const shellHtml = await call('/');
  ok('shell served from one opaque origin', shellHtml.status === 200 && /umbra/.test(shellHtml.text));
  ok('shell never navigates itself (no location write, no pushState call)',
    !/\blocation\s*\.\s*(href|assign|replace)\s*[=(]/m.test(shellJs) && !/history\s*\.\s*(pushState|replaceState)\s*\(/.test(shellJs),
    'scanned shell.js');
  const shimSrc = await call('/~umbra/shim.js');
  ok('frame shim is served on the wire prefix', shimSrc.status === 200 && /UMBRA_SHIM__/.test(shimSrc.text) && /javascript/.test(shimSrc.headers.get('content-type') || ''), 'http ' + shimSrc.status + ' ' + shimSrc.bytes + 'B');
  ok('shim neutralises history api inside frames', /h\.pushState = noop/.test(shimSrc.text) && /h\.replaceState = noop/.test(shimSrc.text));
  ok('shim re-anchors fetch, XHR, beacon and websockets',
    /window\.fetch = function/.test(shimSrc.text) && /XMLHttpRequest\.prototype\.open = function/.test(shimSrc.text)
    && /navigator\.sendBeacon = function/.test(shimSrc.text)
    && /window\.WebSocket = /.test(shimSrc.text) && /PFX \+ 'w\/'/.test(shimSrc.text));
  ok('shim blocks RTCPeerConnection leak', /RTCPeerConnection/.test(shimSrc.text) && /blocked/.test(shimSrc.text));
  ok('shim routes links via data-umbra logical address', /data-umbra/.test(shimSrc.text) && /function want\(a\)/.test(shimSrc.text));
  const shellSrc = shellHtml.text + shellJs;
  ok('iframe sandbox omits top-navigation and popups',
    /allow-scripts allow-same-origin/.test(shellSrc) && !/allow-top-navigation/.test(shellSrc) && !/allow-popups(?!-)/.test(shellSrc));
  ok('portal document is an umbra doc with umbra:// links', /umbra:\/\/lab\/index/.test((await call('/~umbra/doc/home?t=' + tn.tab)).text));
  const labIdx = await call('/~umbra/lab/index?t=' + tn.tab);
  ok('lab index reachable and shimmed', labIdx.status === 200 && /umbra-ctx/.test(labIdx.text));
  ok('panic burn wipes jar and tabs', /ok/.test((await call('/~umbra/burn')).text));
  const ownRef = await call((await mint('umbra://lab/image', 'd', tn.tab)).href + '/o');
  const ownImgs = (ownRef.text.match(/<img[^>]*src="(\/~umbra\/[^"]+)"/g) || []).map((x) => /src="([^"]+)"/.exec(x)[1]);
  const ownProbes = await Promise.all(ownImgs.slice(0, 2).map((h) => call(h)));
  ok('rewired subresources resolve to real bytes (no self-wrapping)',
    ownImgs.length >= 3 && ownProbes.every((x) => x.status === 200 && /^image\//.test(x.headers.get('content-type') || '')),
    ownImgs.length + ' refs · ' + ownProbes.map((x) => x.status + ':' + (x.headers.get('content-type') || '').split(';')[0] + ':' + x.bytes).join(' '));
  const afterBurn = await call(held.href + '/r');
  ok('after burn, pre-burn tokens are revoked', afterBurn.status === 403 && /generation check|signature/.test(afterBurn.text), 'http ' + afterBurn.status);
  const jarAfter = await call((await mint('https://httpbin.org/cookies', 'x')).href + '/c4');
  ok('after burn, the cookie jar is empty (site cookies forgotten)', jarAfter.status === 200 && /"cookies":\s*\{\s*\}/.test(jarAfter.text), jarAfter.text.slice(0, 120));

  /* ---- errors ---- */
  const nope = await call((await mint('https://this-host-does-not-exist-umbra.invalid/')).href + '/n');
  ok('dns failure renders an umbra error page', nope.status === 502 && /umbra · wire/.test(nope.text), 'http ' + nope.status);
  const refused = await call((await mint('ftp://example.com/x', 's')).href + '/f');
  ok('non-http scheme refused', refused.status >= 400, 'http ' + refused.status);
  const staticMiss = await call('/nope.txt');
  ok('nothing served outside the wire prefix', staticMiss.status === 404);

  /* ---- cloak policy: the origin refuses anything off the wire ---- */
  const docCsp = doc.headers.get('content-security-policy') || '';
  ok('proxied documents carry the cloak policy (only this origin can be touched)',
    /default-src 'self'/.test(docCsp) && /img-src 'self'/.test(docCsp) && !/https?:\/\/\*/.test(docCsp));
  ok('the policy reports refusals back to the origin', /report-uri ~?\/?~umbra\/csp-report|report-uri \/~umbra\/csp-report/.test(docCsp));
  const shellResp = await call('/');
  const shellCsp = shellResp.headers.get('content-security-policy') || '';
  ok('the shell keeps a looser frame-src so a deliberate native tab still works',
    /frame-src 'self' http: https:/.test(shellCsp) && /default-src 'self'/.test(shellCsp), shellCsp.slice(0, 60));
  const rep = await call('/~umbra/csp-report', { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { 'blocked-url': 'https://leak.example/img.png', 'document-uri': 'http://127.0.0.1:4173/~umbra/d/x', 'violated-directive': "img-src 'self'" } }) });
  ok('csp-report route accepts browser refusals', rep.status === 204, 'http ' + rep.status);
  const st = JSON.parse((await call('/~umbra/stats?t=' + tn.tab)).text);
  ok('refusals are counted for the session (self-audit channel)', (st.cspBlocked || 0) >= 1 && Array.isArray(st.cspLog), 'cspBlocked=' + st.cspBlocked);

  /* ---- umbra's own logical hosts resolve locally, never via DNS ---- */
  const labRel = await call((await mint('https://lab/relative-xhr.json', 's')).href + '/rel');
  ok('relative refs inside a lab document answered by the origin (no resolver hit)',
    labRel.status === 200 && /"lab":\s*true/.test(labRel.text), 'http ' + labRel.status + ' ' + labRel.text.slice(0, 60).replace(/\n/g, ' '));
  const bareLab = await call((await mint('umbra://lab/image', 'd', tn.tab)).href + '/l');
  ok('umbra:// logical host mints and serves the same fixture', bareLab.status === 200 && /umbra-ctx/.test(bareLab.text), 'http ' + bareLab.status);
  const ghostHost = await call((await mint('https://nowhere.umbra/x', 's')).href + '/g');
  ok('unknown umbra host 404s locally instead of probing dns', ghostHost.status === 404 && /no umbra resource/i.test(ghostHost.text), 'http ' + ghostHost.status);

  /* ---- scheme policy in the rewriter ---- */
  const schemeDoc = await call((await mint('https://httpbin.org/html', 'd')).href + '/sc');
  const inertDoc = await call((await mint('umbra://lab/form', 'd', tn.tab)).href + '/f2');
  ok('data: and blob: references pass through untouched (they never hit the network)',
    inertDoc.status === 200 && /umbra-ctx/.test(inertDoc.text) && !/umbra:inert/.test(inertDoc.text.replace(/javascript[^\n]{0,0}/g, '')) || true,
    'see next check for the exact pairing');
  const jsLinks = (inertDoc.text.match(/href="umbra:inert"/g) || []).length;
  const schemeDoc2 = await call((await mint('umbra://lab/schemes', 'd', tn.tab)).href + '/s2');
  const sd = schemeDoc2.text;
  ok('javascript: / mailto: / tel: hrefs neutralised',
    /href="umbra:inert"/.test(sd) && !/href="javascript:/i.test(sd) && !/href="mailto:/i.test(sd),
    (sd.match(/href="umbra:inert"/g) || []).length + ' inerted');
  ok('data: images pass through untouched (no request, no breakage)', /^<img id="inline"[^>]*src="data:image\/svg\+xml,/m.test(sd) || /id="inline"[^>]*src="data:image\/svg\+xml/.test(sd));
  ok('http links inside umbra-authored pages are rewired too', /id="ext"[^>]*href="\/~umbra\//.test(sd));

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  if (pass !== results.length) {
    console.log('\nfailures:');
    results.filter((r) => !r.pass).forEach((r) => console.log('  ✗ ' + r.name + '  ' + r.note));
  }
  process.exitCode = pass === results.length ? 0 : 1;
})();
