# umbra

A web proxy. Pages are fetched by the server and rewritten so the browser only
ever talks to Umbra — no direct requests to the origin, no third-party cookies,
no leaked referrer.

```
npm start            # http://0.0.0.0:4173
npm test             # offline suite, no network required
```

Node 18+. No dependencies.

## Running it in Codespaces

```
node umbra-proxy/server/index.mjs
```

Then open the forwarded port. Two things to set:

- **Make the port public** (Ports panel → right-click → Port Visibility →
  Public) if you want to reach it from outside the editor. Codespaces' private
  forwarding injects an auth redirect that Umbra's own redirect handling will
  chase.
- Nothing else needs configuring. Umbra binds `0.0.0.0` and takes its host from
  the request, so the forwarded `*.app.github.dev` hostname works as-is.

Worth knowing before you test YouTube from there: Codespaces egress is Azure
datacenter IP space, which is the most aggressively bot-gated address range
there is. Expect the native player and the built-in Piped instance to be
challenged more often than they would be from a home connection. That is what
the failover pool below is for.

## Umbra Tube

`umbra://tube/` is a YouTube front end speaking the Piped API. Search, watch,
channels, trending and comments, with the video bytes coming back over the
Umbra media wire like everything else — your browser never contacts Google.

It is fed by a **failover pool**, tried in order:

1. **Umbra's own Piped instance**, in-process. No third party sees what you
   watch, and nothing breaks when a public instance disappears.
2. **Public Piped instances**, as a fallback.

The order matters and so does the fallback. The local instance extracts from
*this machine's* address — the exact thing YouTube profiles — so it does not
beat a bot gate on its own. A public instance extracts from *its* address, so
when this one is challenged the pool rotates to somewhere that isn't. Failed
instances are benched for a cooldown and the working one becomes sticky.

