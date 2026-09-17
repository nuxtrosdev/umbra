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
        JSON.stringify({ form, data: raw, ct: req.headers['content-type'] || null }));
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
  if (p === '/watch') {
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
    return send(res, 200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'self'",
    }, `<!doctype html><html><head><title>embed</title></head><body><div id="mock-embed">embed for ${p.slice(7)}</div></body></html>`);
  }
  if (p === '/cap-en') {
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'hello ' }, { utf8: 'world' }] },
        { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: 'second line' }] },
      ],
    }));
  }
  if (p === '/youtubei/v1/player') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(playerResponse(base))));
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('mock missing');
});

server.listen(PORT, '0.0.0.0', () => console.log(`mock upstream on http://127.0.0.1:${PORT}`));
