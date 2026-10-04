/**
 * YouTube.js provider (optional dependency).
 *
 * YouTube.js is the most actively maintained InnerTube client in the JS
 * ecosystem, and it carries the one thing our native engine does not: a
 * player-script interpreter that deobfuscates signature and `n` parameters.
 * When YouTube returns ciphered formats, this adapter can still produce
 * playable URLs where `providers/innertube.mjs` cannot.
 *
 * It is an optional dependency on purpose. Umbra has no node_modules and the
 * rest of the proxy runs on the standard library alone; adding a hard
 * dependency for a fallback would be a poor trade. The import is lazy and
 * failure to resolve it disables the provider cleanly rather than crashing
 * the server, so `npm i youtubei.js` is all that is needed to turn it on.
 */

import { InstancePool, ProviderInstance } from './pool.mjs';
import * as T from './types.mjs';

export const id = 'youtubejs';
export const name = 'YouTube.js';

export const capabilities = {
  search: true, video: true, channel: true, playlist: true,
  comments: true, recommendations: true, streams: true, trending: true,
};

const self = new ProviderInstance('', id, {
  id: 'youtubejs:in-process',
  local: true,
  capabilities: Object.keys(capabilities).filter((k) => capabilities[k]),
});
export const pool = new InstancePool(id, [self]);

let yt = null;
let loadState = null; /* null = untried, 'ok', or a reason string */

/** Resolve and memoise the client. Absence is reported, never thrown past. */
async function client() {
  if (yt) return yt;
  if (loadState && loadState !== 'ok') throw new Error(loadState);
  try {
    const mod = await import('youtubei.js');
    const Innertube = mod.Innertube || mod.default?.Innertube || mod.default;
    yt = await Innertube.create({ retrieve_player: true, generate_session_locally: true });
    loadState = 'ok';
    return yt;
  } catch (e) {
    loadState = /Cannot find (module|package)/i.test(String(e && e.message))
      ? 'youtubei.js is not installed (npm i youtubei.js)'
      : 'youtubei.js failed to initialise: ' + String(e && e.message).slice(0, 120);
    throw new Error(loadState);
  }
}

export async function available() {
  try { await client(); return true; } catch { return false; }
}
export const enabled = () => loadState !== 'ok' ? loadState === null : true;

/* YouTube.js node shapes are deeply optional; read defensively throughout. */
const textOf = (t) => (typeof t === 'string' ? t : (t && (t.text || t.toString?.())) || '');
const thumbsOf = (n) => (n && n.thumbnails) || (n && n.thumbnail) || [];

function vidFrom(v) {
  if (!v) return null;
  return T.video({
    id: v.id || v.video_id,
    title: textOf(v.title),
    description: textOf(v.description || v.description_snippet),
    author: {
      id: v.author?.id,
      name: textOf(v.author?.name),
      avatar: thumbsOf(v.author)[0]?.url,
      verified: v.author?.is_verified === true,
    },
    thumbnails: thumbsOf(v),
    duration: v.duration?.seconds ?? v.duration,
    publishedText: textOf(v.published),
    viewCount: v.view_count?.text ?? v.view_count,
    live: v.is_live === true,
  }, { provider: id, instance: 'in-process' });
}

export async function search(query, { limit = 30 } = {}) {
  return pool.run(async () => {
    const c = await client();
    const r = await c.search(query, { type: 'video' });
    return (r.videos || r.results || []).map(vidFrom).filter(Boolean).slice(0, limit);
  }, { capability: 'search' });
}

export async function getVideo(videoId) {
  return pool.run(async () => {
    const c = await client();
    const info = await c.getInfo(videoId);
    const b = info.basic_info || {};
    const v = T.video({
      id: b.id || videoId,
      title: b.title,
      description: b.short_description,
      author: { id: b.channel_id, name: b.author, avatar: thumbsOf(info.secondary_info?.owner?.author)[0]?.url },
      thumbnails: b.thumbnail || [],
      duration: b.duration,
      viewCount: b.view_count,
      live: b.is_live === true,
      metadata: { likeCount: T.num(b.like_count) },
    }, { provider: id, instance: 'in-process' });
    if (!v) throw new Error('video payload failed validation');
    return v;
  }, { capability: 'video' });
}

export async function getChannel(channelId) {
  return pool.run(async () => {
    const c = await client();
    const ch = await c.getChannel(channelId);
    const meta = ch.metadata || {};
    const out = T.channel({
      id: meta.external_id || channelId,
      name: meta.title,
      description: meta.description,
      avatars: meta.avatar || [],
      subscriberCount: textOf(ch.header?.subscribers),
      videos: (ch.videos || []).map(vidFrom).filter(Boolean),
    }, { provider: id, instance: 'in-process' });
    if (!out) throw new Error('channel payload failed validation');
    return out;
  }, { capability: 'channel' });
}

