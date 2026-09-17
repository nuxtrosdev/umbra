/**
 * Umbra-authored documents. These are served through the *same* pipeline as
 * proxied pages (rewrite + shim), so an umbra:// address is always a real
 * Umbra document, whether its bytes came from the clear web or from us.
 */
export const DOC_CSS = `
*{box-sizing:border-box}
body{margin:0;padding:30px 26px 60px;color:#dde6f2;
 background:radial-gradient(85% 60% at 6% -6%,#182233 0%,transparent 58%),
 radial-gradient(70% 50% at 100% 0%,#12291f 0%,transparent 55%),#0a0d12;
 font:14px/1.65 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
main{max-width:900px;margin:0 auto}
.kicker{display:inline-block;font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;
 text-transform:uppercase;color:#8fd6c8;background:rgba(60,190,160,.1);border:1px solid rgba(60,190,160,.28);
 padding:6px 9px;border-radius:99px}
h1{font-size:28px;margin:14px 0 8px;letter-spacing:-.015em}
h2{font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#8fa2ba;margin:30px 0 12px}
p.muted{color:#93a4bb;margin:0 0 18px;max-width:62ch}
a{color:#a8e6ff}
form{display:flex;gap:8px;max-width:640px;margin-top:4px}
input{flex:1;background:#0b1017;border:1px solid rgba(255,255,255,.14);border-radius:11px;padding:12px 14px;
 color:#eaf2fb;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;outline:0}
input:focus{border-color:rgba(79,209,179,.6);box-shadow:0 0 0 3px rgba(79,209,179,.1)}
button{border:1px solid rgba(79,209,179,.4);background:rgba(79,209,179,.14);color:#bdf3e5;border-radius:11px;
 padding:0 18px;font-size:13px;cursor:pointer}
button:hover{filter:brightness(1.15)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:10px}
a.card{display:block;text-decoration:none;border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:14px 15px;
 background:rgba(255,255,255,.03);transition:background .14s,border-color .14s,transform .14s}
a.card:hover{background:rgba(255,255,255,.07);border-color:rgba(79,209,179,.42);transform:translateY(-1px)}
a.card b{display:block;color:#eaf4fb;font-size:14px;margin-bottom:4px}
a.card span{color:#8fa2ba;font-size:12px}
ol.res{list-style:none;margin:0;padding:0;max-width:820px}
ol.res li{padding:14px 0;border-bottom:1px solid rgba(255,255,255,.06)}
ol.res a{font-size:17px;color:#a8e6ff;text-decoration:none}
ol.res a:hover{text-decoration:underline}
ol.res .from{font:11px ui-monospace,monospace;color:#4fd1b3;margin:3px 0 5px;word-break:break-all}
ol.res p{margin:0;color:#9db0c6;font-size:13px}
.facts{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:9px}
.facts li{border-left:2px solid rgba(79,209,179,.42);padding:3px 0 3px 12px;font-size:12.5px;color:#9db0c6}
.facts b{color:#cdeee5}
pre{background:rgba(0,0,0,.34);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:13px;
 overflow:auto;font-size:12px;color:#bfd4e6}
code{font:12px ui-monospace,monospace;background:rgba(255,255,255,.07);padding:1px 5px;border-radius:5px;color:#bfe9dd}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:1px solid rgba(255,255,255,.07);padding:7px 9px;text-align:left;vertical-align:top}
th{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8fa2ba}
.warn{color:#ffcf8b}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-top:6px}
.kv div{border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 13px;background:rgba(255,255,255,.03)}
.kv b{display:block;font:22px/1.1 ui-monospace,monospace;color:#a8e3d6}
.kv span{font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:#7f92a8}
`;

