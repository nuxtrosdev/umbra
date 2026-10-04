/**
 * PokeTube provider.
 *
 * Worth being precise about what this is, because the project is easy to
 * miscategorise. PokeTube is a front end built directly on YouTube's InnerTube
 * API — the same engine as `providers/innertube.mjs`, YouTube.js and
 * NewPipeExtractor. It is not a second extraction technique; it is a second
 * deployment of one we already run natively.
 *
 * It also publishes no stable, documented JSON API. Its own SDK config points
 * at a third-party endpoint rather than a first-party one, so hardcoding
 * guessed routes against the public site would be inventing a contract and
 * calling it an integration.
 *
 * So this adapter is real but inert by default: it speaks the Invidious-
 * compatible `/api/v1/` surface that PokeTube-family deployments commonly put
 * in front of their extractor, and it only enters the pool when an operator
 * points it at one with UMBRA_POKETUBE_INSTANCES. What it buys you is
 * *address* diversity — someone else's egress running the same engine — which
 * is genuinely useful when ours is bot-gated, and nothing more than that.
 */

import { InstancePool, getJson, envList } from './pool.mjs';
import * as T from './types.mjs';

export const id = 'poketube';
export const name = 'PokeTube';

export const capabilities = {
  search: true, video: true, channel: true, playlist: false,
  comments: true, recommendations: true, streams: false, trending: true,
};

const BASES = envList('UMBRA_POKETUBE_INSTANCES', []);

/** Empty unless configured; the manager skips providers with no instances. */
export const pool = new InstancePool(id, BASES, {
  capabilities: Object.keys(capabilities).filter((k) => capabilities[k]),
});

export const enabled = () => pool.instances.length > 0;

const call = (inst, path) => getJson(inst.baseUrl + path);

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
    viewCount: r.viewCount,
    live: r.liveNow === true,
  }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl });
}

export async function search(query, { limit = 30 } = {}) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/api/v1/search?' + new URLSearchParams({ q: query, type: 'video' }));
    if (!Array.isArray(j)) throw new Error('search did not return a list');
    return j.filter((r) => r && r.type === 'video').map((r) => vidFrom(r, inst)).filter(Boolean).slice(0, limit);
  }, { capability: 'search' });
}

export async function getVideo(videoId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/api/v1/videos/' + encodeURIComponent(videoId));
    const v = vidFrom(j, inst);
    if (!v) throw new Error('video payload failed validation');
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
      subscriberCount: j.subCount,
      verified: j.authorVerified === true,
      videos: (j.latestVideos || []).map((r) => vidFrom(r, inst)).filter(Boolean),
    }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl });
    if (!c) throw new Error('channel payload failed validation');
    return c;
  }, { capability: 'channel' });
}

export async function getComments(videoId) {
  return pool.run(async (inst) => {
    const j = await call(inst, '/api/v1/comments/' + encodeURIComponent(videoId));
    return {
      items: (j.comments || []).map((c) => T.comment({
        id: c.commentId,
        text: c.content,
        author: { id: c.authorId, name: c.author, avatar: c.authorThumbnail },
        publishedAt: c.published,
        publishedText: c.publishedText,
        likeCount: c.likeCount,
        pinned: c.isPinned === true,
      }, { provider: id, instance: inst.baseUrl, base: inst.baseUrl })).filter(Boolean),
      disabled: !j.comments,
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

export async function healthCheck() {
  if (!enabled()) return { provider: id, healthy: false, disabled: true, reason: 'no instances configured' };
  const t0 = Date.now();
  try {
    const { instance } = await pool.run((inst) => call(inst, '/api/v1/stats'), { attempts: 1 });
    return { provider: id, healthy: true, latency: Date.now() - t0, instance: instance.id };
  } catch (e) {
    return { provider: id, healthy: false, latency: Date.now() - t0, error: String(e.message || e) };
  }
}

export function report() { return pool.report(); }
