/**
 * Proof-of-Origin tokens.
 *
 * Since 2024 YouTube scores every player request and, for most clients, wants
 * a PO token: a value minted by its own BotGuard JavaScript that asserts the
 * request came from a plausible browser. Without one the response is either
 * the bot wall or — more confusingly — a success whose formats are all gated.
 * That second case is what "no playable streams" looks like from the outside,
 * and no amount of signature deciphering fixes it, because the formats never
 * arrive in the first place.
 *
 * Minting a token requires executing BotGuard, which expects a DOM. This
 * proxy has no dependencies and no browser, so rather than pretend otherwise
 * there are four honest sources, tried in order:
 *
 *   0. harvested         — the token the *user's own browser* minted inside a
 *                          proxied YouTube document, seen on its way through
 *                          the wire. No infrastructure, no configuration, and
 *                          it is a genuine BotGuard token because a genuine
 *                          BotGuard produced it. See below.
 *   1. UMBRA_YT_POTOKEN   — a token lifted from a real browser session. Free,
 *                           no infrastructure, and good for hours.
 *   2. UMBRA_POT_PROVIDER_URL — a bgutil-style minting service. This is what
 *                           yt-dlp users run, and it is the maintainable
 *                           answer for a long-lived deployment.
 *   3. bgutils-js         — used in-process if the operator installed it.
 *
 * All three configured sources are optional. With none of them Umbra behaves
 * exactly as before, which on a residential address is often fine; on a
 * datacentre address, such as a Codespace, it usually is not.
 */

import { upstream, readBody } from './net.mjs';

const TTL = Number(process.env.UMBRA_POT_TTL || 6 * 3600 * 1000);
const TIMEOUT = Number(process.env.UMBRA_POT_TIMEOUT || 10000);

const STATIC = () => (process.env.UMBRA_YT_POTOKEN || '').trim();
const PROVIDER = () => (process.env.UMBRA_POT_PROVIDER_URL || '').trim().replace(/\/+$/, '');

/** visitorData -> { token, at, source } */
const cache = new Map();
let lastError = null;

/* -------------------------------------------------- harvested from the wire
 *
 * Why this exists, stated plainly, because it is the difference between
 * playback working and not working from a datacentre address:
 *
 * Every other YouTube front end that "just works" from a server — the
 * service-worker proxies, the browser-extension ones — has one thing in
 * common, and it is not a better extractor. It is that YouTube's own
 * JavaScript runs in the *visitor's* browser. BotGuard executes there, mints
 * a real PO token bound to the page's visitor identity, and the player
 * requests that follow carry it. The egress address still belongs to the
 * server, and YouTube still answers, because a valid proof of origin is what
 * the gate is actually asking for.
 *
 * Umbra already runs YouTube's JavaScript in the visitor's browser — that is
 * what the proxied embed document is — and every request that page makes
 * passes through this origin by construction. So the token is already in our
 * hands: the in-page /youtubei/v1/player POST carries it, bound to the
 * visitorData in the same body. Record the *pair* (a token bound to one
 * identity is worthless under another) and the server-side ladder can
 * present the same credentials the browser just proved.
 *
 * Nothing is minted here and nothing is forged. This is observation.
 */
const HARVEST_TTL = Number(process.env.UMBRA_POT_HARVEST_TTL || 6 * 3600 * 1000);
/** visitorData -> { token, at, videoId } */
const harvest = new Map();
let latest = null;
let harvestCount = 0;

export function observe({ poToken = '', visitorData = '', videoId = '' } = {}) {
  const tok = String(poToken || '').trim();
  /* BotGuard tokens are long opaque base64url. Anything short is a field we
     misread, and storing it would poison every later request. */
  if (tok.length < 32 || tok.length > 1024 || !/^[\w\-%.+/=]+$/.test(tok)) return null;
  const key = String(visitorData || '') || '(none)';
  const prev = harvest.get(key);
  const rec = { token: tok, at: Date.now(), videoId: String(videoId || '') };
  harvest.set(key, rec);
  latest = { visitorData: key === '(none)' ? '' : key, ...rec };
  if (!prev || prev.token !== tok) harvestCount++;
  /* a harvested token supersedes whatever was cached for that identity */
  cache.set(key, { token: tok, at: rec.at, source: 'harvested' });
  return latest;
}

const fresh = (rec) => !!rec && Date.now() - rec.at < HARVEST_TTL;

/**
 * The freshest browser-proved pair, or null. The ladder adopts the whole
 * pair or neither half of it.
 */
export function harvestedIdentity() {
  return fresh(latest) ? { visitorData: latest.visitorData, poToken: latest.token, at: latest.at } : null;
}

