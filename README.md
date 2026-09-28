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

## Tests

```
npm test
```

Spins a mock upstream and a mock Piped instance on loopback and exercises the
whole surface — rewriting, the cookie jar, the media wire, the client ladder,
pool failover, and the built-in instance — with no outbound network. The
browser suites under `browsertest/` need a real Chromium.
