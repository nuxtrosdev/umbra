/**
 * HLS manifests, rewritten onto the wire.
 *
 * A manifest is a list of addresses, which makes it the one media format
 * that cannot simply be relayed: hand the browser YouTube's playlist
 * unchanged and every segment request goes straight to googlevideo from the
 * visitor's own address — outside the proxy, and refused anyway, because
 * those urls are signed for the address that extracted them.
 *
 * So each line that names a resource is re-anchored: nested playlists stay
 * manifests (mode h, so they are rewritten in turn), everything else becomes
 * bytes (mode m). Comments, timing and tag structure are untouched — this is
 * deliberately a line rewriter, not a parser. A playlist we half-understand
 * is worse than one we copy faithfully apart from its addresses.
 */
import { href } from './protocol.mjs';

/* Tags whose URI="..." attribute addresses a resource rather than describing
   one: keys, initialisation segments, alternate renditions. */
const URI_ATTR = /^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT|SESSION-KEY)\b/i;

const isManifest = (u) => /\.m3u8(\?|$)/i.test(String(u).split('#')[0]);

/** Rewrite one manifest body. `base` is the url it was fetched from. */
export function rewriteManifest(body, base, ctx, mint = href) {
  const out = [];
  for (const line of String(body).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }

    if (t.startsWith('#')) {
      if (URI_ATTR.test(t)) {
        out.push(line.replace(/URI="([^"]*)"/i, (m, u) => {
          const abs = absolute(u, base);
          if (!abs) return m;
          return 'URI="' + mint(ctx, abs, isManifest(abs) ? 'h' : 'm') + '"';
        }));
      } else {
        out.push(line);
      }
      continue;
    }

    /* a bare line is a resource: a variant playlist or a media segment */
    const abs = absolute(t, base);
    out.push(abs ? mint(ctx, abs, isManifest(abs) ? 'h' : 'm') : line);
  }
  return out.join('\n');
}

function absolute(u, base) {
  const s = String(u || '').trim();
  if (!s) return null;
  try { return new URL(s, base).toString(); } catch { return null; }
}

export { isManifest };
