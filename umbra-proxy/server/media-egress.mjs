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
