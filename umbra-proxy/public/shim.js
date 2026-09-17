/*
 * UMBRA FRAME SHIM -- the first script of every proxied (and every
 * Umbra-authored) document. Four jobs, in priority order:
 *
 *   1. nothing this document does may add an entry to the browser's history;
 *   2. every reference built at runtime (JS-assigned src/href, fetch, XHR,
 *      beacon, websocket, worker) is re-anchored onto the Umbra wire, resolved
 *      against the *logical* umbra base rather than the wire path;
 *   3. every navigation the page attempts is reported to the shell, which
 *      decides same-tab vs new-tab -- the frame itself never navigates;
 *   4. the frame cannot reach the network out of band (peer connections,
 *      service workers, top-level navigation, popups are disabled).
 *
 * Each capability installs inside step(), so a hostile page that breaks one
 * hook cannot silently take the rest down: __UMBRA_DIAG__ says what is live.
 */
(function () {
  var ctxEl = document.getElementById('umbra-ctx');
  if (!ctxEl || window.__UMBRA_SHIM__) return;
  window.__UMBRA_SHIM__ = true;
  var DIAG = { version: 'umbra/1.0', done: [], failed: [] };
  var ADOPT = { adoptNode: function () {} }; /* filled by the adopt step */
  window.__UMBRA_DIAG__ = DIAG;
  function step(name, fn) {
    try { fn(); DIAG.done.push(name); }
    catch (e) { DIAG.failed.push(name + ': ' + ((e && e.message) || e)); }
  }

  var ctx;
  try { ctx = JSON.parse(ctxEl.textContent); } catch (e) { DIAG.failed.push('ctx: parse'); return; }
  var ORIGIN = ctx.origin;
  var PFX = '/~umbra/';
  var LOGICAL = ctx.url;
  var DIR = ctx.dir;

  /* ------------------------------------------------------ shell channel */
  function root() {
    try { var t = window.top; void t.location.href; return t; }
    catch (e) { try { return window.parent; } catch (e2) { return null; } }
  }
  var SHELL_ROOT = root();
  function hasShell() { try { return !!(SHELL_ROOT && SHELL_ROOT.__UMBRA_SHELL__); } catch (e) { return false; } }
  function post(type, payload) {
    var msg = { umbra: 1, tab: ctx.tab, frame: ctx.frame, type: type };
    for (var k in payload) msg[k] = payload[k];
    if (hasShell()) { try { SHELL_ROOT.postMessage(msg, ORIGIN); return true; } catch (e) {} }
    return false;
  }
  window.__umbraPost = post;

  /* --------------------------------------------------------- addresses */
  var SKIP = /^(javascript|data|blob|about|mailto|tel|sms|intent|file|view-source|chrome|moz-extension|ms-appx|vbscript|geo|whatsapp|tg|magnet|slack|zoomus|obsidian):/i;
  function onWire(x) {
    var s = String(x == null ? '' : x);
    return s.indexOf(PFX) !== -1 || s.indexOf('umbra:') === 0;
  }
  function abs(ref) {
    var s = String(ref == null ? '' : ref).trim();
    if (!s || SKIP.test(s)) return null;
    if (s.indexOf('umbra://') === 0) s = 'https://' + s.slice('umbra://'.length);
    /* DIR carries the umbra scheme; a relative ref must come back as a real
       http(s) address, or the origin would be asked to fetch umbra://… */
    const fix = (x) => (x && x.protocol !== 'http:' && x.protocol !== 'https:' ? 'https' + x.href.slice(x.protocol.length - 1) : x && x.href);
    try { return fix(new URL(s, DIR)); } catch (e) { try { return fix(new URL(s)); } catch (e2) { return null; } }
  }
  function b64u(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  /** logical ref -> absolute wire url, minted through this frame's key */
  function wire(ref, mode) {
    if (ref == null) return 'about:blank';
    var raw = String(ref);
    if (onWire(raw)) return raw;
    var u = abs(raw);
    if (!u) return 'about:blank';
    try {
      var seg = new URL(u).pathname.split('/').pop();
      var tail = /^[\w.~-]{1,64}$/.test(seg || '') ? '/' + encodeURIComponent(seg) : '';
      return ORIGIN + PFX + 'p/' + (mode || 's') + '/' + b64u(u) + tail +
        '?k=' + encodeURIComponent(ctx.key) + '&t=' + encodeURIComponent(ctx.tab);
    } catch (e) { return 'about:blank'; }
  }
  function logical(u) {
    var a = abs(u);
    if (!a) return null;
    try {
      var p = new URL(a);
      return 'umbra://' + p.host + (p.pathname === '/' ? '/' : p.pathname) + p.search + p.hash;
    } catch (e) { return null; }
  }
  window.UMBRA = { url: LOGICAL, dir: DIR, tab: ctx.tab, logical: logical, wire: wire, abs: abs, diag: DIAG };

  /* ------------------------------------------ runtime reference hooks */
  var MODE_BY_ATTR = {
    href: 'd', src: 's', action: 'f', formaction: 'f', poster: 'm', cite: 'd', background: 's',
    codebase: 's', ping: 'x', 'data-src': 's', 'data-original': 's', 'data-lazy-src': 's',
    'data-srcset': 's', srcset: 's', imagesrcset: 's', 'xlink:href': 's', icon: 's', mask: 's',
    fill: 's', longdesc: 's', 'aria-details': 's', content: 's',
  };
  var MODE_BY_TAG_ATTR = {
    A: { href: 'd' }, AREA: { href: 'd' }, IFRAME: { src: 'd' }, FRAME: { src: 'd' },
    OBJECT: { data: 's' }, EMBED: { src: 's' },
    VIDEO: { src: 'm' }, AUDIO: { src: 'm' }, SOURCE: { src: 'm' }, TRACK: { src: 's' },
    IMG: { src: 's' }, IMAGE: { href: 's', 'xlink:href': 's' }, SCRIPT: { src: 's' },
    LINK: { href: 's' }, FORM: { action: 'f' }, BUTTON: { formaction: 'f' }, INPUT: { formaction: 'f' },
  };
  function modeFor(el, name) {
    var byTag = el && MODE_BY_TAG_ATTR[String(el.tagName).toUpperCase()];
    if (byTag && byTag[name]) return byTag[name];
    if (name === 'href' && el && /^(A|AREA)$/.test(String(el.tagName))) return 'd';
    return MODE_BY_ATTR[name] || 's';
  }
  var nativeSetAttribute = Element.prototype.setAttribute;

  step('refs', function () {
    function patch(proto, name, forceMode) {
      if (!proto) return;
      var d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.set) return;
      Object.defineProperty(proto, name, {
        configurable: true, enumerable: d.enumerable,
        get: function () { return d.get ? d.get.call(this) : ''; },
        set: function (v) {
          var mode = forceMode || modeFor(this, name);
          var before = typeof v === 'string' && v.indexOf('umbra://') === 0 ? v : null;
          d.set.call(this, wire(v, mode));
          /* keep the logical address beside it so clicks route exactly, even
             for anchors the page built itself */
          if (name === 'href' || name === 'src') {
            var lg = before || logical(v);
            if (lg) { try { nativeSetAttribute.call(this, 'data-umbra', lg); } catch (e) {} }
          }
        },
      });
    }
    patch(HTMLAnchorElement.prototype, 'href');
    patch(HTMLAreaElement.prototype, 'href');
    patch(HTMLIFrameElement.prototype, 'src');
    patch(HTMLFrameElement.prototype, 'src');
    patch(HTMLImageElement.prototype, 'src');
    patch(HTMLScriptElement.prototype, 'src');
    patch(HTMLLinkElement.prototype, 'href');
    patch(HTMLMediaElement.prototype, 'src', 'm');
    patch(HTMLInputElement.prototype, 'src');
    patch(HTMLFormElement.prototype, 'action', 'f');
    patch(HTMLObjectElement.prototype, 'data');
    /* srcdoc hands the parser a whole document: nothing else sees it */
    var sd = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc');
    if (sd && sd.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
        configurable: true, enumerable: sd.enumerable,
        get: function () { return sd.get ? sd.get.call(this) : ''; },
        set: function (v) {
          var fixed = window.__umbraMarkup ? window.__umbraMarkup(v) : v;
          sd.set.call(this, fixed);
          try { var w = this.contentWindow; if (w) { /* shim lands via the adopt step */ } } catch (e) {}
        },
      });
    }
    patch(HTMLQuoteElement.prototype, 'cite');

    Element.prototype.setAttribute = function (name, value) {
      var n = String(name).toLowerCase();
      if (n === 'data-umbra' || n === 'srcset' || n === 'data-srcset') {
        if (n !== 'data-umbra') {
          var fixed = String(value).split(',').map(function (part) {
            var seg = part.trim();
            if (!seg) return '';
            var bits = seg.split(/\s+/);
            bits[0] = wire(bits[0], this.tagName === 'SOURCE' ? 'm' : 's');
            return bits.join(' ');
          }, this).join(', ');
          return nativeSetAttribute.call(this, name, fixed);
        }
        return nativeSetAttribute.call(this, name, value);
      }
      if (MODE_BY_ATTR[n] || (this.tagName === 'SOURCE' && n === 'src')) {
        if (n === 'href') { var lg = logical(value); if (lg) nativeSetAttribute.call(this, 'data-umbra', lg); }
        return nativeSetAttribute.call(this, name, wire(value, modeFor(this, n)));
      }
      return nativeSetAttribute.call(this, name, value);
    };
    /* candidate lists (srcset, imagesrcset) are exposed as IDL properties too, and
       `link.imagesrcset = "https://…  2x"` is exactly how modern pages kick off a
       preload; the browser fetches those without any attribute ever appearing */
    function patchList(proto, name, mode) {
      if (!proto) return;
      var d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.set) return;
      Object.defineProperty(proto, name, {
        configurable: true, enumerable: d.enumerable,
        get: function () { return d.get ? d.get.call(this) : ''; },
        set: function (v) {
          var fixed = String(v == null ? '' : v).replace(/(^|,\s*)([^,\s][^,]*)/g, function (m0, pre, cand) {
            var bits = cand.trim().split(/\s+/);
            if (bits[0] && !onWire(bits[0]) && !SKIP.test(bits[0])) bits[0] = wire(bits[0], mode);
            return pre + bits.join(' ');
          });
          d.set.call(this, fixed);
        },
      });
    }
    patchList(HTMLImageElement.prototype, 'srcset', 's');
    patchList(HTMLSourceElement.prototype, 'srcset', 's');
    patchList(HTMLLinkElement.prototype, 'imagesrcset', 's');
    patchList(HTMLLinkElement.prototype, 'href', 's');

    var ns = Element.prototype.setAttributeNS;
    Element.prototype.setAttributeNS = function (sp, name, value) {
      var n = String(name).toLowerCase();
      if (n === 'href' || n === 'xlink:href') {
        var lg2 = logical(value);
        if (lg2) { try { nativeSetAttribute.call(this, 'data-umbra', lg2); } catch (e) {} }
        return ns.call(this, sp, name, wire(value, 's'));
      }
      return ns.call(this, sp, name, value);
    };
  });

  /* ------------------------------------------------------ networking */
  step('net', function () {
    var of = window.fetch;
    if (of) window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) input = wire(input, 'x');
        else if (input && typeof input.url === 'string') input = new Request(wire(input.url, 'x'), input);
      } catch (e) {}
      return of.call(this, input, init);
    };
    var XO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      var args = [].slice.call(arguments);
      args[1] = wire(u, 'x');
      return XO.apply(this, args);
    };
    if (navigator.sendBeacon) {
      var sb = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (u, d) { return sb(wire(u, 'x'), d); };
    }
    if (window.EventSource) {
      var ES = window.EventSource;
      window.EventSource = function (u, o) { return new ES(wire(u, 'x'), o); };
      window.EventSource.prototype = ES.prototype;
    }
    if (window.WebSocket) {
      var WS = window.WebSocket;
      var wss = ORIGIN.replace(/^http/, 'ws');
      var UmbraSocket = function (u, p) {
        var a = abs(u);
        if (!a) return new WS('ws://127.0.0.1:1/');
        var url = new URL(a);
        return new WS(wss + PFX + 'w/' + b64u(url.href.replace(/^http/, 'ws')) + '/ws?k=' + encodeURIComponent(ctx.key) + '&t=' + encodeURIComponent(ctx.tab), p);
      };
      UmbraSocket.prototype = WS.prototype;
      UmbraSocket.CONNECTING = WS.CONNECTING; UmbraSocket.OPEN = WS.OPEN;
      UmbraSocket.CLOSING = WS.CLOSING; UmbraSocket.CLOSED = WS.CLOSED;
      window.WebSocket = UmbraSocket;
    }
    /* a service worker registered by a proxied site would outlive the tab and
       control this origin: refuse it. Same for WebRTC, which bypasses HTTP. */
    if (navigator.serviceWorker) {
      try {
        navigator.serviceWorker.register = function () {
          post('blocked', { why: 'serviceWorker.register' });
          return Promise.reject(new Error('umbra: service workers are disabled inside a proxied document'));
        };
      } catch (e) {}
    }
    try {
      if (window.RTCPeerConnection) {
        window.RTCPeerConnection = function () { throw new Error('umbra: peer connections are blocked (they bypass the wire)'); };
        window.RTCPeerConnection.prototype = {};
        ['webkitRTCPeerConnection', 'mozRTCPeerConnection'].forEach(function (n) { try { window[n] = window.RTCPeerConnection; } catch (e) {} });
      }
    } catch (e) {}
    try {
      if (window.Worker) {
        var W = window.Worker;
        window.Worker = function (u, o) { return new W(wire(u, 's'), o); };
        window.Worker.prototype = W.prototype;
      }
    } catch (e) {}
  });

  /* ------------------------------------------ history -> umbra tab state */
  step('history', function () {
    var h = window.history;
    var noop = function (state, title, url) {
      if (url == null) return;
      var l = logical(url);
      if (!l) return;
      window.UMBRA.url = l;
      post('nav', { url: l, why: 'pushState', replace: true });
    };
    h.pushState = noop;
    h.replaceState = noop;
    h.back = function (n) { post('history', { delta: -(n || 1) }); };
    h.forward = function (n) { post('history', { delta: n || 1 }); };
    h.go = function (n) { post('history', { delta: n || 0 }); };
  });

  /* ------------------------------------------------------------- clicks */
  function anchorFrom(ev) {
    var el = ev.target;
    while (el && el !== document.documentElement) {
      if (el.tagName === 'A' || el.tagName === 'AREA') return el;
      el = el.parentElement;
    }
    return null;
  }
  /** where a clicked anchor actually wants to go, in trust order */
  function want(a) {
    var lu = a.getAttribute('data-umbra');
    if (lu && String(lu).indexOf('umbra://') === 0) return { url: lu };
    var raw = a.getAttribute('href');
    if (raw && String(raw).indexOf('umbra://') === 0) return { url: String(raw) };
    if (raw && onWire(raw)) return { wire: String(raw) };
    var lg = logical(raw || a.href);
    return lg ? { url: lg } : null;
  }
  step('links', function () {
    document.addEventListener('click', function (ev) {
      if (ev.defaultPrevented || (ev.button != null && ev.button !== 0)) return;
      var a = anchorFrom(ev);
      if (!a) return;
      var raw = a.getAttribute('href');
      if (raw === null || raw === '' ) return;
      if (/^#/i.test(String(raw))) return;
      if (/^(javascript|mailto|tel|sms|data|blob):/i.test(String(raw))) { ev.preventDefault(); return; }
      var w = want(a);
      if (!w) return;
      var newTab = ev.metaKey || ev.ctrlKey || ev.shiftKey || a.hasAttribute('download') ||
        (a.target && a.target !== '_self') || (a.rel && String(a.rel).indexOf('external') !== -1);
      ev.preventDefault();
      ev.stopPropagation();
      w.referrer = LOGICAL;
      post(newTab ? 'open' : 'nav', w);
    }, true);
    document.addEventListener('auxclick', function (ev) {
      if (ev.button !== 1) return;
      var a = anchorFrom(ev);
      if (!a) return;
      var w = want(a);
      if (!w) return;
      ev.preventDefault();
      post('open', w);
    }, true);
  });

  step('forms', function () {
    document.addEventListener('submit', function (ev) {
      var f = ev.target;
      if (!f || !f.tagName || f.tagName !== 'FORM') return;
      var fa = f.getAttribute('action');
      if (fa && fa.indexOf('umbra://') === 0) {
        /* a umbra-native action (the portal search box) resolves through the shell */
        ev.preventDefault();
        try {
          var sp = new URLSearchParams();
          new FormData(f).forEach(function (v, k) { if (typeof v === 'string') sp.append(k, v); });
          var qs = sp.toString();
          post('nav', { url: fa.replace(/\/$/, '') + '/' + (qs ? '?' + qs : '') });
        } catch (e) {}
        return;
      }
      if (!fa || !onWire(fa)) { try { f.setAttribute('action', wire(fa || LOGICAL, 'f')); } catch (e) {} }
      if (String(f.method || 'get').toUpperCase() === 'GET') {
        ev.preventDefault();
        try {
          var u = new URL(abs(f.getAttribute('action') || '') || DIR);
          var sp2 = new URLSearchParams();
          new FormData(f).forEach(function (v, k) { if (typeof v === 'string') sp2.append(k, v); });
          var q = sp2.toString();
          if (q) u.search = q;
          var lg = logical(u.href);
          if (lg) post('nav', { url: lg, why: 'form-get' });
        } catch (e) {}
      }
    }, true);
  });

  /* ------------------------------------------------------- window.open */
  step('popups', function () {
    window.open = function (u, name, feats) {
      var lg = u == null || u === '' ? null : logical(u);
      post('open', { url: lg, referrer: LOGICAL, name: name, features: feats });
      return { closed: false, focus: function () {}, blur: function () {}, close: function () { this.closed = true; }, document: null, location: { href: lg || '' }, opener: null };
    };
    try { window.showModalDialog = function () { return null; }; } catch (e) {}
    try { window.print = function () { post('blocked', { why: 'print' }); }; } catch (e) {}
  });

  /* ------------------------------------------------- location assign/replace */
  step('location', function () {
    var L = window.location;
    var route = function (u) {
      var lg = logical(u);
      if (!lg) return;
      if (!post('nav', { url: lg, why: 'location' })) { try { L.assign(u); } catch (e) {} }
    };
    try { L.assign = function (u) { route(u); }; } catch (e) {}
    try { L.replace = function (u) { route(u); }; } catch (e) {}
    /* `location.href = x` cannot be intercepted (Location is [Unforgeable]), so
       the shell watches the frame's load event and reverts anything off-wire. */
  });

  /* ------------------------------------------------------ meta refresh */
  step('refresh', function () {
    var metas = document.querySelectorAll('meta[data-umbra-target]');
    Array.prototype.forEach.call(metas, function (m) {
      var t = m.getAttribute('data-umbra-target');
      if (!t) return;
      var delay = parseInt(m.getAttribute('data-umbra-delay') || '0', 10);
      setTimeout(function () {
        post('redirect', { url: logical(t), status: 'meta-refresh', from: LOGICAL, holdHere: 1 });
      }, Math.max(0, delay) * 1000);
    });
  });

  /* ------------------------------------------------ ephemeral storage cloak */
  step('storage', function () {
    if (!ctx.ephemeral) return;
    ['localStorage', 'sessionStorage'].forEach(function (name) {
      var mem = {};
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () {
          return {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
            setItem: function (k, v) { mem[k] = String(v); },
            removeItem: function (k) { delete mem[k]; },
            clear: function () { mem = {}; },
            key: function (i) { var ks = Object.keys(mem); return ks[i] === undefined ? null : ks[i]; },
            get length() { return Object.keys(mem).length; },
          };
        },
      });
    });
    /* IndexedDB on the shell origin would persist past the tab: neutered. */
    try {
      if (window.indexedDB) {
        window.indexedDB = {
          open: function () { var rq = { onerror: null, onsuccess: null, onupgradeneeded: null, result: null, addEventListener: function () {} }; setTimeout(function () { if (rq.onerror) rq.onerror({ target: rq }); }, 0); return rq; },
          deleteDatabase: function () { return { onerror: null, onsuccess: null }; },
          cmp: function (a, b) { return a === b ? 0 : (a > b ? 1 : -1); },
        };
      }
    } catch (e) {}
    try { if (window.Cache) window.caches = undefined; } catch (e) {}
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist = function () { return Promise.resolve(false); }; } catch (e) {}
  });

  /* ------------------------------------------------ nested frame hygiene */
  step('mutation', function () {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (!n || !n.tagName) return;
          if (/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(n.tagName)) {
            var s = n.getAttribute('src') || n.getAttribute('data');
            if (s && !onWire(s)) n.setAttribute('src', wire(s, 'd'));
            n.setAttribute('data-umbra-frame', '1');
            if (/^(IFRAME|FRAME)$/.test(n.tagName)) ADOPT.adoptNode(n);
          }
          if (n.tagName === 'FORM') {
            var a = n.getAttribute('action');
            if (a && !onWire(a) && a.indexOf('umbra://') !== 0) n.setAttribute('action', wire(a, 'f'));
          }
          if (n.tagName === 'SCRIPT') {
            var sc = n.getAttribute('src');
            if (sc && /^https?:/i.test(sc) && sc.indexOf(ORIGIN) !== 0) n.setAttribute('src', wire(sc, 's'));
          }
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  });

  /* --------------------------------------------------- markup insertion
       document.write / innerHTML / insertAdjacentHTML hand the HTML parser a
       string. Any absolute reference in it is fetched by the parser itself,
       before any element or attribute hook of ours could run, so the markup
       has to be pulled onto the wire here. */
  step('write', function () {
    var ATTR_RE = /\b(src|href|xlink:href|poster|srcset|data-srcset|imagesrcset|data-src|data-original|data-lazy-src|action|formaction|background|cite|longdesc)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
    var SRCSET_LIKE = /^(srcset|data-srcset|imagesrcset)$/i;
    var CSS_RE = /url\(\s*(['"]?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi;
    function modeAt(html, index, name) {
      var lt = html.lastIndexOf('<', index);
      var tag = lt >= 0 ? ((html.slice(lt + 1, lt + 24).match(/^[\w:-]+/) || [''])[0]) : '';
      return modeFor({ tagName: (tag || 'div').toUpperCase() }, name);
    }
    function mw(html) {
      html = String(html == null ? '' : html);
      if (!/https?:\/\/|url\s*\(|srcdoc/i.test(html)) return html;
      /* an srcdoc attribute embeds a whole document, entity-encoded */
      html = html.replace(/\bsrcdoc\s*=\s*("([^"]*)"|'([^']*)')/gi, function (w0, _q, dq, sq) {
        var v = dq !== undefined ? dq : sq;
        if (!v) return w0;
        var dec = v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        if (!/https?:\/\//i.test(dec)) return w0;
        var enc = mw(dec).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        return w0.slice(0, w0.indexOf('=')) + '="' + enc + '"';
      });
      var out = html.replace(ATTR_RE, function (m0, nameRaw, quoted, dq, sq, bare, off) {
        var name = String(nameRaw).toLowerCase();
        var value = dq !== undefined ? dq : (sq !== undefined ? sq : bare);
        var q = dq !== undefined ? '"' : (sq !== undefined ? "'" : '');
        if (!value || onWire(value)) return m0;
        if (SKIP.test(value.trim())) return m0;
        if (SRCSET_LIKE.test(name)) {
          var fixed = value.replace(/([^,\s]+(?:\s+[\d.]+[wx])?)/g, function (part) {
            var bits = part.trim().split(/\s+/);
            if (bits[0] && !onWire(bits[0]) && !SKIP.test(bits[0])) bits[0] = wire(bits[0], modeAt(html, off, name));
            return bits.join(' ');
          });
          return name + '=' + q + fixed + q;
        }
        return name + '=' + q + wire(value, modeAt(html, off, name)) + q;
      });
      out = out.replace(CSS_RE, function (c0, q1, u) {
        if (onWire(u)) return c0;
        var w = wire(u, 's');
        return w === 'about:blank' ? 'none' : 'url(' + q1 + w + q1 + ')';
      });
      return out;
    }
    window.__umbraMarkup = mw;

    ['write', 'writeln'].forEach(function (fn) {
      var ow = document[fn];
      if (!ow) return;
      document[fn] = function () {
        var args = [].slice.call(arguments).map(mw);
        return ow.apply(document, args);
      };
    });
    if (document.write && document.write._rewrites) { /* patched elsewhere */ }

    var dsc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (dsc && dsc.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true, enumerable: dsc.enumerable,
        get: dsc.get,
        set: function (v) { dsc.set.call(this, mw(v)); },
      });
    }
    var osc = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
    if (osc && osc.set) {
      Object.defineProperty(Element.prototype, 'outerHTML', {
        configurable: true, enumerable: osc.enumerable,
        get: osc.get,
        set: function (v) { osc.set.call(this, mw(v)); },
      });
    }
    var iaj = Element.prototype.insertAdjacentHTML;
    if (iaj) {
      Element.prototype.insertAdjacentHTML = function (pos, html) { return iaj.call(this, pos, mw(html)); };
    }
    var caf = Element.prototype.createContextualFragment;
    if (caf && window.Range) {
      Range.prototype.createContextualFragment = function (html) { return caf.call(this, mw(html)); };
    }
    var dp = window.DOMParser && DOMParser.prototype.parseFromString;
    if (dp) {
      DOMParser.prototype.parseFromString = function (t, type) { return dp.call(this, type === 'text/html' || type === 'application/xhtml+xml' ? mw(t) : t, type); };
    }
  });

  /* ------------------------------- cssom: el.style.x = 'url(http://…)' is a
       fetch the page can trigger without touching any attribute, so the style
       object itself has to sit on the wire. */
  step('cssom', function () {
    var STYLE_PROPS = ['backgroundImage', 'content', 'listStyleImage', 'maskImage', 'mask',
      'borderImage', 'borderImageSource', 'cursor', 'fill', 'stroke'];
    function fix(v) {
      v = String(v == null ? '' : v);
      if (v.indexOf('url(') === -1) return v;
      return v.replace(/url\(\s*(['"]?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi, function (m0, q1, u) {
        var w = wire(u, 's');
        return w === 'about:blank' ? 'none' : 'url(' + q1 + w + q1 + ')';
      });
    }
    var proto = window.CSSStyleDeclaration && CSSStyleDeclaration.prototype;
    if (!proto) return;
    var setP = proto.setProperty;
    if (setP) {
      proto.setProperty = function (name, value, prio) {
        return setP.call(this, name, /url\s*\(/i.test(String(value)) ? fix(value) : value, prio);
      };
    }
    STYLE_PROPS.forEach(function (p2) {
      var d = Object.getOwnPropertyDescriptor(proto, p2);
      if (!d || !d.set) return;
      Object.defineProperty(proto, p2, {
        configurable: true, enumerable: d.enumerable,
        get: function () { return d.get.call(this); },
        set: function (v) { d.set.call(this, fix(v)); },
      });
    });
  });

  /* ------------------------------------- inline style guard (defence in depth) */
  step('styleguard', function () {
    var scan = function (root) {
      var els = (root || document).querySelectorAll('[style]');
      Array.prototype.forEach.call(els, function (el) {
        var v = el.getAttribute('style');
        if (!v || v.indexOf('/~umbra/') !== -1 || v.indexOf('http') === -1) return;
        var fixed = v.replace(/url\(\s*(['"]?)(https?:\/\/[^)'"]+)\1\s*\)/gi, function (m0, q1, u) {
          return 'url(' + q1 + wire(u, 's') + q1 + ')';
        });
        if (fixed !== v) { try { nativeSetAttribute.call(el, 'style', fixed); } catch (e) {} }
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { scan(document); }, { once: true });
    else scan(document);
    try {
      new MutationObserver(function (muts) {
        muts.forEach(function (m) { if (m.type === 'attributes' && m.target.getAttribute && m.target.getAttribute('style')) scan(m.target.parentNode || document); });
      }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['style'] });
    } catch (e) {}
  });

  /* ------------------------------------------- adopting nested live frames
       A page can build an iframe and document.write() markup into it — even
       while the frame is still detached. That child has its own, unpatched
       realm, so a <link rel=preload> written there is fetched by the browser
       as-is, straight to the destination host. Every same-origin frame we own
       therefore gets both the shim (for its logical state) and a direct patch
       of its realm prototypes (which survives doc.open() wiping our nodes). */
  var CSP_CHILD = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; "
    + "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
    + "font-src 'self' data:; connect-src 'self' ws: wss: blob: data:; frame-src 'self' blob:; "
    + "child-src 'self' blob:; form-action 'self'; base-uri 'self'; report-uri /~umbra/csp-report";
  step('adopt', function () {
    /* A parent that already adopted us hands the source down, so a page with
       twenty hidden frames pays for one fetch, not twenty blocking ones. */
    var SRC = '';
    if (window.__UMBRA_SRC_CACHE) SRC = window.__UMBRA_SRC_CACHE;
    else if (window.parent !== window) { try { SRC = window.parent.__UMBRA_SRC_CACHE || ''; } catch (e) { SRC = ''; } }
    if (!SRC) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', ORIGIN + PFX + 'shim.js', false);
        x.send();
        if (x.status === 200) { SRC = x.responseText; window.__UMBRA_SRC_CACHE = SRC; }
      } catch (e) { SRC = ''; }
    }

    function mwOf(win) {
      /* reuse the parent's markup rewriter; it only needs wire()/onWire/SKIP */
      return window.__umbraMarkup;
    }

    function patchRealm(win) {
      if (!win || win.__UMBRA_REALM__) return false;
      var doc = win.document;
      if (!doc) return false;
      var mw = mwOf(win);
      if (!mw) return false;
      win.__UMBRA_REALM__ = 1;
      var Dproto = Object.getPrototypeOf(doc);
      var CLOAK = '<meta http-equiv="Content-Security-Policy" content="' + CSP_CHILD + '">';
      ['write', 'writeln'].forEach(function (fn) {
        var orig = Dproto[fn];
        if (typeof orig !== 'function') return;
        Dproto[fn] = function () {
          try {
            var a = arguments;
            var args = new Array(a.length);
            for (var i = 0; i < a.length; i++) args[i] = mw(a[i]);
            /* A document written into a child frame we do not control loses the
               inherited policy in some engines, so hand it one explicitly: the
               first thing it parses is a rule that forbids leaving the wire. */
            if (args.length && typeof args[0] === 'string' && /<link|<img|<script|srcdoc|url\s*\(/i.test(args[0]) &&
                args[0].toLowerCase().indexOf('content-security-policy') === -1) {
              args[0] = CLOAK + args[0];
            }
            return orig.apply(this, args);
          } catch (e) { return orig.apply(this, arguments); }
        };
      });
      var I = win.HTMLIFrameElement && win.HTMLIFrameElement.prototype;
      if (I) {
        var sd2 = Object.getOwnPropertyDescriptor(I, 'srcdoc');
        if (sd2 && sd2.set) {
          Object.defineProperty(I, 'srcdoc', {
            configurable: true, enumerable: sd2.enumerable,
            get: function () { return sd2.get ? sd2.get.call(this) : ''; },
            set: function (v) { sd2.set.call(this, mw(v)); },
          });
        }
      }
      var E = win.Element && win.Element.prototype;
      if (E) {
        ['innerHTML', 'outerHTML'].forEach(function (name) {
          var d = Object.getOwnPropertyDescriptor(E, name);
          if (!d || !d.set) return;
          Object.defineProperty(E, name, {
            configurable: true, enumerable: d.enumerable,
            get: d.get,
            set: function (v) { d.set.call(this, mw(v)); },
          });
        });
        var iaj = E.insertAdjacentHTML;
        if (iaj) E.insertAdjacentHTML = function (pos, html) { return iaj.call(this, pos, mw(html)); };
        var sa = E.setAttribute;
        if (sa) {
          E.setAttribute = function (name, value) {
            var n = String(name).toLowerCase();
            if (/^(src|href|poster|srcset|data-src|imagesrcset|action|formaction|background|cite)$/.test(n)) {
              return sa.call(this, name, wire(value, modeFor(this, n)));
            }
            return sa.call(this, name, value);
          };
        }
      }
      /* the reference-bearing IDL properties, patched in the child realm */
      var setters = [
        [win.HTMLAnchorElement, 'href', 'd'], [win.HTMLAreaElement, 'href', 'd'],
        [win.HTMLImageElement, 'src', 's'], [win.HTMLScriptElement, 'src', 's'],
        [win.HTMLIFrameElement, 'src', 'd'], [win.HTMLLinkElement, 'href', 's'],
        [win.HTMLMediaElement, 'src', 'm'], [win.HTMLFormElement, 'action', 'f'],
      ];
      setters.forEach(function (t) {
        var proto = t[0] && t[0].prototype;
        if (!proto) return;
        var d = Object.getOwnPropertyDescriptor(proto, t[1]);
        if (!d || !d.set) return;
        try {
          Object.defineProperty(proto, t[1], {
            configurable: true, enumerable: d.enumerable,
            get: function () { return d.get ? d.get.call(this) : ''; },
            set: function (v) { d.set.call(this, wire(v, t[2])); },
          });
        } catch (e) {}
      });
      return true;
    }

    function injectShimInto(win) {
      try {
        var d = win.document;
        if (!d || !d.documentElement || win.__UMBRA_SHIM__ || win.__UMBRA_INJECTED__ || !SRC) return;
        win.__UMBRA_INJECTED__ = 1;
        if (!d.getElementById('umbra-ctx')) {
          var c = d.createElement('script');
          c.id = 'umbra-ctx';
          c.type = 'application/json';
          c.textContent = ctxEl.textContent;
          d.documentElement.appendChild(c);
        }
        try { win.__UMBRA_SRC_CACHE = SRC; } catch (e0) {}
        var sc = d.createElement('script');
        sc.textContent = SRC;
        d.documentElement.appendChild(sc);
      } catch (e) {}
    }

    function adopt(win) {
      if (!win || win === window) return false;
      try { void win.document.location.href; } catch (e) { return false; } /* cross-origin: nothing we can do from here */
      var patched = patchRealm(win);
      injectShimInto(win);
      return patched;
    }

    var pending = [];
    function adoptNode(el) {
      if (!el) return;
      var w = null;
      try { w = el.__umbraWin || (el.__umbraWin = winGetter.call(el)); } catch (e) { w = null; }
      if (adopt(w)) return;
      if (pending.indexOf(el) === -1 && pending.length < 64) pending.push(el);
    }
    function eachFrame(node, fn) {
      if (!node || node.nodeType !== 1) return;
      if (/^(IFRAME|FRAME)$/.test(node.tagName)) fn(node);
      if (node.querySelectorAll) {
        var inner = node.querySelectorAll('iframe, frame');
        for (var i = 0; i < inner.length; i++) fn(inner[i]);
      }
    }
    /* a detached frame is adoptable the moment it exists — its document.write
       already runs a parser that will fetch whatever it is handed */
    var ce = Document.prototype.createElement;
    Document.prototype.createElement = function (tag, opts) {
      var el = ce.apply(this, arguments);
      try {
        if (el && /^(IFRAME|FRAME)$/.test(String(tag).toUpperCase())) {
          el.addEventListener('load', function () { adoptNode(el); });
          adoptNode(el);
        }
      } catch (e) {}
      return el;
    };
    /* Only the inserted node itself is checked synchronously — a subtree scan on
       every append turns a busy page quadratic. Markup inserted through
       innerHTML/write is handled by the batched observer below instead, which is
       early enough because those parsers have not fetched yet at flush time. */
    function quick(node) {
      if (node && node.nodeType === 1 && /^(IFRAME|FRAME)$/.test(node.tagName)) adoptNode(node);
    }
    ['appendChild', 'insertBefore', 'replaceChild'].forEach(function (fn) {
      var orig = Node.prototype[fn];
      if (!orig) return;
      Node.prototype[fn] = function () {
        var r = orig.apply(this, arguments);
        try { for (var i = 0; i < arguments.length; i++) quick(arguments[i]); } catch (e) {}
        return r;
      };
    });
    ['append', 'prepend', 'before', 'after', 'replaceWith'].forEach(function (fn) {
      var orig = Element.prototype[fn];
      if (!orig) return;
      Element.prototype[fn] = function () {
        var r = orig.apply(this, arguments);
        try { for (var i = 0; i < arguments.length; i++) quick(arguments[i]); } catch (e) {}
        return r;
      };
    });
    var winGetter = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get;
    ['contentDocument', 'contentWindow'].forEach(function (prop) {
      var proto = HTMLIFrameElement.prototype;
      var d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.get) return;
      try {
        Object.defineProperty(proto, prop, {
          configurable: true, enumerable: d.enumerable,
          /* pages reach a hidden frame through either accessor, and the write
             that follows is synchronous: the realm has to be patched here, on
             first touch, not from an observer microtask afterwards */
          get: function () {
            var v = d.get.call(this);
            /* read the window through the *native* getter: calling this.contentWindow
               here would re-enter this same function */
            try {
              var w = this.__umbraWin || (this.__umbraWin = winGetter.call(this));
              if (w) { patchRealm(w); injectShimInto(w); }
            } catch (e2) {}
            return v;
          },
          set: d.set,
        });
      } catch (e) {}
    });
    ADOPT.adoptNode = adoptNode;
    /* bounded backstop, not a heartbeat: it stops once the page settles */
    var ticks = 0;
    var sweep = setInterval(function () {
      try {
        while (pending.length) { var el2 = pending.shift(); if (el2) adoptNode(el2); }
        if (++ticks > 60 || document.hidden && ticks > 20) return clearInterval(sweep);
        if ((document.__umbraFrameCount || 0) !== (document.querySelectorAll('iframe, frame').length)) {
          document.__umbraFrameCount = document.querySelectorAll('iframe, frame').length;
          var fs = document.querySelectorAll('iframe, frame');
          for (var i = 0; i < fs.length; i++) adoptNode(fs[i]);
        }
      } catch (e) { clearInterval(sweep); }
    }, 250);
  });

  /* ------------------------------------------------------ title + uplink */
  step('title', function () {
    var tEl = document.querySelector('title');
    var last = '';
    var emit = function () {
      var t = ((tEl && tEl.textContent) || '').trim();
      if (t && t !== last) { last = t; post('title', { title: t.slice(0, 120) }); }
    };
    if (tEl) {
      try { new MutationObserver(emit).observe(tEl, { childList: true, characterData: true, subtree: true }); } catch (e) {}
    }
    emit();
    post('title', { title: (document.title || '').trim() });
  });

  addEventListener('load', function () { post('ready', { url: LOGICAL }); }, { once: true });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { post('ready', { url: LOGICAL }); }, { once: true });
  }

  /* panic chord from inside a proxied page: press the backtick twice */
  var pk = 0;
  addEventListener('keydown', function (e) {
    if (e.key !== '`' && e.key !== '~') return;
    pk++;
    clearTimeout(window.__umbraPk);
    window.__umbraPk = setTimeout(function () { pk = 0; }, 700);
    if (pk >= 2) { pk = 0; post('panic', {}); }
  }, true);

  DIAG.ready = true;
  post('ready', { url: LOGICAL, diag: DIAG.done.length });
})();
