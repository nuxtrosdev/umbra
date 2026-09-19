/**
 * UMBRA WIRE PROTOCOL  (v1)
 * ------------------------
 * Umbra is a URL scheme + token envelope + out-of-band metadata channel that
 * lets a browser tab address the "clear web" without ever letting the browser
 * itself navigate there.
 *
 *   umbra://host[:port]/path?query#frag      -- logical address of a resource
 *   /~umbra/<mode>/<token>[/<name>]          -- physical wire form (always same-origin)
 *
 * Modes (how the origin should treat the response):
 *   d  document      HTML, rewritten, shim injected, framing headers stripped
 *   s  subresource   CSS (rewritten) / JS / fonts / images (bytes)
 *   m  media         byte-exact stream, Range passthrough, never rewritten
 *   x  xhr           byte-exact passthrough for fetch()/XHR, Umbra-Meta exposed
 *   f  form-post     forwards method + body, then behaves like `d`
 *   r  raw           byte-exact passthrough (downloads)
 *   c  capsule       locally generated Umbra document (redirect notice, player...)
 *
 * A token is `base64url(json).<hmac8>`. It is bound to a session + tab, so a
 * token captured from one tab cannot be replayed by a third party as an
 * open-proxy primitive, and the signature keeps the path fully opaque: no
 * destination host ever appears in a URL, a Referer, or a history entry.
 *
 * Server -> client metadata travels in the `X-Umbra-Meta` response header as
 * base64url(json) (final URL, status chain, kind, notes) because Umbra
 * documents must be able to report facts that the destination URL cannot.
 */
import crypto from 'node:crypto';

export const SCHEME = 'umbra://';
export const PFX = '/~umbra/';
export const MODES = new Set(['d', 's', 'm', 'x', 'f', 'r', 'c']);

const SECRET =
  process.env.UMBRA_SECRET ||
  crypto.createHash('sha256').update('umbra-v1:' + crypto.randomBytes(8).toString('hex')).digest('hex');

/* ------------------------------------------------------------------ logical */

/** umbra://host/p -> {protocol,host,...} ; throws on garbage */
export function parseUmbra(str) {
  if (typeof str !== 'string') throw new TypeError('not a url');
  if (str.startsWith(SCHEME)) return new URL('https://' + str.slice(SCHEME.length));
  return new URL(str);
}

/** absolute http(s) URL -> umbra:// logical address */
export function toUmbra(absUrl) {
  const u = new URL(absUrl);
  let out = SCHEME + u.host + (u.pathname === '/' ? '/' : u.pathname);
  if (u.search) out += u.search;
  if (u.hash) out += u.hash;
  return out;
}

/** host for display (drops userinfo, keeps punycode-visible form) */
export function displayHost(absUrl) {
  try {
    const u = new URL(absUrl);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : '');
  } catch {
    return absUrl.slice(0, 60);
  }
}

/* ------------------------------------------------------------------- tokens */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8');

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url').slice(0, 10);
}

/**
 * @param {object} p  {u: absolute url, t: tabId, s: sessionId, m: mode, ...}
 */
export function encodeToken(p) {
  const payload = b64u(JSON.stringify(p));
  return payload + '.' + sign(payload);
}

export function decodeToken(tok) {
  const i = tok.lastIndexOf('.');
  if (i < 8) return null;
  const payload = tok.slice(0, i);
  if (sign(payload) !== tok.slice(i + 1)) return null;
  try {
    return JSON.parse(unb64u(payload));
  } catch {
    return null;
  }
}

/** wire path for a rewritten reference */
export function href(ctx, absUrl, mode) {
  const tok = encodeToken({
    u: absUrl,
    t: ctx.tabId || 'anon',
    s: ctx.session || 'anon',
    g: ctx.gen || '',
    m: mode,
  });
  let name = '';
  try {
    const seg = new URL(absUrl).pathname.split('/').pop();
    if (/^[\w.~-]{1,64}$/.test(seg)) name = '/' + seg;
  } catch {
    /* ignore */
  }
  return PFX + mode + '/' + tok + name;
}

/** absolute (origin-relative) href usable inside a proxied document */
export function absHref(ctx, absUrl, mode) {
  return href(ctx, absUrl, mode);
}

/* ------------------------------------------------------------ Umbra-Meta */

export function encodeMeta(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/* -------------------------------------------------------------- resolving */

/**
 * Resolve a reference found inside a proxied document against the document's
 * base URL. Returns an absolute http(s) URL, or null when the reference is a
 * scheme Umbra refuses to carry.
 */
export function resolveRef(ref, baseAbs) {
  if (ref == null) return null;
  let r = String(ref).trim();
  if (!r) return null;
  if (r.startsWith(SCHEME)) {
    try {
      return new URL('https://' + r.slice(SCHEME.length)).href;
    } catch {
      return null;
    }
  }
  if (/^(javascript|data|blob|filesystem|about|mailto|tel|sms|whatsapp|intent|file|view-source|chrome|chrome-extension|moz-extension|ms-appx|qqlive|weixin|tg|magnet|ed2k|steam|itms|itms-apps|market|geo|sms|callto|skype|slack|zoomus|obsidian|x-apple):/i.test(r)) {
    return null;
  }
  try {
    return new URL(r, baseAbs).href;
  } catch {
    return null;
  }
}

const UNSAFE = /^(javascript|data|blob|filesystem|about|vbscript):/i;
export function isUnsafeHref(r) {
  return UNSAFE.test(String(r || '').trim());
}

/* ------------------------------------------------------------------ session */

export function newSession() {
  return crypto.randomBytes(12).toString('hex');
}
export function newTab() {
  return 'T' + crypto.randomBytes(5).toString('hex');
}
export const COOKIE_NAME = 'umbra_s';

export function readSession(req) {
  /* Explicit first: third-party cookie blocking (an embedded preview, Safari,
     hardened Chrome) silently drops the cookie, so the shell also sends its
     boot-issued session as a header, and navigation-capable URLs (frames,
     images, sockets — anything that cannot set headers) carry it as ?sid=. */
  const h = req.headers['x-umbra-session'];
  if (h && /^[0-9a-f]{20,64}$/i.test(String(h).trim())) return String(h).trim();
  try {
    const q = new URL(req.url || '/', 'http://x').searchParams.get('sid');
    if (q && /^[0-9a-f]{20,64}$/i.test(q)) return q;
  } catch {}
  const raw = req.headers.cookie || '';
  for (const part of raw.split(/;\s*/)) {
    const [k, ...rest] = part.split('=');
    if (k === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

export function sameOrigin(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin;
  } catch {
    return false;
  }
}
