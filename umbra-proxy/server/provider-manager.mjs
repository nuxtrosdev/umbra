/**
 * Provider manager — the only thing that decides which backend answers.
 *
 * Two layers of failover sit underneath this, and they do different jobs.
 * `InstancePool` moves between *instances of one provider* when a particular
 * Invidious host is down. This moves between *providers* when the whole
 * Invidious fleet is being squeezed and Piped is not. Keeping them separate
 * is what makes "YouTube broke one parser" survivable.
 *
 * Routing is deterministic. The brief wants an AI router eventually, so the
 * decision is isolated in `route()`, which takes a capability and returns an
 * ordered provider list. Swapping that for something smarter — see
 * `setRouter()` — changes selection without touching transport, caching,
 * normalization or any call site. The router chooses from registered
 * providers only; it never gets to name a URL.
 */

import * as registry from './providers/index.mjs';
import * as T from './providers/types.mjs';
import { wrap, key, TTL, stats as cacheStats } from './cache.mjs';
import { recentLog, log } from './providers/pool.mjs';

/* Find out which optional engines are actually installed, without blocking. */
registry.detectOptional();

/* Unwraps both adapter return styles: pool.run() gives {data,instance,tried},
   a couple of adapters return the value directly. */
function unwrap(r) {
  if (r && typeof r === 'object' && 'data' in r && ('instance' in r || 'tried' in r)) {
    return {
      data: r.data,
      instance: r.instance && (r.instance.id || r.instance.baseUrl || String(r.instance)),
      tried: r.tried || [],
    };
  }
  return { data: r, instance: null, tried: [] };
}

/* ------------------------------------------------------------- routing */

/**
 * Health tier. Only ever used to *demote*.
 *
 * Scoring a provider upward on no evidence is how an untested optional engine
 * ends up ahead of a Piped pool that has been answering all day — the fresh
 * one looks perfect precisely because nothing has been asked of it. So the
 * configured order stands until a provider gives us a reason to move it, and
 * the only direction it can move is down.
 */
function tier(p) {
  let rows;
  try { rows = p.report ? p.report() : []; } catch { return 2; }
  const live = rows.filter((r) => r.status !== 'DISABLED');
  if (!live.length) return 2;
  if (live.every((r) => r.status === 'COOLDOWN')) return 2;
  if (live.some((r) => r.status === 'COOLDOWN' || r.status === 'DEGRADED' || r.failures > 0)) return 1;
  return 0;
}

/**
 * Deterministic default: registry order, filtered by capability and
 * availability, then demoted by observed health. Stable within a tier, so the
 * operator's configured preference is what decides between two healthy
 * backends.
 */
