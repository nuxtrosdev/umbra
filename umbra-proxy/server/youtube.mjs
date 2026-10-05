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
 *
 * Anti-bot posture (see innertube.mjs for the reasoning in full):
 *   - config comes from the /embed/ document, never /watch, because the embed
 *     surface is built to be loaded by third-party sites and is challenged
 *     far more loosely than the watch page;
 *   - stream data comes from a *ladder* of InnerTube client identities, tried
 *     until one returns formats we can actually fetch bytes for;
 *   - one visitor identity is minted per egress and reused, rather than
 *     randomised per request.
 */
import { upstream, readBody } from './net.mjs';
import { href } from './protocol.mjs';
import {
  LADDER,
  CLIENTS,
  getVisitorData,
  playerRequest,
} from './innertube.mjs';
import { getPoToken } from './potoken.mjs';

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be', 'youtube.googleapis.com', 'gaming.youtube.com',
]);

/* Test hook: the offline suite points YouTube fetches at the mock upstream.
   Unset in every real deployment, where this is exactly www.youtube.com. */
const YT_BASE = (process.env.UMBRA_YT_BASE || 'https://www.youtube.com').replace(/\/$/, '');

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
  /* signatureCipher is a bare `url=…&s=…&sp=…` string with no '?', so only
     split when there is actually a URL in front of the query */
  try {
    const q = String(s || '');
    return Object.fromEntries(new URLSearchParams(q.includes('?') ? q.split('?')[1] : q));
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

/** Does this player response carry at least one directly fetchable stream? */
function hasUsableStreams(pr) {
  const sd = (pr && pr.streamingData) || {};
  const all = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
  return all.some((f) => {
    const p = playable(f, null);
    return p && p.url;
  });
}

/** Count formats we had to discard because they were signature-ciphered. */
function cipheredCount(pr) {
  const sd = (pr && pr.streamingData) || {};
  const all = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
  return all.filter((f) => {
    const p = playable(f, null);
    return p && p.blockedSig;
  }).length;
}

export async function inspect(url, ctx) {
  const videoId = parseVideoId(url);
  if (!videoId) return null;

  /* --- config from the embed document, not the watch page -----------------
     The watch page is the most heavily challenged surface on the site. The
     embed document exists to be loaded cross-origin by strangers, so it is
     gated far more loosely and still carries a usable ytcfg (and often a
     complete ytInitialPlayerResponse). */
  const embedUrl = YT_BASE + '/embed/' + videoId + '?hl=en';
  let html = '';
  try {
    const res = await upstream(embedUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'upgrade-insecure-requests': '1',
        cookie: ctx.cookieJar.header(embedUrl),
        /* an embed is reached from a third-party page, so that is the referer
           a genuine one carries */
        referer: 'https://www.google.com/',
      },
    });
    html = (await readBody(res.res, { limit: 60 * 1024 * 1024 })).toString('latin1');
  } catch {
    /* no embed document: the ladder below can still run keyless */
  }

  let pr =
    harvest(html, 'ytInitialPlayerResponse = ') ||
    harvest(html, 'ytInitialPlayerResponse=') ||
    harvest(html, 'var ytInitialPlayerResponse = ');
  const cfg = harvest(html, 'ytcfg.set(') || {};
  const key =
    (cfg.INNERTUBE_API_KEY) ||
    (/INNERTUBE_API_KEY\s*:\s*"([^"]+)/.exec(html) || [])[1] ||
    '';

  /* One visitor identity per egress, reused — never randomised per request. */
  const visitorRec = await getVisitorData({
    cookie: ctx.cookieJar.header(embedUrl),
    embedHtml: html,
  });
  const visitor = visitorRec.value;
  /* The ladder used to walk every client without ever attaching a proof of
     origin, which on a scored address is the difference between formats and
     an empty streamingData. Whatever source has one — a harvested browser
     token, the env var, a provider — it belongs on these requests. */
  const poToken = await getPoToken(visitor);

  /* --- client ladder ------------------------------------------------------
     Walk the configured identities until one hands back formats with real
     URLs. Stop early on success; record every attempt so a block can be
     attributed to a specific client rather than to "YouTube". */
  const attempts = [];
  let usedClient = pr && hasUsableStreams(pr) ? 'embed-document' : null;

  if (!usedClient) {
    for (const clientKey of LADDER) {
      let note = 'no usable formats';
      try {
        const j = await playerRequest(videoId, clientKey, {
          visitorData: visitor,
          cookie: ctx.cookieJar.header(embedUrl),
          apiKey: key,
          poToken,
        });
        const status = ((j || {}).playabilityStatus || {}).status || 'UNKNOWN';
        if (j && hasUsableStreams(j)) {
          pr = j;
          usedClient = clientKey;
          attempts.push({ client: clientKey, status, ok: true });
          break;
        }
        const ciph = cipheredCount(j);
        if (ciph) note = ciph + ' ciphered format(s), no JS player';
        else if (status !== 'OK') note = status + (((j || {}).playabilityStatus || {}).reason ? ': ' + j.playabilityStatus.reason : '');
        else note = 'urls stripped';
        /* Keep the most informative response around in case every client
           fails, so the error surface still has real metadata to show. */
        if (j && (j.streamingData || j.playabilityStatus) && !pr) pr = j;
        attempts.push({ client: clientKey, status, ok: false, note });
      } catch (e) {
        attempts.push({ client: clientKey, status: 'ERROR', ok: false, note: String(e.message || e).slice(0, 120) });
      }
    }
  }

  if (!pr) {
    return {
      videoId,
      ok: false,
      reason: 'no player response from the embed document or any innertube client',
      embedOnly: true,
      attempts,
      visitorSource: visitorRec.source,
    };
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

  /* Distinguish the two failure modes that used to collapse into "blocked":
     a ciphered format list means the request was fine and we simply cannot
     run YouTube's signature JS; a stripped list means the PO-token gate. */
  const ciphered = cipheredCount(pr);
  const blockNote =
    !muxed.length && !vids.length
      ? ciphered
        ? `upstream returned ${ciphered} signature-ciphered format(s); no JS player to unscramble them`
        : ps.status === 'OK'
          ? 'upstream returned formats with stream URLs stripped (PO-token gate on this egress IP)'
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
    /* provenance, so a block is attributable rather than mysterious */
    client: usedClient || 'none',
    clientLabel: CLIENTS[usedClient] ? CLIENTS[usedClient].name : usedClient || 'none',
    attempts,
    ciphered,
    visitorSource: visitorRec.source,
    visitorSynthetic: !!visitorRec.synthetic,
    /* "no playable streams" has two very different causes; say which one
       applied so the reader is not left guessing */
    poToken: poToken ? 'attached' : 'none',
    muxed: muxed.slice(0, 8).map(withWire(ctx)),
    video: vids.slice(0, 8).map(withWire(ctx)),
    audio: auds.slice(0, 2).map(withWire(ctx)),
    captions: capTracks,
    embedDoc: href(ctx, YT_BASE + '/embed/' + videoId + '?enablejsapi=1&rel=0&modestbranding=1', 'd'),
    watchDoc: href(ctx, YT_BASE + '/watch?v=' + videoId, 'd'),
    expires: Number(sd.expiresInSeconds || 0),
  };
}

function withWire(ctx) {
  return (f) => ({
    ...f,
    wire: href(ctx, f.url, 'm'),
  });
}