const link = (href, title, sub) => `<a class="card" href="${href}"><b>${esc(title)}</b><span>${esc(sub)}</span></a>`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function portalDoc() {
  return `<main>
  <header>
    <span class="kicker">umbra/1 · one history entry</span>
    <h1>Portal</h1>
    <p class="muted">Everything you open from here lives in the Umbra tab strip. The browser tab keeps this
    URL, this title and exactly one history record, whatever you navigate to.</p>
    <form method="get" action="umbra://search/">
      <input name="q" placeholder="search the web through umbra, or paste an address" autocomplete="off" spellcheck="false">
      <button>Go</button>
    </form>
  </header>

  <h2>Start here</h2>
  <div class="grid">
    ${link('umbra://lab/index', 'Umbra lab', 'one live fixture per guarantee')}
    ${link('umbra://protocol', 'Protocol notes', 'the scheme, the token, the modes')}
    ${link('umbra://stats', 'Session stats', 'wire requests, bytes, held redirects')}
    ${link('umbra://example.com', 'example.com', 'smallest possible document')}
    ${link('umbra://en.wikipedia.org/wiki/Web_proxy', 'Web proxy · Wikipedia', 'heavy html, css, fonts, images')}
    ${link('umbra://www.youtube.com', 'YouTube', 'full site, proxied')}
    ${link('umbra://www.youtube.com/watch?v=aqz-KE-bpKQ', 'YouTube watch page', 'player pill + umbra player capsule')}
    ${link('umbra://httpbin.org/redirect/3', 'httpbin 3-hop chain', 'redirect policy under a real chain')}
    ${link('umbra://httpbin.org/image/png', 'binary image as document', 'umbra viewer + mode m/r')}
    ${link('umbra://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4', 'mp4 as document', 'Range-capable media viewer')}
  </div>

  <h2>How this tab is isolated</h2>
  <ul class="facts">
    <li><b>history</b> the shell never navigates; every page is a sandboxed frame</li>
    <li><b>redirects</b> a cross-host 3xx is answered with a capsule and split into its own tab</li>
    <li><b>addresses</b> the wire path carries an HMAC token, so no destination host appears in any URL</li>
    <li><b>media</b> video and audio stream through mode m with Range copied both ways</li>
    <li><b>storage</b> proxied sites get memory-only localStorage while ephemeral is on</li>
    <li><b>cookies</b> the jar lives in server memory for this session; nothing reaches your browser</li>
  </ul>
  </main>`;
}

export function labIndexDoc() {
  const rows = [
    ['umbra://lab/redirect', 'held 302', 'cross-host redirect must open a NEW umbra tab and leave this one intact'],
    ['umbra://lab/samehost', 'same-host 301', 'must be followed silently: one tab, no notice'],
    ['umbra://lab/meta', 'meta refresh, 3s', 'same handling as an HTTP redirect'],
    ['umbra://lab/js', 'scripted location.href', 'top navigation is sandbox-forbidden; the frame is reverted'],
    ['umbra://lab/windowopen', 'window.open()', 'routed into the tab strip, never a real window'],
    ['umbra://lab/image', 'images + srcset + 302', 'all subresources same-origin'],
    ['umbra://lab/video', 'html5 video + Range', 'mode m, seekable'],
    ['umbra://lab/form', 'GET + POST + nested frame', 'mode f forwards method and body'],
    ['umbra://lab/frames', 'nested proxied frames', 'the shim runs inside children too'],
    ['umbra://lab/storage', 'localStorage probe', 'ephemeral: writes die with the tab'],
    ['umbra://lab/xhr', 'fetch / XHR / relative URL', 'runtime refs re-anchored to the wire'],
    ['umbra://lab/schemes', 'data: / blob: / javascript: policy', 'inert where a scheme leaves the browser, verbatim where it cannot'],
  ].map(([h, b, s]) => link(h, b, s)).join('');
  return `<main><span class="kicker">umbra · lab</span>
  <h1>Behaviour fixtures</h1>
  <p class="muted">Each card is a live probe of one guarantee. Watch the shell's ledger (bottom right) while they fire —
  the point of the lab is that the tab strip, not the browser, absorbs all of it.</p>
  <div class="grid">${rows}</div></main>`;
}

