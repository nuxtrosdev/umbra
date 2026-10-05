#!/usr/bin/env node
/**
 * Mock clear-web upstream for offline verification.
 *
 * The full e2e suite needs the real internet (example.com, wikipedia,
 * httpbin, youtube, …). This server stands in for all of them on loopback so
 * `test/offline.mjs` can prove the shipping proxy pipeline — documents,
 * rewriting, redirects, media Range, cookies, forms, YouTube inspect, the
 * player — with zero network access.
 *
 * Two hostnames, one server: 127.0.0.1 and localhost resolve to the same
 * listener but are *different hosts* for the redirect policy, which is what
 * lets the held-vs-followed split be exercised locally.
 *
 *   node umbra-proxy/test/mock-upstream.mjs [port]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 4181);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
// genuinely decodable 2x2 JPEG (ImageMagick xc:red, q75): the browser suite
// asserts naturalWidth > 0, so SOI+EOI alone is not enough here.
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCLAGVxf//Z',
  'base64',
);
// 256 KiB of deterministic bytes so Range slices are verifiable
const CLIP = Buffer.alloc(256 * 1024);
for (let i = 0; i < CLIP.length; i++) CLIP[i] = i % 251;

// 1s 440Hz sine, 8kHz mono 16-bit PCM WAV — genuinely decodable, so the
// browser suite can prove media playback end to end without any codec.
function toneWav() {
  const rate = 8000, n = rate, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const TONE = toneWav();

const VID = 'dQw4w9WgXcQ';
const hostOf = (req) => req.headers.host || `127.0.0.1:${PORT}`;
const baseOf = (req) => `http://${hostOf(req)}`;

function playerResponse(base) {
  return {
    playabilityStatus: { status: 'OK' },
    streamingData: {
      expiresInSeconds: '3600',
      formats: [
        {
          itag: 18, mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          url: `${base}/v18.mp4`, quality: 'medium', qualityLabel: '360p',
          width: 640, height: 360, fps: 24, contentLength: String(CLIP.length), bitrate: 500000,
        },
      ],
      adaptiveFormats: [
        {
          itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"',
          url: `${base}/v137.mp4`, quality: 'hd1080', qualityLabel: '1080p',
          width: 1920, height: 1080, fps: 30, contentLength: String(CLIP.length), bitrate: 2000000,
        },
        {
          itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          url: `${base}/a140.m4a`, quality: 'tiny', bitrate: 128000,
          contentLength: '65536', audioTrack: { displayName: 'English' },
        },
      ],
    },
    videoDetails: {
      videoId: VID, title: 'Mock Video Title', author: 'Mock Channel',
      lengthSeconds: '212', viewCount: '12345', isLiveContent: false,
      thumbnail: { thumbnails: [{ url: `${base}/thumb.jpg`, width: 120 }, { url: `${base}/thumb.jpg`, width: 640 }] },
    },
    microformat: {
      playerMicroformatRenderer: {
        title: 'Mock Video Title', lengthSeconds: '212',
        channel: { name: 'Mock Channel', canonicalBaseUrl: '/c/mock' },
      },
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: `${base}/cap-en`, languageCode: 'en', name: { simpleText: 'English' } },
        ],
      },
    },
  };
}

function indexDoc(base) {
  return `<!doctype html><html><head><title>Mock Origin</title>
<link rel="stylesheet" href="/style.css">
<base href="${base}/sub/">
<script src="/app.js"></script>
</head><body>
<h1>Mock Origin</h1>
<a href="/page2">relative page</a>
<a href="http://localhost:${PORT}/other">cross-host page</a>
<a href="javascript:alert(1)">js link</a>
<a href="mailto:a@b.c">mail link</a>
<img src="/pixel.png" alt="png" width="1">
<img srcset="/pixel.png 1x, /photo.jpg 2x" src="/pixel.png" alt="srcset">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" alt="inline">
<img src="/photo.jpg" alt="photo">
<video src="/clip.mp4" poster="/photo.jpg" controls></video>
<form method="get" action="/get"><input name="q" value="x"><button>go</button></form>
<form method="post" action="/post"><input name="sent" value="hello from umbra"><button>go</button></form>
<iframe src="/frame" width="200" height="60"></iframe>
<div style="background:url('/photo.jpg')">styled</div>
<noscript><img src="/pixel.png" alt="noscript"></noscript>
<script>var thumb="https://cdn.mock/img/photo.jpg";</script>
</body></html>`;
}

const CSS = `body{background:url('/photo.jpg')}
@import "/more.css";
ul{list-style:url('http://localhost:${PORT}/photo.jpg')}`;

/* ---- anti-bot fixtures -------------------------------------------------
   The mock plays the part of a *gating* YouTube: it records the InnerTube
   client identity each POST presents and only hands real stream URLs to the
   clients that are not under the PO-token regime. That makes the client
   ladder and the visitor-identity reuse observable offline. */

