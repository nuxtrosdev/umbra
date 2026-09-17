/**
 * Umbra document rewriting: every reference that could leak the real
 * destination (or make the frame navigate off-origin) is pulled back through
 * the wire protocol, and the frame is given a context the shim can act on.
 */
import { href, resolveRef, toUmbra, SCHEME } from './protocol.mjs';

const URL_ATTRS = new Set([
  'href', 'src', 'poster', 'data-src', 'data-original', 'data-lazy-src', 'srcset',
  'data-srcset', 'imagesrcset', 'action', 'formaction', 'codebase', 'cite', 'longdesc',
  'usemap', 'manifest', 'xlink:href', 'ping', 'background', 'data', 'icon', 'content',
])
/* <link rel=preload imagesrcset=...> is a fetch the browser issues on its own,
   before any script runs -- if it is not pulled onto the wire it becomes a
   direct request to the destination host, which is exactly what cloaking is
   supposed to prevent. */
const SRCSET_ATTRS = new Set(['srcset', 'data-srcset', 'imagesrcset'])
/* <meta content> is only a URL inside http-equiv=refresh or an og:url style
   value; treating every content attribute as a reference corrupts viewport
   tags, so those two cases are handled explicitly. */;
/* Elements whose children are raw text, not markup: never rewritten.
   <noscript> is deliberately NOT here -- its children are real markup in a
   scripting-enabled frame, and leaving it alone is how a <noscript><img>
   beacon escapes the proxy. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

const decoderCache = new Map();
function decoderFor(label) {
  if (!decoderCache.has(label)) {
    try {
      decoderCache.set(label, new TextDecoder(label));
    } catch {
      decoderCache.set(label, new TextDecoder('utf-8'));
    }
  }
  return decoderCache.get(label);
}

export function detectCharset(buf) {
  const head = buf.subarray(0, 4096).toString('latin1');
  let m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  if (m) return m[1].toLowerCase();
  m = /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head);
  if (m) return m[1].toLowerCase();
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  return 'utf-8';
}

export function decodeHtml(buf) {
  const label = detectCharset(buf);
  const dec = decoderFor(label === 'ascii' ? 'utf-8' : label);
  try {
    return dec.decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

/**
 * Which wire mode a reference needs. Getting this wrong is not cosmetic: a
 * navigation minted as a subresource would arrive un-shimmed and un-framed,
 * and a stylesheet minted as a document would be re-rewritten as HTML.
 */
const NAV_TAGS = new Set(['a', 'area', 'iframe', 'frame']);
const MEDIA_TAGS = new Set(['video', 'audio', 'source', 'track']);
export function modeFor(tag, name) {
  if (name === 'action' || name === 'formaction') return 'f';
  if (name === 'src' && MEDIA_TAGS.has(tag)) return 'm';
  if (name === 'poster') return 'm';
  if (name === 'srcset' && tag === 'source') return 'm';
  if (NAV_TAGS.has(tag) && (name === 'href' || name === 'xlink:href')) return 'd';
  if (name === 'src' && tag === 'iframe') return 'd';
  return 's';
}

/**
 * Rewrite one attribute value (may be srcset) into a wire reference.
 * Returns null for "leave this alone": umbra:// addresses are Umbra-native and
 * are routed by the shim through the shell, which can also resolve documents
 * the origin authors itself (portal, search, lab, player).
 */
