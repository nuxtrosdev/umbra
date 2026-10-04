/**
 * Watch-page provider.
 *
 * The important thing about this adapter is what it is *not*: it is not
 * another deployment of the InnerTube API. Every other backend in this
 * directory ends up calling `/youtubei/v1/player`, so a refusal there takes
 * all of them down together. This one reads the HTML page a browser would
 * read and lifts the same object out of it, which is a separate surface with
 * separate gating.
 *
 * It runs in-process on our own address, so it does not buy address
 * diversity the way Piped and Invidious do. It buys *surface* diversity,
 * which is the axis nothing else here varies.
 */

import * as W from '../watchpage.mjs';
import * as T from './types.mjs';
import { InstancePool } from './pool.mjs';

export const id = 'watchpage';
export const name = 'YouTube watch page';

export const capabilities = {
  search: false, video: true, channel: true, playlist: false,
  comments: false, recommendations: false, streams: true, trending: false,
};

/* One "instance" — ourselves — so health tracking, cooldown and the debug
   view treat this like any other backend instead of special-casing it. */
export const pool = new InstancePool(id, ['in-process'], {
  capabilities: Object.keys(capabilities).filter((k) => capabilities[k]),
});

export async function getStreams(videoId) {
  return pool.run(async () => {
    const j = await W.streams(videoId);
    const s = T.streamInfo({
      id: videoId,
      live: j.livestream,
      title: j.title,
      description: j.description,
      uploader: j.uploader,
      uploaderUrl: j.uploaderUrl,
      duration: j.duration,
      views: j.views,
      thumbnailUrl: j.thumbnailUrl,
      livestream: j.livestream,
      hls: j.hls,
      dash: j.dash,
      videoStreams: j.videoStreams,
      audioStreams: j.audioStreams,
      subtitles: j.subtitles,
    }, { provider: id, instance: 'in-process' });
    if (!s) throw new Error('stream payload failed validation');
    if (!s.videoStreams.length && !s.audioStreams.length && !s.hls) {
      throw new Error('no playable formats and no hls manifest');
    }
    return s;
  }, { capability: 'streams' });
}

export async function getVideo(videoId) {
  return pool.run(async () => {
    /* Streams imply metadata, so prefer the full object and fall back to
       oEmbed — which is keyless and answers when the page does not, and is
       the difference between naming a video and showing an error. */
    let j;
    try {
      j = await W.streams(videoId);
    } catch {
      const o = await W.oembed(videoId);
      j = { ...o, description: '', views: 0, uploadDate: '', livestream: false };
    }
    const v = T.video({
      id: videoId,
      title: j.title,
      description: j.description,
      author: j.uploader,
      authorUrl: j.uploaderUrl,
      duration: j.duration,
      views: j.views,
      published: j.uploadDate,
      thumbnails: j.thumbnailUrl ? [{ url: j.thumbnailUrl }] : [],
      live: j.livestream,
    }, { provider: id, instance: 'in-process' });
    if (!v) throw new Error('video payload failed validation');
    return v;
  }, { capability: 'video' });
}

export async function getChannel(channelId) {
  return pool.run(async () => {
    const f = await W.channelFeed(channelId);
    const c = T.channel({
      id: f.id,
      name: f.name,
      videos: f.videos.map((v) => T.video({
        id: v.id,
        title: v.title,
        author: v.uploader,
        authorUrl: v.uploaderUrl,
        published: v.uploaded,
        views: v.views,
        duration: v.duration,
        thumbnails: [{ url: v.thumbnail }],
      }, { provider: id, instance: 'in-process' })).filter(Boolean),
    }, { provider: id, instance: 'in-process' });
    if (!c) throw new Error('channel payload failed validation');
    return c;
  }, { capability: 'channel' });
}
