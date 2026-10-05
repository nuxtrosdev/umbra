/**
 * Piped provider.
 *
 * Piped wraps NewPipeExtractor, which makes it the most structurally different
 * backend from Invidious in the pool — when YouTube changes something that
 * breaks one parser, the other often survives. That independence is the whole
 * reason to carry both.
 *
 * This adapter does not reimplement the Piped client. `server/piped.mjs`
 * already owns the instance pool, the local in-process instance and the
 * bench/cooldown logic, and it is load-bearing for Umbra Tube. Here it is
 * wrapped and normalized, so the existing behaviour is preserved exactly while
 * the result joins the common vocabulary.
 */

import * as piped from '../piped.mjs';
import * as T from './types.mjs';

export const id = 'piped';
export const name = 'Piped';

export const capabilities = {
  search: true, video: true, channel: true, playlist: true,
  comments: true, recommendations: true, streams: true, trending: true,
};

/** Piped returns site-relative refs: "/watch?v=ID", "/channel/UC…". */
const vidId = (u) => piped.videoIdOf(u);
const chanId = (u) => piped.channelIdOf(u);

function itemFrom(r, instance) {
  const vid = vidId(r.url) || r.id;
  return T.video({
    id: vid,
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
    live: r.isShort ? false : r.duration === -1,
    short: r.isShort === true,
  }, { provider: id, instance });
}

/* The underlying client throws with `.tried` already attached; keep it. */
async function viaPool(path, map) {
  const { json, instance, tried } = await piped.api(path);
  const out = map(json, instance);
  if (out && typeof out === 'object' && !Array.isArray(out)) out.providerInstance = instance;
  return { out, instance, tried };
}

export async function search(query, { limit = 30, filter = 'videos' } = {}) {
  const { out, instance, tried } = await viaPool(
    `/search?q=${encodeURIComponent(query)}&filter=${encodeURIComponent(filter)}`,
    (j, inst) => (j.items || []).map((r) => itemFrom(r, inst)).filter(Boolean));
  return { data: out.slice(0, limit), instance: { id: `${id}:${instance}`, baseUrl: instance }, tried };
}

export async function getVideo(videoId) {
  const { out, instance, tried } = await viaPool(`/streams/${encodeURIComponent(videoId)}`, (j, inst) => {
    const v = T.video({
      id: videoId,
      title: j.title,
      description: j.description,
      author: {
        id: chanId(j.uploaderUrl),
        name: j.uploader,
        avatar: j.uploaderAvatar,
        verified: j.uploaderVerified === true,
      },
      thumbnails: j.thumbnailUrl ? [{ url: j.thumbnailUrl }] : [],
      duration: j.duration,
      publishedText: j.uploadDate,
      viewCount: j.views,
      live: j.livestream === true,
      metadata: { likeCount: T.num(j.likes), dislikeCount: T.num(j.dislikes) },
    }, { provider: id, instance: inst });
    if (!v) throw new Error('video payload failed validation');
    v.metadata.recommendations = (j.relatedStreams || []).map((r) => itemFrom(r, inst)).filter(Boolean);
    return v;
  });
  return { data: out, instance: { id: `${id}:${instance}`, baseUrl: instance }, tried };
}

export async function getChannel(channelId) {
  const { out, instance, tried } = await viaPool(`/channel/${encodeURIComponent(channelId)}`, (j, inst) => {
    const c = T.channel({
      id: j.id || channelId,
      name: j.name,
      description: j.description,
      avatars: j.avatarUrl ? [{ url: j.avatarUrl }] : [],
      banners: j.bannerUrl ? [{ url: j.bannerUrl }] : [],
      subscriberCount: j.subscriberCount,
      verified: j.verified === true,
      videos: (j.relatedStreams || []).map((r) => itemFrom(r, inst)).filter(Boolean),
    }, { provider: id, instance: inst });
    if (!c) throw new Error('channel payload failed validation');
    return c;
  });
  return { data: out, instance: { id: `${id}:${instance}`, baseUrl: instance }, tried };
}

