/**
 * Clear-web transport. Uses node:https/node:http directly (not fetch) because
 * fetch silently drops forbidden headers (Cookie, Host, Connection) and a
 * proxy has to be able to set exactly what the destination expects.
 */
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'host',
]);
/* content-encoding must survive the passthrough path: we pipe the upstream
   bytes untouched, so dropping the header hands the browser gzip noise and
   turns every proxied script into "Invalid or unexpected token". Rewritten
   documents are decoded first and re-served plain, so they never carry it. */

/** Headers the destination uses to lock a document into a real browser tab. */
const DROP_RESPONSE_HEADERS = new Set([
  'x-frame-options', 'content-security-policy',
  'content-security-policy-report-only', 'cross-origin-opener-policy',
  'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'origin-agent-cluster', 'permissions-policy', 'x-content-type-options',
  'refresh', 'set-cookie', 'report-to', 'nel',
]);

const UA =
  process.env.UMBRA_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_BODY = 40 * 1024 * 1024; // rewrite ceiling for documents

export class UpstreamError extends Error {
  constructor(msg, code = 'upstream') {
    super(msg);
    this.code = code;
  }
}

/* --------------------------------------------------------------- cookie jar */

export class CookieJar {
  constructor() {
    this.map = new Map(); // domain -> Map(name -> {name,value,path,secure,expires})
  }
  static domainSuffixes(host) {
    const parts = host.split('.');
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      out.push(parts.slice(i).join('.'));
      out.push('.' + parts.slice(i).join('.'));
    }
    out.push('');
    return out;
  }
  store(setCookie, url) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const line of list) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const a = {};
      for (const at of attrs) {
        const [k, ...v] = at.split('=');
        a[k.trim().toLowerCase()] = v.join('=').trim();
      }
      const dom = (a.domain || host).replace(/^\./, '');
      if (!this.map.has(dom)) this.map.set(dom, new Map());
      if (value === '' || (a.expires && new Date(a.expires) < new Date())) {
        this.map.get(dom).delete(name);
      } else {
        this.map.get(dom).set(name, { name, value, path: a.path || '/', secure: !!a.secure });
      }
    }
  }
  header(url) {
    let host, secure;
    try {
      const u = new URL(url);
      host = u.hostname;
      secure = u.protocol === 'https:';
    } catch {
      return '';
    }
    const out = [];
    for (const [dom, names] of this.map) {
      if (host !== dom && !host.endsWith('.' + dom)) continue;
      for (const c of names.values()) {
        if (c.secure && !secure) continue;
        out.push(c.name + '=' + c.value);
      }
    }
    return out.join('; ');
  }
}

/* ------------------------------------------------------------------- client */

/**
 * Perform one request. Never follows redirects: the router decides whether a
 * redirect is followed silently (same host, subresource) or split into a new
 * Umbra tab (top-level documents). That decision is the core of the tab
 * isolation guarantee.
 */
export function upstream(urlStr, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = opts.stream ? 0 : 20000,
    maxRedirects = 0,
  } = opts;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return reject(new UpstreamError('bad upstream url', 'badurl'));
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return reject(new UpstreamError('refused protocol ' + u.protocol, 'proto'));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const send = (target, count) => {
      const req = mod.request(
        target,
        {
          method,
          headers: {
            'user-agent': UA,
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'accept-encoding': 'gzip, deflate, br',
            ...headers,
            host: target.hostname + (target.port ? ':' + target.port : ''),
          },
          timeout,
          servername: target.hostname,
          rejectUnauthorized: false,
        },
        (res) => {
          const status = res.statusCode || 0;
          const loc = res.headers.location;
          if (
            count < maxRedirects &&
            [301, 302, 303, 307, 308].includes(status) &&
            loc
          ) {
            // drain then recurse so the socket can be reused
            res.resume();
            let next;
            try {
              next = new URL(loc, target.href);
            } catch {
              return resolve({ res, req, url: target.href, status, headers: res.headers, redirected: true, location: loc });
            }
            return send(next, count + 1);
          }
          resolve({ res, req, url: target.href, status, headers: res.headers, location: loc });
        },
      );
      req.on('error', (e) => reject(new UpstreamError(e.message, 'net')));
      req.on('timeout', () => {
        req.destroy(new UpstreamError('upstream timeout', 'timeout'));
      });
      if (body) {
        if (typeof body.pipe === 'function') body.pipe(req);
        else req.end(body);
      } else req.end();
    };
    send(u, 0);
  });
}

export async function readBody(res, { decompress = true, limit = MAX_BODY } = {}) {
  const chunks = [];
  let size = 0;
  const enc = (res.headers['content-encoding'] || '').toLowerCase();
  let gunzip = null;
  const sinks = [
    (c) => chunks.push(c),
  ];
  const push = (c) => {
    chunks.push(c);
    size += c.length;
    if (size > limit) throw new UpstreamError('response too large', 'size');
  };
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      try {
        push(c);
      } catch (e) {
        reject(e);
        res.destroy();
      }
    });
    res.on('error', reject);
    res.on('end', resolve);
    res.on('close', resolve);
  });
  let buf = Buffer.concat(chunks);
  if (decompress && buf.length) {
    try {
      if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
      else if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
      else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
    } catch {
      /* some servers mislabel; keep raw */
    }
  }
  return buf;
}

/** Headers to hand back to the browser for a proxied response. */
export function outboundHeaders(upRes, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(upRes.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || DROP_RESPONSE_HEADERS.has(lk)) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return { ...out, ...extra };
}

export { UA, MAX_BODY, DROP_RESPONSE_HEADERS };