/** A structurally genuine visitorData: 0x0a 0x0b + 11-char id + timestamp. */
function mockVisitorData() {
  const id = 'CgtMOCK1d2FyZQ'.slice(0, 11);
  const buf = Buffer.concat([
    Buffer.from([0x0a, 0x0b]),
    Buffer.from(id, 'ascii'),
    Buffer.from([0x28, 0xd0, 0x0f]),
  ]);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const MOCK_VISITOR = mockVisitorData();

/* Clients the mock treats as PO-token gated: they get a format list with the
   urls stripped, exactly like the real thing does to a datacenter IP. */
const GATED_CLIENTS = new Set(['WEB', 'ANDROID_VR', 'MWEB', 'WEB_CREATOR']);
/* the video every backend fails on, from the watch page down */
const NOSTREAM = 'NoStream123';

/** Every InnerTube POST the mock saw, for assertions in the offline suite. */
export const hits = [];
const HITS = hits;

/**
 * Re-pack formats the way YouTube does for most real videos: no `url`, a
 * `signatureCipher` carrying a scrambled `s` plus the base url, and an `n`
 * parameter that still needs its own transform.
 */
function cipherUrls(pr) {
  const out = JSON.parse(JSON.stringify(pr));
  for (const list of ['formats', 'adaptiveFormats']) {
    for (const f of out.streamingData[list] || []) {
      if (!f.url) continue;
      const u = new URL(f.url);
      u.searchParams.set('n', 'XYZ');
      f.signatureCipher = new URLSearchParams({ s: 'abcdefgh', sp: 'sig', url: u.toString() }).toString();
      delete f.url;
    }
  }
  return out;
}

function stripUrls(pr) {
  const out = JSON.parse(JSON.stringify(pr));
  for (const list of ['formats', 'adaptiveFormats']) {
    for (const f of out.streamingData[list] || []) delete f.url;
  }
  return out;
}

function send(res, status, headers, body) {
  const buf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'content-length': buf.length, ...headers });
  res.end(buf);
}

