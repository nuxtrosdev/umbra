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
  var state = { mode: d.ok ? (muxed.length ? 'muxed' : (vids.length ? 'dual' : 'embed')) : 'embed', vi: 0, ai: 0, mi: 0 };

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
    video.addEventListener('play', function () { if (state.mode === 'dual') { audio.volume = video.muted ? 0 : 1; audio.play().catch(function(){}); } });
    video.addEventListener('pause', function () { if (state.mode === 'dual') audio.pause(); });
    video.addEventListener('seeked', syncDual);
    video.addEventListener('timeupdate', function () {
      syncDual();
      var out = [];
      out.push(state.mode + ' · ' + fmt(video.currentTime) + '/' + fmt(video.duration || d.duration) + (video.paused ? ' ⏸' : ' ▶'));
      if (state.mode === 'dual' && vids[state.vi]) out.push('video ' + (vids[state.vi].label || '') + ' ' + (vids[state.vi].codecs || '') + (auds[state.ai] ? ' + audio ' + (auds[state.ai].codecs || '') : ''));
      if (state.mode === 'muxed' && muxed[state.mi]) out.push('muxed itag ' + muxed[state.mi].itag + ' ' + (muxed[state.mi].label || '') + ' · ' + (muxed[state.mi].contentLength ? Math.round(muxed[state.mi].contentLength / 1048576) + ' MB' : ''));
      out.push('every byte via /~umbra/m · nothing requested from googlevideo.com by you');
      readout.textContent = out.join('  |  ');
    });
    video.onerror = function () {
      readout.textContent = 'this browser cannot decode the chosen track (' + (video.error ? ['ABORTED', 'NETWORK', 'DECODE', 'SRC_NOT_SUPPORTED', 'MEDIA_ERR'][video.error.code - 1] : '?') + ') — switch codec/quality above, or use the proxied embed.';
    };
  }

  function mount() {
    stage.innerHTML = '';
    ctl.innerHTML = '';
    if (state.mode === 'embed') {
      var f = el('iframe', {
        src: d.embedDoc || 'about:blank', allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        allowfullscreen: '', loading: 'lazy',
        style: 'width:100%;aspect-ratio:16/9;border:0;display:block;background:#000',
      });
      stage.appendChild(f);
      ctl.appendChild(btn('proxied embed document', 'go', function () {}));
      ctl.appendChild(btn('try native stream', '', function () { state.mode = muxed.length ? 'muxed' : (vids.length ? 'dual' : 'embed'); mount(); }));
      readout.textContent = d.ok ? 'native available' : 'stream URLs withheld upstream: ' + (d.reason || 'blocked') + ' — the embed document is served through Umbra with X-Frame-Options and CSP removed';
      host.appendChild(stage); host.appendChild(ctl); host.appendChild(readout);
      return;
    }

    if (state.mode === 'muxed') {
      var m = muxed[state.mi] || muxed[0];
      video.src = m.wire;
      video.removeAttribute('muted');
      stage.appendChild(video);
      ctl.appendChild(btn('muxed stream (video+audio)', 'go', function () {}));
      if (muxed.length > 1) ctl.appendChild(selectOf(muxed.map(function (x) { return (x.label || x.quality) + ' · ' + (x.codecs || '').slice(0, 12) + (x.contentLength ? ' · ' + Math.round(x.contentLength / 1048576) + 'MB' : ''); }), 'quality', function (i) { state.mi = i; video.pause(); video.src = muxed[i].wire; video.load(); }));
    } else {
      var v = vids[state.vi] || vids[0];
      var a = auds[state.ai] || auds[0];
      video.src = v.wire;
      video.muted = true;
      if (a) audio.src = a.wire;
      stage.appendChild(video);
      stage.appendChild(audio);
      ctl.appendChild(btn('dual track (video + separate audio)', 'go', function () {}));
      if (vids.length > 1) ctl.appendChild(selectOf(vids.map(function (x) { return (x.height || '?') + 'p ' + (x.fps || '') + ' · ' + (x.codecs || '').slice(0, 14); }), 'video track', function (i) { state.vi = i; var t = video.paused; video.pause(); video.src = vids[i].wire; video.load(); if (!t) video.play(); }));
      if (auds.length > 1) ctl.appendChild(selectOf(auds.map(function (x) { return 'audio · ' + (x.codecs || x.label || '') + (x.bitrate ? ' · ' + Math.round(x.bitrate / 1000) + 'kbps' : ''); }), 'audio track', function (i) { state.ai = i; audio.src = auds[i].wire; audio.load(); video.dispatchEvent(new Event('play')); }));
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