export async function getPlaylist(playlistId) {
  return pool.run(async () => {
    const c = await client();
    const pl = await c.getPlaylist(playlistId);
    const p = T.playlist({
      id: playlistId,
      title: textOf(pl.info?.title),
      description: textOf(pl.info?.description),
      author: { name: textOf(pl.info?.author?.name) },
      videoCount: pl.info?.total_items,
      videos: (pl.videos || []).map(vidFrom).filter(Boolean),
    }, { provider: id, instance: 'in-process' });
    if (!p) throw new Error('playlist payload failed validation');
    return p;
  }, { capability: 'playlist' });
}

export async function getComments(videoId) {
  return pool.run(async () => {
    const c = await client();
    const res = await c.getComments(videoId);
    return {
      items: (res.contents || []).map((n) => {
        const cm = n.comment || n;
        return T.comment({
          id: cm.comment_id,
          text: textOf(cm.content),
          author: { id: cm.author?.id, name: textOf(cm.author?.name), avatar: thumbsOf(cm.author)[0]?.url },
          publishedText: textOf(cm.published_time || cm.published),
          likeCount: cm.like_count,
          pinned: cm.is_pinned === true,
          hearted: cm.is_hearted === true,
        }, { provider: id, instance: 'in-process' });
      }).filter(Boolean),
      disabled: false,
    };
  }, { capability: 'comments' });
}

export async function getRecommendations(videoId) {
  return pool.run(async () => {
    const c = await client();
    const info = await c.getInfo(videoId);
    return (info.watch_next_feed || []).map(vidFrom).filter(Boolean);
  }, { capability: 'recommendations' });
}

export async function trending() {
  return pool.run(async () => {
    const c = await client();
    const t = await c.getTrending();
    return (t.videos || []).map(vidFrom).filter(Boolean);
  }, { capability: 'trending' });
}

/**
 * The reason this provider is worth carrying: `chooseFormat`/`decipher` run
 * the player script, so ciphered URLs come back usable.
 */
export async function getStreams(videoId) {
  return pool.run(async () => {
    const c = await client();
    const info = await c.getInfo(videoId);
    const all = [...(info.streaming_data?.formats || []), ...(info.streaming_data?.adaptive_formats || [])];
    const deciphered = all.map((f) => {
      let u = f.url;
      try { if (!u && typeof f.decipher === 'function') u = f.decipher(c.session.player); } catch { u = null; }
      return { f, u };
    });
    const mk = ({ f, u }) => ({
      url: u, itag: f.itag, mimeType: f.mime_type, quality: f.quality_label || f.quality,
      bitrate: f.bitrate, width: f.width, height: f.height, fps: f.fps,
      contentLength: f.content_length,
    });
    const s = T.streamInfo({
      id: videoId,
      title: info.basic_info?.title,
      duration: info.basic_info?.duration,
      live: info.basic_info?.is_live === true,
      videoStreams: deciphered.filter((x) => x.u && /^video\//.test(String(x.f.mime_type || '')))
        .map((x) => ({ ...mk(x), videoOnly: !/mp4a|opus/.test(String(x.f.mime_type || '')) })),
      audioStreams: deciphered.filter((x) => x.u && /^audio\//.test(String(x.f.mime_type || '')))
        .map((x) => ({ ...mk(x), audioOnly: true })),
      subtitles: (info.captions?.caption_tracks || []).map((t) => ({
        url: t.base_url, code: t.language_code, name: textOf(t.name), autoGenerated: t.kind === 'asr',
      })),
      hls: info.streaming_data?.hls_manifest_url,
      dash: info.streaming_data?.dash_manifest_url,
    }, { provider: id, instance: 'in-process' });
    if (!s || (!s.videoStreams.length && !s.audioStreams.length && !s.hls)) {
      throw new Error('no playable formats after deciphering');
    }
    return s;
  }, { capability: 'streams' });
}

export async function healthCheck() {
  const t0 = Date.now();
  const ok = await available();
  return ok
    ? { provider: id, healthy: true, latency: Date.now() - t0, instance: self.id }
    : { provider: id, healthy: false, disabled: true, reason: loadState };
}

export function report() {
  return pool.report().map((r) => ({
    ...r,
    status: loadState && loadState !== 'ok' ? 'DISABLED' : r.status,
    lastError: loadState && loadState !== 'ok' ? loadState : r.lastError,
  }));
}
