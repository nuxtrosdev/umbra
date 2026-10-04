/**
 * InnerTube client identities + visitor-session minting.
 *
 * Why this file exists
 * --------------------
 * YouTube's "Sign in to confirm you're not a bot" wall is two separate gates
 * wearing one error message:
 *
 *   1. *Document* gating. The full watch page runs BotGuard and will hand a
 *      datacenter IP a consent/challenge interstitial instead of a player.
 *      The /embed/ document is a much smaller surface: it is designed to be
 *      loaded by arbitrary third-party sites, so the challenge attached to it
 *      is looser. We read player config from /embed/ and never touch /watch.
 *
 *   2. *API* gating. /youtubei/v1/player decides what to return based on the
 *      `context.client` identity in the POST body. Some clients are held to
 *      the full Proof-of-Origin (PO) token regime — no token, and the response
 *      comes back with every format `url` stripped. Other clients (TV, VR,
 *      visionOS) authenticate differently and still answer without one.
 *
 * So the fix is a *ladder* of client identities, tried in order, stopping at
 * the first one that returns formats this proxy can actually fetch bytes for.
 *
 * Two constraints shape the default ordering, and neither is obvious:
 *
 *   - Umbra has no JavaScript player interpreter. Clients marked
 *     REQUIRE_JS_PLAYER in yt-dlp return `signatureCipher` formats whose URLs
 *     must be unscrambled by running YouTube's own obfuscated base.js. We
 *     cannot do that, so those formats are dead weight to us even when the
 *     request itself succeeds. Clients that never cipher (visionos, android_vr)
 *     are therefore preferred, not merely tolerated.
 *
 *   - A client can answer 200 with a full format list whose URLs then 403 at
 *     the Google Video Server because that client needs a GVS PO token. That
 *     failure lands *after* inspect() returns, so client choice has to account
 *     for it up front. See the GVS notes on each entry.
 *
 * Client facts are tracked against yt-dlp's INNERTUBE_CLIENTS table, which is
 * the best-maintained public record of this moving target. Version strings go
 * stale — every one of them is overridable by env, see LADDER below.
 */
import { upstream, readBody } from './net.mjs';

/* Read at call time, not at import time. A constant captured on first import
   cannot be redirected afterwards, which made the module untestable against a
   local upstream and silently sent test traffic to the real youtube.com. */
const ytBase = () => (process.env.UMBRA_YT_BASE || 'https://www.youtube.com').replace(/\/$/, '');

/* An embedded player identifies the page hosting it. It must NOT be a YouTube
   URL: the whole premise of the embedded clients is that an external site is
   doing the embedding, and a youtube.com embedUrl is a contradiction that
   marks the request as synthetic. yt-dlp uses reddit.com for the same reason. */
const EMBED_HOST = process.env.UMBRA_YT_EMBED_URL || 'https://www.reddit.com/';

/**
 * Client registry.
 *
 * jsPlayer  — true when the client returns ciphered stream URLs that require
 *             running YouTube's base.js to unscramble. Umbra cannot, so these
 *             are downgraded in the ladder.
 * gvsToken  — true when stream URLs from this client are known to demand a GVS
 *             PO token, i.e. the format list may look fine and still 403.
 * screen    — 'EMBED' makes the player treat the request as an embedded view,
 *             which is what unlocks embeddable age-gated videos.
 */
