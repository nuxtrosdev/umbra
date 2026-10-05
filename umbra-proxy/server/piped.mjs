/**
 * Piped: an alternative YouTube front end.
 *
 * Why this exists
 * ---------------
 * innertube.mjs fights YouTube's PO-token gate from *our* egress IP. That is a
 * fight you can lose permanently: once the address is profiled, no client
 * identity rescues it. Piped moves the fight somewhere else entirely — a
 * federated network of public instances does the extraction on their egress,
 * and hands us plain JSON with ready-to-fetch stream URLs.
 *
 * Three properties make it a good fit for Umbra specifically:
 *
 *   1. The URLs are already deciphered. Piped runs NewPipeExtractor, so we
 *      never see `signatureCipher` — which matters because Umbra has no JS
 *      player and discards ciphered formats (see innertube.mjs).
 *   2. Streams are served from the instance's own proxy host, so the bytes
 *      still route through Umbra's media wire and never touch googlevideo.
 *   3. It is federated. One instance being blocked, rate-limited or simply
 *      down is routine, so this module treats instances as a failover pool
 *      rather than a dependency.
 *
 * What it is not: a way to make YouTube itself stop bot-checking you. It is a
 * different door into the same catalogue. Instances get blocked too — that is
 * why the pool exists and why every failure is reported per-instance instead
 * of collapsing into "Piped is down".
 */
import { upstream, readBody } from './net.mjs';
import { href } from './protocol.mjs';
import { handle as localHandle } from './piped-local.mjs';

/* The instance Umbra runs itself (piped-local.mjs), addressed in-process so
   the pool never makes an HTTP round trip to its own socket. It is first by
   default: it is instant, involves no third party, and cannot disappear.
   It is NOT a bot-gate bypass — extraction still happens on this egress —
   so the public pool stays behind it as the thing that rescues a gated
   local instance. Drop it with UMBRA_PIPED_INSTANCES if you want the
   third-party path only. */
export const LOCAL = 'local';

/* Public API instances. Overridable, because this list ages fast: the set of
   surviving public instances churns as YouTube blocks them. */
const DEFAULT_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.ducks.party',
];

/* A baked-in list is wrong the moment it ships — these hosts come and go, and
   several of the ones this file used to carry stopped resolving entirely.
   TeamPiped publishes the live set, so prefer asking over guessing. */
export const DIRECTORY = process.env.UMBRA_PIPED_DIRECTORY || 'https://piped-instances.kavin.rocks/';

/**
 * Replace the public half of the pool from the published directory. The local
 * instance keeps its place at the front; only the third-party entries are
 * swapped, so refreshing can never cost us the one backend that cannot vanish.
 */
