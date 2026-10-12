/**
 * Who carries the video bytes, and what the content policy must therefore
 * allow. Kept apart from the server module so it can be reasoned about (and
 * tested) without starting a listener.
 *
 *   wire    (default) browser -> umbra -> source. Private, and bills this
 *           origin for every megabyte of every stream.
 *   peer    browser -> a public Piped/Invidious media proxy. Costs us
 *           nothing; that instance sees the viewer's address.
 *   direct  browser -> googlevideo. Costs us nothing; Google sees the
 *           viewer. Often refused, because googlevideo signs its urls to
 *           the address that extracted them - so the player treats this as
 *           an attempt, not a promise, and falls back to the wire.
 */
export const MODES = ['wire', 'peer', 'direct'];

export function modeFrom(env) {
  const v = String(env || 'wire').toLowerCase().trim();
  return MODES.includes(v) ? v : 'wire';
}

export const mediaSrcFor = (mode) => "media-src 'self' blob: data:" +
  (mode === 'direct' ? ' https://*.googlevideo.com' : '') +
  /* A peer is whichever instance answered, and the pool is not fixed at
     boot, so this cannot be an explicit host list. It stays https-only. */
  (mode === 'peer' ? ' https:' : '');

/* ------------------------------------------------------- media expiry ---
 * googlevideo signs every url with an `expire` timestamp. Past it the CDN
 * answers 403 to everyone, including the address that minted it - so this
 * is not a bot wall and must not be reported as one. A long video outlives
 * its own url mid-playback, and the browser's only symptom is that the
 * picture stops.
 *
 * Lives here, beside the other media decisions and away from the server
 * module, so it can be tested without starting a listener.
 */
export function expiredMediaUrl(raw, now = Date.now()) {
  try {
    const u = new URL(String(raw));
    if (!/(^|\.)googlevideo\.com$/i.test(u.hostname)) return false;
    const exp = Number(u.searchParams.get('expire') || 0);
    if (!exp) return false;
    /* a minute of slack: a url about to expire will expire mid-request */
    return (exp * 1000) - 60000 <= now;
  } catch { return false; }
}
