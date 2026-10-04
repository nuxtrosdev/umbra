/**
 * Native InnerTube provider — Umbra's own extraction engine.
 *
 * This is the same class of backend as YouTube.js, NewPipeExtractor and
 * PokeTube: all four talk to YouTube's internal InnerTube API and parse the
 * renderer tree that comes back. We already implement that natively in
 * `piped-local.mjs`, with no npm dependency and no JVM, so this adapter wraps
 * it rather than adding a second engine that does the same job.
 *
 * Its one real weakness is the reason the HTTP-based providers stay in the
 * pool: extraction happens on *this* machine's address, which is the exact
 * thing YouTube rate-limits and bot-gates. Invidious and Piped extract from
 * someone else's. Keeping both kinds is the point of the pool.
 */

import * as local from '../piped-local.mjs';
import { innertubeRequest, getVisitorData } from '../innertube.mjs';
import { ProviderInstance, InstancePool } from './pool.mjs';
import * as T from './types.mjs';

export const id = 'innertube';
export const name = 'InnerTube (native)';

export const capabilities = {
  search: true, video: true, channel: true, playlist: true,
  comments: true, recommendations: true, streams: true, trending: true,
};

/* One "instance": ourselves. It still carries a health record so the debug
   surface and the scorer treat it like any other backend. */
const self = new ProviderInstance('', id, {
  id: 'innertube:in-process',
  local: true,
  capabilities: Object.keys(capabilities).filter((k) => capabilities[k]),
});
export const pool = new InstancePool(id, [self]);

const vidId = (u) => {
  const m = /[?&]v=([\w-]{11})/.exec(String(u || ''));
  return m ? m[1] : null;
};

function itemFrom(r) {
  return T.video({
    id: vidId(r.url),
    title: r.title,
    description: r.shortDescription,
    author: {
      id: (/\/channel\/([\w-]+)/.exec(String(r.uploaderUrl || '')) || [])[1],
      name: r.uploaderName,
      avatar: r.uploaderAvatar,
      verified: r.uploaderVerified === true,
    },
    thumbnails: r.thumbnail ? [{ url: r.thumbnail }] : [],
    duration: r.duration,
    publishedText: r.uploadedDate,
    viewCount: r.views,
    short: r.isShort === true,
  }, { provider: id, instance: 'in-process' });
}

export async function search(query, { limit = 30 } = {}) {
  return pool.run(async () => {
    const j = await local.search(query, 'videos');
    return (j.items || []).map(itemFrom).filter(Boolean).slice(0, limit);
  }, { capability: 'search' });
}

export async function getVideo(videoId) {
  return pool.run(async () => {
    const s = await local.streams(videoId);
    const v = T.video({
      id: videoId,
      title: s.title,
      description: s.description,
      author: {
        id: (/\/channel\/([\w-]+)/.exec(String(s.uploaderUrl || '')) || [])[1],
        name: s.uploader,
        avatar: s.uploaderAvatar,
        verified: s.uploaderVerified === true,
      },
      thumbnails: s.thumbnailUrl ? [{ url: s.thumbnailUrl }] : [],
      duration: s.duration,
      publishedText: s.uploadDate,
      viewCount: s.views,
      live: s.livestream === true,
      metadata: { likeCount: T.num(s.likes), umbraClient: s.umbraClient },
    }, { provider: id, instance: 'in-process' });
    if (!v) throw new Error('video payload failed validation');
    return v;
  }, { capability: 'video' });
}

export async function getChannel(channelId) {
  return pool.run(async () => {
    const j = await local.channel(channelId);
    const c = T.channel({
      id: j.id || channelId,
      name: j.name,
      description: j.description,
      avatars: j.avatarUrl ? [{ url: j.avatarUrl }] : [],
      banners: j.bannerUrl ? [{ url: j.bannerUrl }] : [],
      subscriberCount: j.subscriberCount,
      verified: j.verified === true,
      videos: (j.relatedStreams || []).map(itemFrom).filter(Boolean),
    }, { provider: id, instance: 'in-process' });
    if (!c) throw new Error('channel payload failed validation');
    return c;
  }, { capability: 'channel' });
}