export const CLIENTS = {
  /* visionOS: no JS player, no PO token policy on record. Best first pick for
     a proxy that cannot decipher. "Made for kids" videos are unavailable. */
  visionos: {
    name: 'VISIONOS',
    id: 101,
    version: '1.02',
    jsPlayer: false,
    gvsToken: false,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    extra: {
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
    },
  },

  /* The iOS app. Worth placing high for a reason that is easy to miss: it is
     the client most likely to answer with an HLS manifest rather than a list
     of individual formats. A manifest is a single URL that needs no
     per-format deciphering and is not gated format by format, so when
     everything else comes back with an empty format table this is the one
     that can still produce something playable. */
  ios: {
    name: 'IOS',
    id: 5,
    version: '20.10.4',
    jsPlayer: false,
    gvsToken: true,
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X; en_US)',
    extra: {
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
    },
  },

  /* The Android app. A separate scoring bucket from anything web-shaped, and
     it does not cipher. It now wants a PO token more often than it used to,
     which is precisely why it sits behind the clients that do not. */
  android: {
    name: 'ANDROID',
    id: 3,
    version: '20.10.38',
    jsPlayer: false,
    gvsToken: true,
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US) gzip',
    extra: {
      androidSdkVersion: 34,
      osName: 'Android',
      osVersion: '14',
    },
  },

  /* YouTube Music. A different product surface with its own scoring, which
     occasionally answers for a plain video when the video clients will not. */
  web_music: {
    name: 'WEB_REMIX',
    id: 67,
    version: '1.20250310.01.00',
    jsPlayer: true,
    gvsToken: true,
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extra: {},
  },

  /* Safari on desktop. YouTube treats the Safari web client differently from
     Chrome's and it is the usual fallback once `tv` stops working; it ciphers,
     which is fine now that we can decipher. */
  web_safari: {
    name: 'WEB',
    id: 1,
    version: '2.20260725.01.00',
    jsPlayer: true,
    gvsToken: true,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    extra: {},
  },

  /* Mobile web. A distinct scoring bucket again, and cheap to try. */
  mweb: {
    name: 'MWEB',
    id: 2,
    version: '2.20260725.01.00',
    jsPlayer: true,
    gvsToken: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    extra: {},
  },

  /* Cobalt / smart-TV client. Needs the JS player for some videos but is not
     under the GVS token regime, so when it does return plain URLs they work. */
  tv: {
    name: 'TVHTML5',
    id: 7,
    version: '7.20260707.07.00',
    jsPlayer: true,
    gvsToken: false,
    ua: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
    extra: {},
  },

  /* The client the real /embed/ page runs as. Pairs naturally with an embed
     referer and unlocks embeddable age-gated videos via clientScreen=EMBED. */
  web_embedded: {
    name: 'WEB_EMBEDDED_PLAYER',
    id: 56,
    version: '2.20260708.00.00',
    jsPlayer: true,
    gvsToken: false,
    screen: 'EMBED',
    embedded: true,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)',
    extra: {},
  },

  /* Older TV build. Kept as a fallback because the current one occasionally
     starts returning SABR-only responses ahead of a yt-dlp version bump. */
  tv_downgraded: {
    name: 'TVHTML5',
    id: 7,
    version: '5.20260707',
    jsPlayer: true,
    gvsToken: false,
    ua: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
    extra: {},
  },

  /* Requested explicitly, and kept — but read this before relying on it.
     android_vr was for a long time the standard PO-token-free client. As of
     2026-08-17 yt-dlp records that ALL formats from it, including live HLS and
     the itag-18 muxed fallback, are being 403'd at version 1.65.10. Versions
     above 1.65 return SABR-only responses, so bumping is not a fix either.
     It sits near the bottom of the ladder: it costs one request in the case
     where everything better has already failed, and it may come back. */
  android_vr: {
    name: 'ANDROID_VR',
    id: 28,
    version: '1.65.10',
    jsPlayer: false,
    gvsToken: true,
    ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    extra: {
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12L',
    },
  },

  /* Last resort. Under the full web PO-token regime: expect a format list with
     the URLs stripped, which is precisely the symptom being worked around. */
  web: {
    name: 'WEB',
    id: 1,
    version: '2.20260708.00.00',
    jsPlayer: true,
    gvsToken: true,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extra: {},
  },
};

/** Ordered client attempts. Override with UMBRA_YT_CLIENTS=visionos,tv,... */
export const LADDER = (process.env.UMBRA_YT_CLIENTS ||
  'tv,ios,visionos,web_embedded,tv_downgraded,android,web_safari,mweb,web_music,android_vr,web')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => Object.hasOwn(CLIENTS, s));

/* ------------------------------------------------------- visitor identity */

/**
 * visitorData is NOT a random string.
 *
 * It is base64(protobuf) whose first two bytes are always 0x0a 0x0b — field 1,
 * length 11 — wrapping an 11-character visitor id, usually followed by a
 * timestamp field. Minting a fresh random one per request is actively harmful:
 * it is both easy to reject as malformed and, when well-formed, a perfect
 * bot signature, because a real client keeps one visitor identity across its
 * whole session. NewPipeExtractor shipped random generation, watched it break,
 * and moved to reading a real token from /sw.js_data.
 *
 * So: mint one real token per egress identity, cache it, and reuse it. The
 * cache is process-wide on purpose — the thing YouTube is profiling is the
 * egress IP, and one IP presenting many visitor identities is the pattern we
 * are trying not to produce.
 */
