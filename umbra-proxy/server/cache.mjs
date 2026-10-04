/**
 * Metadata cache.
 *
 * Deliberately small and deliberately not a media cache. Entries are capped
 * in both count and serialized size, and anything binary is refused outright
 * — a cache that will happily hold a Buffer is one accident away from being a
 * video cache, which is exactly what this project does not want to become.
 *
 * In-memory and per-process by design: Umbra has no Redis and no other store,
 * and a metadata cache losing its contents on restart costs one slow request.
 * `swap()` exists so a deployment that does have Redis can drop in a backend
 * implementing the same four methods without touching call sites.
 */

const DEFAULT_MAX = Number(process.env.UMBRA_CACHE_MAX || 500);
/** Refuse anything this large; metadata simply is not. */
const MAX_ENTRY_BYTES = Number(process.env.UMBRA_CACHE_MAX_ENTRY || 2 * 1024 * 1024);

/** Per-kind lifetimes. Search ages fastest, channel metadata slowest. */
export const TTL = {
  search: Number(process.env.UMBRA_CACHE_TTL_SEARCH || 300000),
  video: Number(process.env.UMBRA_CACHE_TTL_VIDEO || 900000),
  channel: Number(process.env.UMBRA_CACHE_TTL_CHANNEL || 1800000),
  playlist: Number(process.env.UMBRA_CACHE_TTL_PLAYLIST || 1800000),
  comments: Number(process.env.UMBRA_CACHE_TTL_COMMENTS || 300000),
  recommendations: Number(process.env.UMBRA_CACHE_TTL_RECS || 600000),
  trending: Number(process.env.UMBRA_CACHE_TTL_TRENDING || 600000),
  health: Number(process.env.UMBRA_CACHE_TTL_HEALTH || 60000),
  instances: Number(process.env.UMBRA_CACHE_TTL_INSTANCES || 3600000),
  /* streams are intentionally absent: format URLs are short-lived and
     IP-bound, so a cached one is a broken one */
};

export class MemoryCache {
  constructor({ max = DEFAULT_MAX } = {}) {
    this.max = max;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.refused = 0;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) { this.misses++; return undefined; }
    if (Date.now() > e.expires) { this.map.delete(key); this.misses++; return undefined; }
    /* re-insert so iteration order approximates least-recently-used */
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.value;
  }

  set(key, value, ttl) {
    if (!ttl || ttl <= 0) return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      this.refused++;
      return value; /* this cache is for metadata, not media */
    }
    let size = 0;
    try { size = JSON.stringify(value).length; } catch { this.refused++; return value; }
    if (size > MAX_ENTRY_BYTES) { this.refused++; return value; }
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + ttl, size });
    return value;
  }

  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }

  stats() {
    let bytes = 0;
    for (const e of this.map.values()) bytes += e.size || 0;
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      max: this.max,
      approxBytes: bytes,
      hits: this.hits,
      misses: this.misses,
      refused: this.refused,
      hitRate: total ? Number((this.hits / total).toFixed(3)) : null,
    };
  }
}

let backend = new MemoryCache();

/** Replace the backend with anything exposing get/set/delete/clear/stats. */
export function swap(impl) { backend = impl; return backend; }
export const cache = () => backend;

export const key = (...parts) => parts.map((p) => String(p ?? '')).join('|');

/**
 * Read-through. A miss runs `fn`, caches the result and returns it; a thrown
 * `fn` is never cached, because caching failure turns a blip into an outage.
 */
export async function wrap(k, ttl, fn) {
  const hit = backend.get(k);
  if (hit !== undefined) return { value: hit, cached: true };
  const value = await fn();
  backend.set(k, value, ttl);
  return { value, cached: false };
}

export function stats() { return backend.stats(); }
export function clear() { return backend.clear(); }
