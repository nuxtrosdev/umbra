/**
 * A Piped instance, served by Umbra itself.
 *
 * piped.mjs treats public Piped instances as a failover pool. That solves one
 * problem (their egress does the extraction, not ours) and creates another:
 * you are trusting strangers' uptime, and the public instance list churns
 * constantly as YouTube blocks them. This module removes the dependency by
 * implementing the Piped REST surface locally, backed by innertube.mjs.
 *
 * Be clear about what this does and does not buy you:
 *
 *   IT DOES   remove the third party entirely — no stranger sees which videos
 *             you ask for, nothing breaks when an instance disappears, and
 *             Umbra becomes a Piped API that other Piped clients can point at.
 *   IT DOES   give a stable, documented JSON contract over the InnerTube mess.
 *   IT DOESN'T beat the bot gate. Extraction happens on *this* machine's
 *             egress IP, which is the address YouTube was already profiling.
 *             When the local instance is gated, the public pool is still the
 *             thing that rescues you — which is exactly why it is kept as
 *             failover rather than deleted.
 *
 * Parsing strategy: YouTube reshuffles its renderer trees constantly, so
 * nothing here hardcodes a path like
 * `contents.twoColumnSearchResultsRenderer.primaryContents…`. Instead we walk
 * the whole response and collect every node of a known renderer type wherever
 * it happens to live. That survives layout churn that would break a fixed
 * path, at the cost of being slightly less precise about ordering.
 */
import { LADDER, playerRequest, innertubeRequest, getVisitorData } from './innertube.mjs';
import { getPlayer, resolveFormat, inspect as playerInspect } from './decipher.mjs';
import { getPoToken, inspect as potInspect } from './potoken.mjs';

const METADATA_CLIENT = process.env.UMBRA_PIPED_LOCAL_CLIENT || 'web';

/* ------------------------------------------------------------ walkers */

/** Collect every object carrying `key`, anywhere in the tree. */
export function collect(node, key, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return out;
  if (Array.isArray(node)) {
    for (const v of node) collect(v, key, out, depth + 1);
    return out;
  }
  for (const k of Object.keys(node)) {
    if (k === key && node[k] && typeof node[k] === 'object') out.push(node[k]);
    else collect(node[k], key, out, depth + 1);
  }
  return out;
}

/** InnerTube text nodes come as {simpleText} or {runs:[{text}]}. */
export function txt(n) {
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (n.simpleText) return String(n.simpleText);
  if (Array.isArray(n.runs)) return n.runs.map((r) => r.text || '').join('');
  if (n.content) return String(n.content);
  return '';
}

/** "3:32" / "1:02:03" -> seconds. */
export function durToSeconds(s) {
  const parts = String(s || '').trim().split(':').map((x) => parseInt(x, 10));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** "1,234,567 views" / "1.2M views" -> number. */
export function viewsToNumber(s) {
  const t = String(s || '').replace(/,/g, '').trim();
  const m = /([\d.]+)\s*([KMB])?/i.exec(t);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mul = { k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || '').toLowerCase()] || 1;
  return Math.round(n * mul);
}

const bestThumb = (t) => {
  const list = (t && t.thumbnails) || [];
  return list.length ? list[list.length - 1].url : '';
};

/** Normalise any of the video renderer shapes into a Piped list item. */
function itemFromRenderer(r) {
  const id = r.videoId;
  if (!id) return null;
  const owner = r.ownerText || r.longBylineText || r.shortBylineText;
  const chId =
    (((owner || {}).runs || [])[0] || {}).navigationEndpoint?.browseEndpoint?.browseId ||
    r.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.navigationEndpoint?.browseEndpoint?.browseId ||
    '';
  const dur =
    txt(r.lengthText) ||
    (collect(r, 'thumbnailOverlayTimeStatusRenderer')[0] || {}).text && txt(collect(r, 'thumbnailOverlayTimeStatusRenderer')[0].text) ||
    '';
  const badges = JSON.stringify(r.ownerBadges || []);
  return {
    url: '/watch?v=' + id,
    type: 'stream',
    title: txt(r.title),
    thumbnail: bestThumb(r.thumbnail),
    uploaderName: txt(owner),
    uploaderUrl: chId ? '/channel/' + chId : '',
    uploaderAvatar: bestThumb(
      r.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail ||
      r.channelThumbnail),
    uploadedDate: txt(r.publishedTimeText),
    shortDescription: txt(r.detailedMetadataSnippets?.[0]?.snippetText) || txt(r.descriptionSnippet),
    duration: durToSeconds(dur),
    views: viewsToNumber(txt(r.viewCountText) || txt(r.shortViewCountText)),
    uploaderVerified: /VERIFIED/i.test(badges),
    isShort: !dur && /shorts/i.test(JSON.stringify(r.navigationEndpoint || {})),
  };
}

