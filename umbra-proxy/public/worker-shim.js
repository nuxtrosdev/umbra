/**
 * The shim, again, for the inside of a Worker.
 *
 * public/shim.js rewrites the *script URL* passed to `new Worker(...)`, so the
 * worker's code is fetched through the wire. That is where the protection
 * stopped. A worker runs in its own global scope, and nothing in that scope
 * was patched — so the moment the worker called fetch, XMLHttpRequest,
 * importScripts or WebSocket, the request left the browser for the real
 * network, with the user's own address and cookies, while the page that
 * spawned it was still fully proxied.
 *
 * The page could not fix this from outside: there is no way to reach into a
 * worker's globals after it starts. The worker has to install the patches
 * itself, before any of the real code runs. So Worker creation now points at
 * a tiny generated bootstrap that pulls in this file, configures it, and only
 * then imports the real script.
 *
 * Everything here mirrors shim.js deliberately. The wire format must agree
 * exactly between the two or the server will reject what the worker sends,
 * and a second, subtly different implementation of the URL codec is how that
 * kind of bug gets in.
 */
/* eslint-env worker */
(function () {
  'use strict';
  if (typeof self === 'undefined' || self.__umbraWorkerInit) return;

  var CFG = null;
  /* Anything that is already a wire url, or is not a network reference at
     all, must be left exactly as it is — rewriting twice is as broken as not
     rewriting at all. */
  var SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i;

  function b64u(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function onWire(u) {
    return typeof u === 'string' && u.indexOf(CFG.origin + CFG.pfx) === 0;
  }

  /* Relative references inside a worker resolve against the worker's own
     script url, which is now a blob: or a wire url — neither of which is
     where the code thinks it lives. CFG.base is the *logical* location (the
     real upstream url of the script), so relative refs resolve the way the
     original author intended. */
  function abs(ref) {
    var s = String(ref == null ? '' : ref).trim();
    if (!s || SKIP.test(s)) return null;
    if (s.indexOf('umbra://') === 0) s = 'https://' + s.slice('umbra://'.length);
    try { return new URL(s, CFG.base).href; } catch (e) {
      try { return new URL(s).href; } catch (e2) { return null; }
    }
  }

  function wire(ref, mode) {
    if (ref == null) return 'about:blank';
    var raw = String(ref);
    if (onWire(raw)) return raw;
    if (SKIP.test(raw)) return raw;
    var u = abs(raw);
    if (!u) return 'about:blank';
    try {
      var seg = new URL(u).pathname.split('/').pop();
      var tail = /^[\w.~-]{1,64}$/.test(seg || '') ? '/' + encodeURIComponent(seg) : '';
      return CFG.origin + CFG.pfx + 'p/' + (mode || 's') + '/' + b64u(u) + tail +
        '?k=' + encodeURIComponent(CFG.key) + '&t=' + encodeURIComponent(CFG.tab) +
        (CFG.sid ? '&sid=' + encodeURIComponent(CFG.sid) : '');
    } catch (e) { return 'about:blank'; }
  }

  self.__umbraWorkerWire = wire;

  self.__umbraWorkerInit = function (cfg) {
    CFG = cfg || {};
    CFG.pfx = CFG.pfx || '/~umbra/';
    CFG.origin = CFG.origin || '';
    CFG.base = CFG.base || CFG.origin;

    /* importScripts is the one that matters most here: it is how a worker
       loads more code, it is synchronous, and it takes any number of urls. */
    var oi = self.importScripts;
    if (oi) {
      self.importScripts = function () {
        var args = [].slice.call(arguments).map(function (u) { return wire(u, 's'); });
        return oi.apply(self, args);
      };
    }

    var of = self.fetch;
    if (of) {
      self.fetch = function (input, init) {
        try {
          if (typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL)) {
            input = wire(input, 'x');
          } else if (input && typeof input.url === 'string') {
            input = new Request(wire(input.url, 'x'), input);
          }
        } catch (e) { /* fall through with the original */ }
        return of.call(self, input, init);
      };
    }

    if (self.XMLHttpRequest) {
      var XO = self.XMLHttpRequest.prototype.open;
      self.XMLHttpRequest.prototype.open = function (m, u) {
        var args = [].slice.call(arguments);
        args[1] = wire(u, 'x');
        return XO.apply(this, args);
      };
    }

    if (self.WebSocket) {
      var WS = self.WebSocket;
      var wss = String(CFG.origin).replace(/^http/, 'ws');
      var S = function (u, p) {
        var a = abs(u);
        if (!a) return new WS('ws://127.0.0.1:1/');
        return new WS(wss + CFG.pfx + 'w/' + b64u(a.replace(/^http/, 'ws')) + '/ws?k='
          + encodeURIComponent(CFG.key) + '&t=' + encodeURIComponent(CFG.tab)
          + (CFG.sid ? '&sid=' + encodeURIComponent(CFG.sid) : ''), p);
      };
      S.prototype = WS.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { S[k] = WS[k]; });
      self.WebSocket = S;
    }

    /* A nested worker would escape by the same route this file exists to
       close, and it has no bootstrap of its own, so refuse it rather than
       leave a hole one level down. */
    if (self.Worker) {
      self.Worker = function () {
        throw new Error('umbra: nested workers are not proxied');
      };
    }
  };
}());
