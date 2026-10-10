/**
 * Invidious provider.
 *
 * Invidious is the oldest of the alternative front ends and the one with the
 * most complete JSON API, which makes it the best-behaved metadata source in
 * the pool. It extracts server-side on its own address, so it is genuinely
 * independent of our egress — the main reason to keep it even when our own
 * InnerTube extraction is working.
 *
 * Instances are never hardcoded to one host. The pool is seeded from
 * UMBRA_INVIDIOUS_INSTANCES, falling back to a list of long-lived public ones,
 * and can be refreshed at runtime from the project's instance directory.
 */

import { InstancePool, ProviderInstance, getJson, envList } from './pool.mjs';
import * as T from './types.mjs';

export const id = 'invidious';
export const name = 'Invidious';

export const capabilities = {
  search: true, video: true, channel: true, playlist: true,
  comments: true, recommendations: true, streams: true, trending: true,
};

/* Seeds only. The instance directory below is the authoritative list, and
   operators are expected to override this with a pool they trust. */
const SEED = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.jing.rocks',
  'https://inv.tux.pizza',
];

/** The project publishes a machine-readable directory of public instances. */
const DIRECTORY = process.env.UMBRA_INVIDIOUS_DIRECTORY || 'https://api.invidious.io/instances.json';

export const pool = new InstancePool(
  id,
  envList('UMBRA_INVIDIOUS_INSTANCES', SEED),
  { capabilities: Object.keys(capabilities).filter((k) => capabilities[k]) });

/**
 * Replace the pool from the public directory.
 *
 * Filtered to https instances that report themselves up and have the API
 * enabled — an instance with `api: false` will 404 every call we make, and
 * discovering that one request at a time is exactly the waste the health
 * system exists to avoid.
 */
export async function refreshInstances({ limit = 8 } = {}) {
  const list = await getJson(DIRECTORY, { timeout: 10000 });
  if (!Array.isArray(list)) throw new Error('instance directory was not a list');
  const picked = [];
  for (const entry of list) {
    const [host, meta] = Array.isArray(entry) ? entry : [null, null];
    if (!host || !meta || meta.type !== 'https') continue;
    if (meta.api === false) continue;
    if (meta.monitor && meta.monitor.down === true) continue;
    picked.push('https://' + String(host).replace(/\/+$/, ''));
    if (picked.length >= limit) break;
  }
  if (!picked.length) throw new Error('instance directory had no usable https instances');
  pool.instances = picked.map((b) => new ProviderInstance(b, id, {
    capabilities: Object.keys(capabilities).filter((k) => capabilities[k]),
  }));
  return picked;
}

const call = (inst, path) => getJson(inst.baseUrl + path);

/* --------------------------------------------------------- normalizing */

function vidFrom(r, inst) {
  return T.video({
    id: r.videoId,
    title: r.title,
    description: r.description,
    author: {
      id: r.authorId,
      name: r.author,
      avatar: (r.authorThumbnails || []).slice(-1)[0]?.url,
      verified: r.authorVerified === true,
    },
    thumbnails: r.videoThumbnails || [],
    duration: r.lengthSeconds,
    publishedAt: r.published,
    publishedText: r.publishedText,
    viewCount: r.viewCount ?? r.viewCountText,
    live: r.liveNow === true,
    metadata: { premium: r.premium === true },
  }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl });
}

function commentFrom(c, inst) {
  return T.comment({
    id: c.commentId,
    text: c.content,
    author: { id: c.authorId, name: c.author, avatar: c.authorThumbnail },
    publishedAt: c.published,
    publishedText: c.publishedText,
    likeCount: c.likeCount,
    replyCount: c.replies && c.replies.replyCount,
    pinned: c.isPinned === true,
    hearted: !!c.creatorHeart,
  }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl });
}

/* ------------------------------------------------------------ methods */

export async function search(query, { limit = 30, region } = {}) {
  return pool.run(async (inst) => {
    const qs = new URLSearchParams({ q: query, type: 'video' });
    if (region) qs.set('region', region);
    const j = await call(inst, '/api/v1/search?' + qs);
    if (!Array.isArray(j)) throw new Error('search did not return a list');
    return j.filter((r) => r && r.type === 'video')
      .map((r) => vidFrom(r, inst)).filter(Boolean).slice(0, limit);
  }, { capability: 'search' });
}

export async function getVideo(videoId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/api/v1/videos/' + encodeURIComponent(videoId));
    const v = vidFrom(j, inst);
    if (!v) throw new Error('video payload failed validation');
    v.metadata.likeCount = T.num(j.likeCount);
    v.metadata.subscriberText = T.str(j.subCountText, 32);
    v.metadata.recommendations = (j.recommendedVideos || [])
      .map((r) => vidFrom(r, inst)).filter(Boolean);
    return v;
  }, { capability: 'video' });
}

export async function getChannel(channelId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/api/v1/channels/' + encodeURIComponent(channelId));
    const c = T.channel({
      id: j.authorId || channelId,
      name: j.author,
      description: j.description,
      avatars: j.authorThumbnails || [],
      banners: j.authorBanners || [],
      subscriberCount: j.subCount,
      verified: j.authorVerified === true,
      videos: (j.latestVideos || []).map((r) => vidFrom(r, inst)).filter(Boolean),
    }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl });
    if (!c) throw new Error('channel payload failed validation');
    return c;
  }, { capability: 'channel' });
}