function serveRange(req, res, buf, ct) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (!m) {
    return send(res, 200, { 'content-type': ct, 'accept-ranges': 'bytes' }, buf);
  }
  let start = m[1] === '' ? Math.max(0, buf.length - Number(m[2] || 0)) : Number(m[1]);
  let end = m[2] === '' ? buf.length - 1 : Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= buf.length) {
    res.writeHead(416, { 'content-range': `bytes */${buf.length}` });
    return res.end();
  }
  end = Math.min(end, buf.length - 1);
  res.writeHead(206, {
    'content-type': ct,
    'accept-ranges': 'bytes',
    'content-range': `bytes ${start}-${end}/${buf.length}`,
    'content-length': end - start + 1,
  });
  res.end(buf.subarray(start, end + 1));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, baseOf(req));
  const p = u.pathname;
  const base = baseOf(req);

  if (p === '/health') return send(res, 200, { 'content-type': 'text/plain' }, 'ok');
  if (p === '/') {
    return send(res, 200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
      'set-cookie': 'origin_probe=1; Path=/',
    }, indexDoc(base));
  }
  if (p === '/page2' || p === '/sub/page2') return send(res, 200, { 'content-type': 'text/html' }, '<!doctype html><title>p2</title><h1>page two</h1>');
  if (p === '/other') return send(res, 200, { 'content-type': 'text/html' }, '<!doctype html><title>other</title><h1>other host doc</h1>');
  if (p === '/frame') return send(res, 200, { 'content-type': 'text/html' }, '<!doctype html><title>framed</title><a href="/page2">x</a>');
  /* native-hop probes: location.href= is [Unforgeable], so these navigate the
     frame for real and the shell must adopt (or, for the loop, veil) */
  if (p === '/escape-test') return send(res, 200, { 'content-type': 'text/html' },
    '<!doctype html><title>escape probe</title><h1>escape probe</h1><button class="go">native hop</button><script>document.querySelector(".go").onclick=function(){location.href="/page2"};</script>');
  if (p === '/escape-loop') return send(res, 200, { 'content-type': 'text/html' },
    '<!doctype html><title>loop</title><h1>loop</h1><script>location.href="/escape-loop";</script>');
  if (p === '/style.css') return send(res, 200, { 'content-type': 'text/css' }, CSS);
  if (p === '/more.css') return send(res, 200, { 'content-type': 'text/css' }, 'p{color:red}');
  if (p === '/app.js') return send(res, 200, { 'content-type': 'application/javascript' }, 'console.log("mock-app");');
  if (p === '/pixel.png') return send(res, 200, { 'content-type': 'image/png' }, PNG);
  if (p === '/photo.jpg' || p === '/thumb.jpg') return send(res, 200, { 'content-type': 'image/jpeg' }, JPG);
  if (p === '/clip.mp4' || p === '/v18.mp4' || p === '/v137.mp4' || p === '/a140.m4a') {
    return serveRange(req, res, CLIP, p.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4');
  }
  if (p === '/tone.wav') return serveRange(req, res, TONE, 'audio/wav');
  if (p === '/media') {
    return send(res, 200, { 'content-type': 'text/html; charset=utf-8' },
      `<!doctype html><html><head><title>media</title></head><body><h1>media</h1>` +
      `<audio id="tone" controls preload="auto" src="/tone.wav"></audio>` +
      `<video id="clip" controls preload="metadata" src="/clip.mp4"></video></body></html>`);
  }
  if (p === '/probe-net') {
    return send(res, 200, { 'content-type': 'text/html; charset=utf-8' },
      `<!doctype html><html><head><title>probe-net</title></head><body><pre id="o">running…</pre><script>
(async function(){
  var out=[];
  try{var r=await fetch('${base}/get?via=fetch');var j=await r.json();out.push('fetch -> '+r.status+' '+JSON.stringify(j.args))}catch(e){out.push('fetch failed: '+e)}
  try{
    var x=new XMLHttpRequest();x.open('GET','/get?via=rel');x.send();
    await new Promise(function(res){x.onloadend=res});
    out.push('XHR relative -> '+x.status+' '+x.responseText.slice(0,40))
  }catch(e){out.push('xhr '+e)}
  try{if(navigator.sendBeacon){navigator.sendBeacon('${base}/post','beacon=1');out.push('beacon sent')}}catch(e){out.push('beacon '+e)}
  try{var rp=await fetch('${base}/post',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rpc:'player'})});var jp=await rp.json();out.push('fetch POST -> '+rp.status+' '+(jp.data||'').slice(0,40))}catch(e){out.push('fetch POST failed: '+e)}
  document.getElementById('o').textContent=out.join('\\n')
})();
</script></body></html>`);
  }
  const many = /^\/many$/.exec(p);
  if (many) {
    const n = Math.min(200, Math.max(1, Number(u.searchParams.get('n') || 60)));
    let iframes = '';
    for (let i = 0; i < n; i++) iframes += `<iframe src="/frame?i=${i}" width="4" height="4"></iframe>`;
    return send(res, 200, { 'content-type': 'text/html; charset=utf-8' },
      `<!doctype html><html><head><title>many</title></head><body><h1>${n} frames</h1>${iframes}</body></html>`);
  }
  if (p === '/redirect-to') {
    const to = u.searchParams.get('url') || '/';
    const code = Number(u.searchParams.get('status_code') || 302);
    res.writeHead(code, { location: to });
    return res.end();
  }
  const rm = /^\/redirect\/(\d+)$/.exec(p);
  if (rm) {
    const n = Number(rm[1]);
    if (n <= 0) return send(res, 200, { 'content-type': 'text/plain' }, 'chain end');
    res.writeHead(302, { location: `/redirect/${n - 1}` });
    return res.end();
  }
  if (p === '/get') {
    return send(res, 200, { 'content-type': 'application/json' },
      JSON.stringify({ args: Object.fromEntries(u.searchParams), headers: { referer: req.headers.referer || null, cookie: req.headers.cookie || null } }));
  }
  if (p === '/post') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let form = raw;
      try {
        if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
          form = Object.fromEntries(new URLSearchParams(raw));
        }
      } catch {}
      return send(res, 200, { 'content-type': 'application/json' },
        JSON.stringify({ form, data: raw, ct: req.headers['content-type'] || null, method: req.method }));
    });
  }
  if (p === '/headers') {
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ headers: req.headers }, null, 1));
  }
  if (p === '/cookies/set') {
    const [[k, v] = ['x', '1']] = [...u.searchParams];
    res.writeHead(302, { 'set-cookie': `${k}=${v}; Path=/`, location: '/cookies' });
    return res.end();
  }
  if (p === '/cookies') {
    const jar = {};
    for (const part of String(req.headers.cookie || '').split(/;\s*/)) {
      if (!part) continue;
      const i = part.indexOf('=');
      if (i > 0) jar[part.slice(0, i)] = part.slice(i + 1);
    }
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ cookies: jar }));
  }
  /* ---- mock Invidious API instance --------------------------------------
     The real /api/v1 shapes, so the invidious adapter is exercised against a
     payload it would actually meet. Titles differ from the Piped mock's on
     purpose: the aggregation tests need to tell the two sources apart while
     still agreeing on the video id. */
  if (p.startsWith('/api/v1/')) {
    const rest = p.slice(8);
    HITS.push({ path: '/api/v1', method: req.method, rest, q: u.searchParams.get('q') });
    const J = (o) => send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(o));
    const thumbs = [
      { quality: 'medium', url: `${base}/thumb.jpg`, width: 320, height: 180 },
      { quality: 'maxres', url: `${base}/thumb.jpg`, width: 1280, height: 720 },
    ];
    const item = (id, title) => ({
      type: 'video', title, videoId: id, author: 'Mock Inv Channel', authorId: 'UCinvmock',
      authorUrl: '/channel/UCinvmock', authorVerified: true, videoThumbnails: thumbs,
      description: 'inv description', viewCount: 4242, published: 1767225600,
      publishedText: '3 weeks ago', lengthSeconds: 212, liveNow: false,
    });
    if (rest === 'stats') return J({ version: '2.x', software: { name: 'invidious' } });
    if (rest === 'videos/' + NOSTREAM) return send(res, 500, { 'content-type': 'text/plain' }, 'instance error');
    if (rest === 'search') {
      if (u.searchParams.get('q') === '__invdown__') return send(res, 503, { 'content-type': 'text/plain' }, 'nope');
      return J([
        item(VID, 'Invidious Search Hit'),
        item('aaaaaaaaaaa', 'Invidious Only Hit'),
        { type: 'channel', authorId: 'UCx', author: 'not a video' },
      ]);
    }
    if (rest === 'trending') return J([item(VID, 'Invidious Trending Hit')]);
    if (rest.startsWith('videos/')) {
      return J({
        ...item(rest.slice(7), 'Invidious Video Title'),
        likeCount: 99, subCountText: '1.2M',
        adaptiveFormats: [
          { url: `${base}/v137.mp4`, itag: '137', type: 'video/mp4; codecs="avc1"', qualityLabel: '1080p',
            bitrate: '2000000', fps: 30, clen: String(CLIP.length) },
          { url: `${base}/a140.m4a`, itag: '140', type: 'audio/mp4; codecs="mp4a"', audioQuality: 'AUDIO_QUALITY_MEDIUM',
            bitrate: '128000', clen: String(CLIP.length) },
        ],
        formatStreams: [
          { url: `${base}/v18.mp4`, itag: '18', type: 'video/mp4', quality: 'medium',
            qualityLabel: '360p', bitrate: '500000', container: 'mp4' },
        ],
        captions: [{ label: 'English', language_code: 'en', url: '/api/v1/captions/' + rest.slice(7) + '?label=English' }],
        recommendedVideos: [item('bbbbbbbbbbb', 'Invidious Related')],
      });
    }
    if (rest.startsWith('channels/')) {
      return J({
        authorId: rest.slice(9), author: 'Invidious Channel', description: 'inv channel desc',
        authorThumbnails: thumbs, authorBanners: thumbs, subCount: 1200000, authorVerified: true,
        latestVideos: [item(VID, 'Invidious Channel Upload')],
      });
    }
    if (rest.startsWith('playlists/')) {
      return J({
        playlistId: rest.slice(10), title: 'Invidious Playlist', author: 'Inv Author', authorId: 'UCinvmock',
        description: 'inv playlist', videoCount: 1, playlistThumbnail: `${base}/thumb.jpg`,
        videos: [item(VID, 'Invidious Playlist Item')],
      });
    }
    if (rest.startsWith('comments/')) {
      return J({
        commentCount: 1, videoId: rest.slice(9),
        comments: [{
          author: 'Inv Commenter', authorId: 'UCinvc', authorThumbnail: `${base}/thumb.jpg`,
          content: 'an invidious comment', published: 1767225600, publishedText: '2 hours ago',
          likeCount: 12, commentId: 'ic1', isPinned: false,
        }],
      });
    }
    return send(res, 404, { 'content-type': 'application/json' }, JSON.stringify({ error: 'no such invidious route' }));
  }

  /* ---- mock Piped API instance ------------------------------------------
     Same shapes the real /streams, /search, /trending, /channel and /comments
     endpoints return, pointed at this mock's own media so the Umbra media
     wire can actually stream the bytes in the offline suite. */
  if (p.startsWith('/streams/')) {
    HITS.push({ path: '/streams', method: req.method, videoId: p.slice(9) });
    /* One video id that no backend can extract, so the suite can drive the
       case the whole provider pool exists for and still fails: a scored
       address being refused by everything at once. */
    if (p.slice(9) === NOSTREAM) return send(res, 500, { 'content-type': 'text/plain' }, 'instance error');
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
      title: 'Mock Piped Video', description: 'piped description line one\nline two',
      uploader: 'Mock Channel', uploaderUrl: '/channel/UCmock', uploaderVerified: true,
      duration: 212, views: 4242, likes: 99, uploadDate: '2026-01-02',
      thumbnailUrl: `${base}/thumb.jpg`, livestream: false, hls: null, dash: null,
      proxyUrl: base,
      videoStreams: [
        { url: `${base}/v18.mp4`, format: 'MPEG_4', quality: '360p', mimeType: 'video/mp4',
          codec: 'avc1.42001E', videoOnly: false, bitrate: 500000, width: 640, height: 360, fps: 24, contentLength: CLIP.length },
        { url: `${base}/v137.mp4`, format: 'MPEG_4', quality: '1080p', mimeType: 'video/mp4',
          codec: 'avc1.640028', videoOnly: true, bitrate: 2000000, width: 1920, height: 1080, fps: 30, contentLength: CLIP.length },
      ],
      audioStreams: [
        { url: `${base}/a140.m4a`, format: 'M4A', quality: '128 kbps', mimeType: 'audio/mp4',
          codec: 'mp4a.40.2', videoOnly: false, bitrate: 128000, contentLength: 65536 },
      ],
      subtitles: [
        { url: `${base}/cap-en`, mimeType: 'application/ttml+xml', name: 'English', code: 'en', autoGenerated: false },
      ],
      relatedStreams: [
        { url: '/watch?v=relatedVid1', title: 'Related One', thumbnail: `${base}/thumb.jpg`,
          uploaderName: 'Other Channel', uploaderUrl: '/channel/UCother', duration: 99, views: 7, uploadedDate: '1 day ago' },
      ],
    }));
  }
  if (p === '/search' && u.searchParams.get('q') === '__allgated__') {
    /* every piped instance refusing at once, the way a squeeze actually looks */
    return send(res, 500, { 'content-type': 'application/json' }, JSON.stringify({ error: 'piped is squeezed too' }));
  }
  if (p === '/search') {
    HITS.push({ path: p, method: req.method, q: u.searchParams.get('q'), filter: u.searchParams.get('filter') });
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
      corrected: false, suggestion: null, nextpage: null,
      items: [
        { url: `/watch?v=${VID}`, type: 'stream', title: 'Mock Piped Result', thumbnail: `${base}/thumb.jpg`,
          uploaderName: 'Mock Channel', uploaderUrl: '/channel/UCmock', uploaderVerified: true,
          duration: 212, views: 4242, uploadedDate: '2 weeks ago', shortDescription: 'a result' },
        { url: '/channel/UCmock', type: 'channel', name: 'not a video' },
      ],
    }));
  }
  if (p === '/trending') {
    HITS.push({ path: p, method: req.method, region: u.searchParams.get('region') });
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify([
      { url: `/watch?v=${VID}`, title: 'Mock Trending', thumbnail: `${base}/thumb.jpg`,
        uploaderName: 'Mock Channel', uploaderUrl: '/channel/UCmock', duration: 212, views: 100, uploadedDate: '3 hours ago' },
    ]));
  }
  if (p.startsWith('/channel/')) {
    HITS.push({ path: '/channel', method: req.method, id: p.slice(9) });
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
      id: p.slice(9), name: 'Mock Channel', description: 'a mock channel', subscriberCount: 1234, verified: true,
      avatarUrl: `${base}/thumb.jpg`, bannerUrl: `${base}/photo.jpg`,
      relatedStreams: [
        { url: `/watch?v=${VID}`, title: 'Channel Upload', thumbnail: `${base}/thumb.jpg`,
          uploaderName: 'Mock Channel', uploaderUrl: '/channel/UCmock', duration: 212, views: 5, uploadedDate: '1 month ago' },
      ],
    }));
  }
  if (p.startsWith('/comments/')) {
    HITS.push({ path: '/comments', method: req.method });
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
      disabled: false, nextpage: null,
      comments: [
        { author: 'Commenter', commentText: 'a mock comment', commentedTime: '2 hours ago',
          likeCount: 3, pinned: false, hearted: false, verified: false, thumbnail: `${base}/thumb.jpg` },
      ],
    }));
  }

  if (p === '/watch') {
    HITS.push({ path: p, method: req.method, videoId: u.searchParams.get('v') || null,
      cookie: req.headers.cookie || null });
    /* One id exercises the watch page as an extraction surface. Without a
       consent cookie the real site serves a wall instead of the page, and an
       extractor that does not send one reads that as a block. */
    if (u.searchParams.get('v') === NOSTREAM) {
      /* the bot wall, on the surface that is usually the last one standing */
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8' },
        '<!doctype html><html><body><div>LOGIN_REQUIRED: Sign in to confirm you\u2019re not a bot</div></body></html>');
    }
    if (u.searchParams.get('v') === 'EmbedOnly12') {
      /* the exact shape the user hit: watch refused, embed still answering */
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8' },
        '<!doctype html><html><body><div>LOGIN_REQUIRED: Sign in to confirm you\u2019re not a bot</div></body></html>');
    }
    if (u.searchParams.get('v') === 'PageOnly123') {
      if (!/SOCS=|CONSENT=/.test(req.headers.cookie || '')) {
        return send(res, 200, { 'content-type': 'text/html; charset=utf-8' },
          '<!doctype html><html><head><title>Before you continue</title></head>'
          + '<body><form action="https://consent.youtube.com/save">CONSENT_WALL</form></body></html>');
      }
      /* a decoy object first, and braces inside strings: the two things that
         defeat a regex-based extractor */
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8' },
        '<!doctype html><html><head><title>mock watch</title></head><body>'
        + '<script>var ytInitialData = {"contents":{"note":"} not the object you want {"}};</script>'
        + '<script nonce="x">var ytInitialPlayerResponse = ' + JSON.stringify(playerResponse(base)) + ';</script>'
        + '<div>watch page for PageOnly123</div></body></html>');
    }
    const html = `<!doctype html><html><head><title>Mock Video Title - MockTube</title></head><body>` +
      `<div id="player"></div><script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse(base))};</script>` +
      `<a href="/watch?v=${VID}">self</a><img src="/thumb.jpg">` +
      `<a href="https://www.mocktube.example/channel/mock">channel</a></body></html>`;
    return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, html);
  }
  if (p === '/results') {
    return send(res, 200, { 'content-type': 'text/html; charset=utf-8' },
      `<!doctype html><html><head><title>results</title></head><body>` +
      `<script>var data={"contents":[{"videoRenderer":{"videoId":"${VID}","title":{"runs":[{"text":"Mock Video Title"}]},"thumbnail":{"thumbnails":[{"url":"${base}/thumb.jpg"}]}}}]}};</script>` +
      `<a href="/watch?v=${VID}">Mock Video Title</a></body></html>`);
  }
  if (p.startsWith('/embed/')) {
    HITS.push({ path: p, method: req.method });
    /* carries a ytcfg like the real embed document, but deliberately no
       ytInitialPlayerResponse, so the client ladder has to do the work */
    return send(res, 200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'self'",
    }, `<!doctype html><html><head><title>embed</title>` +
      `<script>ytcfg.set({"INNERTUBE_API_KEY":"MOCK_EMBED_KEY","INNERTUBE_CLIENT_VERSION":"2.20260708.00.00","VISITOR_DATA":"${MOCK_VISITOR}"});</script>` +
      `</head><body><div id="mock-embed">embed for ${p.slice(7)}</div></body></html>`);
  }
  /* ---- the watch page as an extraction surface ----
     The real page embeds the same playerResponse the API returns, inside a
     script tag, surrounded by megabytes of unrelated markup. The mock
     reproduces the two things that actually break naive extractors: braces
     inside strings, and a second JSON object on the page. */
  if (p === '/oembed') {
    HITS.push({ path: '/oembed', method: req.method });
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
      title: 'Mock oEmbed Title', author_name: 'Mock Author',
      author_url: 'https://www.youtube.com/channel/UC' + 'x'.repeat(22),
      thumbnail_url: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
    }));
  }
  if (p === '/feeds/videos.xml') {
    const cid = u.searchParams.get('channel_id') || '';
    HITS.push({ path: '/feeds/videos.xml', method: req.method, channelId: cid });
    return send(res, 200, { 'content-type': 'application/atom+xml' },
      '<?xml version="1.0"?><feed><title>Mock Feed Channel</title>'
      + '<entry><yt:videoId>FeedVideo01</yt:videoId><title>Feed Video One</title>'
      + '<author><name>Mock Author</name></author><published>2026-01-02T00:00:00+00:00</published>'
      + '<media:statistics views="4242"/></entry>'
      + '<entry><yt:videoId>FeedVideo02</yt:videoId><title><![CDATA[Feed & Video Two]]></title>'
      + '<author><name>Mock Author</name></author><published>2026-01-01T00:00:00+00:00</published>'
      + '</entry></feed>');
  }
  /* service-worker data blob: where a genuine visitorData is minted from */
  if (p === '/sw.js_data') {
    HITS.push({ path: p, method: req.method });
    return send(res, 200, { 'content-type': 'text/plain; charset=utf-8' },
      `)]}'\n[[["mock",["${MOCK_VISITOR}"],1]]]`);
  }
  if (p === '/__hits') {
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(HITS));
  }
  if (p === '/cap-en') {
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'hello ' }, { utf8: 'world' }] },
        { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: 'second line' }] },
      ],
    }));
  }
  /* ---- the player script, for signature + n deciphering --------------
     Not a stub: this carries the same *shapes* the real base.js uses -- a
     helper object of primitive transforms, a signature function that calls
     into it, and an n-transform reached through an array reference. The
     extractor has to find all of that by pattern, exactly as it does in
     production, so a regex that stops matching real YouTube will usually
     stop matching this too. */
  if (p === '/iframe_api') {
    HITS.push({ path: p, method: req.method });
    return send(res, 200, { 'content-type': 'text/javascript' },
      'var a="/s/player/deadbeef/player_ias.vflset/en_US/base.js";');
  }
  if (/^\/s\/player\/[0-9a-f]+\/player_ias\.vflset\/en_US\/base\.js$/.test(p)) {
    HITS.push({ path: '/base.js', method: req.method });
    return send(res, 200, { 'content-type': 'text/javascript' }, [
      'var Pq={',
      ' Wx:function(a){a.reverse()},',
      ' Lm:function(a,b){a.splice(0,b)},',
      ' Rt:function(a,b){var c=a[0];a[0]=a[b%a.length];a[b%a.length]=c}',
      '};',
      'var zx=function(a){a=a.split("");Pq.Wx(a);Pq.Lm(a,2);Pq.Rt(a,3);return a.join("")};',
      'var ndx=function(a){var b=a.split("");b.reverse();return "N"+b.join("")};',
      'var nArr=[ndx];',
      'function setup(c){var b;if((b=c.get("n"))&&(b=nArr[0](b))){c.set("n",b)}return c}',
      'var noise=function(){return "/"+"not a regex"};',
    ].join('\n'));
  }

  /* ---- innertube metadata endpoints, for the LOCAL piped instance --------
     Renderer-shaped like the real thing, deliberately nested at an awkward
     depth so the recursive collector is what finds them, not a fixed path. */
  if (p === '/youtubei/v1/search' || p === '/youtubei/v1/browse' || p === '/youtubei/v1/next') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* record anyway */ }
      HITS.push({
        path: p, method: req.method,
        clientName: ((body.context || {}).client || {}).clientName || null,
        browseId: body.browseId || null, query: body.query || null,
        continuation: body.continuation ? 'yes' : null,
      });
      const vr = (id, title) => ({
        videoRenderer: {
          videoId: id,
          title: { runs: [{ text: title }] },
          thumbnail: { thumbnails: [{ url: `${base}/thumb.jpg`, width: 120 }, { url: `${base}/thumb.jpg`, width: 640 }] },
          ownerText: { runs: [{ text: 'Mock Channel', navigationEndpoint: { browseEndpoint: { browseId: 'UCmocklocal' } } }] },
          publishedTimeText: { simpleText: '2 weeks ago' },
          lengthText: { simpleText: '3:32' },
          viewCountText: { simpleText: '1,234,567 views' },
          ownerBadges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_VERIFIED' } }],
          detailedMetadataSnippets: [{ snippetText: { runs: [{ text: 'a local snippet' }] } }],
        },
      });
      if (p === '/youtubei/v1/search') {
        /* a bot-gated reply: valid JSON, HTTP 200, and not one renderer in it */
        if (body.query === '__gated__' || body.query === '__allgated__') {
          return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
            responseContext: {},
            alerts: [{ alertRenderer: { type: 'ERROR', text: { simpleText: "Sign in to confirm you're not a bot" } } }],
          }));
        }
        /* a real miss: no videos, but the scaffolding is still there */
        if (body.query === '__nohits__') {
          return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
            contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: {
              contents: [{ itemSectionRenderer: { contents: [{ backgroundPromoRenderer: {
                title: { runs: [{ text: 'No results found' }] } } }] } }],
            } } } },
          }));
        }
        return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
          contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: {
            contents: [{ itemSectionRenderer: { contents: [vr(VID, 'Local Search Hit'), { channelRenderer: { channelId: 'UCx' } }] } }],
          } } } },
        }));
      }
      if (p === '/youtubei/v1/browse') {
        if (String(body.browseId || '').startsWith('UC')) {
          return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
            metadata: { channelMetadataRenderer: { externalId: body.browseId, title: 'Local Channel', description: 'local channel desc' } },
            header: { c4TabbedHeaderRenderer: {
              title: 'Local Channel',
              avatar: { thumbnails: [{ url: `${base}/thumb.jpg` }] },
              banner: { thumbnails: [{ url: `${base}/photo.jpg` }] },
              subscriberCountText: { simpleText: '1.2M subscribers' },
              badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_VERIFIED' } }],
            } },
            contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: {
              contents: [{ richItemRenderer: { content: vr(VID, 'Local Channel Upload') } }],
            } } } }] } },
          }));
        }
        return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
          contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: {
            contents: [{ itemSectionRenderer: { contents: [{ shelfRenderer: { content: { expandedShelfContentsRenderer: {
              items: [vr(VID, 'Local Trending Hit')],
            } } } }] } }],
          } } } }] } },
        }));
      }
      /* next: first call hands back a continuation, second the comments */
      if (body.continuation) {
        return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
          frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: { commentEntityPayload: {
            properties: { commentId: 'c1', content: { content: 'a local comment' }, publishedTime: '2 hours ago' },
            author: { displayName: 'Local Commenter', channelId: 'UCcommenter', avatarThumbnailUrl: `${base}/thumb.jpg`, isVerified: true },
            toolbar: { likeCountNotliked: '12' },
          } } }] } },
        }));
      }
      return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
        contents: { twoColumnWatchNextResults: {
          results: { results: { contents: [
            { itemSectionRenderer: { contents: [{ continuationItemRenderer: {
              continuationEndpoint: { continuationCommand: { token: 'MOCK_COMMENT_TOKEN' } },
            } }] } },
          ] } },
          /* the watch-next rail, where recommendations actually live */
          secondaryResults: { secondaryResults: { results: [
            { compactVideoRenderer: {
              videoId: 'ccccccccccc',
              title: { simpleText: 'Local Related One' },
              thumbnail: { thumbnails: [{ url: `${base}/thumb.jpg`, width: 320 }] },
              longBylineText: { runs: [{ text: 'Mock Channel', navigationEndpoint: { browseEndpoint: { browseId: 'UCmocklocal' } } }] },
              lengthText: { simpleText: '2:10' },
              viewCountText: { simpleText: '900 views' },
            } },
          ] } },
        } },
      }));
    });
  }

  if (p === '/youtubei/v1/player') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* record anyway */ }
      const client = ((body.context || {}).client) || {};
      HITS.push({
        path: p,
        method: req.method,
        clientName: client.clientName || null,
        clientVersion: client.clientVersion || null,
        visitorData: client.visitorData || null,
        visitorHeader: req.headers['x-goog-visitor-id'] || null,
        clientNameHeader: req.headers['x-youtube-client-name'] || null,
        embedUrl: ((body.context || {}).thirdParty || {}).embedUrl || null,
        ua: req.headers['user-agent'] || null,
        poToken: (body.serviceIntegrityDimensions || {}).poToken || null,
        cookie: req.headers.cookie || null,
      });
      const pr = playerResponse(base);
      /* one video id serves the ciphered shape, so both the plain and the
         deciphered paths are exercised by the same suite */
      if (body.videoId === 'Ciphered123') {
        return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(cipherUrls(pr)));
      }
      /* A video YouTube serves only as a manifest: no progressive or adaptive
         formats at all. Before the fallback existed this looked identical to
         a total extraction failure. */
      if (body.videoId === 'HlsOnly1234') {
        const only = JSON.parse(JSON.stringify(pr));
        only.streamingData = { expiresInSeconds: '21540', hlsManifestUrl: 'http://127.0.0.1:' + PORT + '/hls/HlsOnly1234.m3u8' };
        return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(only));
      }
      /* the all-gated id: every client, every time, urls withheld — which is
         what a bot-scored address actually gets back */
      if (body.videoId === NOSTREAM) {
        return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(stripUrls(pr)));
      }
      /* gated clients get the stripped-url treatment; others get real urls */
      if (GATED_CLIENTS.has(client.clientName)) {
        return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(stripUrls(pr)));
      }
      return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(pr));
    });
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('mock missing');
});

server.listen(PORT, '0.0.0.0', () => console.log(`mock upstream on http://127.0.0.1:${PORT}`));