function defaultRouter(capability) {
  return registry.order()
    .filter((p) => registry.supports(p, capability) && registry.enabled(p))
    .map((p, i) => ({ p, i, t: tier(p) }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map((x) => x.p);
}

let router = defaultRouter;

/**
 * Replace the routing policy. The replacement receives the capability and a
 * read-only view of provider health, and must return an ordered subset of the
 * registered providers — it cannot introduce a destination of its own.
 */
export function setRouter(fn) {
  router = typeof fn === 'function' ? fn : defaultRouter;
  return router;
}
export function resetRouter() { router = defaultRouter; }

export function route(capability) {
  const picked = router(capability, { health: healthSnapshot(), registry });
  const valid = (Array.isArray(picked) ? picked : [])
    .filter((p) => p && registry.get(p.id) && registry.supports(p, capability));
  return valid.length ? valid : defaultRouter(capability);
}

/** Mean instance score, so a provider with one dead instance still ranks. */
function providerScore(p) {
  try {
    const rows = p.report ? p.report() : [];
    if (!rows.length) return 50;
    const live = rows.filter((r) => r.status !== 'DISABLED');
    if (!live.length) return -1;
    return live.reduce((a, r) => a + (typeof r.score === 'number' ? r.score : (r.healthy ? 60 : 0)), 0) / live.length;
  } catch { return 0; }
}

/* ------------------------------------------------------------ failover */

/**
 * Try providers in routed order until one answers.
 *
 * Every attempt is recorded. When they all fail the caller gets an error
 * carrying the full `tried` list, which is what lets the UI say *which*
 * backends were asked instead of a bare "unavailable".
 */
/* ------------------------------------------------------- what counts ----
 * Failover only ever reacted to a throw, so a backend that answered HTTP
 * 200 with an empty format list ended the chain as a "success" and the
 * watch page got a player with nothing to play — indistinguishable, from
 * the sofa, from total failure, except that the providers that WOULD have
 * worked were never asked.
 *
 * Two different things were being conflated, so there are two verdicts:
 *   'bad'      nothing usable at all — treat exactly like a thrown error.
 *   'degraded' usable, but less than another provider might give. An HLS
 *              manifest is the case that matters: it genuinely plays, so
 *              it is never discarded, but a set of real formats beats it.
 *              Hold it, keep asking, and return it only if nobody better
 *              answers.
 */
const GRADE = {
  streams: (d) => {
    const n = [...((d && d.videoStreams) || []), ...((d && d.audioStreams) || [])]
      .filter((f) => f && f.url).length;
    if (n) return null;
    if (d && d.hls) return { grade: 'degraded', why: 'hls manifest only, no individual formats' };
    return { grade: 'bad', why: 'answered with no playable formats' };
  },
};

async function failover(capability, run, { providers = null } = {}) {
  const chain = providers || route(capability);
  if (!chain.length) {
    const e = new Error(`no provider offers ${capability}`);
    e.tried = [];
    e.code = 'NO_PROVIDER';
    throw e;
  }
  const tried = [];
  let held = null; /* a usable-but-beatable answer, kept in case nothing better comes */
  for (const p of chain) {
    const t0 = Date.now();
    try {
      const out = unwrap(await run(p));
      if (out.data === null || out.data === undefined) throw new Error('provider returned nothing');
      const g = GRADE[capability] && GRADE[capability](out.data);
      if (g && g.grade === 'bad') throw new Error(g.why);
      const answer = { data: out.data, provider: p.id, instance: out.instance, tried, ms: Date.now() - t0 };
      if (g && g.grade === 'degraded') {
        if (!held) held = answer;
        tried.push({ provider: p.id, note: g.why, instances: [] });
        log({ capability, provider: p.id, ok: true, ms: Date.now() - t0, error: g.why });
        continue;
      }
      log({ capability, provider: p.id, ok: true, ms: Date.now() - t0 });
      return answer;
    } catch (e) {
      const note = String((e && e.message) || e).slice(0, 200);
      tried.push({ provider: p.id, note, instances: (e && e.tried) || [] });
      log({ capability, provider: p.id, ok: false, ms: Date.now() - t0, error: note });
    }
  }
  if (held) return { ...held, tried };
  const err = new Error(`every provider failed for ${capability}`);
  err.tried = tried;
  err.code = 'ALL_PROVIDERS_FAILED';
  throw err;
}

/* -------------------------------------------------------- capabilities */

export async function search(query, opts = {}) {
  const q = T.str(query, 300).trim();
  if (!q) return { data: [], provider: null, tried: [], cached: false };
  const { aggregate = false, limit = 30, region = '' } = opts;
  const k = key('search', q, limit, region, aggregate ? 'agg' : 'one');
  const { value, cached } = await wrap(k, TTL.search, () =>
    (aggregate ? searchAggregated(q, { limit, region }) : failover('search', (p) => p.search(q, { limit, region }))));
  return { ...value, cached };
}

/**
 * Aggregated search: ask several providers at once, merge, dedupe by video
 * id, rank by agreement.
 *
 * Only worth it for search, where providers genuinely differ in what they
 * surface. Doing this for `getVideo` would triple the request count to
 * produce the same record, which is why nothing else uses it.
 */
async function searchAggregated(q, { limit, region, max = 3 } = {}) {
  const chain = route('search').slice(0, max);
  const settled = await Promise.allSettled(chain.map((p) => p.search(q, { limit, region })));
  const lists = [];
  const tried = [];
  const used = [];
  const orderHint = new Map();
  settled.forEach((r, i) => {
    const p = chain[i];
    if (r.status === 'fulfilled') {
      const out = unwrap(r.value);
      const list = out.data || [];
      list.forEach((v, pos) => {
        if (!orderHint.has(v.id)) orderHint.set(v.id, pos);
      });
      lists.push(list);
      used.push(p.id);
    } else {
      tried.push({ provider: p.id, note: String(r.reason && r.reason.message || r.reason).slice(0, 200) });
    }
  });
  if (!lists.length) {
    const err = new Error('every provider failed for search');
    err.tried = tried;
    err.code = 'ALL_PROVIDERS_FAILED';
    throw err;
  }
  const merged = T.rankVideos(T.dedupeVideos(lists), orderHint).slice(0, limit);
  return { data: merged, provider: used.join('+'), providers: used, instance: null, tried, aggregated: true };
}

export async function getVideo(videoId) {
  const id = T.str(videoId, 32);
  if (!T.VIDEO_ID.test(id)) throw badId('video id');
  const { value, cached } = await wrap(key('video', id), TTL.video, () =>
    failover('video', (p) => p.getVideo(id)));
  return { ...value, cached };
}

export async function getChannel(channelId) {
  const id = T.str(channelId, 64).trim();
  if (!id || /[^\w@.-]/.test(id)) throw badId('channel id');
  const { value, cached } = await wrap(key('channel', id), TTL.channel, () =>
    failover('channel', (p) => p.getChannel(id)));
  return { ...value, cached };
}

export async function getPlaylist(playlistId) {
  const id = T.str(playlistId, 64).trim();
  if (!T.PLAYLIST_ID.test(id)) throw badId('playlist id');
  const { value, cached } = await wrap(key('playlist', id), TTL.playlist, () =>
    failover('playlist', (p) => p.getPlaylist(id)));
  return { ...value, cached };
}

export async function getComments(videoId) {
  const id = T.str(videoId, 32);
  if (!T.VIDEO_ID.test(id)) throw badId('video id');
  const { value, cached } = await wrap(key('comments', id), TTL.comments, () =>
    failover('comments', (p) => p.getComments(id)));
  return { ...value, cached };
}

export async function getRecommendations(videoId) {
  const id = T.str(videoId, 32);
  if (!T.VIDEO_ID.test(id)) throw badId('video id');
  const { value, cached } = await wrap(key('recs', id), TTL.recommendations, () =>
    failover('recommendations', (p) => p.getRecommendations(id)));
  return { ...value, cached };
}

export async function trending(region = 'US') {
  const r = T.str(region, 4).toUpperCase().replace(/[^A-Z]/g, '') || 'US';
  const { value, cached } = await wrap(key('trending', r), TTL.trending, () =>
    failover('trending', (p) => p.trending(r)));
  return { ...value, cached };
}

/**
 * Stream metadata. Never cached: format URLs expire quickly and are bound to
 * the address that requested them, so a cache hit here is a broken player.
 */
export async function getStreams(videoId) {
  const id = T.str(videoId, 32);
  if (!T.VIDEO_ID.test(id)) throw badId('video id');
  const out = await failover('streams', (p) => p.getStreams(id));
  return { ...out, cached: false };
}

function badId(what) {
  const e = new Error('invalid ' + what);
  e.code = 'BAD_ID';
  e.status = 400;
  return e;
}

/* ---------------------------------------------------------- diagnostics */

export function providers() {
  return registry.ALL.map((p) => ({
    id: p.id,
    name: p.name,
    enabled: registry.enabled(p),
    routed: registry.order().some((o) => o.id === p.id),
    capabilities: Object.keys(p.capabilities || {}).filter((k) => p.capabilities[k]),
    score: Number(providerScore(p).toFixed(1)),
    instances: p.report ? p.report().length : 0,
  }));
}

function healthSnapshot() {
  const out = {};
  for (const p of registry.ALL) out[p.id] = { enabled: registry.enabled(p), score: providerScore(p) };
  return out;
}

/** Live health, instance by instance. Cheap: reads bookkeeping, no requests. */
export function health() {
  return {
    providers: providers(),
    instances: registry.ALL.flatMap((p) => (p.report ? p.report() : [])),
    cache: cacheStats(),
    recent: recentLog(40),
    survey: registry.SURVEY,
  };
}

/** Active probe. Costs one request per provider, so it is never automatic. */
export async function probe() {
  const results = await Promise.allSettled(
    registry.ALL.map((p) => (p.healthCheck ? p.healthCheck() : Promise.resolve({ provider: p.id, healthy: null }))));
  return results.map((r, i) => (r.status === 'fulfilled'
    ? r.value
    : { provider: registry.ALL[i].id, healthy: false, error: String(r.reason && r.reason.message || r.reason) }));
}

export { registry };
