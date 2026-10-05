/**
 * Normalized models → the shapes the Tube templates already render.
 *
 * Umbra Tube was written against Piped's response shapes, which coupled the
 * UI to one backend: when the Piped pool was having a bad day the page failed
 * even though Invidious was answering fine. This module is the seam that
 * breaks that coupling. The templates keep their existing vocabulary, the
 * provider manager picks whichever backend is healthy, and neither knows
 * about the other.
 *
 * Image URLs are wrapped onto the Umbra media wire here, not in the adapters,
 * because wrapping needs a request context and adapters are context-free.
 */

import { href } from './protocol.mjs';
import { toPlayerPayload } from './piped.mjs';

const wireImg = (ctx, u) => (u ? href(ctx, u, 's') : null);
const best = (list) => (Array.isArray(list) && list.length ? list[0].url : '');
const thumb = (u, id) => {
  const fallback = id ? 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' : '';
  if (!u) return fallback;
  try {
    const x = new URL(u);
    if (x.searchParams.get('host') === 'i.ytimg.com' || /(^|\.)proxy\.piped\./i.test(x.hostname)) return fallback;
  } catch {}
  return u;
};

/** Normalized Video → video card. */
export function toCard(v, ctx) {
  return {
    videoId: v.id,
    title: v.title || '',
    uploader: (v.author && v.author.name) || '',
    channelId: (v.author && v.author.id) || null,
    verified: !!(v.author && v.author.verified),
    duration: v.duration || 0,
    views: v.viewCount || 0,
    uploaded: v.publishedText || '',
    desc: v.description || '',
    isShort: !!v.short,
    thumbWire: wireImg(ctx, thumb(best(v.thumbnails), v.id)),
    avatarWire: wireImg(ctx, v.author && v.author.avatar),
  };
}

export const toCards = (list, ctx) => (list || []).map((v) => toCard(v, ctx));

/**
 * Which backend answered, in the shape `provenance()` already renders.
 * Instance-level detail is folded into the note so a failure reads as
 * "invidious — every instance in cooldown" rather than just "invidious".
 */
export function provenanceOf(r) {
  return {
    instance: r.provider ? (r.providers ? r.providers.join('+') : r.provider) : '',
    tried: (r.tried || []).map((t) => ({
      instance: t.provider || t.instance || '?',
      note: t.note || '',
    })),
  };
}

export function toSearchView(r, ctx) {
  return {
    query: r.query || '',
    ...provenanceOf(r),
    corrected: false,
    suggestion: '',
    items: toCards(r.data, ctx),
  };
}

export function toTrendingView(r, ctx, region) {
  return { region: region || 'US', ...provenanceOf(r), items: toCards(r.data, ctx) };
}

export function toChannelView(r, ctx) {
  const c = r.data || {};
  return {
    ...provenanceOf(r),
    id: c.id,
    name: c.name || c.id,
    description: c.description || '',
    subscribers: c.subscriberCount || 0,
    verified: !!c.verified,
    avatarWire: wireImg(ctx, best(c.avatars)),
    bannerWire: wireImg(ctx, best(c.banners)),
    items: toCards(c.videos, ctx),
  };
}

export function toCommentsView(r, ctx) {
  const d = r.data || {};
  return {
    ...provenanceOf(r),
    disabled: !!d.disabled,
    items: (d.items || []).slice(0, 40).map((c) => ({
      author: (c.author && c.author.name) || '',
      text: c.text || '',
      when: c.publishedText || '',
      likes: c.likeCount || 0,
      pinned: !!c.pinned,
      hearted: !!c.hearted,
      verified: !!(c.author && c.author.verified),
      avatarWire: wireImg(ctx, c.author && c.author.avatar),
    })),
  };
}

/**
 * Build the watch payload.
 *
 * `toPlayerPayload` already knows how to split muxed/video-only/audio, wrap
 * each format onto the media wire and attach captions, and it is the same
 * code the native player capsule uses. Rather than reimplement that against
 * the normalized shape, the normalized stream info is rendered back into the
 * Piped-flavoured object it expects — the field names already line up, which
 * is why the normalizer was given those names in the first place.
 */
export function toWatchPayload({ streams, video, related }, ctx, videoId) {
  const s = (streams && streams.data) || {};
  const v = (video && video.data) || {};
  const rel = (related && related.data) || [];

  const pipedish = {
    title: s.title || v.title || '',
    description: v.description || '',
    uploader: (v.author && v.author.name) || '',
    uploaderUrl: v.author && v.author.id ? '/channel/' + v.author.id : '',
    uploaderVerified: !!(v.author && v.author.verified),
    uploaderAvatar: (v.author && v.author.avatar) || '',
    uploadDate: v.publishedText || '',
    views: v.viewCount || 0,
    likes: (v.metadata && v.metadata.likeCount) || 0,
    duration: s.duration || v.duration || 0,
    livestream: !!s.live,
    thumbnailUrl: thumb(best(v.thumbnails), videoId),
    proxyUrl: s.proxyUrl || null,
    hls: s.hls || null,
    dash: s.dash || null,
    videoStreams: s.videoStreams || [],
    audioStreams: s.audioStreams || [],
    subtitles: s.subtitles || [],
    relatedStreams: [],
  };

  const served = [streams && streams.provider, video && video.provider]
    .filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join('+');
  const payload = toPlayerPayload(pipedish, ctx, videoId, served);

  /* related comes from its own capability and may have been served by a
     different backend than the streams were */
  payload.related = toCards(rel, ctx);
  payload.tried = [
    ...((streams && streams.tried) || []),
    ...((video && video.tried) || []),
  ].map((t) => ({ instance: t.provider || t.instance || '?', note: t.note || '' }));
  return payload;
}
