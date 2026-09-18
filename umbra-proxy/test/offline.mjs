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
  ok('inspect lifts streamingData from the watch page', ytj.videoId === VID && ytj.ok === true && ytj.title === 'Mock Video Title', ytj.title + ' muxed=' + ytj.muxed?.length);
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