A bot-gated reply from YouTube is valid JSON with no results in it. The local
instance tells that apart from an honestly empty result (a real miss still
carries YouTube's result scaffolding; a block carries none) and raises it as a
failure, so the pool moves on instead of serving you a blank page.

`/~umbra/tube.health` reports which instances are benched and which is
preferred.

### The built-in instance is a real instance

It is served over the genuine Piped REST surface, so any Piped client can be
pointed at this origin:

```
GET /~umbra/piped/healthcheck
GET /~umbra/piped/streams/<videoId>
GET /~umbra/piped/search?q=<query>&filter=videos
GET /~umbra/piped/trending?region=<cc>
GET /~umbra/piped/channel/<channelId>
GET /~umbra/piped/comments/<videoId>
```

It is **shut to callers without an Umbra session** unless you set
`UMBRA_PIPED_PUBLIC=1`. This is the only surface that would spend your egress
on behalf of an anonymous caller, so opening it is deliberate rather than
default. The internal pool does not need it open — it calls the same handler
in-process.

Differences from upstream Piped, stated plainly:

- Stream URLs are returned raw, as extracted, rather than rewritten to a
  `pipedproxy-*` host. Umbra wraps them with its own media wire on the way out.
- `?region=` on `/trending` is accepted and ignored; trending follows the
  egress IP.
- `nextpage` is always `null`; pagination is not implemented.
- Responses carry non-standard `umbraClient` / `umbraTried` fields recording
  which InnerTube client identity actually worked.

Parsing is done by searching the response for renderer types wherever they
appear, rather than walking fixed paths, so YouTube reshuffling its response
tree does not break it.

## Multi-backend YouTube metadata

`/api/youtube/*` is one normalized API over several independent YouTube
backends. The browser only ever talks to this origin — every upstream request
is made by the server, so an instance your network blocks is still reachable
for us, and failover happens entirely behind the boundary.

```
GET  /api/youtube/search?q=&aggregate=0|1&limit=&region=
GET  /api/youtube/trending?region=
GET  /api/youtube/video/:id
GET  /api/youtube/channel/:id
GET  /api/youtube/playlist/:id
GET  /api/youtube/comments/:id
GET  /api/youtube/recommendations/:id
GET  /api/youtube/streams/:id
GET  /api/youtube/providers
GET  /api/youtube/providers/health?probe=0|1
GET  /api/youtube/providers/survey
POST /api/youtube/providers/refresh/invidious
GET  /api/youtube/cache
POST /api/youtube/cache/clear
```

Every response is `{ ok, data, meta }`. `meta` names the provider and instance
that answered and lists what was tried first. Session-gated like the rest of
Umbra unless `UMBRA_API_PUBLIC=1`.

`umbra://providers/` renders the same data as a table: routing order, instance
status, latency, cooldowns, recent decisions and cache hit rate.

### Backends

| Provider | Engine | Default |
| --- | --- | --- |
| `innertube` | Umbra's own InnerTube extraction | on |
| `piped` | NewPipeExtractor, via the Piped instance pool | on |
| `invidious` | Invidious, multi-instance | on |
| `poketube` | InnerTube, someone else's deployment | needs `UMBRA_POKETUBE_INSTANCES` |
| `newpipe` | self-hosted NewPipeExtractor bridge | needs `UMBRA_NEWPIPE_URL` |
| `youtubejs` | YouTube.js — adds signature deciphering | needs `npm i youtubei.js` |
| `ytdlp` | yt-dlp subprocess, metadata only | needs `yt-dlp` on PATH |

Two layers of failover sit under this and do different jobs. An **instance
pool** moves between hosts of one provider when a particular Invidious server
is down. The **manager** moves between providers when a whole fleet is being
squeezed. That separation is what makes "YouTube broke one parser" survivable:
`innertube`, `piped`/`newpipe` and `youtubejs` are genuinely different parsers,
and `invidious` extracts from an address that isn't ours.

Instances are scored on reliability, latency and recent success, and a failing
one is benched with exponential backoff rather than retried. Scoring only ever
*demotes* — an untested provider is never promoted above the configured order,
because looking perfect on no evidence is not the same as being good.

Search can optionally fan out (`aggregate=1`), merging by **video id** and
ranking by how many backends agreed. Everything else tries one provider and
falls through only on failure, because asking three backends for the same video
record costs three requests and returns one answer.

### Projects deliberately not wired up

CloudTube, ViewTube, FreeTube, LibreTube, Yattee, Clipious, TubiTui, ytfzf,
youtube-viewer, pipe-viewer, PlasmaTube and Pipeline are **clients**, not
extraction backends — they consume Invidious, Piped or YouTube.js, all of which
are already in the pool. Adding them would add hops, not independence. The
reasoning per project is served from `/api/youtube/providers/survey` and shown
on the diagnostics page.

Metadata only. No video bytes pass through this API; `/streams/:id` returns
format metadata, and what a caller does with those URLs is its own decision.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4173` | Listen port. |
| `UMBRA_PIPED_INSTANCES` | `local` + public pool | Comma-separated pool, in order. `local` means the built-in instance. Set this to just `local` to never touch a third party. |
| `UMBRA_PIPED_PUBLIC` | off | Serve `/~umbra/piped/*` to callers with no Umbra session. |
| `UMBRA_PIPED_TIMEOUT` | `8000` | Per-instance timeout, ms. |
| `UMBRA_PIPED_COOLDOWN` | `120000` | How long a failed instance stays benched, ms. |
| `UMBRA_PIPED_LOCAL_CLIENT` | `web` | InnerTube client used for the metadata endpoints. |
| `UMBRA_YT_CLIENTS` | `visionos,tv,web_embedded,tv_downgraded,android_vr,web` | Client ladder for native stream extraction, tried in order. |
| `UMBRA_YT_VISITOR_TTL` | `21600000` | Visitor identity cache lifetime, ms. |
| `UMBRA_YT_EMBED_URL` | `https://www.reddit.com/` | Referring origin presented for embedded playback. |
| `UMBRA_YT_BASE` | — | Override the YouTube origin. Used by the test suite to point at a mock. |
| `UMBRA_YT_POTOKEN` | — | A proof-of-origin token lifted from a browser session. See below. |
| `UMBRA_POT_PROVIDER_URL` | — | A bgutil-style PO token minting service, e.g. `http://127.0.0.1:4416`. |
| `UMBRA_YT_COOKIES` | — | Cookie header for a signed-in YouTube session. |
| `UMBRA_POT_TTL` | `21600000` | PO token cache lifetime, ms. |
| `UMBRA_API_PUBLIC` | off | Serve `/api/youtube/*` to callers with no Umbra session. |
| `UMBRA_PROVIDERS` | `innertube,piped,invidious,poketube,newpipe,youtubejs,ytdlp` | Provider order and membership. |
| `UMBRA_INVIDIOUS_INSTANCES` | built-in seed list | Invidious instance pool. |
| `UMBRA_INVIDIOUS_DIRECTORY` | `https://api.invidious.io/instances.json` | Where `providers/refresh/invidious` discovers instances. |
| `UMBRA_POKETUBE_INSTANCES` | — | Enables the PokeTube provider. |
| `UMBRA_NEWPIPE_URL` | — | Enables the NewPipeExtractor bridge provider. |
| `UMBRA_YTDLP_BIN` | `yt-dlp` | yt-dlp binary to probe for. |
| `UMBRA_PROVIDER_TIMEOUT` | `8000` | Per-instance request timeout, ms. |
| `UMBRA_PROVIDER_FAIL_LIMIT` | `3` | Consecutive failures before an instance is benched. |
| `UMBRA_PROVIDER_COOLDOWN` | `120000` | Base cooldown, ms. Doubles per consecutive bench. |
| `UMBRA_PROVIDER_MAX_ATTEMPTS` | `3` | Instances tried per call, per provider. |
| `UMBRA_CACHE_MAX` | `500` | Metadata cache entries. |

### When playback fails: proof-of-origin

If every video reports no playable streams, the cause is usually not
extraction. Since 2024 YouTube scores each player request and, for most
clients, expects a **proof-of-origin token** minted by its own BotGuard
JavaScript. A request without one is either refused outright or — more
confusingly — answered with `200 OK` and every good format withheld. From the
outside those two outcomes look identical to a broken extractor.

The giveaway is in `GET /api/youtube/diagnose/<videoId>`:

- formats arrive but are **ciphered and unresolved** → a deciphering problem;
- formats arrive and resolve → playback works;
- **no formats at all, across every client** → a proof-of-origin problem.

IP reputation sets the difficulty. A home connection often needs nothing. A
datacentre address — Codespaces, a VPS, CI — is scored far more harshly, and
**no combination of flags fixes a flagged address**. In rough order of effort:

1. **Paste a token.** Open YouTube in a normal browser, copy the `poToken`
   from a `/youtubei/v1/player` request in devtools, set `UMBRA_YT_POTOKEN`.
   Costs nothing, lasts hours, and is the fastest way to confirm the diagnosis.
2. **Run a provider.** `bgutil-ytdlp-pot-provider` serves tokens over HTTP;
   point `UMBRA_POT_PROVIDER_URL` at it. This is the durable answer, because
   tokens are minted on demand instead of expiring overnight.
3. **Add cookies.** `UMBRA_YT_COOKIES` from a signed-in session. Helpful, but
   no longer sufficient on its own.
4. **Change egress.** If the above still fails, the address itself is the
   problem and only residential egress will clear it.

Umbra degrades rather than failing when none of these are configured: it still
tries, falls back through its client ladder, and will serve an HLS manifest if
that is all YouTube offers. `diagnose` reports which of these applied.

## Tests

```
npm test
```

Spins a mock upstream and a mock Piped instance on loopback and exercises the
whole surface — rewriting, the cookie jar, the media wire, the client ladder,
pool failover, and the built-in instance — with no outbound network. The
browser suites under `browsertest/` need a real Chromium.