export async function getPlaylist(playlistId) {
  const { out, instance, tried } = await viaPool(`/playlists/${encodeURIComponent(playlistId)}`, (j, inst) => {
    const p = T.playlist({
      id: playlistId,
      title: j.name,
      description: j.description,
      author: { id: chanId(j.uploaderUrl), name: j.uploader, avatar: j.uploaderAvatar },
      thumbnails: j.thumbnailUrl ? [{ url: j.thumbnailUrl }] : [],
      videoCount: j.videos,
      videos: (j.relatedStreams || []).map((r) => itemFrom(r, inst)).filter(Boolean),
    }, { provider: id, instance: inst });
    if (!p) throw new Error('playlist payload failed validation');
    return p;
  });
  return { data: out, instance: { id: `${id}:${instance}`, baseUrl: instance }, tried };
}

export async function getComments(videoId) {
  const { out, instance, tried } = await viaPool(`/comments/${encodeURIComponent(videoId)}`, (j, inst) => ({
    items: (j.comments || []).map((c) => T.comment({
      id: c.commentId,
      text: c.commentText,
      author: { id: chanId(c.commentorUrl), name: c.author, avatar: c.thumbnail, verified: c.verified === true },
      publishedText: c.commentedTime,
      likeCount: c.likeCount,
      replyCount: c.replyCount,
      pinned: c.pinned === true,
      hearted: c.hearted === true,
    }, { provider: id, instance: inst })).filter(Boolean),
    disabled: j.disabled === true,
    total: T.num(j.commentCount),
  }));
  return { data: out, instance: { id: `${id}:${instance}`, baseUrl: instance }, tried };
}

export async function getRecommendations(videoId) {
  const { out, instance, tried } = await viaPool(`/streams/${encodeURIComponent(videoId)}`,
    (j, inst) => (j.relatedStreams || []).map((r) => itemFrom(r, inst)).filter(Boolean));
  return { data: out, instance: { id: `${id}:${instance}`, baseUrl: instance }, tried };
}

export async function trending(region = 'US') {
  const { out, instance, tried } = await viaPool(`/trending?region=${encodeURIComponent(region)}`,
    (j, inst) => (Array.isArray(j) ? j : []).map((r) => itemFrom(r, inst)).filter(Boolean));
  return { data: out, instance: { id: `${id}:${instance}`, baseUrl: instance }, tried };
}

export async function getStreams(videoId) {
  const { out, instance, tried } = await viaPool(`/streams/${encodeURIComponent(videoId)}`, (j, inst) => {
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
        url: f.url, itag: f.itag, mimeType: f.mimeType, codec: f.codec, quality: f.quality,
        bitrate: f.bitrate, audioOnly: true,
      })),
      subtitles: (j.subtitles || []).map((c) => ({
        url: c.url, code: c.code, name: c.name, autoGenerated: c.autoGenerated === true,
      })),
      hls: j.hls,
      dash: j.dash,
      proxyUrl: j.proxyUrl,
    }, { provider: id, instance: inst });
    if (!s) throw new Error('stream payload failed validation');
    return s;
  });
  return { data: out, instance: { id: `${id}:${instance}`, baseUrl: instance }, tried };
}

export async function healthCheck() {
  const t0 = Date.now();
  try {
    const { instance } = await piped.api('/healthcheck');
    return { provider: id, healthy: true, latency: Date.now() - t0, instance };
  } catch (e) {
    return { provider: id, healthy: false, latency: Date.now() - t0, error: String(e.message || e) };
  }
}

/** Surfaced through the debug endpoint alongside the new-style pools. */
export function report() {
  return piped.instanceHealth().map((i) => ({
    id: `${id}:${i.instance}`,
    provider: id,
    baseUrl: i.instance,
    status: i.benchedFor > 0 ? 'COOLDOWN' : (i.preferred ? 'ONLINE' : 'UNKNOWN'),
    healthy: i.benchedFor === 0,
    latency: null,
    failures: i.benchedFor > 0 ? 1 : 0,
    preferred: i.preferred,
    capabilities: Object.keys(capabilities).filter((k) => capabilities[k]),
    cooldownUntil: i.benchedFor > 0 ? new Date(Date.now() + i.benchedFor * 1000).toISOString() : null,
  }));
}
