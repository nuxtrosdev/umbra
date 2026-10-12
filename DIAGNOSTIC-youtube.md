# YouTube playback — diagnostic report

No code was changed to produce this. Every claim is labelled:

* **CONFIRMED** — read in the code or executed here.
* **PROBABLE** — strong code or log evidence, one experiment away from certain.
* **UNKNOWN** — cannot be settled from here.

**Honesty note on method.** This sandbox has *no network egress at all*
(`curl https://www.youtube.com` → `000`, same for google.com and example.com;
`yt-dlp` is not installed here). So no live upstream evidence was gathered in
this session. Live evidence comes from your probe run of 2026‑10‑12T19:30:59Z,
which is quoted where used. Everything else is code-reading of the actual call
chains.

---

## 1. Architecture map (from the code, not the docs)

### Request entry

| Path | Handler | What it does |
|---|---|---|
| `/~umbra/d/<tok>` | `index.mjs serve()` | fetch upstream, rewrite HTML (`html.mjs`), inject `shim.js`, apply `CSP_DOC` |
| `/~umbra/s`,`x`,`m`,`r` | same `serve()` | subresource / XHR / media / raw |
| `/~umbra/c/<tok>` | capsule | Umbra-authored docs incl. the player |
| `https://tube.umbra/*` | `tube.mjs` + `api-youtube.mjs` | Umbra's own YouTube front end |
| `/api/piped/*` | `piped-local.mjs` | a Piped-compatible API served by Umbra |

### Extraction stack

```
provider-manager.failover('streams')
  └─ registry order: innertube → watchpage → piped → invidious
                     → poketube → newpipe → youtubejs → ytdlp
       innertube  ─┐
       piped(LOCAL)─┴─► piped-local.streams()  ─► innertube.playerRequest()
                                                   over LADDER =
                                                   tv,ios,visionos,web_embedded,
                                                   tv_downgraded,android,web_safari,
                                                   mweb,web_music,android_vr,web
       watchpage  ───► watchpage.mjs  (HTML scrape of /watch then /embed,
                                       then ytcfg → web_embedded player call)
       piped(public)/invidious/poketube/newpipe ─► third-party HTTP instances
       youtubejs ───► YouTube.js library            ytdlp ─► yt-dlp subprocess
```

**CONFIRMED and important:** `providers/innertube.mjs` is a *wrapper around
`piped-local.mjs`*, and `piped.mjs`'s instance list begins with `LOCAL =
'local'`, which is also `piped-local.mjs` in-process. So the probe rows
`innertube` and `piped` are **the same extraction engine called twice**, not two
independent backends. Only the *public* Piped instances, Invidious, PokeTube and
NewPipe leave this machine's address.

### Media path

`piped-local` → `href(ctx, f.url, 'm', {v,i})` → browser requests
`/~umbra/m/<tok>` → `serve()` → `upstream()` → `up.res.pipe(res)`.
Bytes always pass through Umbra (unless `UMBRA_MEDIA_EGRESS=direct`).

### PO token

`potoken.getPoToken(visitorData)` resolution order — **CONFIRMED**:
harvested (from a real browser POST passing through the proxy) → cache → env
`UMBRA_YT_POTOKEN` → `UMBRA_POT_PROVIDER_URL` → in-process `bgutils-js`.
Applied in two places: `serviceIntegrityDimensions.poToken` on the player RPC
(`innertube.mjs:526`) and `&pot=` appended to each media URL
(`piped-local.mjs:289`). Both are correct placements.

---

## 2. Where the bot-flag sentence comes from

**CONFIRMED.** `verdict.mjs:70` — it is **Umbra's own inference**, not YouTube's
text:

```js
const BOT = /sign ?in to confirm|not a bot|LOGIN_REQUIRED|CONSENT_WALL|consent wall|confirm you'?re|age.?restrict/i;
if (any(BOT)) return { kind:'bot-wall',
  headline: 'This machine’s IP address is bot-flagged by YouTube.', … }
