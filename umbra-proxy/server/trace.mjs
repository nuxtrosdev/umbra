/* UMBRA_TRACE=1 — a running account of what the page asked for and what
 * came back, printed where the person running the server can read it.
 *
 * A page that renders its skeleton and stops has failed in one of two very
 * different ways: either the document arrived without the data it bootstraps
 * from, or the data arrived and the JavaScript that consumes it threw. The
 * difference is invisible from the outside — both look like grey boxes — and
 * guessing between them is how you end up patching the wrong half of a
 * proxy. So record both sides: every upstream request with its status, and
 * every error the page's own JavaScript raised.
 *
 * Everything printed here passes through redact() first. A trace is the
 * worst possible place for a credential, because a trace is the thing people
 * paste into chat windows.
 */

export const TRACE = /^(1|true|yes|on)$/i.test(String(process.env.UMBRA_TRACE || ''));

/* Query parameters that carry authority rather than meaning. */
const SECRET_PARAM = /^(key|api_?key|access_?token|id_?token|auth|authuser|token|pot|po_?token|sid|session|sig|signature|s|lsig|hmac|password|pwd|secret|code|state|cpn)$/i;

/** A url safe to print: secrets replaced, length bounded, wire tokens short. */
export function redact(url, { max = 140 } = {}) {
  let s = String(url == null ? '' : url);
  if (!s) return '';

  /* Our own wire urls are mostly an opaque capability token. Keep the mode
     and the first few characters so lines can be matched up, drop the rest:
     a whole token in a log is a replayable grant. */
  s = s.replace(/\/~umbra\/([a-z])\/([A-Za-z0-9_-]{8})[A-Za-z0-9_.-]*/g, '/~umbra/$1/$2…');

  let u;
  try { u = new URL(s); } catch { return s.length > max ? s.slice(0, max) + '…' : s; }

  for (const k of [...u.searchParams.keys()]) {
    if (SECRET_PARAM.test(k)) u.searchParams.set(k, '…');
  }
  /* Cookies and bearer material sometimes ride in the fragment. */
  if (u.hash) u.hash = '';
  let out = u.toString();
  if (out.length > max) {
    const tail = out.slice(-18);
    out = out.slice(0, max - 19) + '…' + tail;
  }
  return out;
}

const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);

/** One upstream exchange. */
export function wireLine({ mode = '?', method = 'GET', url = '', status = 0, type = '', bytes = -1, ms = -1 } = {}) {
  const flag = status >= 400 || status === 0 ? '!' : ' ';
  const size = bytes >= 0 ? (bytes >= 1024 ? Math.round(bytes / 1024) + 'k' : bytes + 'b') : '';
  const bits = [
    flag + pad(mode, 1),
    pad(method, 4),
    String(status || '---'),
    pad(String(type || '').split(';')[0].replace('application/', ''), 16),
    pad(size, 5),
    ms >= 0 ? pad(ms + 'ms', 6) : pad('', 6),
    redact(url),
  ];
  return 'umbra·wire ' + bits.join(' ');
}

/** One error raised by the page's own JavaScript. */
export function clientLine({ message = '', source = '', line = 0, col = 0, kind = 'error' } = {}) {
  const where = source ? ` · ${redact(source, { max: 90 })}:${line || 0}:${col || 0}` : '';
  return `umbra·page ${kind}: ${String(message).replace(/\s+/g, ' ').slice(0, 200)}${where}`;
}

/** Print only when tracing is on. Callers do not need to check first. */
export function trace(line) {
  if (TRACE) console.log(line);
}

export default trace;