const VISITOR_TTL = Number(process.env.UMBRA_YT_VISITOR_TTL || 6 * 3600 * 1000);
let visitorCache = { value: null, at: 0, source: 'none' };

/** A visitorData candidate must decode to the 0x0a 0x0b protobuf header. */
export function looksLikeVisitorData(s) {
  if (typeof s !== 'string' || s.length < 16 || s.length > 512) return false;
  try {
    const b = Buffer.from(s.replace(/%3D/gi, '=').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return b.length >= 13 && b[0] === 0x0a && b[1] === 0x0b;
  } catch {
    return false;
  }
}

/**
 * Structurally valid synthetic token, used only when minting fails outright.
 * Better than sending nothing (some endpoints key session state off it), but
 * it is not a real Google-issued identity — callers surface it as `synthetic`
 * so a persistent block can be attributed correctly.
 */
export function synthesizeVisitorData() {
  const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = '';
  for (let i = 0; i < 11; i++) id += AL[Math.floor(Math.random() * AL.length)];
  const ts = Math.floor(Date.now() / 1000);
  /* field 1 (id, len 11) + field 5 varint (timestamp) */
  const varint = [];
  let n = ts;
  while (n > 0x7f) { varint.push((n & 0x7f) | 0x80); n >>>= 7; }
  varint.push(n);
  const buf = Buffer.concat([
    Buffer.from([0x0a, 0x0b]),
    Buffer.from(id, 'ascii'),
    Buffer.from([0x28]),
    Buffer.from(varint),
  ]);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Pull every JSON string literal out of a blob and test each as a token. */
function scanForVisitor(text) {
  const re = /"([A-Za-z0-9_\-+/=%]{16,512})"/g;
  let m;
  while ((m = re.exec(text))) if (looksLikeVisitorData(m[1])) return m[1];
  return null;
}

/**
 * Mint a visitor identity. Order: the service-worker data endpoint (cheap,
 * no video context, returns a genuine token), then whatever the embed page's
 * ytcfg carried, then a synthetic fallback.
 */
export async function getVisitorData({ cookie = '', embedHtml = '', force = false } = {}) {
  const now = Date.now();
  if (!force && visitorCache.value && now - visitorCache.at < VISITOR_TTL) return visitorCache;

  try {
    const res = await upstream(ytBase() + '/sw.js_data', {
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        referer: ytBase() + '/',
        origin: ytBase(),
        cookie,
      },
    });
    if (res.status === 200) {
      const body = (await readBody(res.res, { limit: 2 * 1024 * 1024 })).toString('utf8');
      /* response is XSSI-guarded with )]}' before the JSON array */
      const found = scanForVisitor(body.replace(/^\)\]\}'\s*/, ''));
      if (found) {
        visitorCache = { value: found, at: now, source: 'sw.js_data', synthetic: false };
        return visitorCache;
      }
    } else {
      res.res.resume();
    }
  } catch {
    /* fall through to the page-scraped value */
  }

  if (embedHtml) {
    const m = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(embedHtml) ||
      /VISITOR_DATA\s*:\s*"([^"]+)"/.exec(embedHtml);
    if (m && looksLikeVisitorData(m[1])) {
      visitorCache = { value: m[1], at: now, source: 'embed-ytcfg', synthetic: false };
      return visitorCache;
    }
  }

  /* Keep a synthetic token stable too — churning it is the worst of both. */
  if (visitorCache.value && visitorCache.synthetic) return visitorCache;
  visitorCache = { value: synthesizeVisitorData(), at: now, source: 'synthetic', synthetic: true };
  return visitorCache;
}

/** Test seam: drop the cached identity. */
export function resetVisitorCache() {
  visitorCache = { value: null, at: 0, source: 'none' };
}

/* ------------------------------------------------------- request shaping */

/** Build the `context` object for one client. */
export function buildContext(key, { visitorData = '', hl = 'en', gl = 'US' } = {}) {
  const c = CLIENTS[key];
  if (!c) throw new Error('unknown innertube client: ' + key);
  const client = {
    clientName: c.name,
    clientVersion: c.version,
    hl,
    gl,
    ...c.extra,
  };
  if (c.ua) client.userAgent = c.ua;
  if (visitorData) client.visitorData = visitorData;
  const context = { client };
  if (c.screen) context.client.clientScreen = c.screen;
  if (c.embedded) context.thirdParty = { embedUrl: EMBED_HOST };
  return context;
}

