/**
 * yt-dlp provider.
 *
 * An extraction engine, not a front end, and the most capable one in the set:
 * it carries signature/nsig deobfuscation that the pure-HTTP adapters do not,
 * so it often recovers formats when everything else has been gated. The cost
 * is that it is a subprocess, which is slower and heavier than an HTTP call,
 * so it is ranked last and used as a fallback rather than a default.
 *
 * It never downloads media. Every invocation is `--dump-single-json` with
 * `--skip-download`, which fetches the watch page and player script and
 * prints metadata. No file is written, nothing is cached to disk, and the
 * format URLs it returns are handed on as metadata exactly like every other
 * provider's.
 */

import { execFile } from 'node:child_process';
import { InstancePool, ProviderInstance } from './pool.mjs';
import * as T from './types.mjs';

export const id = 'ytdlp';
export const name = 'yt-dlp';

export const capabilities = {
  search: true, video: true, channel: false, playlist: true,
  comments: false, recommendations: false, streams: true, trending: false,
};

const BIN = process.env.UMBRA_YTDLP_BIN || 'yt-dlp';
const TIMEOUT = Number(process.env.UMBRA_YTDLP_TIMEOUT || 25000);

const self = new ProviderInstance('', id, {
  id: 'ytdlp:subprocess',
  local: true,
  capabilities: Object.keys(capabilities).filter((k) => capabilities[k]),
});
export const pool = new InstancePool(id, [self]);

let present = null;
/** Probe once. An absent binary is a configuration fact, not a failure. */
export async function available() {
  if (present !== null) return present;
  present = await new Promise((resolve) => {
    execFile(BIN, ['--version'], { timeout: 5000 }, (err) => resolve(!err));
  });
  return present;
}
export const enabled = () => present !== false;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).split('\n')[0].slice(0, 200)));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('yt-dlp output was not json')); }
    });
  });
}

/* Arguments are fixed; only the id/query varies and it is validated before
   it gets here. execFile takes an argv array, so there is no shell to quote
   against in the first place. */
const BASE_ARGS = ['--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist'];

function vidFrom(j) {
  return T.video({
    id: j.id,
    title: j.title,
    description: j.description,
    author: { id: j.channel_id, name: j.uploader || j.channel, avatar: null },
    thumbnails: (j.thumbnails || []).map((t) => ({ url: t.url, width: t.width, height: t.height })),
    duration: j.duration,
    publishedAt: j.timestamp || (j.upload_date
      ? `${j.upload_date.slice(0, 4)}-${j.upload_date.slice(4, 6)}-${j.upload_date.slice(6, 8)}`
      : null),
    viewCount: j.view_count,
    live: j.is_live === true,
    metadata: { likeCount: T.num(j.like_count), extractor: T.str(j.extractor, 64) },
  }, { provider: id, instance: 'subprocess' });
}

export async function getVideo(videoId) {
  return pool.run(async () => {
    const j = await run([...BASE_ARGS, 'https://www.youtube.com/watch?v=' + videoId]);
    const v = vidFrom(j);
    if (!v) throw new Error('video payload failed validation');
    return v;
  }, { capability: 'video' });
}

export async function search(query, { limit = 20 } = {}) {
  return pool.run(async () => {
    const j = await run(['--dump-single-json', '--skip-download', '--no-warnings', '--flat-playlist',
      `ytsearch${Math.min(limit, 50)}:${query}`]);
    return (j.entries || []).map((e) => T.video({
      id: e.id,
      title: e.title,
      description: e.description,
      author: { id: e.channel_id, name: e.uploader || e.channel },
      thumbnails: (e.thumbnails || []).map((t) => ({ url: t.url, width: t.width, height: t.height })),
      duration: e.duration,
      viewCount: e.view_count,
    }, { provider: id, instance: 'subprocess' })).filter(Boolean);
  }, { capability: 'search' });
}

export async function getPlaylist(playlistId) {
  return pool.run(async () => {
    const j = await run(['--dump-single-json', '--skip-download', '--no-warnings', '--flat-playlist',
      'https://www.youtube.com/playlist?list=' + playlistId]);
    const p = T.playlist({
      id: j.id || playlistId,
      title: j.title,
      description: j.description,
      author: { id: j.channel_id, name: j.uploader || j.channel },
      videoCount: j.playlist_count,
      videos: (j.entries || []).map((e) => T.video({
        id: e.id, title: e.title, duration: e.duration,
        author: { id: e.channel_id, name: e.uploader || e.channel },
        thumbnails: (e.thumbnails || []).map((t) => ({ url: t.url, width: t.width, height: t.height })),
      }, { provider: id, instance: 'subprocess' })).filter(Boolean),
    }, { provider: id, instance: 'subprocess' });
    if (!p) throw new Error('playlist payload failed validation');
    return p;
  }, { capability: 'playlist' });
}

export async function getStreams(videoId) {
  return pool.run(async () => {
    const j = await run([...BASE_ARGS, 'https://www.youtube.com/watch?v=' + videoId]);
    const fmts = j.formats || [];
    const s = T.streamInfo({
      id: j.id || videoId,
      title: j.title,
      duration: j.duration,
      live: j.is_live === true,
      videoStreams: fmts.filter((f) => f.vcodec && f.vcodec !== 'none').map((f) => ({
        url: f.url, itag: f.format_id, mimeType: f.ext ? 'video/' + f.ext : null,
        codec: f.vcodec, quality: f.format_note || (f.height ? f.height + 'p' : null),
        bitrate: f.tbr ? Math.round(f.tbr * 1000) : null,
        width: f.width, height: f.height, fps: f.fps,
        contentLength: f.filesize || f.filesize_approx,
        videoOnly: !f.acodec || f.acodec === 'none',
      })),
      audioStreams: fmts.filter((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none')
        .map((f) => ({
          url: f.url, itag: f.format_id, mimeType: f.ext ? 'audio/' + f.ext : null,
          codec: f.acodec, quality: f.format_note,
          bitrate: f.abr ? Math.round(f.abr * 1000) : null,
          contentLength: f.filesize || f.filesize_approx, audioOnly: true,
        })),
      subtitles: Object.entries(j.subtitles || {}).flatMap(([code, tracks]) =>
        (tracks || []).slice(0, 1).map((t) => ({ url: t.url, code, name: t.name || code }))),
    }, { provider: id, instance: 'subprocess' });
    if (!s || (!s.videoStreams.length && !s.audioStreams.length)) throw new Error('no formats in payload');
    return s;
  }, { capability: 'streams' });
}

export async function healthCheck() {
  const ok = await available();
  return ok
    ? { provider: id, healthy: true, instance: self.id }
    : { provider: id, healthy: false, disabled: true, reason: `${BIN} not on PATH` };
}

export function report() {
  return pool.report().map((r) => ({ ...r, status: present === false ? 'DISABLED' : r.status }));
}
