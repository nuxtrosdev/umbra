/**
 * The common vocabulary every provider is translated into.
 *
 * Nothing downstream of this file is allowed to know whether a result came
 * from Invidious, Piped, our own InnerTube extraction or yt-dlp. Each adapter
 * ends in a call to one of the constructors here, and the constructors are
 * deliberately paranoid: a provider is a remote party we do not control, so
 * its output is treated as untrusted input and coerced into shape rather than
 * spread into our objects.
 *
 * Anything that fails to produce a usable id is dropped rather than passed on
 * half-built — a list with three good videos is more useful than one with
 * three good videos and two shaped like `{title: undefined}`.
 */

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
/* playlists are the loose one: PL…, UU…, OLAK5uy_…, RD…, and plain mixes */
export const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;

/* ------------------------------------------------------------ coercion */

export function str(v, max = 4096) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/** Numbers arrive as "1.2M", "1,234 views", "1234", 1234 or nonsense. */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = str(v, 64).trim();
  if (!s) return null;
  const m = /^([\d.,]+)\s*([KMB])?/i.exec(s.replace(/\s+/g, ' '));
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(base * mult);
}

/** Durations arrive as seconds, "3:32" or "1:02:03". */
export function duration(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const s = str(v, 32).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((a, n) => a * 60 + n, 0);
}

/** Providers disagree on epoch units; both seconds and ms show up. */
export function isoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e11 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(+d) ? null : d.toISOString();
  }
  const d = new Date(str(v, 64));
  return Number.isNaN(+d) ? null : d.toISOString();
}

/**
 * Only absolute http(s) URLs survive. A provider handing back `javascript:`
 * or a data: blob has no business reaching a template.
 */
export function url(v) {
  const s = str(v, 2048).trim();
  if (!s) return '';
  if (/^\/\//.test(s)) return 'https:' + s;
  return /^https?:\/\//i.test(s) ? s : '';
}

/** Resolve a provider's site-relative URL against the instance it came from. */
export function absolute(v, base) {
  const s = str(v, 2048).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'https:' + s;
  if (!base) return '';
  try { return new URL(s, base).href; } catch { return ''; }
}

/* -------------------------------------------------------------- models */

export function thumbnail(t, base) {
  const u = absolute(t && (t.url || t.src || t), base);
  if (!u) return null;
  return {
    url: u,
    width: num(t && t.width) || null,
    height: num(t && t.height) || null,
    quality: str((t && t.quality) || '', 32) || null,
  };
}

/** Largest first, so `thumbnails[0]` is always the best available. */
export function thumbnails(list, base) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(list) ? list : [list]) {
    const th = thumbnail(t, base);
    if (!th || seen.has(th.url)) continue;
    seen.add(th.url);
    out.push(th);
  }
  return out.sort((a, b) => (b.width || 0) - (a.width || 0));
}

export function author(a = {}, base) {
  const id = str(a.id, 64);
  return {
    id: id || null,
    name: str(a.name, 300),
    avatar: absolute(a.avatar, base) || null,
    verified: a.verified === true,
    subscriberCount: num(a.subscriberCount),
    url: id ? '/channel/' + id : null,
  };
}

/**
 * @returns {object|null} null when the payload cannot be trusted to identify
 *   a real video, which the caller should drop rather than render.
 */
export function video(v = {}, { provider, instance, base } = {}) {
  const id = str(v.id, 32).trim();
  if (!VIDEO_ID.test(id)) return null;
  const title = str(v.title, 500).trim();
  if (!title) return null;
  return {
    id,
    title,
    description: str(v.description, 20000) || null,
    author: author(v.author || {}, base),
    thumbnails: thumbnails(v.thumbnails || [], base),
    duration: duration(v.duration),
    publishedAt: isoDate(v.publishedAt),
    publishedText: str(v.publishedText, 64) || null,
    viewCount: num(v.viewCount),
    url: '/watch?v=' + id,
    live: v.live === true,
    short: v.short === true,
    provider: str(provider, 64),
    providerInstance: str(instance, 200) || null,
    metadata: v.metadata && typeof v.metadata === 'object' ? v.metadata : {},
  };
}

export function channel(c = {}, { provider, instance, base } = {}) {
  const id = str(c.id, 64).trim();
  if (!id) return null;
  return {
    id,
    name: str(c.name, 300) || id,
    description: str(c.description, 20000) || null,
    avatars: thumbnails(c.avatars || [], base),
    banners: thumbnails(c.banners || [], base),
    subscriberCount: num(c.subscriberCount),
    verified: c.verified === true,
    url: '/channel/' + id,
    videos: Array.isArray(c.videos) ? c.videos.filter(Boolean) : [],
    provider: str(provider, 64),
    providerInstance: str(instance, 200) || null,
    metadata: c.metadata && typeof c.metadata === 'object' ? c.metadata : {},
  };
}