/** Headers that must agree with the in-body client identity. */
export function buildHeaders(key, { visitorData = '', videoId = '', cookie = '' } = {}) {
  const c = CLIENTS[key];
  const h = {
    'content-type': 'application/json',
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': c.ua,
    'x-youtube-client-name': String(c.id),
    'x-youtube-client-version': c.version,
    origin: ytBase(),
    referer: c.embedded && videoId ? ytBase() + '/embed/' + videoId : ytBase() + '/',
  };
  if (visitorData) h['x-goog-visitor-id'] = visitorData;
  if (cookie) h.cookie = cookie;
  return h;
}

/** True for the InnerTube RPC surface on any YouTube host. */
export function isInnertubeUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)(youtube\.com|youtube-nocookie\.com|youtubei\.googleapis\.com)$/i.test(u.hostname) &&
      u.pathname.startsWith('/youtubei/');
  } catch {
    return false;
  }
}

/**
 * Rewrite an in-flight InnerTube POST body so a request minted by the page's
 * own JavaScript carries our chosen identity instead of the browser's WEB one.
 * Returns null when the body is not InnerTube JSON, so the caller passes it
 * through untouched.
 */
export function rewriteInnertubeBody(buf, { client = LADDER[0], visitorData = '' } = {}) {
  if (!buf || !buf.length || buf.length > 4 * 1024 * 1024) return null;
  let j;
  try {
    j = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !j.context) return null;
  const ctxObj = buildContext(client, { visitorData });
  j.context = {
    ...j.context,
    ...ctxObj,
    client: { ...(j.context.client || {}), ...ctxObj.client },
  };
  /* Age/content gates block the embedded path far more often than the watch
     path; assert both so an embeddable age-gated video still resolves. */
  j.contentCheckOk = true;
  j.racyCheckOk = true;
  return Buffer.from(JSON.stringify(j), 'utf8');
}

/**
 * One InnerTube RPC as `client`. Returns the parsed JSON or throws.
 *
 * `endpoint` is the bare name ('player', 'search', 'browse', 'next').
 * `apiKey` is optional: modern InnerTube accepts keyless calls, but passing
 * the page's own key when we have it keeps the request consistent with what
 * the embed document would have sent.
 */
export async function innertubeRequest(endpoint, payload, key, { visitorData = '', cookie = '', apiKey = '', videoId = '' } = {}) {
  const url = ytBase() + '/youtubei/v1/' + endpoint + '?prettyPrint=false' +
    (apiKey ? '&key=' + encodeURIComponent(apiKey) : '');
  const body = JSON.stringify({
    context: buildContext(key, { visitorData }),
    ...payload,
  });
  const res = await upstream(url, {
    method: 'POST',
    headers: { ...buildHeaders(key, { visitorData, videoId, cookie }), 'content-length': String(Buffer.byteLength(body)) },
    body,
  });
  const raw = await readBody(res.res, { limit: 16 * 1024 * 1024 });
  if (res.status !== 200) throw new Error('innertube ' + endpoint + '/' + key + ' http ' + res.status);
  return JSON.parse(raw.toString('utf8'));
}

/**
 * One /youtubei/v1/player call as `client`. Returns the parsed player response
 * or throws. `apiKey` is optional: modern InnerTube accepts keyless calls, but
 * passing the page's own key when we have it keeps the request consistent with
 * what the embed document would have sent.
 */
export async function playerRequest(videoId, key, { visitorData = '', cookie = '', apiKey = '', poToken = '' } = {}) {
  const payload = {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: 'HTML5_PREF_WANTS',
        signatureTimestamp: 20073,
      },
    },
  };
  /* The proof-of-origin token rides on the player request itself. Without it
     YouTube commonly answers 200 with every good format withheld, which reads
     downstream as "no playable streams" rather than as a refusal. */
  if (poToken) payload.serviceIntegrityDimensions = { poToken };
  /* A signed-in session is the other thing that clears the gate; cookies are
     supplied by the operator, never collected here. */
  const jar = cookie || (process.env.UMBRA_YT_COOKIES || '').trim();
  return innertubeRequest('player', payload, key, { visitorData, cookie: jar, apiKey, videoId });
}

export { ytBase, EMBED_HOST };
/* compatibility: some callers read the value, not the getter */
export const YT_BASE = ytBase();
