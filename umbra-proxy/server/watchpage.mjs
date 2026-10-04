/**
 * The watch page as an extraction surface.
 *
 * Every backend Umbra had — our own InnerTube client, Piped, Invidious,
 * NewPipe, YouTube.js — ultimately calls `/youtubei/v1/player`. They differ in
 * whose address makes the call, not in what they call. So when that endpoint
 * refuses us, it refuses all of them at once, which is exactly the "no
 * instance answered" cascade.
 *
 * This module is a genuinely different door. YouTube's own web page embeds the
 * same playerResponse object in its HTML, as `ytInitialPlayerResponse`, so a
 * plain GET of a page a browser would fetch yields the data without ever
 * touching the API. It is scored differently from the API — it is the request
 * an ordinary reader makes — and it needs no API key.
 *
 * Three details matter and are easy to get wrong:
 *
 *   - The EU consent interstitial replaces the page with a wall unless a
 *     consent cookie is present. We send one.
 *   - The embed page (`/embed/<id>`) is a separate surface again, and is often
 *     served when the watch page is withheld. Both are tried.
 *   - Regex is the wrong tool for finding the JSON. The object contains
 *     braces inside strings, so a lazy `{.+?}` truncates it and a greedy one
 *     swallows the rest of the page. We reuse the brace walker written for the
 *     player script, which already understands string and regex literals.
 */

import { upstream, readBody } from './net.mjs';
import { balanced } from './decipher.mjs';
import { payloadFromPlayerResponse } from './piped-local.mjs';
import { getPoToken } from './potoken.mjs';
import { playerRequest } from './innertube.mjs';

const BASE = () => (process.env.UMBRA_YT_BASE || 'https://www.youtube.com').replace(/\/+$/, '');
const TIMEOUT = Number(process.env.UMBRA_WATCHPAGE_TIMEOUT || 10000);

/* A current desktop browser. The watch page varies its markup by user agent,
   and an unrecognised one gets a degraded page with no player response. */
const UA = process.env.UMBRA_WATCHPAGE_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* SOCS/CONSENT short-circuit the EU cookie wall. Without them a European
   egress gets an interstitial instead of a video and the failure looks like a
   block. */
const CONSENT = 'SOCS=CAI; CONSENT=YES+cb; PREF=hl=en&tz=UTC';

/**
 * Pull a `var NAME = {...}` object out of page HTML.
 *
 * Returns null rather than throwing: a missing object is an ordinary outcome
 * (the consent wall, an age gate, a markup change) and the caller has another
 * surface to try.
 */
export function extractJson(html, name) {
  /* The assignment appears in a few shapes: `var x = {`, `window["x"] = {`,
     and `x = {`. Anchor on the name and take the first brace after it. */
  const patterns = [
    new RegExp('var\\s+' + name + '\\s*=\\s*'),
    new RegExp('window\\s*\\[\\s*[\'"]' + name + '[\'"]\\s*\\]\\s*=\\s*'),
    new RegExp('[\'"]' + name + '[\'"]\\s*:\\s*'),
    new RegExp(name + '\\s*=\\s*'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (!m) continue;
    const span = balanced(html, m.index + m[0].length, '{}');
    if (!span) continue;
    try {
      /* balanced() reports an exclusive end and hands back the slice itself */
      return JSON.parse(span.body);
    } catch { /* try the next shape */ }
  }
  return null;
}

/**
 * The object passed to a call like `ytcfg.set({...})`.
 *
 * Not the same shape as a `var x = {...}` assignment, which is why the
 * assignment patterns above miss it — and missing it is what made the embed
 * page look empty when it was in fact the one surface still answering us.
 */
export function extractCallArg(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const span = balanced(html, i + marker.length, '{}');
  if (!span) return null;
  try { return JSON.parse(span.body); } catch { return null; }
}

async function getPage(url, cookie) {
  const res = await upstream(url, {
    timeout: TIMEOUT,
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      cookie,
    },
  });
  if (res.status !== 200) {
    res.res.resume();
    throw new Error('watch page http ' + res.status);
  }
  const html = (await readBody(res.res, { limit: 6 * 1024 * 1024 })).toString('utf8');
  if (!html) throw new Error('watch page was empty');
  return html;
}

/**
 * The playerResponse for a video, taken from page HTML.
 *
 * Tries the watch page first because it carries the richest object, then the
 * embed page, which is a distinct surface that is sometimes served when the
 * watch page is not.
 */