export async function refreshInstances({ limit = 8 } = {}) {
  const res = await upstream(DIRECTORY, { timeout: 10000, headers: { accept: 'application/json' } });
  if (res.status !== 200) { res.res.resume(); throw new Error('directory http ' + res.status); }
  const list = JSON.parse((await readBody(res.res, { limit: 2 * 1024 * 1024 })).toString('utf8'));
  if (!Array.isArray(list)) throw new Error('directory was not a list');
  const found = list
    .map((e) => String((e && (e.api_url || e.apiUrl)) || '').trim().replace(/\/+$/, ''))
    .filter((u) => /^https:\/\//.test(u))
    .slice(0, limit);
  if (!found.length) throw new Error('directory had no api urls');
  const keepLocal = INSTANCES.includes(LOCAL);
  INSTANCES.length = 0;
  if (keepLocal) INSTANCES.push(LOCAL);
  INSTANCES.push(...found);
  benched.clear();
  preferred = INSTANCES[0];
  return [...INSTANCES];
}

export const INSTANCES = (process.env.UMBRA_PIPED_INSTANCES || [LOCAL, ...DEFAULT_INSTANCES].join(','))
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const TIMEOUT = Number(process.env.UMBRA_PIPED_TIMEOUT || 8000);
/* How long a failing instance is benched before it is tried again. */
const COOLDOWN = Number(process.env.UMBRA_PIPED_COOLDOWN || 120000);

/* Sticky instance + per-instance health. Staying on one instance that works
   keeps latency down and spreads load less erratically than round-robin. */
let preferred = INSTANCES[0] || '';
const benched = new Map(); // instance -> unix ms when it may be retried

function order() {
  const now = Date.now();
  const live = INSTANCES.filter((i) => (benched.get(i) || 0) <= now);
  const pool = live.length ? live : INSTANCES; // all benched: try anyway
  return [preferred, ...pool.filter((i) => i !== preferred)].filter((i) => pool.includes(i) || i === preferred);
}

export function instanceHealth() {
  const now = Date.now();
  return INSTANCES.map((i) => ({
    instance: i,
    preferred: i === preferred,
    benchedFor: Math.max(0, Math.round(((benched.get(i) || 0) - now) / 1000)),
  }));
}

/** Test seam. */
export function resetInstanceHealth() {
  benched.clear();
  preferred = INSTANCES[0] || '';
}

/**
 * GET one Piped API path, walking the pool until an instance answers with
 * usable JSON. Returns { json, instance, tried } so callers can report which
 * instance served them and what was attempted.
 */
export async function api(path) {
  const tried = [];
  for (const base of order()) {
    if (base === LOCAL) {
      /* same function a third party would reach over HTTP, called directly */
      try {
        const qi = path.indexOf('?');
        const json = await localHandle(
          qi < 0 ? path : path.slice(0, qi),
          new URLSearchParams(qi < 0 ? '' : path.slice(qi + 1)));
        preferred = base;
        benched.delete(base);
        return { json, instance: base, tried };
      } catch (e) {
        tried.push({ instance: base, note: String(e.message || e).slice(0, 120) });
        benched.set(base, Date.now() + COOLDOWN);
        continue;
      }
    }
    try {
      const res = await upstream(base + path, {
        headers: {
          accept: 'application/json',
          'accept-language': 'en-US,en;q=0.9',
          referer: base + '/',
        },
        timeout: TIMEOUT,
      });
      if (res.status !== 200) {
        res.res.resume();
        tried.push({ instance: base, note: 'http ' + res.status });
        benched.set(base, Date.now() + COOLDOWN);
        continue;
      }
      const body = (await readBody(res.res, { limit: 8 * 1024 * 1024 })).toString('utf8');
      const json = JSON.parse(body);
      /* Piped reports upstream extraction failures as a 200 with an error
         field — treat that as an instance failure, not as data. */
      if (json && json.error) {
        tried.push({ instance: base, note: String(json.error).slice(0, 120) });
        benched.set(base, Date.now() + COOLDOWN);
        continue;
      }
      preferred = base;
      benched.delete(base);
      return { json, instance: base, tried };
    } catch (e) {
      tried.push({ instance: base, note: String(e.message || e).slice(0, 120) });
      benched.set(base, Date.now() + COOLDOWN);
    }
  }
  /* An instance that was skipped for cooldown never appears in the loop, so
     without this the report reads as though it was never part of the pool at
     all — which is exactly how "it only tried Piped" looks when the local
     instance is benched. Silent omission is worse than a boring line. */
  const now = Date.now();
  for (const i of INSTANCES) {
    const until = benched.get(i) || 0;
    if (until > now && !tried.some((t) => t.instance === i)) {
      tried.push({ instance: i, note: `skipped — in cooldown for ${Math.round((until - now) / 1000)}s` });
    }
  }
  const err = new Error('no piped instance answered ' + path);
  err.tried = tried;
  throw err;
}

/* ------------------------------------------------------------- helpers */

/** Piped hands back site-relative refs like "/watch?v=ID" and "/channel/ID". */
export function videoIdOf(u) {
  const m = /[?&]v=([\w-]{11})/.exec(String(u || '')) || /^\/?([\w-]{11})$/.exec(String(u || ''));
  return m ? m[1] : null;
}
export function channelIdOf(u) {
  const m = /\/channel\/([\w-]+)/.exec(String(u || ''));
  return m ? m[1] : null;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* UMBRA_YT_BASE moves the YouTube origin (the offline suite points it at a
   mock). The embed and watch documents are YouTube requests like any other. */
const YT_WATCH_BASE = () => (process.env.UMBRA_YT_BASE || 'https://www.youtube.com').replace(/\/$/, '');
const NOCOOKIE_BASE = () => (process.env.UMBRA_YT_BASE || 'https://www.youtube-nocookie.com').replace(/\/$/, '');

/**
 * Point an image back at the host that actually owns it.
 *
 * Piped and Invidious hand out thumbnails and avatars through their *own*
 * image proxy (`https://proxy.<instance>/vi/<id>/hq.jpg?host=i.ytimg.com`),
 * which is useful to their clients and useless to Umbra: we proxy every byte
 * ourselves, so routing an i.ytimg.com image through a third party adds a hop
 * and a dependency on a host that may well be gone — a dead instance's proxy
 * is exactly how a page full of 404 thumbnails happens, long after the API
 * call that named them succeeded.
 *
 * Conservative on purpose: only the shapes those two projects actually mint
 * are unwrapped, and anything else is handed back untouched.
 */
const YT_IMG_HOST = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com|youtube\.com)$/i;
export function unproxyImage(raw) {
  const s = String(raw || '');
  if (!/^https?:\/\//i.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return s; }
  if (YT_IMG_HOST.test(u.hostname)) return s;
  /* 1. the explicit form: the real host travels as ?host= */
  const declared = u.searchParams.get('host');
  if (declared && YT_IMG_HOST.test(declared)) {
    u.searchParams.delete('host');
    const q = u.searchParams.toString();
    return 'https://' + declared + u.pathname + (q ? '?' + q : '');
  }
  /* 2. the implicit form: the path alone identifies the owner. A ?host= we
     refused to believe travels no further — it is the proxy's routing
     instruction, not part of the image's address. */
  if (declared) u.searchParams.delete('host');
  const q = u.searchParams.toString();
  const tail = (q ? '?' + q : '') + u.hash;
  if (/^\/(vi|vi_webp|sb)\//.test(u.pathname)) return 'https://i.ytimg.com' + u.pathname + tail;
  if (/^\/(ggpht|ytc)\//.test(u.pathname)) return 'https://yt3.ggpht.com' + u.pathname.replace(/^\/ggpht/, '') + tail;
  return s;
}

/** Normalise one list item (search / trending / related / channel video). */
export function normItem(it, ctx) {
  const id = videoIdOf(it.url);
  return {
    videoId: id,
    title: it.title || '',
    uploader: it.uploaderName || it.uploader || '',
    channelId: channelIdOf(it.uploaderUrl),
    verified: !!it.uploaderVerified,
    duration: num(it.duration),
    views: num(it.views),
    uploaded: it.uploadedDate || it.uploaded || '',
    desc: it.shortDescription || '',
    isShort: !!it.isShort,
    thumb: unproxyImage(it.thumbnail || ''),
    thumbWire: it.thumbnail ? href(ctx, unproxyImage(it.thumbnail), 's') : null,
    avatarWire: it.uploaderAvatar ? href(ctx, unproxyImage(it.uploaderAvatar), 's') : null,
  };
}

/**
 * Convert a Piped /streams response into exactly the payload shape the
 * existing Umbra player capsule already consumes, so playback, quality
 * switching, dual-track sync and captions all work unchanged.
 */
export function toPlayerPayload(s, ctx, videoId, instance) {
  const wire = (f) => ({ ...f, wire: href(ctx, f.url, 'm') });

  const mk = (st, kind) => ({
    kind,
    itag: st.itag || 0,
    mime: st.mimeType || '',
    url: st.url,
    label: st.quality || '',
    quality: st.quality || '',
    fps: num(st.fps),
    codecs: st.codec || '',
    contentLength: num(st.contentLength),
    bitrate: num(st.bitrate),
    width: num(st.width),
    height: num(st.height),
    audioOnly: kind === 'audio',
    format: st.format || '',
  });

  const vs = Array.isArray(s.videoStreams) ? s.videoStreams : [];
  const as = Array.isArray(s.audioStreams) ? s.audioStreams : [];

  /* videoOnly=false in videoStreams is a progressive (muxed) rendition */
  const muxed = vs.filter((f) => f.url && !f.videoOnly).map((f) => mk(f, 'muxed'))
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  const video = vs.filter((f) => f.url && f.videoOnly).map((f) => mk(f, 'video'))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0));
  const audio = as.filter((f) => f.url).map((f) => mk(f, 'audio'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  /* Piped subtitle URLs are proxied YouTube timedtext, so asking for json3
     lets Umbra's existing WebVTT converter handle them unchanged. */
  const captions = (Array.isArray(s.subtitles) ? s.subtitles : [])
    .filter((t) => t.url)
    .slice(0, 8)
    .map((t) => {
      const raw = t.url + (t.url.includes('?') ? '&' : '?') + 'fmt=json3';
      return {
        raw,
        code: t.code || 'und',
        label: (t.name || t.code || 'subtitles') + (t.autoGenerated ? ' (auto)' : ''),
        wire: href(ctx, raw, 's'),
      };
    });

  const thumb = unproxyImage(s.thumbnailUrl || '');
  const ok = !!(muxed.length || video.length);

  return {
    ok,
    source: 'piped',
    instance,
    videoId,
    title: s.title || videoId,
    author: s.uploader || '',
    channel: s.uploader || '',
    channelUrl: s.uploaderUrl || '',
    channelId: channelIdOf(s.uploaderUrl),
    verified: !!s.uploaderVerified,
    duration: num(s.duration),
    thumb,
    thumbWire: thumb ? href(ctx, thumb, 's') : null,
    hqWire: thumb ? href(ctx, thumb, 's') : null,
    desc: s.description || '',
    isLive: !!s.livestream,
    views: num(s.views),
    likes: num(s.likes),
    uploadDate: s.uploadDate || '',
    playability: ok ? 'OK' : 'NO_STREAMS',
    reason: ok ? null : 'this instance returned no playable streams for the video',
    muxed: muxed.slice(0, 8).map(wire),
    video: video.slice(0, 8).map(wire),
    audio: audio.slice(0, 3).map(wire),
    captions,
    hls: s.hls || null,
    hlsWire: s.hls ? href(ctx, s.hls, 'm') : null,
    related: (Array.isArray(s.relatedStreams) ? s.relatedStreams : [])
      .filter((r) => videoIdOf(r.url))
      .slice(0, 12)
      .map((r) => normItem(r, ctx)),
    /* the capsule links back out to the native path for comparison */
    /* The embed is a real fallback, not a link: when extraction yields
       nothing this is what the page plays. It honours the YouTube base
       override for the same reason every other YouTube call does — a test
       that cannot reach the surface cannot prove it works. */
    embedDoc: href(ctx, NOCOOKIE_BASE() + '/embed/' + videoId, 'd'),
    /* Read at call time, not at import time, so the suite can toggle it per
       request. Present unless the operator switched it off. */
    directEmbed: !/^(0|false|no|off)$/i.test(process.env.UMBRA_DIRECT_EMBED || '')
      ? 'https://www.youtube-nocookie.com/embed/' + videoId + '?rel=0&modestbranding=1'
      : null,
    watchDoc: href(ctx, YT_WATCH_BASE() + '/watch?v=' + videoId, 'd'),
  };
}

/* --------------------------------------------------------- endpoints */

export async function streams(videoId, ctx) {
  const { json, instance, tried } = await api('/streams/' + encodeURIComponent(videoId));
  const payload = toPlayerPayload(json, ctx, videoId, instance);
  payload.tried = tried;
  return payload;
}

export async function search(q, ctx, filter = 'videos') {
  const { json, instance, tried } = await api(
    '/search?q=' + encodeURIComponent(q) + '&filter=' + encodeURIComponent(filter));
  const items = Array.isArray(json.items) ? json.items : [];
  return {
    query: q,
    instance,
    tried,
    corrected: !!json.corrected,
    suggestion: json.suggestion || '',
    items: items.filter((i) => videoIdOf(i.url)).map((i) => normItem(i, ctx)),
  };
}

export async function trending(region, ctx) {
  const { json, instance, tried } = await api('/trending?region=' + encodeURIComponent(region || 'US'));
  const items = Array.isArray(json) ? json : [];
  return {
    region: region || 'US',
    instance,
    tried,
    items: items.filter((i) => videoIdOf(i.url)).map((i) => normItem(i, ctx)),
  };
}

export async function channel(id, ctx) {
  const { json, instance, tried } = await api('/channel/' + encodeURIComponent(id));
  return {
    instance,
    tried,
    id: json.id || id,
    name: json.name || id,
    description: json.description || '',
    subscribers: num(json.subscriberCount),
    verified: !!json.verified,
    avatarWire: json.avatarUrl ? href(ctx, json.avatarUrl, 's') : null,
    bannerWire: json.bannerUrl ? href(ctx, json.bannerUrl, 's') : null,
    items: (Array.isArray(json.relatedStreams) ? json.relatedStreams : [])
      .filter((i) => videoIdOf(i.url))
      .map((i) => normItem(i, ctx)),
  };
}

export async function comments(videoId, ctx) {
  const { json, instance, tried } = await api('/comments/' + encodeURIComponent(videoId));
  return {
    instance,
    tried,
    disabled: !!json.disabled,
    items: (Array.isArray(json.comments) ? json.comments : []).slice(0, 40).map((c) => ({
      author: c.author || '',
      text: c.commentText || '',
      when: c.commentedTime || '',
      likes: num(c.likeCount),
      pinned: !!c.pinned,
      hearted: !!c.hearted,
      verified: !!c.verified,
      avatarWire: c.thumbnail ? href(ctx, c.thumbnail, 's') : null,
    })),
  };
}
