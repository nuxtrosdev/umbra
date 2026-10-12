/*
 * UMBRA TOKEN MINT -- borrowing the one legitimate client in the building.
 *
 * Every server-side attempt to mint a proof-of-origin token fails for the
 * same reason: BotGuard does not check who you say you are, it checks the
 * runtime it is running in. jsdom is not a browser, so the challenge is
 * refused or the VM never starts, and no amount of user-agent spoofing
 * changes that. Meanwhile a real browser is sitting right here, already
 * trusted by Google, already rendering this page.
 *
 * So the work is split along the line each side can actually serve:
 *
 *   the browser   runs BotGuard's interpreter, which is the part that needs
 *                 a genuine JS engine, DOM and timing;
 *   the server    carries the two HTTP calls (the attestation RPC is not
 *                 reachable cross-origin from this page) and keeps the
 *                 resulting token for its own extraction.
 *
 * The token is bound to a visitor identity, not to a session cookie, so the
 * one minted here is exactly the one the server-side ladder needs - which is
 * why the server hands us *its* visitorData to mint against rather than
 * letting the page invent one.
 */
(function () {
  var out = document.getElementById('mint-out');
  var btn = document.getElementById('mint-go');
  function say(s, cls) {
    var p = document.createElement('p');
    if (cls) p.className = cls;
    p.textContent = s;
    out.appendChild(p);
    out.scrollTop = out.scrollHeight;
  }

  /* Google's endpoints are not reachable from this origin: no CORS for us,
     and connect-src is 'self' by design. Relay them through the wire the
     same way every other proxied request travels. */
  function relayFetch(url, init) {
    return fetch('/~umbra/bgrelay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: String(url),
        method: (init && init.method) || 'GET',
        body: init && init.body ? String(init.body) : null,
        headers: (init && init.headers) || {},
      }),
    }).then(function (r) {
      return r.json().then(function (j) {
        /* hand bgutils something shaped like a Response */
        return {
          ok: j.status >= 200 && j.status < 300,
          status: j.status,
          text: function () { return Promise.resolve(j.body || ''); },
          json: function () { return Promise.resolve(JSON.parse(j.body || 'null')); },
        };
      });
    });
  }

  async function mint() {
    btn.disabled = true;
    out.innerHTML = '';
    try {
      say('asking umbra which visitor identity to mint for…');
      const who = await (await fetch('/~umbra/potid')).json();
      if (!who.visitorData) throw new Error('the server has no visitor identity yet');
      say('identity ' + who.visitorData.slice(0, 14) + '… (' + (who.source || 'unknown') + ')');

      if (!window.BGUtils || !window.BGUtils.BG) {
        throw new Error('bgutils-js is not installed on the server: run "npm i bgutils-js"');
      }
      const BG = window.BGUtils.BG;
      const bgConfig = {
        fetch: relayFetch,
        globalObj: window,
        requestKey: 'O43z0dpjhgX20SCx4KAo',
        identifier: who.visitorData,
      };

      say('fetching the botguard challenge…');
      const challenge = await BG.Challenge.create(bgConfig);
      if (!challenge) throw new Error('no challenge came back');

      /* bgutils does not run the interpreter for you: the challenge carries
         its source and the caller is expected to execute it, which is what
         defines the VM the next step looks for. */
      if (!window[challenge.globalName]) {
        const src = challenge.interpreterJavascript &&
          (challenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue ||
           challenge.interpreterJavascript.private_do_not_access_or_else_safe_script_wrapped_value);
        if (!src) throw new Error('the challenge carried no interpreter');
        say('running botguard in this browser…');
        new Function(String(src))();
      }
      if (!window[challenge.globalName]) throw new Error('the interpreter defined no vm');

      say('generating the token…');
      const token = await BG.PoToken.generate({
        program: challenge.program,
        globalName: challenge.globalName,
        bgConfig: bgConfig,
      });
      const tok = (token && (token.poToken || token)) || '';
      if (!tok || String(tok).length < 32) throw new Error('botguard returned nothing usable');

      say('minted ' + String(tok).length + ' characters. handing it to umbra…');
      const saved = await (await fetch('/~umbra/pot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visitorData: who.visitorData, poToken: String(tok) }),
      })).json();
      if (!saved.ok) throw new Error(saved.error || 'umbra refused the token');
      say('done — the server will use this for extraction until it expires.', 'ok');
      say('try a video that failed a moment ago.', 'ok');
    } catch (e) {
      say('failed: ' + (e && e.message ? e.message : String(e)), 'bad');
      say('this is the hard part, and it can fail for honest reasons: google may refuse the '
        + 'challenge to this address even though your browser ran it.', '');
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', mint);
})();