export function resetHarvest() {
  harvest.clear();
  latest = null;
  harvestCount = 0;
}

/**
 * Ask a bgutil-style provider to mint one.
 *
 * The token is bound to the identity that will use it, so the visitorData we
 * are about to send must be the same one the provider signs over. Reusing a
 * token across identities is worse than having none: it looks like forgery.
 */
async function fromProvider(visitorData) {
  const base = PROVIDER();
  if (!base) return null;
  const body = JSON.stringify({
    visitor_data: visitorData || undefined,
    visitorData: visitorData || undefined,
  });
  const res = await upstream(base + '/get_pot', {
    method: 'POST',
    timeout: TIMEOUT,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body,
  });
  if (res.status !== 200) { res.res.resume(); throw new Error('pot provider http ' + res.status); }
  const text = (await readBody(res.res, { limit: 256 * 1024 })).toString('utf8');
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('pot provider returned non-json'); }
  const tok = j.po_token || j.poToken || j.potoken || j.token;
  if (!tok) throw new Error('pot provider returned no token');
  return String(tok);
}

let bg = null;
let bgState = null;
/** In-process minting, only if the operator installed the pieces. */
async function fromBgUtils(visitorData) {
  if (bgState && bgState !== 'ok') return null;
  try {
    if (!bg) {
      const mod = await import('bgutils-js');
      bg = mod.BG || mod.default?.BG || mod.default;
      bgState = 'ok';
    }
    const requestKey = 'O43z0dpjhgX20SCx4KAo';
    const challenge = await bg.Challenge.create(
      { fetch: (...a) => globalThis.fetch(...a), globalObj: globalThis, identifier: visitorData, requestKey });
    if (!challenge) throw new Error('bgutils returned no challenge');
    const token = await bg.PoToken.generate(
      { program: challenge.program, globalName: challenge.globalName, bgConfig:
        { fetch: (...a) => globalThis.fetch(...a), globalObj: globalThis, identifier: visitorData, requestKey } });
    return token && String(token.poToken || token);
  } catch (e) {
    bgState = /Cannot find (module|package)/i.test(String(e && e.message))
      ? 'bgutils-js is not installed'
      : 'bgutils-js failed: ' + String(e && e.message).slice(0, 120);
    return null;
  }
}

/**
 * The token to attach to requests made under `visitorData`, or '' when none
 * is obtainable. Never throws: no token is a degraded state, not a failure,
 * and the caller should still try.
 */
export async function getPoToken(visitorData = '') {
  const key = visitorData || '(none)';
  /* A token the browser proved for exactly this identity beats anything we
     could configure, so it is checked before the cache's own TTL logic. */
  const seen = harvest.get(key);
  if (fresh(seen)) return seen.token;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.token;

  const stat = STATIC();
  if (stat) {
    cache.set(key, { token: stat, at: Date.now(), source: 'env' });
    return stat;
  }
  if (PROVIDER()) {
    try {
      const t = await fromProvider(visitorData);
      if (t) {
        cache.set(key, { token: t, at: Date.now(), source: 'provider' });
        lastError = null;
        return t;
      }
    } catch (e) { lastError = String(e.message || e).slice(0, 180); }
  }
  const t2 = await fromBgUtils(visitorData);
  if (t2) {
    cache.set(key, { token: t2, at: Date.now(), source: 'bgutils' });
    return t2;
  }
  return '';
}

export function resetPoTokenCache() { cache.clear(); lastError = null; }

export function inspect() {
  const entries = [...cache.values()];
  const h = harvestedIdentity();
  return {
    configured: !!(STATIC() || PROVIDER()) || bgState === 'ok' || !!h,
    sources: {
      harvested: h
        ? { seen: harvestCount, ageMs: Date.now() - h.at, identities: harvest.size }
        : (harvestCount ? 'expired' : 'none seen yet'),
      env: !!STATIC(),
      provider: PROVIDER() || null,
      bgutils: bgState === 'ok' ? 'ok' : (bgState || 'untried'),
    },
    cached: entries.length,
    source: entries.length ? entries[entries.length - 1].source : null,
    lastError,
    /* the single most useful line when playback is broken on a server */
    advice: (h || STATIC() || PROVIDER() || bgState === 'ok')
      ? null
      : 'No PO token source configured and none harvested yet. On a datacentre address '
        + '(Codespaces, VPS, CI) YouTube gates most formats without one. Open the proxied '
        + 'embed once — BotGuard runs in your browser and Umbra keeps the token it mints — '
        + 'or set UMBRA_YT_POTOKEN, or point UMBRA_POT_PROVIDER_URL at a bgutil provider.',
  };
}