export async function playerResponse(videoId) {
  const jar = [CONSENT, (process.env.UMBRA_YT_COOKIES || '').trim()].filter(Boolean).join('; ');
  const surfaces = [
    { name: 'watch', url: BASE() + '/watch?v=' + encodeURIComponent(videoId) + '&has_verified=1&bpctr=9999999999' },
    { name: 'embed', url: BASE() + '/embed/' + encodeURIComponent(videoId) },
  ];
  const tried = [];
  for (const s of surfaces) {
    try {
      const html = await getPage(s.url, jar);
      let pr = extractJson(html, 'ytInitialPlayerResponse')
        || extractJson(html, 'ytInitialEmbeddedPlayerResponse');
      /* The embed page usually carries no playerResponse at all — it carries
         a ytcfg, and the player fetches the rest itself. That config is worth
         more than the page: it holds an API key and a VISITOR_DATA minted for
         this request, which is a fresher identity than our cached one. So
         rather than give up, spend them on an embedded player call. */
      if (!pr) {
        const cfg = extractCallArg(html, 'ytcfg.set(');
        const key = cfg && (cfg.INNERTUBE_API_KEY
          || (cfg.WEB_PLAYER_CONTEXT_CONFIGS || {}).innertubeApiKey);
        const vis = cfg && (cfg.VISITOR_DATA || cfg.visitorData);
        if (key || vis) {
          try {
            const viaCfg = await playerRequest(videoId, 'web_embedded', {
              visitorData: vis || '', apiKey: key || '', poToken: await getPoToken(vis || ''),
            });
            const sd = (viaCfg || {}).streamingData || {};
            if (sd.formats || sd.adaptiveFormats || sd.hlsManifestUrl) {
              return { pr: viaCfg, surface: s.name + '+ytcfg', tried };
            }
            tried.push({ surface: s.name + '+ytcfg', note: 'page config accepted but formats were withheld' });
            continue;
          } catch (e) {
            tried.push({ surface: s.name + '+ytcfg', note: String(e.message || e).slice(0, 100) });
            continue;
          }
        }
      }
      if (!pr) {
        /* Distinguish the consent wall from a markup change: the operator can
           act on one and not the other. */
        /* Order matters. A bot wall page also references the consent
           domain, so checking consent first reports a cookie problem for
           what is actually YouTube refusing the address — and sends the
           operator chasing a cookie that was never missing. */
        const why = /sign ?in to confirm|not a bot|LOGIN_REQUIRED/i.test(html)
          ? 'sign-in wall: YouTube refused this address'
          : /consent\.youtube\.com\/m|CONSENT_WALL|before you continue/i.test(html)
            ? 'consent wall was served instead of the page'
            : 'no ytInitialPlayerResponse in the html';
        tried.push({ surface: s.name, note: why });
        continue;
      }
      const status = ((pr.playabilityStatus || {}).status) || 'UNKNOWN';
      if (status !== 'OK') {
        tried.push({
          surface: s.name,
          note: status + ': ' + String((pr.playabilityStatus || {}).reason || '').slice(0, 80),
        });
        /* Keep it anyway — an unplayable response still carries metadata, and
           the next surface may be playable. */
        if (!(pr.streamingData || {}).formats && !(pr.streamingData || {}).adaptiveFormats
          && !(pr.streamingData || {}).hlsManifestUrl) continue;
      }
      return { pr, surface: s.name, tried };
    } catch (e) {
      tried.push({ surface: s.name, note: String(e.message || e).slice(0, 120) });
    }
  }
  const err = new Error('watch page extraction failed for ' + videoId
    + ' (' + tried.map((t) => t.surface + ': ' + t.note).join('; ') + ')');
  err.tried = tried;
  throw err;
}

/** Piped-shaped stream payload, deciphered and PO-tokened like any other. */
export async function streams(videoId) {
  const { pr, surface, tried } = await playerResponse(videoId);
  const pot = await getPoToken('');
  const payload = await payloadFromPlayerResponse(pr, videoId, {
    pot, used: 'watchpage:' + surface, tried,
  });
  if (!payload.videoStreams.length && !payload.audioStreams.length && !payload.hls) {
    throw new Error('watch page returned no playable formats');
  }
  return payload;
}

/**
 * oEmbed: title, author and thumbnail with no key, no quota and no client
 * context. It cannot return streams, but it answers when everything else is
 * refused, which makes it the difference between a broken page and a page
 * that names the video it cannot play.
 */
export async function oembed(videoId) {
  const url = BASE() + '/oembed?format=json&url='
    + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
  const res = await upstream(url, {
    timeout: TIMEOUT,
    headers: { 'user-agent': UA, accept: 'application/json' },
  });
  if (res.status !== 200) { res.res.resume(); throw new Error('oembed http ' + res.status); }
  const j = JSON.parse((await readBody(res.res, { limit: 128 * 1024 })).toString('utf8'));
  return {
    title: j.title || videoId,
    uploader: j.author_name || '',
    uploaderUrl: j.author_url || '',
    thumbnailUrl: j.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    duration: 0,
  };
}

/**
 * A channel's recent uploads from its Atom feed.
 *
 * Another keyless first-party surface. It returns only the latest ~15 entries
 * so it cannot back a catalogue, but it is close to unblockable and makes
 * channel pages work when the API will not talk to us.
 */
export async function channelFeed(channelId) {
  const url = BASE().replace(/\/+$/, '') + '/feeds/videos.xml?channel_id=' + encodeURIComponent(channelId);
  const res = await upstream(url, { timeout: TIMEOUT, headers: { 'user-agent': UA, accept: 'application/atom+xml' } });
  if (res.status !== 200) { res.res.resume(); throw new Error('feed http ' + res.status); }
  const xml = (await readBody(res.res, { limit: 2 * 1024 * 1024 })).toString('utf8');
  const one = (block, tag) => {
    const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>').exec(block);
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
  };
  const entries = xml.split('<entry>').slice(1).map((block) => {
    const id = one(block, 'yt:videoId');
    return id ? {
      id,
      title: one(block, 'title'),
      uploader: one(block, 'name'),
      uploaderUrl: '/channel/' + channelId,
      uploaded: one(block, 'published'),
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      duration: 0,
      views: Number((/<media:statistics views="(\d+)"/.exec(block) || [])[1] || 0),
    } : null;
  }).filter(Boolean);
  if (!entries.length) throw new Error('feed contained no entries');
  return { name: one(xml, 'title'), id: channelId, videos: entries };
}
