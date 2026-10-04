/**
 * NewPipeExtractor provider.
 *
 * NewPipeExtractor is a Java library, not a service. It cannot be called from
 * Node directly, and shipping a JVM with this proxy to duplicate an engine we
 * already reach would be a bad trade — Piped *is* NewPipeExtractor behind an
 * HTTP API, and `providers/piped.mjs` already gives us that, across a whole
 * pool of instances, for free.
 *
 * So the honest integration is this: a thin adapter for a self-hosted
 * extractor bridge, off unless UMBRA_NEWPIPE_URL points at one. That covers
 * the operator who runs their own NewPipeExtractor HTTP wrapper and wants it
 * in the rotation as a distinct address, without pretending we have embedded
 * a Java library in a dependency-free Node server.
 *
 * The bridge is expected to speak the Piped API shape, which is the de-facto
 * contract for NewPipeExtractor-over-HTTP and lets this reuse the Piped
 * normalizer rather than inventing a third dialect.
 */

import { InstancePool, getJson, envList } from './pool.mjs';
import * as T from './types.mjs';

export const id = 'newpipe';
export const name = 'NewPipeExtractor (bridge)';

export const capabilities = {
  search: true, video: true, channel: true, playlist: true,
  comments: true, recommendations: true, streams: true, trending: true,
};

const BASES = envList('UMBRA_NEWPIPE_URL', []);

export const pool = new InstancePool(id, BASES, {
  capabilities: Object.keys(capabilities).filter((k) => capabilities[k]),
});

export const enabled = () => pool.instances.length > 0;

const call = (inst, path) => getJson(inst.baseUrl + path);
const vidId = (u) => (/[?&]v=([\w-]{11})/.exec(String(u || '')) || [])[1] || null;
const chanId = (u) => (/\/channel\/([\w-]+)/.exec(String(u || '')) || [])[1] || null;

function itemFrom(r, inst) {
  return T.video({
    id: vidId(r.url),
    title: r.title,
    description: r.shortDescription,
    author: {
      id: chanId(r.uploaderUrl),
      name: r.uploaderName || r.uploader,
      avatar: r.uploaderAvatar,
      verified: r.uploaderVerified === true,
    },
    thumbnails: r.thumbnail ? [{ url: r.thumbnail }] : [],
    duration: r.duration,
    publishedAt: r.uploaded,
    publishedText: r.uploadedDate,
    viewCount: r.views,
  }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl });
}

export async function search(query, { limit = 30 } = {}) {
  return pool.run(async (inst) => {
    const j = await call(inst, `/search?q=${encodeURIComponent(query)}&filter=videos`);
    return (j.items || []).map((r) => itemFrom(r, inst)).filter(Boolean).slice(0, limit);
  }, { capability: 'search' });
}

export async function getVideo(videoId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/streams/' + encodeURIComponent(videoId));
    const v = T.video({
      id: videoId,
      title: j.title,
      description: j.description,
      author: { id: chanId(j.uploaderUrl), name: j.uploader, avatar: j.uploaderAvatar },
      thumbnails: j.thumbnailUrl ? [{ url: j.thumbnailUrl }] : [],
      duration: j.duration,
      publishedText: j.uploadDate,
      viewCount: j.views,
      live: j.livestream === true,
    }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl });
    if (!v) throw new Error('video payload failed validation');
    return v;
  }, { capability: 'video' });
}

export async function getChannel(channelId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/channel/' + encodeURIComponent(channelId));
    const c = T.channel({
      id: j.id || channelId,
      name: j.name,
      description: j.description,
      avatars: j.avatarUrl ? [{ url: j.avatarUrl }] : [],
      banners: j.bannerUrl ? [{ url: j.bannerUrl }] : [],
      subscriberCount: j.subscriberCount,
      verified: j.verified === true,
      videos: (j.relatedStreams || []).map((r) => itemFrom(r, inst)).filter(Boolean),
    }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl });
    if (!c) throw new Error('channel payload failed validation');
    return c;
  }, { capability: 'channel' });
}

export async function getPlaylist(playlistId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/playlists/' + encodeURIComponent(playlistId));
    const p = T.playlist({
      id: playlistId,
      title: j.name,
      author: { name: j.uploader },
      thumbnails: j.thumbnailUrl ? [{ url: j.thumbnailUrl }] : [],
      videoCount: j.videos,
      videos: (j.relatedStreams || []).map((r) => itemFrom(r, inst)).filter(Boolean),
    }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl });
    if (!p) throw new Error('playlist payload failed validation');
    return p;
  }, { capability: 'playlist' });
}

export async function getComments(videoId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/comments/' + encodeURIComponent(videoId));
    return {
      items: (j.comments || []).map((c) => T.comment({
        id: c.commentId,
        text: c.commentText,
        author: { id: chanId(c.commentorUrl), name: c.author, avatar: c.thumbnail },
        publishedText: c.commentedTime,
        likeCount: c.likeCount,
        pinned: c.pinned === true,
      }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl })).filter(Boolean),
      disabled: j.disabled === true,
    };
  }, { capability: 'comments' });
}

export async function getRecommendations(videoId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/streams/' + encodeURIComponent(videoId));
    return (j.relatedStreams || []).map((r) => itemFrom(r, inst)).filter(Boolean);
  }, { capability: 'recommendations' });
}

export async function trending(region = 'US') {
  return pool.run(async (inst) => {
    const j = await call(inst, '/trending?region=' + encodeURIComponent(region));
    return (Array.isArray(j) ? j : []).map((r) => itemFrom(r, inst)).filter(Boolean);
  }, { capability: 'trending' });
}

export async function getStreams(videoId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/streams/' + encodeURIComponent(videoId));
    const s = T.streamInfo({
      id: videoId,
      title: j.title,
      duration: j.duration,
      live: j.livestream === true,
      videoStreams: (j.videoStreams || []).map((f) => ({
        url: f.url, itag: f.itag, mimeType: f.mimeType, codec: f.codec, quality: f.quality,
        bitrate: f.bitrate, width: f.width, height: f.height, fps: f.fps, videoOnly: f.videoOnly === true,
      })),
      audioStreams: (j.audioStreams || []).map((f) => ({
        url: f.url, itag: f.itag, mimeType: f.mimeType, codec: f.codec,
        quality: f.quality, bitrate: f.bitrate, audioOnly: true,
      })),
      subtitles: (j.subtitles || []).map((c) => ({ url: c.url, code: c.code, name: c.name })),
      hls: j.hls, dash: j.dash,
    }, { provider: id, instance: inst.baseUrl });
    if (!s) throw new Error('stream payload failed validation');
    return s;
  }, { capability: 'streams' });
}

export async function healthCheck() {
  if (!enabled()) {
    return { provider: id, healthy: false, disabled: true, reason: 'no bridge configured (UMBRA_NEWPIPE_URL)' };
  }
  const t0 = Date.now();
  try {
    const { instance } = await pool.run((inst) => call(inst, '/healthcheck'), { attempts: 1 });
    return { provider: id, healthy: true, latency: Date.now() - t0, instance: instance.id };
  } catch (e) {
    return { provider: id, healthy: false, latency: Date.now() - t0, error: String(e.message || e) };
  }
}

export function report() { return pool.report(); }