export async function getPlaylist(playlistId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/api/v1/playlists/' + encodeURIComponent(playlistId));
    const p = T.playlist({
      id: j.playlistId || playlistId,
      title: j.title,
      description: j.description,
      author: { id: j.authorId, name: j.author },
      thumbnails: j.playlistThumbnail ? [{ url: j.playlistThumbnail }] : [],
      videoCount: j.videoCount,
      videos: (j.videos || []).map((r) => vidFrom(r, inst)).filter(Boolean),
    }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl });
    if (!p) throw new Error('playlist payload failed validation');
    return p;
  }, { capability: 'playlist' });
}

export async function getComments(videoId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/api/v1/comments/' + encodeURIComponent(videoId));
    return {
      items: (j.comments || []).map((c) => commentFrom(c, inst)).filter(Boolean),
      disabled: !j.comments,
      total: T.num(j.commentCount),
    };
  }, { capability: 'comments' });
}

export async function getRecommendations(videoId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/api/v1/videos/' + encodeURIComponent(videoId));
    return (j.recommendedVideos || []).map((r) => vidFrom(r, inst)).filter(Boolean);
  }, { capability: 'recommendations' });
}

export async function trending(region = 'US') {
  return pool.run(async (inst) => {
    const j = await call(inst, '/api/v1/trending?region=' + encodeURIComponent(region));
    if (!Array.isArray(j)) throw new Error('trending did not return a list');
    return j.map((r) => vidFrom(r, inst)).filter(Boolean);
  }, { capability: 'trending' });
}

/* A googlevideo URL an Invidious instance was handed is bound to the address
 * that asked for it — its `ip=` parameter names the instance, not us. Handing
 * those straight to a browser behind a different address is the single most
 * common way a "working" extraction still plays nothing: the API call
 * succeeds, the formats look real, and every byte request is refused.
 *
 * Every Invidious instance can stream the bytes itself instead, which is what
 * `local=true` means on its own URLs and what /latest_version exists for. The
 * instance already has a relationship with Google that works; borrow it. The
 * bytes then travel instance → Umbra → browser, and the only address Google
 * ever sees belongs to a machine whose whole job is to be seen.
 *
 * The raw URL is kept as a fallback for the case where our address is fine
 * and the direct fetch is simply faster. UMBRA_INVIDIOUS_LOCAL=0 restores the
 * old behaviour.
 */
/* read per call, not per import, so a deployment (and the suite) can flip it */
const localStreams = () => !/^(0|false|no|off)$/i.test(process.env.UMBRA_INVIDIOUS_LOCAL || '');

export function viaInstance(inst, videoId, f) {
  const raw = (f && f.url) || '';
  if (!localStreams() || !raw) return raw;
  try {
    /* the instance's own proxy path for a url it already holds */
    const u = new URL(raw);
    if (/(^|\.)googlevideo\.com$/i.test(u.hostname)) {
      const base = String(inst.baseUrl).replace(/\/$/, '');
      if (f.itag != null) {
        return base + '/latest_version?id=' + encodeURIComponent(videoId) +
          '&itag=' + encodeURIComponent(f.itag) + '&local=true';
      }
      /* no itag to ask for: route the exact url through the instance */
      u.searchParams.set('local', 'true');
      return base + '/videoplayback' + u.search;
    }
  } catch { /* not a url we understand: leave it alone */ }
  return raw;
}

export async function getStreams(videoId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/api/v1/videos/' + encodeURIComponent(videoId));
    const adaptive = j.adaptiveFormats || [];
    const via = (f) => viaInstance(inst, j.videoId || videoId, f);
    const s = T.streamInfo({
      id: j.videoId || videoId,
      title: j.title,
      duration: j.lengthSeconds,
      live: j.liveNow === true,
      videoStreams: [
        ...(j.formatStreams || []).map((f) => ({
          url: via(f), directUrl: f.url, itag: f.itag, mimeType: f.type, quality: f.qualityLabel || f.quality,
          bitrate: f.bitrate, fps: f.fps, videoOnly: false,
        })),
        ...adaptive.filter((f) => /^video\//.test(String(f.type || ''))).map((f) => ({
          url: via(f), directUrl: f.url, itag: f.itag, mimeType: f.type, quality: f.qualityLabel,
          bitrate: f.bitrate, fps: f.fps, width: f.width, height: f.height,
          contentLength: f.clen, videoOnly: true,
        })),
      ],
      audioStreams: adaptive.filter((f) => /^audio\//.test(String(f.type || ''))).map((f) => ({
        url: via(f), directUrl: f.url, itag: f.itag, mimeType: f.type, quality: f.audioQuality,
        bitrate: f.bitrate, contentLength: f.clen, audioOnly: true,
      })),
      subtitles: (j.captions || []).map((c) => ({
        url: T.absolute(c.url, inst.baseUrl), code: c.language_code || c.languageCode, name: c.label,
      })),
      hls: j.hlsUrl,
      dash: j.dashUrl,
    }, { provider: id, instance: inst.baseUrl });
    if (!s || (!s.videoStreams.length && !s.audioStreams.length && !s.hls)) {
      throw new Error('no playable formats in payload');
    }
    return s;
  }, { capability: 'streams' });
}

export async function healthCheck() {
  const t0 = Date.now();
  try {
    const { instance } = await pool.run((inst) => call(inst, '/api/v1/stats'), { capability: 'search', attempts: 1 });
    return { provider: id, healthy: true, latency: Date.now() - t0, instance: instance.id };
  } catch (e) {
    return { provider: id, healthy: false, latency: Date.now() - t0, error: String(e.message || e) };
  }
}

export function report() { return pool.report(); }