export function helpDoc() {
  const modes = [
    ['d', 'document', 'HTML decoded, every reference rewritten, shim injected, framing headers dropped'],
    ['s', 'subresource', 'CSS url() rewritten; images, fonts, JS pass through byte-exact'],
    ['m', 'media', 'byte-exact stream, Range and Content-Range copied both directions, never buffered whole'],
    ['x', 'xhr', 'byte-exact passthrough for fetch()/XHR; X-Umbra-Meta is exposed to the caller'],
    ['f', 'form-post', 'method and body forwarded, then treated exactly like d'],
    ['r', 'raw', 'byte-exact passthrough for downloads'],
    ['c', 'capsule', 'Umbra-authored document: redirect hold, error page, player'],
    ['p', 'mint', 'runtime mint for references a page builds after load (frame-key authorised)'],
  ].map(([m, n, d]) => `<tr><td><code>${m}</code></td><td>${n}</td><td>${d}</td></tr>`).join('');
  return `<main><span class="kicker">umbra/1 · specification</span>
  <h1>The wire</h1>
  <p class="muted">Umbra is a URL scheme, a token envelope and an out-of-band metadata header. It exists so a
  document can address the clear web while the browser is only ever told about one opaque origin.</p>
  <pre>umbra://host[:port]/path?query#frag          logical address
/~umbra/&lt;mode&gt;/&lt;token&gt;[/name]                 wire address (same origin, always)
token = base64url(json).hmac8                bound to {u,t,s,m}
X-Umbra-Meta: base64url(json)                 final url, status, chain, kind</pre>
  <h2>Modes</h2>
  <table><tr><th>mode</th><th>name</th><th>behaviour</th></tr>${modes}</table>
  <h2>Invariants</h2>
  <ul>
    <li>The shell never calls <code>pushState</code>, <code>replaceState</code> or navigates; browser history keeps one entry.</li>
    <li>A proxied frame is sandboxed without <code>allow-top-navigation</code> and without <code>allow-popups</code>.</li>
    <li>A cross-host document redirect produces a capsule (mode c) plus a new Umbra tab — never a 3xx to the client.</li>
    <li>Subresource redirects are followed silently, because a stylesheet cannot open a tab.</li>
    <li>Runtime references are re-anchored by the shim against the <b>logical</b> base, not the wire path.</li>
    <li>Tokens are session-scoped and HMAC-bound; a captured token is useless to another session.</li>
  </ul>
  <h2>What cloaking does and does not do</h2>
  <p>Nothing in this build writes to your disk: tab state is in memory, the cookie jar is server memory, and the
  ledger is a JS array. That is the whole claim — it defeats browser history, thumbnails in other apps and
  "recently visited" lists. It does not hide anything from the operator of this origin, from your network path
  (which sees only this origin, one host), or from a forensic image of the machine. Run it over Tailscale on
  localhost and the operator is you.</p></main>`;
}

export function statsDoc(s) {
  const fmt = (n) => (n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n > 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B');
  const chain = (s.chain || []).slice(-14).reverse().map((c) => `<tr><td>${new Date(c.at).toLocaleTimeString()}</td><td>${esc(c.kind)}</td><td>${esc(c.from || '')}</td><td>${esc(c.to || '')}</td></tr>`).join('');
  return `<main><span class="kicker">umbra/1 · session</span>
  <h1>Session stats</h1>
  <p class="muted">Memory-only counters for this session. Reload to refresh; nothing is persisted anywhere.</p>
  <div class="kv">
    <div><b>${s.reqs}</b><span>wire requests</span></div>
    <div><b>${fmt(s.bytes)}</b><span>bytes rewritten/piped</span></div>
    <div><b>${s.held}</b><span>redirects held</span></div>
    <div><b>${s.tabs.size}</b><span>live umbra tabs</span></div>
    <div><b>${s.csp || 0}</b><span>off-wire loads refused by policy</span></div>
  </div>
  ${(s.cspLog && s.cspLog.length) ? `<h2>Refused by the document policy</h2><p class="muted">The browser asked to fetch these directly; the CSP every Umbra document carries said no. Each line is a rewrite gap worth reporting, not a leak.</p><table><tr><th>when</th><th>blocked</th><th>directive</th></tr>${s.cspLog.slice(-10).reverse().map((c) => `<tr><td>${new Date(c.at).toLocaleTimeString()}</td><td>${esc(String(c.blocked).slice(0, 90))}</td><td>${esc(c.directive)}</td></tr>`).join('')}</table>` : '<p class="muted">no document inside Umbra has attempted an off-wire load this session — the rewrite covered every vector the browser tried.</p>'}
  <h2>Redirect ledger</h2>
  ${chain ? `<table><tr><th>when</th><th>kind</th><th>from</th><th>to</th></tr>${chain}</table>` : '<p class="muted">no held redirects yet — run <code>umbra://lab/redirect</code></p>'}
  <h2>Policy</h2>
  <pre>${esc(JSON.stringify(s.policy, null, 2))}</pre>
  <p class="muted">session id ${esc(s.id)} · cookie jar entries ${s.cookieJar.size ? s.cookieJar.size() : Object.keys(s.cookieJar.map || {}).length} domains</p></main>`;
}
