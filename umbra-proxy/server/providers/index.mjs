/**
 * Provider registry.
 *
 * Adding a backend means writing an adapter and adding one line here. Nothing
 * downstream — the manager, the API routes, the Tube UI — carries a list of
 * provider names or a branch on which one answered.
 *
 * Default order encodes a judgement rather than a preference: local extraction
 * first because it is fastest and involves no third party, then the two
 * independent HTTP backends that extract from *someone else's* address (which
 * is what saves us when ours is bot-gated), then the optional engines. The
 * scorer reorders within that by observed health, so a provider having a bad
 * day sinks on its own without anyone editing config.
 */

import * as innertube from './innertube.mjs';
import * as piped from './piped.mjs';
import * as invidious from './invidious.mjs';
import * as poketube from './poketube.mjs';
import * as youtubejs from './youtubejs.mjs';
import * as newpipe from './newpipe.mjs';
import * as ytdlp from './ytdlp.mjs';
import { envList } from './pool.mjs';

export const ALL = [innertube, piped, invidious, poketube, youtubejs, newpipe, ytdlp];

const BY_ID = new Map(ALL.map((p) => [p.id, p]));
export const get = (id) => BY_ID.get(id) || null;

const DEFAULT_ORDER = ['innertube', 'piped', 'invidious', 'poketube', 'newpipe', 'youtubejs', 'ytdlp'];

/** UMBRA_PROVIDERS overrides both the order and the membership. */
export function order() {
  const want = envList('UMBRA_PROVIDERS', DEFAULT_ORDER);
  return want.map((id) => BY_ID.get(id)).filter(Boolean);
}

/**
 * A provider is live if it declares the capability and has somewhere to send
 * the request. Optional providers report themselves off rather than failing
 * three times first and being benched for it.
 */
/**
 * Probe the optional engines once so they can report themselves off rather
 * than being discovered dead three failed requests at a time. Fire-and-forget:
 * nothing waits on it, and until it resolves those providers simply sit at the
 * back of the order where they already belong.
 */
let detected = null;
export function detectOptional() {
  if (detected) return detected;
  detected = Promise.allSettled(
    ALL.filter((p) => typeof p.available === 'function').map((p) => p.available()));
  return detected;
}

export function enabled(p) {
  if (typeof p.enabled === 'function') return p.enabled();
  return true;
}

export function supports(p, capability) {
  return !!(p.capabilities && p.capabilities[capability]) && typeof p[methodFor(capability)] === 'function';
}

export function methodFor(capability) {
  return {
    search: 'search',
    video: 'getVideo',
    channel: 'getChannel',
    playlist: 'getPlaylist',
    comments: 'getComments',
    recommendations: 'getRecommendations',
    streams: 'getStreams',
    trending: 'trending',
  }[capability] || null;
}

export const CAPABILITIES = [
  'search', 'video', 'channel', 'playlist', 'comments', 'recommendations', 'streams', 'trending',
];

/**
 * Projects deliberately *not* wired as independent backends, with the reason.
 *
 * The brief asked for several of these by name and also asked not to treat a
 * project as a backend when it merely consumes one. Both can be true at once,
 * so the finding is recorded here and served from the API rather than being
 * silently dropped — it is the answer to "why isn't CloudTube in the list".
 */
export const SURVEY = [
  { project: 'CloudTube', verdict: 'not-independent',
    reason: 'A front end over Invidious. Its data comes from an Invidious instance, so adding it would be the invidious provider with extra hops.',
    covered_by: 'invidious' },
  { project: 'ViewTube', verdict: 'not-independent',
    reason: 'A full front end whose extraction is YouTube.js plus node-ytpl. The engine is already available directly.',
    covered_by: 'youtubejs' },
  { project: 'FreeTube', verdict: 'not-a-backend',
    reason: 'A desktop application, not a service. Its extraction is the local-API approach plus Invidious, both already represented.',
    covered_by: 'innertube, invidious' },
  { project: 'LibreTube', verdict: 'not-independent',
    reason: 'An Android client that talks to Piped instances. It is a consumer of the Piped API, not a source.',
    covered_by: 'piped' },
  { project: 'Yattee', verdict: 'not-independent',
    reason: 'Apple-platform client over Invidious and Piped.', covered_by: 'invidious, piped' },
  { project: 'Clipious', verdict: 'not-independent',
    reason: 'Android client for Invidious.', covered_by: 'invidious' },
  { project: 'TubiTui', verdict: 'not-independent',
    reason: 'Terminal client for Invidious.', covered_by: 'invidious' },
  { project: 'ytfzf', verdict: 'not-independent',
    reason: 'Shell script that scrapes YouTube or queries Invidious, then hands off to yt-dlp/mpv.',
    covered_by: 'invidious, ytdlp' },
  { project: 'youtube-viewer', verdict: 'not-independent',
    reason: 'Perl client using the YouTube Data API and yt-dlp.', covered_by: 'ytdlp' },
  { project: 'pipe-viewer', verdict: 'not-independent',
    reason: 'Sibling of youtube-viewer that parses YouTube directly; same engine class as our native InnerTube adapter.',
    covered_by: 'innertube' },
  { project: 'PlasmaTube', verdict: 'not-independent',
    reason: 'KDE client over Invidious and Piped.', covered_by: 'invidious, piped' },
  { project: 'Pipeline', verdict: 'not-independent',
    reason: 'GTK client over Piped.', covered_by: 'piped' },
  { project: 'PokeTube', verdict: 'same-engine',
    reason: 'A front end on InnerTube — the same engine we run natively. Wired as an optional provider because a separate deployment still gives address diversity, but it adds no new extraction technique.',
    covered_by: 'innertube' },
  { project: 'NewPipeExtractor', verdict: 'same-engine-via-piped',
    reason: 'A Java library rather than a service. Piped is NewPipeExtractor behind an HTTP API, so the pool already reaches it; a direct bridge adapter is available for operators who self-host one.',
    covered_by: 'piped' },
];
