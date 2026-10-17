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
      say('challenge ok · program ' + String(challenge.program || '').length + ' chars · vm ' + challenge.globalName);

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

      /* The flow is driven by hand rather than through PoToken.generate for
         two reasons, both learned the hard way from "PMD:Undefined" — which
         is bgutils' way of saying the VM finished without leaving a minter
         behind:
         
         1. BotGuard wants an element to watch. The convenience wrapper never
            passes one, and a program that cannot observe interaction has no
            reason to hand over its signals.
         2. The signal array is filled by a VM callback, not by the snapshot's
            return value. Reading it on the very next line is a race the
            browser loses more often than node does, so wait for it. */
      const el = document.getElementById('mint-stage');
      say('taking the botguard snapshot…');
      const webPoSignalOutput = [];
      const botguard = await BG.BotGuardClient.create({
        program: challenge.program,
        globalName: challenge.globalName,
        globalObj: window,
        userInteractionElement: el,
      });
      const snap = await botguard.snapshot({ webPoSignalOutput });
      say('snapshot ok · ' + String(snap || '').length + ' chars');

      for (let i = 0; i < 40 && !webPoSignalOutput[0]; i++) {
        await new Promise(function (r) { setTimeout(r, 50); });
      }
      say('signals: ' + webPoSignalOutput.length +
        (webPoSignalOutput[0] ? ' (minter present)' : ' (no minter yet)'));

      say('exchanging the snapshot for an integrity token…');
      const itRes = await relayFetch(
        'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
          method: 'POST',
          headers: { 'content-type': 'application/json+protobuf' },
          body: JSON.stringify([bgConfig.requestKey, snap]),
        });
      const itJson = await itRes.json();
      if (!itJson) throw new Error('the attestation rpc answered with nothing');

      const integrityToken = itJson[0];
      const fallback = itJson[3];
      let tok = '';
      let kind = '';

      if (integrityToken && webPoSignalOutput[0]) {
        /* The good path: a real integrity token and a VM that left its
           minter behind. The token is minted locally, bound to our identity. */
        say('integrity token ok · ' + String(integrityToken).length + ' chars');
        const minter = await BG.WebPoMinter.create({
          integrityToken: integrityToken,
          estimatedTtlSecs: itJson[1],
          mintRefreshThreshold: itJson[2],
          websafeFallbackToken: fallback,
        }, webPoSignalOutput);
        tok = await minter.mintAsWebsafeString(who.visitorData);
        kind = 'minted';
      } else if (fallback && String(fallback).length >= 32) {
        /* Google answered, but declined to issue an integrity token and sent
           a websafe fallback instead. That is not a failure to report as one:
           the fallback is the token Google itself nominated for a client it
           is not fully convinced by, it carries the ttl it just quoted us,
           and YouTube accepts it for playback at a reduced trust level. The
           honest description is "degraded", not "broken" - so take it, label
           it, and let the ladder find out what it is worth. */
        say('google declined a full token and issued a fallback instead '
          + '(' + String(fallback).length + ' chars, ttl ' + (itJson[1] || '?') + 's)');
        say('that is a real token at a lower trust level — taking it.');
        tok = String(fallback);
        kind = 'fallback';
      } else {
        throw new Error('no integrity token and no fallback: ' + JSON.stringify(itJson).slice(0, 120));
      }

      if (!tok || String(tok).length < 32) throw new Error('botguard returned nothing usable');

      say('minted ' + String(tok).length + ' characters. handing it to umbra…');
      const saved = await (await fetch('/~umbra/pot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visitorData: who.visitorData, poToken: String(tok), kind: kind }),
      })).json();
      if (!saved.ok) throw new Error(saved.error || 'umbra refused the token');
      say('done — the server will use this for extraction until it expires.', 'ok');
      if (kind === 'fallback') {
        say('because this is a fallback token, extraction may still be gated. '
          + 'if it is, the failure is google\u2019s trust in this address, not the plumbing.', '');
      }
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