function rewriteValue(name, value, baseAbs, ctx, mode, tag) {
  const raw = String(value).trim();
  if (/^umbra:\/\//i.test(raw)) return null;
  /* A reference that is already on the Umbra wire stays as it is. Wrapping it
     again would make the origin fetch itself, and a document that quotes a
     proxied address would spiral. */
  if (raw.startsWith('/~umbra/') || (ctx.origin && raw.startsWith(ctx.origin + '/~umbra/'))) return null;
  mode = modeFor(String(tag || '').toLowerCase(), name);
  if (SRCSET_ATTRS.has(name)) {
    const parts = value.split(',');
    let touched = false;
    const out = parts
      .map((p) => {
        const seg = p.trim();
        if (!seg) return seg;
        const [cand, ...rest] = seg.split(/\s+/);
        if (String(cand).startsWith('/~umbra/')) return seg;
        const abs = resolveRef(cand, baseAbs);
        if (!abs) return rest.length ? ' ' + rest.join(' ') : '';
        touched = true;
        return href(ctx, abs, mode) + (rest.length ? ' ' + rest.join(' ') : '');
      })
      .filter((s) => s !== '' || touched)
      .join(', ');
    return touched ? out : null;
  }
  const abs = resolveRef(value, baseAbs);
  if (!abs) return null;
  return href(ctx, abs, mode);
}

/**
 * @param {string} html
 * @param {{base:string, ctx:object, mode:string, kind:string}} o
 */
/*
 * The HTML preload scanner parses <link>/<img>/<source> tokens even when they
 * are inside a <script> body, so a page that document.write()s a preload hint
 * makes the browser fetch that URL before any script of ours could route it.
 * Rewrite markup-shaped references embedded in raw text onto the wire.
 * Deliberately narrow: only tag-attribute shapes, never bare URL strings, so
 * opaque JSON/RPC payloads inside scripts stay byte-identical.
 */
function scrubEmbeddedMarkup(seg, ctx, base, mode) {
  if (!/https?:\/\//i.test(seg)) return seg;
  const one = (whole, tagHead, name, q, dq, sq, bare) => {
    const value = dq !== undefined ? dq : (sq !== undefined ? sq : bare);
    const quote = dq !== undefined ? '"' : (sq !== undefined ? "'" : '');
    if (!/^https?:\/\//i.test(value.trim())) return whole;
    const abs = resolveRef(value, base);
    if (!abs) return whole;
    const as = /\bas\s*=\s*["']?(font|image|style|script|video|audio)/i.exec(tagHead);
    const m = as && as[1] === 'font' ? 's' : (mode === 'd' ? 's' : mode);
    return tagHead + name + '=' + quote + href(ctx, abs, m) + quote;
  };
  seg = seg.replace(
    /(<(?:link|img|source)\b[^>]{0,600}?)\b(href|src|srcset|imagesrcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
    (w, head, name, _q, dq, sq, bare) => one(w, head, name, _q, dq, sq, bare),
  );
  /* Quoted *image* addresses inside script text are the one case the scanner
     can reach us through: Chromium's preload scanner issues the request for a
     thumbnail URL it finds in script bytes. Only image-looking, fully quoted
     URLs are touched, so JSON/RPC payloads stay byte-identical. */
  const IMAGEY = /\.(jpe?g|png|gif|webp|avif|ico|svg|bmp)(?=$|[&?"'\\])|ytimg\.com|pbs\.twimg|imagecdn/i;
  /* Allow \uXXXX escapes: JSON inside script text writes "&" as \u0026, and a
     naive cut would strip the signature off a signed thumbnail URL. Decode
     first, then mint, so the proxied request still resolves upstream. */
  seg = seg.replace(/https?:\/\/(?:[^"'\\\s]|\\u[0-9a-fA-F]{4}|\\\/){6,400}/g, (u) => {
    if (!IMAGEY.test(u)) return u;
    let dec = u.replace(/\\u([0-9a-fA-F]{4})/g, (m0, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/');
    const abs = resolveRef(dec, base);
    if (!abs) return u;
    let host = '';
    try { host = new URL(abs).hostname; } catch { return u; }
    if (host.endsWith('.umbra') || host === '127.0.0.1' || host === 'localhost' || host === '::1') return u;
    return href(ctx, abs, 's');
  });
  /* protocol-relative image refs ("//i1.ytimg.com/vi/…") resolve against the
     frame's own origin, so they never look absolute in the source text */
  seg = seg.replace(/(["'(=,+])\/\/((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'\\]*)?)/gi, (w0, pre, rest) => {
    if (!IMAGEY.test(rest)) return w0;
    const abs = resolveRef('https://' + rest.replace(/\\u([0-9a-fA-F]{4})/g, (m0, h) => String.fromCharCode(parseInt(h, 16))), base);
    if (!abs) return w0;
    let host2 = '';
    try { host2 = new URL(abs).hostname; } catch { return w0; }
    if (host2.endsWith('.umbra') || host2 === '127.0.0.1' || host2 === 'localhost') return w0;
    return pre + href(ctx, abs, 's').slice(0, 0) + '"' + href(ctx, abs, 's') + '"';
  });
  return seg;
}

export function rewriteHtml(html, o) {
  const { base, ctx } = o;
  const mode = o.mode || 's';
  let out = '';
  let last = 0;

  // tokenize: tags, plus script/style text we must not touch
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    out += html.slice(last, m.index);
    last = tagRe.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    let attrs = m[3] || '';

    if (closing) {
      out += `</${tag}>`;
      continue;
    }

    if (tag === 'base') continue; // we re-anchor via explicit rewrites
    if (tag === 'meta' && /\bhttp-equiv\s*=\s*["']?\s*refresh/i.test(attrs)) {
      const mm = /content\s*=\s*(["'])(.*?)\1/i.exec(attrs);
      let target = null;
      let delay = 0;
      if (mm) {
        for (const seg of mm[2].split(';')) {
          const kv = seg.trim();
          if (/^\d+$/.test(kv)) delay = parseInt(kv, 10);
          else if (/^url\s*=/i.test(kv)) target = kv.replace(/^url\s*=\s*["']?/i, '').replace(/["']$/, '');
        }
      }
      const abs = target ? resolveRef(target, base) : null;
      out += `<meta data-umbra-refresh="${abs ? 1 : 0}" data-umbra-delay="${delay}" data-umbra-target="${
        abs || ''
      }" http-equiv="umbra-refresh">`;
      continue;
    }
    if (tag === 'meta') {
      const mm = /content\s*=\s*(["'])([^"']*url\s*=[^"']*)\1/i.exec(attrs);
      if (mm) {
        attrs =
          attrs.slice(0, mm.index) +
          attrs[mm.index] +
          'content=' +
          mm[1] +
          mm[2].replace(/url\s*=\s*([^"']+)/i, (s, u) => {
            const abs = resolveRef(u.trim(), base);
            return abs ? 'url=' + href(ctx, abs, mode) : s;
          }) +
          mm[1] +
          attrs.slice(mm.index + mm[0].length);
      }
    }

    let logicalFor = '';
    /* Inline styles written as style="…url("x")…" break a naive "..." scan (the
       value terminates on the first inner quote, so the url leaks). Match the
       whole attribute tolerating balanced inner quotes, rewrite it here, then
       blank it out of the generic pass by marking it done. */
    let styleDone = false;
    if (/\bstyle\s*=/i.test(attrs)) {
      attrs = attrs.replace(/\bstyle\s*=\s*"([^"]*(?:"[^"]*"[^"]*)*)"|\bstyle\s*=\s*'([^']*(?:'[^']*'[^']*)*)'/i, (w0, dv, sv) => {
        const v = dv !== undefined ? dv : sv;
        if (!/url\s*\(|@import/i.test(v)) return w0;
        const r = rewriteCssUrls(v, base, ctx, mode);
        if (!r.changed) return w0;
        styleDone = true;
        return 'style="' + r.text.replace(/"/g, '&quot;') + '"';
      });
    }
    // rewrite URL-ish attributes
    attrs = attrs.replace(
      /([a-zA-Z:@][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
      (whole, nameRaw, _q, dq, sq, bare) => {
        const name = nameRaw.toLowerCase();
        if (name === 'style' && styleDone) return whole;
        const value = dq !== undefined ? dq : sq !== undefined ? sq : bare;
        /* Parsoid (and lazy-load libraries) keep the untouched destination in a
           side attribute. It is inert, but it still spells the target out in the
           DOM, so demote it to the logical umbra address. */
        if (name === 'data-mw-original-href' || name === 'data-umbra-original') {
          const abs = resolveRef(value, base);
          return abs ? `${name}="${toUmbra(abs)}"` : `${name}=""`;
        }
        if (!URL_ATTRS.has(name) && !(name === 'style' && /url\s*\(/i.test(value)) &&
            !(name === 'data-srcset' || name === 'data-original' || name === 'data-lazy-src')) {
          return whole;
        }
        if (name === 'content' && tag !== 'meta') return whole;
        if (name === 'content') {
          /* only og:url-style values and http-equiv targets carry references */
          if (!/\burl\s*=/i.test(value) && !/^https?:\/\//i.test(value.trim())) return whole;
        }
        if (name === 'srcdoc') {
          /* an iframe's srcdoc is a whole document handed straight to the parser:
             decode, scrub the same way as raw text, re-encode */
          const dec = value
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
          if (/https?:\/\//i.test(dec)) {
            const scrubbed = scrubEmbeddedMarkup(dec, ctx, base, 'd')
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
            return `${name}="${scrubbed}"`;
          }
          return whole;
        }
        if (name === 'style') {
          const r = rewriteCssUrls(value, base, ctx, mode);
          return r.changed ? `${name}="${r.text.replace(/"/g, '&quot;')}"` : whole;
        }
        const next = rewriteValue(name, value, base, ctx, mode, tag);
        if (name === 'href' && /^umbra:\/\//i.test(String(value).trim())) return whole;
        if (next !== null && (name === 'href' || name === 'xlink:href') && (tag === 'a' || tag === 'area' || tag === 'iframe' || tag === 'frame')) {
          try { logicalFor = 'umbra://' + new URL(value, base).host + new URL(value, base).pathname + new URL(value, base).search + new URL(value, base).hash; } catch {}
        }
        if (next === null) {
          /* data:/blob:/about: never touch the network, so they are left
             exactly as authored: inerting them breaks inline icons for no
             cloaking gain. Schemes that *do* leave the browser (or hand control
             to another program) are neutralised. */
          const v = value.trim();
          if (/^(javascript|vbscript|mailto|tel|sms|intent|file|geo|whatsapp|tg|magnet|slack|zoomus|obsidian|web\+sms)/i.test(v)) {
            if (name === 'href' || name === 'xlink:href') return `${name}="umbra:inert"`;
            if (name === 'src' || name === 'data' || name === 'action' || name === 'formaction') return `${name}="about:blank"`;
          }
          return whole;
        }
        return `${name}="${String(next).replace(/"/g, '&quot;')}"`;
      },
    );

    /* Every navigable node keeps its logical umbra address next to its wire
       href: the shim routes clicks from the logical value (exact), while the
       browser gets a real same-origin href for copy/paste, middle click and
       no-JS fallback. Nested containers are tagged for the mutation guard. */
    if (logicalFor) attrs += ` data-umbra="${logicalFor}"`;
    if (tag === 'iframe' || tag === 'frame' || tag === 'object' || tag === 'embed') {
      attrs += ' data-umbra-frame="1"';
    }
    out += `<${tag}${attrs}>`;

    if (RAW_TEXT_TAGS.has(tag) && !attrs.includes('/>')) {
      // skip over the element body verbatim
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(last);
      const cm = closeRe.exec(rest);
      const seg = cm ? rest.slice(0, cm.index) : rest;
      if (tag === 'style') {
        const r = rewriteCssUrls(seg, base, ctx, mode);
        out += r.text;
      } else if (tag === 'title') {
        out += seg; // title handled by the shim -> tab label
      } else {
        out += tag === 'script' ? scrubEmbeddedMarkup(seg, ctx, base, mode) : seg;
      }
      last += seg.length + (cm ? cm[0].length : 0);
      if (cm) out += cm[0];
      tagRe.lastIndex = last; // do not re-match the closing tag we just consumed
    }
  }
  out += html.slice(last);
  return out;
}

/** url(...) and @import inside CSS text */
export function rewriteCssUrls(css, base, ctx, mode) {
  let changed = false;
  let text = css.replace(/url\s*\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, q, ref) => {
    const abs = resolveRef(ref.trim(), base);
    if (!abs) return whole;
    changed = true;
    return `url("${href(ctx, abs, mode)}")`;
  });
  text = text.replace(/@import\s+(["'])([^"']+)\1/gi, (whole, q, ref) => {
    const abs = resolveRef(ref.trim(), base);
    if (!abs) return whole;
    changed = true;
    return `@import "${href(ctx, abs, mode)}"`;
  });
  return { text, changed };
}

/**
 * Inject the frame shim + umbra context. Placement is deliberately tolerant:
 * documents served without <head> still get it.
 */
export function injectShim(html, ctxJs, shimSrc) {
  const tag = `<script id="umbra-ctx" type="application/json">${ctxJs}</script><script src="${shimSrc}"></script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + '<head>' + tag + '</head>' + html.slice(htmlTag.index + htmlTag[0].length);
  return tag + html;
}

export { SCHEME };