```

It fires if **any** note from **any** provider matches that regex.

For `sxQLjN9pJ_g` the verdict happens to be right: your probe shows YouTube's
*literal* string `Sign in to confirm you're not a bot` returned to
`watchpage` (a plain browser-shaped HTML GET) and to all 11 InnerTube clients.
That is YouTube's own words about the requester → **CONFIRMED IP-reputation
restriction**, not an Umbra defect.

But the regex over-reaches (**BUG 1**, below): `LOGIN_REQUIRED` alone, `age
restricted`, and `CONSENT_WALL` are *video-* or *cookie-* level conditions that
do not imply IP reputation. An age-gated video would print "this machine's IP
address is bot-flagged", sending you to fix egress for a video that needs a
sign-in.

---

## 3. Issue 1 — alternate backends fail

### Provider table

| Provider | Location | Enabled by default | Egress | First failing step (your probe) | Observed | Likely cause | Status |
|---|---|---|---|---|---|---|---|
| `innertube` | `providers/innertube.mjs` → `piped-local.mjs` | yes | **ours** | player RPC ×11 clients | `LOGIN_REQUIRED · Sign in to confirm you're not a bot · 0 formats` | IP reputation | CONFIRMED |
| `watchpage` | `providers/watchpage.mjs` → `watchpage.mjs` | yes | **ours** | HTML parsed OK, `playabilityStatus` | `LOGIN_REQUIRED` | IP reputation (page *was* returned and parsed — so not a rewriting or markup bug) | CONFIRMED |
| `piped` (LOCAL) | `piped.mjs` `LOCAL` → `piped-local.mjs` | yes, **first instance** | **ours** | same RPC as innertube | `gated` | same IP; duplicate of row 1 | CONFIRMED |
| `piped` (public ×5) | `piped.mjs` `DEFAULT_INSTANCES` | yes | theirs | instance HTTP | folded into one `gated 740ms` row | instances themselves blocked / 5xx; **per-instance detail is collapsed** | PROBABLE |
| `invidious` | `providers/invidious.mjs`, 5 seeds + directory | yes | theirs | instance HTTP | `403/401/403` | Cloudflare or instance-side YouTube block; 401 suggests an instance requiring auth | PROBABLE |
| `poketube` | `providers/poketube.mjs` | **no — `envList('UMBRA_POKETUBE_INSTANCES', [])`** | n/a | never runs | silent | not configured | CONFIRMED |
| `newpipe` | `providers/newpipe.mjs` | **no — `envList('UMBRA_NEWPIPE_URL', [])`** | n/a | `cooldown 0ms` | benched | not configured, yet reported as a *failure* | CONFIRMED |
| `youtubejs` | `providers/youtubejs.mjs` | if lib present | **ours** | after deciphering | `no formats after deciphering` | same gate; formats returned without URLs | PROBABLE |
| `ytdlp` | `providers/ytdlp.mjs` | if binary present | **ours** | subprocess | `ERROR: … Sign in to confirm you're not a bot` | IP reputation | CONFIRMED |

### Findings

* **They do not fail for one reason.** Three distinct causes: (a) our egress is
  bot-flagged — 5 providers; (b) third-party instances are themselves blocked or
  unhealthy — 2 providers; (c) never configured — 2 providers.
* **BUG 2 — the provider list is less diverse than it looks.** Of 8 rows, 5 run
  on this address and 2 of those are literally the same code. The pool's stated
  purpose ("address diversity") is served by *two* live providers.
* **BUG 3 — an unconfigured provider is reported as a failed one.** `newpipe`
  prints `failed 0ms (cooldown)`, which reads as "tried and broken".
* **No evidence of swallowed errors.** `failover()` records every attempt in
  `tried[]` and the UI prints it; `GRADE.streams` correctly converts a 200 with
  no formats into a failure rather than a success. This part is sound.

---

## 4. Issue 2 — bot checks

**CONFIRMED: this is an IP-reputation restriction, not a configuration gap.**

Evidence, all from your probe:

1. `watchpage` made the most ordinary request possible — a browser-shaped HTML
   `GET /watch?v=…` with consent cookies — and YouTube answered with a
   playerResponse whose status is `LOGIN_REQUIRED` and whose reason is *"Sign in
   to confirm you're not a bot"*. The page parsed fine, so rewriting, markup
   drift and the shim are all excluded.
2. All 11 InnerTube client identities got the same refusal.
3. `yt-dlp`, an independent implementation, got the same refusal from the same
   machine.
4. The *direct* embed (your browser, your home address, same video) plays.

Same video, two addresses, two answers. That isolates the variable to egress.

**A PO token will not, on its own, clear this** — and the code already says so
in `verdict.mjs`. A token proves "a browser ran BotGuard"; it does not launder
the address.

**BUG 4 (PROBABLE, and this one is ours).** `index.mjs:567‑590` rewrites every
in-page `/youtubei/v1/*` POST that lacks a PO token to `IT_LADDER[0]`, which is
`tv` → `TVHTML5`, with `itHeaders()` setting
`user-agent: …Cobalt/25.lts…Unknown_TV_Unknown_0` and
`x-youtube-client-name: 7`. The *document* was fetched moments earlier with a
Chromium UA and Chromium client hints, over the same cookie jar and IP. YouTube
therefore sees one session in which a Chrome browser loads a watch page and then
a Cobalt television asks for the player. That is a textbook automation
signature and is plausibly *contributing to the very flag we are diagnosing*.

---

## 5. Issue 3 — black screen with no cookies

First, which of four paths is black matters, because they fail differently:

| Path | What it is | Status |
|---|---|---|
| A | Proxied real `youtube.com` watch page (mode `d` + YouTube's own JS) | **the black screen under investigation** |
| B | Proxied `/embed/` document | black, `Error: R` in `ytembeds.base` |
| C | Umbra Tube page + `player.js` + mode `m` bytes | depends on extraction (currently gated) |
| D | Direct embed straight from your browser to YouTube | **works** |

### Stage-by-stage for path A/B

1. **Document loads — CONFIRMED OK.** `watchpage` proves YouTube returns real
   HTML to this machine; `html.mjs` rewrote it (you saw a rendered page, not a
   network error).
2. **Resources load — PROBABLE OK.** `CSP_DOC` allows `script-src 'self'
   'unsafe-inline' 'unsafe-eval'`, and rewritten scripts are same-origin, so
   `base.js` is permitted. No CSP violation has been reported in your pastes.
3. **Player config RPC — HERE IS THE DEFECT.** The page's `/youtubei/v1/player`
   POST is rewritten to the TVHTML5 client (BUG 4). YouTube answers in
   TV shape — different renderer tree, different player config, different format
   set. **The WEB player JavaScript cannot consume a TVHTML5 response.**
   `Error: R` in `ytembeds.base` is exactly the shape of a player that received
   a response it could not reconcile. This applies to `next`, `browse` and
   `guide` too, so the whole proxied SPA is affected, not just playback.
   *Status: PROBABLE — code-confirmed behaviour, effect inferred.*
4. **Formats — gated anyway** on this address (Issue 2), so even a correct WEB
   response would likely arrive empty.
5. **Byte delivery — CONFIRMED HEALTHY.** Range in / `206` + `Content-Range`
   out, streamed via `pipe()`, redirects followed for subresources. Covered by
   passing tests (`offline.mjs:1060‑1066`, `1135`, `1360`).

**So: the black screen is probably two bugs stacked.** Even if YouTube liked
our address, path A would still break on the client rewrite; and even with the
rewrite fixed, path A stays empty while the address is flagged.

**The circular dependency (the most actionable thing in this report).**
`potoken.mjs` harvests a *real* PO token when a page's own BotGuard-signed POST
passes through the proxy (`index.mjs:570 pot.observe(seen)`), and
`rewriteInnertubeBody` correctly leaves such requests untouched. Your probe says
`"harvested":"none seen yet"`. The in-page player never gets far enough to mint
one — plausibly *because* of BUG 4 — so the harvest never happens, so extraction
stays gated. **Fixing BUG 4 may be what unlocks the token supply**, which is a
far better outcome than making `bgutils-js` work.

**Cookies:** do not conclude cookies are required. The no-cookie case fails at
stage 3/4, and stage 4 is an address judgement. Cookies would likely clear
stage 4, but that is "buying a different identity", not "fixing a bug".

---

## 6. Confirmed bugs, smallest fix each

| # | Bug | Severity | Smallest safe fix | Test |
|---|---|---|---|---|
| 1 | `verdict.mjs` BOT regex conflates IP reputation with age gates, consent walls and bare `LOGIN_REQUIRED` | medium (misdirects the operator) | split the regex: `not a bot`/`confirm you're not a bot` → `bot-wall`; `age.?restrict`/bare `LOGIN_REQUIRED` → new `sign-in-required` verdict; `CONSENT_WALL` → `consent` | feed notes for each class, assert three different `kind`s |
| 2 | `innertube` and `piped(LOCAL)` are the same engine, presented as independent backends | low (misleading diagnostics) | label the local Piped instance as such in the probe/tried output; no routing change | assert the probe output names them as sharing an egress |
| 3 | Unconfigured providers report as failures | low | `enabled()===false` → report `not-configured`, never `cooldown` | assert `newpipe` with no env reports `not-configured` |
| 4 | In-page InnerTube RPCs rewritten to TVHTML5, breaking YouTube's own player and contradicting the document's own UA | **high** | gate it: only rewrite when the body's client is absent, and never for a request originating from a proxied YouTube *document*; keep the PO-token passthrough exactly as is. Add `UMBRA_IT_REWRITE=off\|player\|all` (default `player`) so it can be A/B'd without a redeploy | update `offline.mjs:1156` (it currently asserts the buggy behaviour), add a case asserting a web-client body survives unrewritten, and that a PO-token body is still untouched |
| 5 | `signatureTimestamp: 20073` hardcoded (`innertube.mjs:519`) instead of the `sts` parsed from the live `base.js` | medium | read `sts` in `decipher.mjs` (it already fetches and parses the player) and pass it through | mock a player JS with a known `sts`, assert the RPC body carries it |
| 6 | A video-only answer is returned as a playable result if nothing better appears | low (just shipped as `degraded`) | surface "no audio track" in the player UI | assert the payload is flagged |

**Test-fidelity gap (Phase 1.8):** `test/mock-upstream.mjs:746` answers
`/youtubei/v1/player` with the **same web-shaped response regardless of
`context.client`**. No test can currently detect BUG 4. Fixing that mock — make
it return a TV-shaped body for `clientName: TVHTML5` — is the single highest-value
test change here.

---

## 7. Priority

1. **BUG 4** — ours, high impact, may unlock the PO-token harvest. Smallest
   change with the largest possible payoff.
2. **Mock fidelity** — so BUG 4 cannot silently return.
3. **BUG 1** — stop over-claiming IP flags.
4. **BUG 5** — stale `sts`.
5. **BUGS 2, 3, 6** — diagnostic honesty.
6. **Not a bug:** the media wire. Leave it alone.

Nothing above fixes `sxQLjN9pJ_g` *on this address*. Issue 2 is upstream and
real. The honest statement is: Umbra has defects worth fixing, and YouTube is
also refusing this machine; only the first half is ours to repair.

---

## 8. What I need from you

1. **Which screen is black** — path A (real youtube.com proxied) or path B
   (`/embed/`)? The fix differs.
2. **One line from the console** on that page: any `Refused to …` (CSP) line, or
   the first red error.
3. Whether `dQw4w9WgXcQ` — the video whose extraction *succeeded* — plays in the
   Umbra Tube player. That separates "extraction gated" from "delivery broken"
   definitively.
4. Permission to implement, in order: BUG 4 + mock fidelity first, alone, so its
   effect is measurable.
