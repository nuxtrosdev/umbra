/*
 * UMBRA PLAYER
 * Renders the payload produced by /~umbra/ytj: whatever streams Umbra could
 * recover from the watch page, plus two escape hatches (dual-track playback
 * when YouTube only handed us separate video/audio tracks, and the proxied
 * embed document when Google stripped every URL).
 */
(function () {
  var host = document.getElementById('player');
  if (!host) return;
  var d;
  try { d = JSON.parse(host.getAttribute('data-info').replace(/&#39;/g, "'")); }
  catch (e) { host.innerHTML = '<p class="warn">player payload unreadable</p>'; return; }

  var muxed = d.muxed || [], vids = d.video || [], auds = d.auds || d.audio || [], caps = d.captions || [];
  /* Opening mode. Native streams win when they exist — they are proxied, so
     nothing leaves the boundary. When extraction produced nothing, the
     proxied embed is a black rectangle on a scored address and the direct
     one plays, so that is what mounts: a working player first, with the
     proxied embed one click away. */
  var fallback = d.directEmbed ? 'direct' : 'embed';
  var state = {
    mode: d.ok ? (muxed.length ? 'muxed' : (vids.length ? 'dual' : fallback)) : fallback,
    vi: 0, ai: 0, mi: 0,
  };

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'html') n.innerHTML = attrs[k]; else n.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { c && n.appendChild(c); });
    return n;
  }
  function post(type, p) {
    var m = Object.assign({ umbra: 1, tab: (d.ctx && d.ctx.tab) || '', type: type }, p || {});
    try { window.top.postMessage(m, '*'); } catch (e) {}
  }
  function fmt(s) { s = s | 0; var h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, x = s % 60; return (h ? h + ':' : '') + (m < 10 && h ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x; }

  /* Where the bytes come from. The server names a preference; this picks
     the best available url for a track and remembers, per element, what to
     fall back to when the chosen source refuses — googlevideo signs its
     urls to the address that extracted them, so a direct hit can 403 even
     though the url is perfectly valid for this server. Falling back costs
     one failed request and keeps the video playing. */
  var egress = d.egress || 'wire';
  function pick(f) {
    if (!f) return null;
    if (egress === 'peer' && f.peer) return { src: f.peer, via: 'peer', next: f.wire };
    if (egress === 'direct' && f.direct) return { src: f.direct, via: 'direct', next: f.peer || f.wire };
    return { src: f.wire, via: 'wire', next: null };
  }
  function setSrc(elm, f) {
    var c = pick(f);
    if (!c) return;
    elm.__umbraNext = c.next;
    elm.__umbraVia = c.via;
    elm.src = c.src;
  }
  /* One retry per element, downgrading to the next source. */
  function onSourceError(elm, label) {
    var next = elm.__umbraNext;
    if (!next) return false;
    elm.__umbraNext = null;
    readout.textContent = label + ' refused by the ' + elm.__umbraVia +
      ' source — falling back to this origin and reloading.';
    elm.__umbraVia = 'wire';
    elm.src = next;
    elm.load();
    var p = elm.play(); if (p && p.catch) p.catch(function () {});
    return true;
  }

  var video = el('video', { controls: '', playsinline: '', preload: 'metadata', id: 'umbra-video' });
  if (d.thumbWire) video.setAttribute('poster', d.thumbWire);
  var audio = el('audio', { id: 'umbra-audio', preload: 'auto' });
  var stage = el('div', { id: 'umbra-stage', style: 'position:relative;background:#05080c;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.08)' });
  var ctl = el('div', { class: 'ctl' });
  var readout = el('div', { class: 'muted', id: 'umbra-readout', style: 'font:11px/1.6 ui-monospace,monospace;margin-top:9px;color:#8b9bb4' });

  function selectOf(items, label, onpick) {
    var sel = el('select', { title: label });
    items.forEach(function (it, i) { var o = el('option', { value: String(i), text: it }); if (!i) o.selected = true; sel.appendChild(o); });
    sel.onchange = function () { onpick(+sel.value); };
    return sel;
  }
  function btn(txt, cls, fn) { var b = el('button', { text: txt, class: cls || '' }); b.onclick = fn; return b; }

  function syncDual() {
    if (state.mode !== 'dual') return;
    if (Math.abs(audio.currentTime - video.currentTime) > 0.28) {
      try { audio.currentTime = video.currentTime; } catch (e) {}
    }
  }
  function wireEvents() {
    audio.onerror = function () { onSourceError(audio, 'audio'); };
    video.addEventListener('play', function () { if (state.mode === 'dual') { audio.volume = video.muted ? 0 : 1; audio.play().catch(function(){}); } });
    video.addEventListener('pause', function () { if (state.mode === 'dual') audio.pause(); });
    video.addEventListener('seeked', syncDual);
    video.addEventListener('timeupdate', function () {
      syncDual();
      var out = [];
      out.push(state.mode + ' · ' + fmt(video.currentTime) + '/' + fmt(video.duration || d.duration) + (video.paused ? ' ⏸' : ' ▶'));
      if (state.mode === 'dual' && vids[state.vi]) out.push('video ' + (vids[state.vi].label || '') + ' ' + (vids[state.vi].codecs || '') + (auds[state.ai] ? ' + audio ' + (auds[state.ai].codecs || '') : ''));
      if (state.mode === 'muxed' && muxed[state.mi]) out.push('muxed itag ' + muxed[state.mi].itag + ' ' + (muxed[state.mi].label || '') + ' · ' + (muxed[state.mi].contentLength ? Math.round(muxed[state.mi].contentLength / 1048576) + ' MB' : ''));
      out.push(video.__umbraVia === 'wire'
        ? 'every byte via /~umbra/m · nothing requested from googlevideo.com by you'
        : video.__umbraVia === 'peer'
          ? 'bytes from a public instance, not this origin · that instance sees your address'
          : 'bytes straight from googlevideo · google sees your address, this origin relays nothing');
      readout.textContent = out.join('  |  ');
    });
    /* Whether sound actually exists in what is playing.
       
       "The video plays but there is no audio" has several causes that look
       identical from the sofa: a muted element, a muxed format that turned
       out to carry no audio track, or a browser that decoded the video and
       not the codec beside it. The element knows which. Ask it once the
       metadata is in, and print the answer instead of leaving it to be
       guessed. */
    video.addEventListener('loadedmetadata', function () {
      setTimeout(function () {
        if (state.mode !== 'muxed') return;
        var tracks = video.audioTracks ? video.audioTracks.length : null;
        var decoded = typeof video.webkitAudioDecodedByteCount === 'number'
          ? video.webkitAudioDecodedByteCount : null;
        var hasAudio = video.mozHasAudio === true || (tracks !== null && tracks > 0) ||
          (decoded !== null && decoded > 0);
        var silent = (tracks === 0) || (decoded === 0 && video.currentTime > 0.5);
        if (video.muted || video.volume === 0) {
          readout.textContent = 'the player was muted — unmuting. If it stays silent, say so.';
          video.muted = false; video.volume = 1;
          return;
        }
        if (silent && !hasAudio) {
          readout.textContent = 'this muxed format (itag ' + ((muxed[state.mi] || {}).itag || '?') +
            ') carries no audio track — youtube withheld the audio formats for this address' +
            (auds.length ? '; switch to dual track for sound.' : ', so there is no audio to pair with it.');
        }
      }, 1200);
    });

    video.onerror = function () {
      if (onSourceError(video, 'video')) return;
      readout.textContent = 'this browser cannot decode the chosen track (' + (video.error ? ['ABORTED', 'NETWORK', 'DECODE', 'SRC_NOT_SUPPORTED', 'MEDIA_ERR'][video.error.code - 1] : '?') + ') — switch codec/quality above, or use the proxied embed.';
    };
    /* stall watchdog: error events cover failures, but a throttled or expired
       stream just sits at readyState 0 forever — black with no message. Say so. */
    if (video.__umbraStall) clearInterval(video.__umbraStall);
    var stallSince = Date.now();
    video.__umbraStall = setInterval(function () {
      if (video.error || video.readyState >= 2) { stallSince = Date.now(); return; }
      if (video.networkState === 2 && Date.now() - stallSince > 20000) {
        clearInterval(video.__umbraStall);
        video.__umbraStall = null;
        readout.textContent = 'no frame in 20s (still loading, readyState ' + video.readyState + ') — the wire may be throttled or the stream URL expired; try another track above, or the proxied embed.';
      }
    }, 5000);
  }

  var verdictTimer = null;
  function askVerdict(delay) {
    clearTimeout(verdictTimer);
    verdictTimer = setTimeout(function () {
      if (state.mode !== 'embed') return;
      var base = (d.ctx && d.ctx.origin ? '' : '') + '/~umbra/ytverdict?v=' + encodeURIComponent(d.videoId || '');
      fetch(base, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (v) {
        if (!v || state.mode !== 'embed') return;
        if (!v.seen) {
          readout.textContent = 'the embed has not asked YouTube for the video yet — if this stays, '
            + 'its player code never started. ' + readout.textContent;
          return;
        }
        var line = 'youtube answered the embed: ' + v.status + ' · ' + v.verdict
          + ' · ' + v.withUrl + '/' + v.formats + ' formats carried urls'
          + (v.reason ? ' · "' + v.reason + '"' : '');
        if (v.verdict !== 'playable' && d.directEmbed) {
          line += ' — this is the address, not the proxy. The direct frame plays.';
        }
        readout.textContent = line;
      }).catch(function () {});
    }, delay || 3000);
  }

  /* ------------------------------------------------------------------
     What the direct frame is actually doing.

     A YouTube embed that refuses is a black rectangle and nothing else:
     no error event crosses the document boundary, so every cause looks
     the same from this page. The IFrame Player API is YouTube's own answer
     to that — it speaks postMessage with the frame and reports readiness,
     state and error codes. Codes 101 and 150 are the one every proxy hits
     and nobody can fix: the uploader switched embedding off, so the video
     plays on youtube.com and nowhere else, forever.
     ------------------------------------------------------------------ */
  var YT_ERR = {
    2: 'YouTube rejected the video id as malformed.',
    5: 'the HTML5 player failed on this video in this browser.',
    100: 'the video does not exist, or was removed or made private.',
    101: 'the uploader does not allow this video to be played outside YouTube.',
    150: 'the uploader does not allow this video to be played outside YouTube.',
  };
  /* YouTube's IFrame API is a JS wrapper around a postMessage protocol, and
     the wrapper is the only part that has to come from Google. Loading it
     would mean allowing Google script into this document — a real widening
     of the boundary for a diagnostic. The protocol itself costs nothing:
     say "listening" to the frame, and it reports readiness, state changes
     and error codes back. Same answers, no third-party code, no CSP
     change. */
  function watchDirect(frame) {
    var origin = 'https://www.youtube-nocookie.com';
    var spoke = false;
    function tell() {
      try {
        frame.contentWindow.postMessage(JSON.stringify({
          event: 'listening', id: 'umbra', channel: 'widget',
        }), origin);
      } catch (e) {}
    }
    if (!window.__umbraDirectHook) {
      window.__umbraDirectHook = true;
      window.addEventListener('message', function (ev) {
        if (!ev || ev.origin !== origin) return;
        var m = ev.data;
        if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { return; } }
        if (!m || !m.event) return;
        spoke = true;
        if (m.event === 'onReady' || m.event === 'initialDelivery') {
          readout.textContent = 'direct embed ready — YouTube accepted this player. Press play. '
            + 'The bytes come from Google to you; Umbra relays nothing here.';
        } else if (m.event === 'onError') {
          var code = Number(m.info);
          readout.textContent = 'YouTube refused this embed (error ' + code + '): '
            + (YT_ERR[code] || 'no reason given')
            + ((code === 101 || code === 150)
              ? ' No server-side change can lift that. The native stream is unaffected — '
                + 'it does not go through the embed.'
              : '');
        } else if (m.event === 'infoDelivery' && m.info && m.info.playerState === 1) {
          readout.textContent = 'playing — direct from YouTube to your browser.';
        }
      });
    }
    frame.addEventListener('load', function () { tell(); setTimeout(tell, 600); });
    setTimeout(function () {
      if (!spoke) {
        readout.textContent = 'direct embed mounted, but the player has not said anything back yet. '
          + 'If it stays black, the uploader may have disabled embedding — try "watch on youtube".';
      }
    }, 6000);
  }

  function mount() {
    stage.innerHTML = '';
    ctl.innerHTML = '';
    /* Direct mode: the iframe is NOT wired, by design. data-umbra-direct is
       set before src so the shim's setAttribute hook sees it and stands
       aside, and the server has already widened frame-src for this host —
       without that the browser refuses the frame and nothing leaks. */
    if (state.mode === 'direct' && d.directEmbed) {
      var df = document.createElement('iframe');
      df.setAttribute('data-umbra-direct', '1');
      df.id = 'umbra-direct-frame';
      /* The page carries <meta name="referrer" content="no-referrer">, and a
         YouTube embed with no Referer at all is refused with error 153 — a
         black rectangle. Send the origin, and only the origin. */
      df.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      df.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
      df.setAttribute('allowfullscreen', '');
      df.setAttribute('style', 'width:100%;aspect-ratio:16/9;border:0;display:block;background:#000');
      /* enablejsapi turns the frame from a black box into something that
         answers questions. Without it a refused embed and a working one
         look identical from out here. */
      df.setAttribute('src', d.directEmbed +
        (d.directEmbed.indexOf('?') < 0 ? '?' : '&') + 'enablejsapi=1&origin=' +
        encodeURIComponent(location.origin));
      stage.appendChild(df);
      ctl.appendChild(btn('use the proxied embed instead', '', function () { state.mode = 'embed'; mount(); }));
      if (muxed.length || vids.length) ctl.appendChild(btn('try native stream', '', function () { state.mode = muxed.length ? 'muxed' : 'dual'; mount(); }));
      /* When the uploader has disabled embedding there is exactly one place
         the video plays, and pretending otherwise wastes the viewer's time. */
      if (d.videoId) {
        ctl.appendChild(btn('open on youtube.com (last resort)', '', function () {
          window.open('https://www.youtube.com/watch?v=' + d.videoId, '_blank', 'noopener');
        }));
      }
      readout.textContent = 'direct embed — this frame is loaded by your browser from youtube-nocookie.com, '
        + 'not through Umbra. YouTube sees your address, and that is why it plays.';
      watchDirect(df);
      host.appendChild(stage); host.appendChild(ctl); host.appendChild(readout);
      return;
    }

    if (state.mode === 'embed') {
      /* A token signed by a previous run of the server is dead on arrival,
         and the frame can only show a capsule saying so. It tells us; we
         mint a fresh one and swap it in. Failing that, fall through to the
         frame the browser loads itself, which needs no token at all. */
      if (!window.__umbraStaleHook) {
        window.__umbraStaleHook = true;
        window.addEventListener('message', function (ev) {
          var m = ev && ev.data;
          if (!m || m.umbra !== 1 || m.type !== 'stale-token') return;
          if (!d.embedUrl) { if (d.directEmbed) { state.mode = 'direct'; mount(); } return; }
          readout.textContent = 'that link was signed before the server restarted — re-minting it…';
          fetch('/~umbra/mint', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: d.embedUrl, tab: (d.ctx && d.ctx.tab) || '', mode: 'd' }),
          }).then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.href) { d.embedDoc = j.href; mount(); }
            else if (d.directEmbed) { state.mode = 'direct'; mount(); }
          }).catch(function () { if (d.directEmbed) { state.mode = 'direct'; mount(); } });
        });
      }
      var f = el('iframe', {
        src: d.embedDoc || 'about:blank', allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        /* YouTube's embedded player refuses with error 153 when it cannot see
           a Referer, so send the origin (and only the origin) with the frame. */
        referrerpolicy: 'strict-origin-when-cross-origin',
        allowfullscreen: '', loading: 'lazy',
        style: 'width:100%;aspect-ratio:16/9;border:0;display:block;background:#000',
      });
      stage.appendChild(f);
      ctl.appendChild(btn('proxied embed document', 'go', function () {}));
      /* Offering "try native stream" when extraction produced nothing was a
         lie that cost the reader a click and told them nothing: it fell
         straight back to this same embed, so the embed's own readout looked
         like the native path's verdict. Only offer it when it exists. */
      if (muxed.length || vids.length) {
        ctl.appendChild(btn('try native stream', '', function () { state.mode = muxed.length ? 'muxed' : 'dual'; mount(); }));
      }
      if (d.directEmbed && !d.ok) {
        ctl.appendChild(btn('\u2190 the frame that usually plays', 'go', function () { state.mode = 'direct'; mount(); }));
      }
      if (d.directEmbed) ctl.appendChild(btn('load direct from youtube (leaves umbra)', 'warn', function () { state.mode = 'direct'; mount(); }));
      readout.textContent = d.ok
        ? 'native available'
        : (d.verdict && d.verdict.headline
          /* "every provider failed" describes our side of the call. When
             YouTube gave an actual reason, that is the thing worth saying. */
          ? d.verdict.headline + ' No extraction can fix that; this frame is the only path left.'
          : 'no backend could extract this video (' + (d.reason || 'blocked') + ') — '
            + 'this is the proxied embed, served through Umbra with X-Frame-Options and CSP removed');
      /* The frame cannot report its own failure across the document
         boundary, but YouTube's answer to it came through this origin. Ask,
         once the player has had time to ask first. A black rectangle becomes
         a sentence. */
      askVerdict(3000);
      host.appendChild(stage); host.appendChild(ctl); host.appendChild(readout);
      return;
    }

    if (state.mode === 'muxed') {
      var m = muxed[state.mi] || muxed[0];
      setSrc(video, m);
      /* `removeAttribute('muted')` does not unmute anything. The content
         attribute only sets the *default*; once dual-track mode has
         assigned the muted IDL property, the element stays silent through
         every later mount — including this one. One visit to dual track
         and back was enough to lose audio for the rest of the session. */
      video.muted = false;
      video.volume = 1;
      stage.appendChild(video);
      ctl.appendChild(btn('muxed stream (video+audio)', 'go', function () {}));
      if (muxed.length > 1) ctl.appendChild(selectOf(muxed.map(function (x) { return (x.label || x.quality) + ' · ' + (x.codecs || '').slice(0, 12) + (x.contentLength ? ' · ' + Math.round(x.contentLength / 1048576) + 'MB' : ''); }), 'quality', function (i) { state.mi = i; video.pause(); setSrc(video, muxed[i]); video.load(); }));
    } else {
      var v = vids[state.vi] || vids[0];
      var a = auds[state.ai] || auds[0];
      setSrc(video, v);
      video.muted = true;
      if (a) setSrc(audio, a);
      stage.appendChild(video);
      stage.appendChild(audio);
      ctl.appendChild(btn('dual track (video + separate audio)', 'go', function () {}));
      if (vids.length > 1) ctl.appendChild(selectOf(vids.map(function (x) { return (x.height || '?') + 'p ' + (x.fps || '') + ' · ' + (x.codecs || '').slice(0, 14); }), 'video track', function (i) { state.vi = i; var t = video.paused; video.pause(); setSrc(video, vids[i]); video.load(); if (!t) video.play(); }));
      if (auds.length > 1) ctl.appendChild(selectOf(auds.map(function (x) { return 'audio · ' + (x.codecs || x.label || '') + (x.bitrate ? ' · ' + Math.round(x.bitrate / 1000) + 'kbps' : ''); }), 'audio track', function (i) { state.ai = i; setSrc(audio, auds[i]); audio.load(); video.dispatchEvent(new Event('play')); }));
    }

    ctl.appendChild(btn(state.mode === 'dual' && muxed.length ? 'switch to muxed' : 'switch to dual track', '', function () {
      state.mode = state.mode === 'dual' ? 'muxed' : 'dual';
      var wasTime = video.currentTime;
      mount();
      video.addEventListener('loadedmetadata', function once() { video.currentTime = wasTime; video.removeEventListener('loadedmetadata', once); });
    }));
    ctl.appendChild(btn('proxied embed', '', function () { state.mode = 'embed'; mount(); }));
    ctl.appendChild(selectOf(['0.5', '0.75', '1', '1.25', '1.5', '2'], 'speed', function (i) { video.playbackRate = [0.5, 0.75, 1, 1.25, 1.5, 2][i]; }));
    if (caps.length) {
      ctl.appendChild(selectOf(['off'].concat(caps.map(function (c) { return 'cc · ' + c.label; })), 'captions', function (i) {
        var old = video.querySelector('track'); if (old) old.remove();
        video.textTracks.length = 0;
        if (i > 0) {
          var tr = el('track', { kind: 'subtitles', label: caps[i - 1].label, src: caps[i - 1].vtt || caps[i - 1].wire, srclang: caps[i - 1].code, default: '' });
          video.appendChild(tr);
          video.textTracks[0] && (video.textTracks[0].mode = 'showing');
        }
      }));
    }
    ctl.appendChild(btn('↗ open watch page in a tab', '', function () { post('open', { url: 'umbra://www.youtube.com/watch?v=' + d.videoId }); }));
    ctl.appendChild(btn('copy stream address', '', function () {
      var src = state.mode === 'muxed' ? (muxed[state.mi] || {}).wire : (vids[state.vi] || {}).wire;
      var abs = location.origin + (src || '');
      navigator.clipboard && navigator.clipboard.writeText(abs).catch(function () {});
      readout.textContent = 'copied: ' + abs;
    }));

    host.appendChild(stage);
    host.appendChild(ctl);
    host.appendChild(readout);
    wireEvents();
    video.load();
  }

  /* header line under the player */
  if (d.desc) {
    var det = el('details', { style: 'margin-top:14px' }, [
      el('summary', { text: 'description', style: 'cursor:pointer;color:#8b9bb4;font-size:12px' }),
      el('pre', { style: 'white-space:pre-wrap;font-size:12.5px;color:#bfd4e6', text: String(d.desc).slice(0, 4000) }),
    ]);
    host.appendChild(det);
  }
  mount();
  document.title = 'umbra player · ' + (d.title || d.videoId);
  post('title', { title: '▶ ' + (d.title || d.videoId) });
})();