/** Every distinct video in a response, in document order, de-duplicated. */
export function videoItems(json) {
  const seen = new Set();
  const out = [];
  for (const key of ['videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'playlistVideoRenderer']) {
    for (const r of collect(json, key)) {
      const it = itemFromRenderer(r);
      if (it && !seen.has(it.url)) { seen.add(it.url); out.push(it); }
    }
  }
  /* richItemRenderer wraps a videoRenderer, already caught above; shorts come
     through reelItemRenderer with a different id field */
  for (const r of collect(json, 'reelItemRenderer')) {
    const id = r.videoId;
    if (!id || seen.has('/watch?v=' + id)) continue;
    seen.add('/watch?v=' + id);
    out.push({
      url: '/watch?v=' + id, type: 'stream', title: txt(r.headline),
      thumbnail: bestThumb(r.thumbnail), uploaderName: '', uploaderUrl: '',
      uploadedDate: '', duration: 0, views: viewsToNumber(txt(r.viewCountText)),
      uploaderVerified: false, isShort: true,
    });
  }
  return out;
}

/* ------------------------------------------------- blocked vs. empty --- */

const GATE_RX = /sign in to confirm|not a bot|unusual traffic|consent\.youtube|before you continue/i;

/** The wording YouTube used to refuse us, if it refused us. */
export function gateReason(json) {
  let s = '';
  try { s = JSON.stringify(json); } catch { return ''; }
  const m = s.match(GATE_RX);
  return m ? m[0] : '';
}

/**
 * True when a response carries none of the scaffolding YouTube wraps results
 * in.
 *
 * This is the difference that matters to the failover pool. A search that
 * genuinely matched nothing still ships an itemSectionRenderer (usually
 * holding "No results found"); a bot-gated or consent-walled reply ships no
 * renderers at all. Without this distinction a blocked response would parse
 * cleanly to `[]`, the pool would score it a success, and the caller would be
 * stranded on a blank page while working public instances sat unused.
 */
export function barren(json) {
  for (const k of ['itemSectionRenderer', 'richGridRenderer', 'sectionListRenderer',
    'backgroundPromoRenderer', 'twoColumnBrowseResultsRenderer']) {
    if (collect(json, k).length) return false;
  }
  return true;
}

function blocked(what, json) {
  const why = gateReason(json);
  const e = new Error(`local extraction recovered no ${what}` + (why ? ` — youtube said "${why}"` : ''));
  e.gated = !!why;
  return e;
}

/* ------------------------------------------------------------ endpoints */

/** Piped /streams/:videoId, extracted locally through the client ladder. */
export async function streams(videoId) {
  const vis = (await getVisitorData({})).value;
  /* Minted once and reused across the ladder: the token is bound to this
     visitor identity, and asking for a fresh one per client would be both
     slower and more suspicious. */
  const pot = await getPoToken(vis);
  let pr = null;
  let used = null;
  const tried = [];
  for (const client of LADDER) {
    try {
      const j = await playerRequest(videoId, client, { visitorData: vis, poToken: pot });
      const sd = (j && j.streamingData) || {};
      /* A ciphered format is a usable format now, so it counts when deciding
         whether this client produced anything. Treating only plain `url` as
         success is what made every ciphered video look empty. */
      /* An HLS manifest is a complete answer by itself — it needs no
         deciphering and is not subject to per-format gating — so a client
         that returns one has succeeded even with no usable formats. */
      const any = [...(sd.formats || []), ...(sd.adaptiveFormats || [])]
        .some((f) => f.url || f.signatureCipher || f.cipher) || !!sd.hlsManifestUrl;
      if (any) { pr = j; used = client; break; }
      tried.push({ client, note: ((j || {}).playabilityStatus || {}).status || 'no urls' });
      if (!pr && j) pr = j;
    } catch (e) {
      tried.push({ client, note: String(e.message || e).slice(0, 100) });
    }
  }
  if (!pr) {
    const err = new Error('local extraction failed for ' + videoId
      + ' (' + tried.map((t) => t.client + ': ' + t.note).join('; ') + ')');
    err.tried = tried;
    throw err;
  }

  return payloadFromPlayerResponse(pr, videoId, { pot, used, tried });
}

/**
 * Turn a playerResponse into the Piped-shaped payload the rest of Umbra
 * speaks.
 *
 * Factored out of streams() because the InnerTube API is no longer the only
 * way we obtain one of these: the watch page carries the same object. Two
 * copies of this logic would drift, and the deciphering and proof-of-origin
 * handling below is exactly the part that must not.
 */
export async function payloadFromPlayerResponse(pr, videoId, { pot = '', used = null, tried = [] } = {}) {
  const sd = pr.streamingData || {};
  const vd = pr.videoDetails || {};
  const mf = (pr.microformat || {}).playerMicroformatRenderer || {};

  /* Piped splits by videoOnly rather than by formats/adaptiveFormats. A
     format carrying both tracks is progressive, i.e. videoOnly=false. */
  const mapStream = (f) => {
    const mime = String(f.mimeType || '');
    const hasV = /video\//.test(mime);
    const hasA = /audio\//.test(mime) || /mp4a|opus|ac-3|vorbis/.test(mime);
    return {
      url: f.url || '',
      format: /webm/.test(mime) ? 'WEBM' : /mp4/.test(mime) ? 'MPEG_4' : '',
      quality: f.qualityLabel || f.audioQuality || f.quality || '',
      mimeType: mime.split(';')[0],
      codec: (mime.split('codecs=')[1] || '').replace(/"/g, '').trim(),
      audioTrackId: (f.audioTrack || {}).id || null,
      audioTrackName: (f.audioTrack || {}).displayName || null,
      videoOnly: hasV && !hasA,
      bitrate: Number(f.bitrate || 0),
      initStart: Number((f.initRange || {}).start || 0),
      initEnd: Number((f.initRange || {}).end || 0),
      indexStart: Number((f.indexRange || {}).start || 0),
      indexEnd: Number((f.indexRange || {}).end || 0),
      width: Number(f.width || 0),
      height: Number(f.height || 0),
      fps: Number(f.fps || 0),
      contentLength: Number(f.contentLength || 0),
      itag: Number(f.itag || 0),
    };
  };

  /* Resolve every format through the player script. Loading base.js can
     fail (network, or YouTube reshaping it); that is survivable as long as
     some formats carried a plain url, so the failure is recorded and the
     plain ones still play rather than the whole page dying. */
  let player = null;
  let playerError = null;
  const raw = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
  const needsPlayer = raw.some((f) => !f.url && (f.signatureCipher || f.cipher));
  if (raw.length) {
    try { player = await getPlayer(); } catch (e) { playerError = String(e.message || e).slice(0, 160); }
  }

  let ciphered = 0;
  let unresolved = 0;
  const all = [];
  for (const f of raw) {
    const r = resolveFormat(f, player);
    if (!r) { unresolved++; continue; }
    if (r.ciphered) ciphered++;
    /* googlevideo wants the same proof on the media request, not just on the
       player request; without `pot` those URLs 403 on first byte. */
    let url = r.url;
    if (pot) {
      try {
        const u = new URL(url);
        if (!u.searchParams.has('pot')) { u.searchParams.set('pot', pot); url = u.toString(); }
      } catch { /* leave it alone */ }
    }
    all.push({ ...f, url });
  }
  const mapped = all.map(mapStream);
  const videoStreams = mapped.filter((s) => /^video\//.test(s.mimeType));
  const audioStreams = mapped.filter((s) => /^audio\//.test(s.mimeType))
    .map((s) => ({ ...s, videoOnly: false }));

  const subtitles = (((pr.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [])
    .filter((t) => t.baseUrl)
    .map((t) => ({
      url: t.baseUrl,
      mimeType: 'application/ttml+xml',
      name: txt(t.name) || t.languageCode || 'subtitles',
      code: t.languageCode || 'und',
      autoGenerated: t.kind === 'asr',
    }));

  return {
    title: vd.title || mf.title || videoId,
    description: (mf.description && txt(mf.description)) || vd.shortDescription || '',
    uploader: vd.author || txt(mf.ownerChannelName) || '',
    uploaderUrl: vd.channelId ? '/channel/' + vd.channelId : '',
    uploaderAvatar: '',
    uploaderVerified: false,
    uploadDate: mf.publishDate || mf.uploadDate || '',
    duration: Number(vd.lengthSeconds || mf.lengthSeconds || 0),
    views: Number(vd.viewCount || 0),
    likes: -1,
    dislikes: -1,
    thumbnailUrl: bestThumb(vd.thumbnail) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    livestream: !!vd.isLiveContent,
    hls: sd.hlsManifestUrl || null,
    dash: sd.dashManifestUrl || null,
    proxyUrl: '',
    lbryId: null,
    videoStreams,
    audioStreams,
    subtitles,
    relatedStreams: [],
    /* provenance beyond the Piped contract, harmless to other clients */
    umbraClient: used,
    umbraTried: tried,
    umbraCiphered: ciphered,
    umbraUnresolved: unresolved,
    umbraPlayerError: playerError,
    umbraPoToken: pot ? 'present' : 'absent',
  };
}

/** Piped /search?q=&filter= */
export async function search(q, filter = 'videos') {
  const vis = (await getVisitorData({})).value;
  /* params is the protobuf filter YouTube expects; this one means
     "type = video", the only filter this instance advertises support for */
  const payload = { query: q };
  if (filter === 'videos') payload.params = 'EgIQAQ%3D%3D';
  const j = await innertubeRequest('search', payload, METADATA_CLIENT, { visitorData: vis });
  const items = videoItems(j);
  /* zero hits is a legitimate answer, so only raise when the reply also came
     back with no result scaffolding at all -- that is a block, not an answer */
  if (!items.length && barren(j)) throw blocked('search results', j);
  return {
    items,
    nextpage: null,
    suggestion: txt(collect(j, 'showingResultsForRenderer')[0]?.correctedQuery) || null,
    corrected: !!collect(j, 'showingResultsForRenderer').length,
  };
}

/** Piped /trending?region= */
export async function trending(region = 'US') {
  const vis = (await getVisitorData({})).value;
  const j = await innertubeRequest('browse', { browseId: 'FEtrending' }, METADATA_CLIENT, { visitorData: vis });
  void region; /* region follows the egress IP; honoured by the public pool */
  const items = videoItems(j);
  /* trending is never legitimately empty, so empty means blocked */
  if (!items.length) throw blocked('trending videos', j);
  return items;
}

/** Piped /channel/:id */
export async function channel(id) {
  const vis = (await getVisitorData({})).value;
  const j = await innertubeRequest('browse', { browseId: id }, METADATA_CLIENT, { visitorData: vis });
  const hdr = collect(j, 'c4TabbedHeaderRenderer')[0] || collect(j, 'pageHeaderRenderer')[0] || {};
  const meta = (j.metadata || {}).channelMetadataRenderer || {};
  const related = videoItems(j);
  const name = meta.title || txt(hdr.title);
  /* a channel with no uploads is possible; one with no name and no uploads
     means we never actually reached the channel */
  if (!name && !related.length) throw blocked('channel', j);
  return {
    id: meta.externalId || id,
    name: name || id,
    description: meta.description || '',
    avatarUrl: bestThumb(hdr.avatar) || (meta.avatar ? bestThumb(meta.avatar) : ''),
    bannerUrl: bestThumb(hdr.banner),
    subscriberCount: viewsToNumber(txt(hdr.subscriberCountText)),
    verified: /VERIFIED/i.test(JSON.stringify(hdr.badges || [])),
    nextpage: null,
    relatedStreams: related,
  };
}

/**
 * Piped /comments/:videoId.
 *
 * Comments live behind a continuation token that only exists inside the /next
 * response, and YouTube has been migrating them to an entity-payload format
 * carried in frameworkUpdates. Both shapes are read here; when neither yields
 * anything the endpoint reports `disabled` rather than inventing an empty
 * thread, so a caller can tell "no comments" from "we could not get them".
 */
export async function comments(videoId) {
  const vis = (await getVisitorData({})).value;
  const first = await innertubeRequest('next', { videoId }, METADATA_CLIENT, { visitorData: vis, videoId });

  const token = collect(first, 'continuationItemRenderer')
    .map((c) => c.continuationEndpoint?.continuationCommand?.token)
    .filter(Boolean)
    .pop();
  let tree = first;
  if (token) {
    try {
      tree = await innertubeRequest('next', { continuation: token }, METADATA_CLIENT, { visitorData: vis, videoId });
    } catch { /* fall back to whatever the first response carried */ }
  }

  const out = [];
  /* legacy renderer shape */
  for (const c of collect(tree, 'commentRenderer')) {
    out.push({
      author: txt(c.authorText),
      commentId: c.commentId || '',
      commentText: txt(c.contentText),
      commentedTime: txt(c.publishedTimeText),
      commentorUrl: c.authorEndpoint?.browseEndpoint?.browseId ? '/channel/' + c.authorEndpoint.browseEndpoint.browseId : '',
      hearted: !!c.actionButtons?.commentActionButtonsRenderer?.creatorHeart,
      likeCount: viewsToNumber(txt(c.voteCount)),
      pinned: !!(c.pinnedCommentBadge || c.isPinned),
      thumbnail: bestThumb(c.authorThumbnail),
      verified: !!c.authorCommentBadge,
      creatorReplied: false,
    });
  }
  /* current entity-payload shape */
  for (const p of collect(tree, 'commentEntityPayload')) {
    const a = p.author || {};
    out.push({
      author: a.displayName || '',
      commentId: p.properties?.commentId || '',
      commentText: p.properties?.content?.content || '',
      commentedTime: p.properties?.publishedTime || '',
      commentorUrl: a.channelId ? '/channel/' + a.channelId : '',
      hearted: !!p.author?.isCreator && !!p.toolbar?.heartActive,
      likeCount: viewsToNumber(p.toolbar?.likeCountNotliked || p.toolbar?.likeCountA11y),
      pinned: false,
      thumbnail: a.avatarThumbnailUrl || '',
      verified: !!a.isVerified,
      creatorReplied: false,
    });
  }

  const seen = new Set();
  const uniq = out.filter((c) => (c.commentId && seen.has(c.commentId) ? false : (seen.add(c.commentId), true)));
  return { comments: uniq, disabled: uniq.length === 0, nextpage: null };
}

/**
 * Route one Piped API path in-process. Mirrors the public REST surface so the
 * same function backs both the HTTP endpoints and the internal pool, which
 * means the local instance is exercised by exactly the code path a third
 * party would hit.
 */
export async function handle(pathname, params = new URLSearchParams()) {
  const p = pathname.replace(/\/+$/, '') || '/';
  let m;
  if (p === '/healthcheck') return { status: 'ok', instance: 'umbra-local' };
  if ((m = /^\/streams\/([\w-]{11})$/.exec(p))) return streams(m[1]);
  if (p === '/search') return search(String(params.get('q') || ''), String(params.get('filter') || 'videos'));
  if (p === '/trending') return trending(String(params.get('region') || 'US'));
  if ((m = /^\/channel\/([\w-]+)$/.exec(p))) return channel(m[1]);
  if ((m = /^\/comments\/([\w-]{11})$/.exec(p))) return comments(m[1]);
  const err = new Error('no such piped endpoint: ' + p);
  err.status = 404;
  throw err;
}

export { METADATA_CLIENT };

/**
 * Why a video did or did not produce streams.
 *
 * "No playable streams" is the least useful error this proxy can emit: it
 * collapses a bot gate, a reshaped player script and an age restriction into
 * one sentence. This walks the whole ladder without short-circuiting and
 * reports what each client actually returned, so the cause is visible rather
 * than guessed at.
 */
export async function diagnose(videoId) {
  const vis = (await getVisitorData({})).value;
  let player = null;
  let playerError = null;
  try { player = await getPlayer(); } catch (e) { playerError = String(e.message || e).slice(0, 200); }
  const pot = await getPoToken(vis);

  const clients = [];
  for (const client of LADDER) {
    const row = { client };
    try {
      const j = await playerRequest(videoId, client, { visitorData: vis, poToken: pot });
      const sd = (j && j.streamingData) || {};
      const raw = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
      row.playability = ((j || {}).playabilityStatus || {}).status || null;
      row.reason = ((j || {}).playabilityStatus || {}).reason || null;
      row.formats = raw.length;
      row.withUrl = raw.filter((f) => f.url).length;
      row.ciphered = raw.filter((f) => !f.url && (f.signatureCipher || f.cipher)).length;
      row.resolved = raw.filter((f) => resolveFormat(f, player)).length;
      row.hls = !!sd.hlsManifestUrl;
      /* An HLS manifest is a complete answer on its own: it sidesteps
         per-format gating and needs no deciphering, so a client that offers
         one is usable even with zero resolvable formats. */
      row.usable = row.resolved > 0 || row.hls;
    } catch (e) {
      row.error = String(e.message || e).slice(0, 200);
      row.usable = false;
    }
    clients.push(row);
  }

  const best = clients.find((c) => c.usable) || null;
  return {
    videoId,
    usable: !!best,
    servedBy: best && best.client,
    player: { ...playerInspect(), error: playerError },
    poToken: potInspect(),
    clients,
    /* the most common causes, named rather than implied */
    diagnosis: !best
      ? (clients.every((c) => c.formats === 0)
        ? 'every client returned zero formats — this is an egress-level block or an unavailable video'
        : clients.some((c) => c.ciphered > 0)
          ? 'formats arrived ciphered and the player script could not unscramble them' + (playerError ? ': ' + playerError : '')
          : (!pot
            ? 'formats were withheld and no PO token was available — this is the usual datacentre-IP failure'
            : 'formats arrived but none resolved to a url'))
      : (best.ciphered > 0 ? 'ciphered formats, deciphered locally' : 'plain urls, no deciphering needed'),
  };
}
