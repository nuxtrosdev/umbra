/**
 * /api/youtube/* — the single normalized surface the frontend talks to.
 *
 * The browser only ever addresses this origin. Every upstream request is made
 * by the server, which matters for more than tidiness: a user whose network
 * blocks a particular Invidious host is unaffected, because their browser
 * never resolves it. Failover happens entirely behind this boundary.
 *
 * Responses are uniform: `{ ok, data, meta }` on success, `{ ok:false, error }`
 * on failure. `meta` carries which provider and instance answered and what
 * was tried first — useful in a debug panel, and harmless to expose, since it
 * names backends rather than anything about the caller. Internal messages are
 * mapped to short reasons and stack traces never leave the process.
 */

import * as pm from './provider-manager.mjs';
import { stats as cacheStats, clear as cacheClear } from './cache.mjs';
import * as invidious from './providers/invidious.mjs';
import * as piped from './piped.mjs';
import * as local from './piped-local.mjs';

const MAX_Q = 300;

const ok = (data, meta = {}) => ({ ok: true, data, meta });

/**
 * Errors are translated, never forwarded. A provider's message can contain a
 * full upstream URL; the client gets a reason and a tried-list of backend
 * names instead.
 */
function errorBody(e) {
  const code = e && e.code;
  const reason =
    code === 'BAD_ID' ? 'That id is not valid.'
      : code === 'NO_PROVIDER' ? 'No configured backend offers this.'
        : 'Could not retrieve this right now. Every backend was tried.';
  return {
    ok: false,
    error: { code: code || 'UPSTREAM_FAILED', message: reason },
    meta: {
      tried: (e && e.tried || []).map((t) => ({
        provider: t.provider,
        /* instance-level notes are kept but stripped of anything URL-shaped */
        attempts: (t.instances || []).length || undefined,
      })),
    },
  };
}

const statusFor = (e) => (e && e.status) || (e && e.code === 'BAD_ID' ? 400 : 502);

const metaOf = (r) => ({
  provider: r.provider,
  providers: r.providers,
  instance: r.instance,
  cached: !!r.cached,
  aggregated: !!r.aggregated,
  ms: r.ms,
  tried: (r.tried || []).map((t) => ({ provider: t.provider, note: t.note })),
});

/**
 * @param {string} sub  path after /api/youtube
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handle(sub, params, { method = 'GET' } = {}) {
  const seg = sub.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const head = seg[0] || '';

  try {
    /* ---- discovery / diagnostics ---- */
    if (head === 'providers') {
      if (seg[1] === 'health') {
        if (params.get('probe') === '1') {
          return { status: 200, body: ok(await pm.probe(), { live: true }) };
        }
        return { status: 200, body: ok(pm.health()) };
      }
      if (seg[1] === 'survey') return { status: 200, body: ok(pm.registry.SURVEY) };
      if (seg[1] === 'refresh' && (seg[2] === 'invidious' || seg[2] === 'piped')) {
        if (method !== 'POST') return { status: 405, body: { ok: false, error: { code: 'METHOD', message: 'POST only.' } } };
        const limit = Number(params.get('limit') || 8);
        /* Baked-in instance lists rot: hosts vanish and the pool quietly
           shrinks to whatever still resolves. Both projects publish the live
           set, so this replaces the pool from the source of truth. */
        const picked = seg[2] === 'piped'
          ? await piped.refreshInstances({ limit })
          : await invidious.refreshInstances({ limit });
        return { status: 200, body: ok({ provider: seg[2], instances: picked }) };
      }
      if (!seg[1]) return { status: 200, body: ok(pm.providers()) };
    }

    /* Why a video produced no streams, client by client. The single most
       useful endpoint when playback breaks, because "no playable streams"
       on its own does not distinguish a bot gate from a reshaped player. */
    if (head === 'diagnose' && seg[1]) {
      const vid = String(seg[1]).slice(0, 32);
      if (!/^[\w-]{11}$/.test(vid)) {
        return { status: 400, body: { ok: false, error: { code: 'BAD_ID', message: 'That id is not valid.' } } };
      }
      return { status: 200, body: ok(await local.diagnose(vid)) };
    }

    if (head === 'cache') {
      if (seg[1] === 'clear') {
        if (method !== 'POST') return { status: 405, body: { ok: false, error: { code: 'METHOD', message: 'POST only.' } } };
        cacheClear();
        return { status: 200, body: ok({ cleared: true }) };
      }
      return { status: 200, body: ok(cacheStats()) };
    }

    /* ---- content ---- */
    if (head === 'search') {
      const q = String(params.get('q') || '').slice(0, MAX_Q).trim();
      if (!q) return { status: 400, body: { ok: false, error: { code: 'BAD_QUERY', message: 'A query is required.' } } };
      const r = await pm.search(q, {
        aggregate: params.get('aggregate') === '1',
        limit: Math.min(Number(params.get('limit') || 30) || 30, 100),
        region: String(params.get('region') || '').slice(0, 4),
      });
      return { status: 200, body: ok(r.data, { ...metaOf(r), query: q }) };
    }

    if (head === 'trending') {
      const r = await pm.trending(String(params.get('region') || 'US'));
      return { status: 200, body: ok(r.data, metaOf(r)) };
    }

    if (head === 'video' && seg[1]) {
      const r = await pm.getVideo(seg[1]);
      return { status: 200, body: ok(r.data, metaOf(r)) };
    }

    if (head === 'channel' && seg[1]) {
      const r = await pm.getChannel(seg[1]);
      return { status: 200, body: ok(r.data, metaOf(r)) };
    }

    if (head === 'playlist' && seg[1]) {
      const r = await pm.getPlaylist(seg[1]);
      return { status: 200, body: ok(r.data, metaOf(r)) };
    }

    if (head === 'comments' && seg[1]) {
      const r = await pm.getComments(seg[1]);
      return { status: 200, body: ok(r.data, metaOf(r)) };
    }

    if (head === 'recommendations' && seg[1]) {
      const r = await pm.getRecommendations(seg[1]);
      return { status: 200, body: ok(r.data, metaOf(r)) };
    }

    /* Format metadata. Returning these URLs is not relaying bytes — what the
       caller does with them is the caller's decision. Umbra Tube, for
       instance, re-wraps them onto its own media wire. */
    if (head === 'streams' && seg[1]) {
      const r = await pm.getStreams(seg[1]);
      return { status: 200, body: ok(r.data, metaOf(r)) };
    }

    return {
      status: 404,
      body: {
        ok: false,
        error: { code: 'NO_ROUTE', message: 'No such endpoint.' },
        meta: { endpoints: ENDPOINTS },
      },
    };
  } catch (e) {
    return { status: statusFor(e), body: errorBody(e) };
  }
}

export const ENDPOINTS = [
  'GET  /api/youtube/search?q=&aggregate=0|1&limit=&region=',
  'GET  /api/youtube/trending?region=',
  'GET  /api/youtube/video/:id',
  'GET  /api/youtube/channel/:id',
  'GET  /api/youtube/playlist/:id',
  'GET  /api/youtube/comments/:id',
  'GET  /api/youtube/recommendations/:id',
  'GET  /api/youtube/streams/:id',
  'GET  /api/youtube/providers',
  'GET  /api/youtube/providers/health?probe=0|1',
  'GET  /api/youtube/providers/survey',
  'POST /api/youtube/providers/refresh/invidious?limit=',
  'POST /api/youtube/providers/refresh/piped?limit=',
  'GET  /api/youtube/diagnose/:id',
  'GET  /api/youtube/cache',
  'POST /api/youtube/cache/clear',
];