export function playlist(p = {}, { provider, instance, base } = {}) {
  const id = str(p.id, 64).trim();
  if (!id) return null;
  return {
    id,
    title: str(p.title, 500) || id,
    description: str(p.description, 20000) || null,
    author: author(p.author || {}, base),
    thumbnails: thumbnails(p.thumbnails || [], base),
    videoCount: num(p.videoCount),
    url: '/playlist?list=' + id,
    videos: Array.isArray(p.videos) ? p.videos.filter(Boolean) : [],
    provider: str(provider, 64),
    providerInstance: str(instance, 200) || null,
    metadata: p.metadata && typeof p.metadata === 'object' ? p.metadata : {},
  };
}

export function comment(c = {}, { provider, instance, base } = {}) {
  const text = str(c.text, 10000);
  if (!text) return null;
  return {
    id: str(c.id, 128) || null,
    text,
    author: author(c.author || {}, base),
    publishedAt: isoDate(c.publishedAt),
    publishedText: str(c.publishedText, 64) || null,
    likeCount: num(c.likeCount),
    replyCount: num(c.replyCount),
    pinned: c.pinned === true,
    hearted: c.hearted === true,
    provider: str(provider, 64),
    providerInstance: str(instance, 200) || null,
  };
}

/**
 * Stream information. This is metadata *about* the formats — bitrates, codecs,
 * and the URLs YouTube issued. Handing these to a caller is not the same as
 * relaying the bytes; what the caller does with them is its own decision.
 */
export function streamInfo(s = {}, { provider, instance } = {}) {
  const id = str(s.id, 32).trim();
  if (!VIDEO_ID.test(id)) return null;
  const fmt = (f) => {
    const u = url(f.url);
    if (!u) return null;
    return {
      url: u,
      itag: num(f.itag),
      mimeType: str(f.mimeType, 128) || null,
      codec: str(f.codec, 64) || null,
      quality: str(f.quality, 32) || null,
      bitrate: num(f.bitrate),
      width: num(f.width),
      height: num(f.height),
      fps: num(f.fps),
      videoOnly: f.videoOnly === true,
      audioOnly: f.audioOnly === true,
      contentLength: num(f.contentLength),
    };
  };
  const keep = (list) => (Array.isArray(list) ? list.map(fmt).filter(Boolean) : []);
  return {
    id,
    title: str(s.title, 500),
    duration: duration(s.duration),
    live: s.live === true,
    /* Piped's proxy is important: its direct googlevideo URLs can be bound
       to the extractor's egress IP and return 403 when Umbra fetches them. */
    proxyUrl: url(s.proxyUrl) || null,
    videoStreams: keep(s.videoStreams),
    audioStreams: keep(s.audioStreams),
    subtitles: (Array.isArray(s.subtitles) ? s.subtitles : []).map((c) => {
      const u = url(c.url);
      if (!u) return null;
      return {
        url: u,
        code: str(c.code, 16) || null,
        name: str(c.name, 64) || null,
        autoGenerated: c.autoGenerated === true,
      };
    }).filter(Boolean),
    hls: url(s.hls) || null,
    dash: url(s.dash) || null,
    provider: str(provider, 64),
    providerInstance: str(instance, 200) || null,
  };
}

/* -------------------------------------------------- merging + ranking */

/**
 * Deduplicate by YouTube video id, never by title — the same upload can be
 * titled differently across providers, and two different uploads can share a
 * title exactly.
 *
 * Where providers overlap, the richer record wins field by field rather than
 * the first one seen: Invidious may know the view count while Piped knows the
 * avatar, and taking either wholesale would throw away the other's work.
 */
export function dedupeVideos(lists) {
  const by = new Map();
  for (const list of lists) {
    for (const v of list || []) {
      if (!v || !v.id) continue;
      const prev = by.get(v.id);
      if (!prev) {
        by.set(v.id, { ...v, providers: [v.provider].filter(Boolean) });
        continue;
      }
      if (!prev.providers.includes(v.provider)) prev.providers.push(v.provider);
      for (const k of ['description', 'duration', 'publishedAt', 'publishedText', 'viewCount']) {
        if ((prev[k] === null || prev[k] === '' || prev[k] === undefined) && v[k] !== null) prev[k] = v[k];
      }
      if (!prev.thumbnails.length) prev.thumbnails = v.thumbnails;
      if (!prev.author.name && v.author.name) prev.author = v.author;
      else if (!prev.author.avatar && v.author.avatar) prev.author.avatar = v.author.avatar;
    }
  }
  return [...by.values()];
}

/**
 * Rank merged results. Agreement is the strongest signal available: if three
 * independent backends surfaced the same video for a query, that is better
 * evidence of relevance than any single backend's ordering. Within the same
 * level of agreement the original ordering is preserved, because each provider
 * already ranked by relevance and we have nothing better to replace it with.
 */
export function rankVideos(videos, orderHint = new Map()) {
  return videos
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const agree = (b.v.providers ? b.v.providers.length : 1) - (a.v.providers ? a.v.providers.length : 1);
      if (agree) return agree;
      const pos = (orderHint.get(a.v.id) ?? a.i) - (orderHint.get(b.v.id) ?? b.i);
      if (pos) return pos;
      return a.i - b.i;
    })
    .map((x) => x.v);
}
