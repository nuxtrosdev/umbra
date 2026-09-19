/**
 * YouTube handling.
 *
 * Umbra treats YouTube as two separable problems:
 *  (a) the *site* (search, channel, watch page) -> ordinary Umbra documents;
 *  (b) the *stream* -> we lift streamingData out of ytInitialPlayerResponse and
 *      hand the browser a native <video>/<track> pair whose bytes come through
 *      the Umbra media mode, so playback never touches youtube.com.
 *
 * Google bot-gates datacenter IPs by returning formats with every `url`
 * stripped. When that happens the response is reported as `blocked` and the
 * player falls back to the Umbra-proxied embed document (framing headers are
 * removed by the proxy, so it renders inside the tab system anyway).
 */
import { upstream, readBody } from './net.mjs';
import { href } from './protocol.mjs';

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be', 'youtube.googleapis.com', 'gaming.youtube.com',
]);

export function isYouTube(url) {
  try {
    return YT_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function parseVideoId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (!YT_HOSTS.has(u.hostname.toLowerCase())) return null;
  const v = u.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const m = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname);
  if (m) return m[1];
  const list = u.searchParams.get('list');
  if (list && u.pathname.startsWith('/playlist')) return null;
  return null;
}

/** balanced-brace JSON harvest, because playerResponse is a giant inline object */
function harvest(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const s = html.slice(i + marker.length);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(0, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const Q = (s) => {
  try {
    return Object.fromEntries(new URLSearchParams(s.split('?')[1] || ''));
  } catch {
    return {};
  }
};

/** A format is playable through Umbra when we can name a byte url for it. */
function playable(f, kind) {
  const mime = String(f.mimeType || '');
  let url = f.url || null;
  let sig = false;
  if (!url) {
    const ciph = f.signatureCipher || f.cipher;
    if (!ciph) return null;
    const q = Q(ciph);
    if (!q.url) return null;
    url = decodeURIComponent(q.url);
    sig = !!q.s;
    if (sig) return { blockedSig: true, kind, mime, itag: f.itag };
  }
  if (sig) return { blockedSig: true, kind, mime, itag: f.itag };
  const hasVideo = /video\//.test(mime) && f.width > 0;
  const hasAudio = /audio\//.test(mime);
  const muxed = hasVideo && hasAudio ? true : kind === 'muxed';
  return {
    kind: muxed ? 'muxed' : hasVideo ? 'video' : 'audio',
    itag: f.itag,
    mime,
    url,
    label: f.qualityLabel || f.quality || '',
    quality: f.quality,
    fps: f.fps,
    codecs: (mime.split('codecs=')[1] || '').replace(/"/g, '').trim(),
    contentLength: Number(f.contentLength || 0),
    bitrate: f.bitrate,
    width: f.width,
    height: f.height,
    audioOnly: hasAudio && !hasVideo,
  };
}

export async function inspect(url, ctx) {
  const videoId = parseVideoId(url);
  if (!videoId) return null;
  const watchUrl = 'https://www.youtube.com/watch?v=' + videoId + '&hl=en';
  const res = await upstream(watchUrl, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'upgrade-insecure-requests': '1',
      cookie: ctx.cookieJar.header(watchUrl),
      referer: 'https://www.youtube.com/',
    },
  });
  const buf = await readBody(res.res, { limit: 60 * 1024 * 1024 });
  const html = buf.toString('latin1');

  let pr =
    harvest(html, 'ytInitialPlayerResponse = ') ||
    harvest(html, 'ytInitialPlayerResponse=') ||
    harvest(html, 'var ytInitialPlayerResponse = ');
  const cfg = harvest(html, 'ytcfg.set(') || {};
  const key =
    (cfg.INNERTUBE_API_KEY) ||
    (/INNERTUBE_API_KEY\s*:\s*"([^"]+)/.exec(html) || [])[1] ||
    'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  const cver = (/INNERTUBE_CLIENT_VERSION\s*:\s*"([^"]+)/.exec(html) || [])[1] || '2.20240901.01.00';
  const visitor = cfg.VISITOR_DATA || (/VISITOR_DATA\s*:\s*"([^"]+)/.exec(html) || [])[1] || '';

  // Second attempt through the innertube RPC -- sometimes yields URLs the HTML
  // response had stripped.
  if (!pr || !(pr.streamingData && (pr.streamingData.formats || pr.streamingData.adaptiveFormats))) {
    try {
      const rpc = await upstream('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
          origin: 'https://www.youtube.com',
          referer: 'https://www.youtube.com/watch?v=' + videoId,
          cookie: ctx.cookieJar.header(watchUrl),
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: cver,
              hl: 'en',
              gl: 'US',
              visitorData: visitor,
              browserName: 'Chrome',
              platform: 'MOBILE',
            },
          },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          thirdParty: { embedUrl: 'https://www.youtube.com/embed/' + videoId },
        }),
      });
      const j = JSON.parse((await readBody(rpc.res, { limit: 8 * 1024 * 1024 })).toString('utf8'));
      if (j && (j.streamingData || j.playabilityStatus)) pr = j;
    } catch {
      /* keep whatever the watch page gave us */
    }
  }
  if (!pr) {
    return { videoId, ok: false, reason: 'no player response (page shape changed)', embedOnly: true };
  }

  const ps = pr.playabilityStatus || {};
  const sd = pr.streamingData || {};
  const vd = pr.videoDetails || {};
  const mf = (pr.microformat || {}).playerMicroformatRenderer || {};

  const streams = [];
  for (const f of sd.formats || []) {
    const p = playable(f, 'muxed');
    if (p && p.url) streams.push(p);
  }
  const adapt = [];
  for (const f of sd.adaptiveFormats || []) {
    const p = playable(f, null);
    if (p && p.url) adapt.push(p);
  }
  const muxed = streams.sort((a, b) => (b.contentLength || 0) - (a.contentLength || 0));
  const vids = adapt
    .filter((f) => !f.audioOnly)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0));
  const auds = adapt
    .filter((f) => f.audioOnly)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  const capTracks = [];
  const cap = ((pr.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
  for (const t of cap.slice(0, 8)) {
    const base = t.baseUrl || t.url;
    if (!base) continue;
    const withFmt = base + (base.includes('?') ? '&' : '?') + 'fmt=json3';
    capTracks.push({
      raw: base.startsWith('http') ? withFmt : 'https://www.youtube.com' + withFmt,
      code: t.languageCode || 'und',
      label: (t.name && (t.name.simpleText || (t.name.runs || [])[0]?.text)) || t.languageCode,
      wire: withFmt.startsWith('http')
        ? href(ctx, withFmt, 's')
        : href(ctx, 'https://www.youtube.com' + withFmt, 's'),
    });
  }

  const thumbWire = (u) => (u ? href(ctx, u, 's') : null);
  const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
  const bestThumb = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const blockNote =
    !muxed.length && !vids.length
      ? ps.status === 'OK'
        ? 'upstream returned formats with stream URLs stripped (bot gating on this egress IP)'
        : ps.reason || ps.status || 'no stream urls'
      : null;

  return {
    ok: !blockNote,
    videoId,
    title: vd.title || mf.title || videoId,
    author: vd.author || '',
    channel: (mf.channel || {}).name || vd.author || '',
    channelUrl: (mf.channel || {}).canonicalBaseUrl || '',
    duration: Number(vd.lengthSeconds || mf.lengthSeconds || 0),
    thumb: bestThumb,
    thumbWire: thumbWire(bestThumb),
    hqWire: thumbWire(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`),
    desc: (mf.description && mf.description.simpleText) || '',
    isLive: !!vd.isLiveContent,
    age: Number((vd.viewCount || 0).toString ? vd.viewCount : 0) || 0,
    views: Number(vd.viewCount || 0) || 0,
    playability: ps.status || 'UNKNOWN',
    reason: blockNote,
    muxed: muxed.slice(0, 8).map(withWire(ctx)),
    video: vids.slice(0, 8).map(withWire(ctx)),
    audio: auds.slice(0, 2).map(withWire(ctx)),
    captions: capTracks,
    embedDoc: href(ctx, 'https://www.youtube.com/embed/' + videoId + '?enablejsapi=1&rel=0&modestbranding=1', 'd'),
    watchDoc: href(ctx, 'https://www.youtube.com/watch?v=' + videoId, 'd'),
    expires: Number(sd.expiresInSeconds || 0),
  };
}

function withWire(ctx) {
  return (f) => ({
    ...f,
    wire: href(ctx, f.url, 'm'),
  });
}