/**
 * Playlists are a browse call with a VL-prefixed id — the one capability the
 * local instance did not already cover.
 */
export async function getPlaylist(playlistId) {
  return pool.run(async () => {
    const vis = (await getVisitorData({})).value;
    const browseId = /^VL/.test(playlistId) ? playlistId : 'VL' + playlistId;
    const j = await innertubeRequest('browse', { browseId }, local.METADATA_CLIENT, { visitorData: vis });
    const videos = local.videoItems(j).map(itemFrom).filter(Boolean);
    const hdr = local.collect(j, 'playlistHeaderRenderer')[0]
      || local.collect(j, 'pageHeaderRenderer')[0] || {};
    const title = local.txt(hdr.title);
    if (!title && !videos.length) throw new Error('local extraction recovered no playlist');
    const p = T.playlist({
      id: playlistId.replace(/^VL/, ''),
      title: title || playlistId,
      description: local.txt(hdr.descriptionText),
      author: { name: local.txt(hdr.ownerText) },
      videoCount: local.viewsToNumber(local.txt(hdr.numVideosText)) || videos.length,
      videos,
    }, { provider: id, instance: 'in-process' });
    if (!p) throw new Error('playlist payload failed validation');
    return p;
  }, { capability: 'playlist' });
}

export async function getComments(videoId) {
  return pool.run(async () => {
    const j = await local.comments(videoId);
    return {
      items: (j.comments || []).map((c) => T.comment({
        id: c.commentId,
        text: c.commentText,
        author: {
          id: (/\/channel\/([\w-]+)/.exec(String(c.commentorUrl || '')) || [])[1],
          name: c.author, avatar: c.thumbnail, verified: c.verified === true,
        },
        publishedText: c.commentedTime,
        likeCount: c.likeCount,
        pinned: c.pinned === true,
        hearted: c.hearted === true,
      }, { provider: id, instance: 'in-process' })).filter(Boolean),
      disabled: j.disabled === true,
    };
  }, { capability: 'comments' });
}

/** The watch-next rail, which `/streams` does not carry locally. */
export async function getRecommendations(videoId) {
  return pool.run(async () => {
    const vis = (await getVisitorData({})).value;
    const j = await innertubeRequest('next', { videoId }, local.METADATA_CLIENT, { visitorData: vis, videoId });
    const items = local.videoItems(j).map(itemFrom).filter(Boolean).filter((v) => v.id !== videoId);
    if (!items.length) throw new Error('local extraction recovered no recommendations');
    return items;
  }, { capability: 'recommendations' });
}

export async function trending(region = 'US') {
  return pool.run(async () => {
    const list = await local.trending(region);
    return (Array.isArray(list) ? list : []).map(itemFrom).filter(Boolean);
  }, { capability: 'trending' });
}

export async function getStreams(videoId) {
  return pool.run(async () => {
    const j = await local.streams(videoId);
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
      /* carried through so an HLS-only video is still playable */
      hls: j.hls,
      dash: j.dash,
    }, { provider: id, instance: 'in-process' });
    if (!s) throw new Error('stream payload failed validation');
    if (!s.videoStreams.length && !s.audioStreams.length && !s.hls) {
      throw new Error('no playable formats and no hls manifest');
    }
    return s;
  }, { capability: 'streams' });
}

export async function healthCheck() {
  const t0 = Date.now();
  try {
    await local.handle('/healthcheck', new URLSearchParams());
    return { provider: id, healthy: true, latency: Date.now() - t0, instance: self.id };
  } catch (e) {
    return { provider: id, healthy: false, latency: Date.now() - t0, error: String(e.message || e) };
  }
}

export function report() { return pool.report(); }
