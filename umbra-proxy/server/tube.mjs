/**
 * Umbra Tube — the browsable surface over piped.mjs.
 *
 * Pure renderers: they take already-normalised data and return HTML. Every
 * link is an `umbra://tube/...` logical address, so navigation stays inside
 * the tab system, and every image is already a wire URL, so nothing here
 * causes the browser to talk to Google or to a Piped instance directly.
 */
import { verdict } from './verdict.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function fmtDur(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
}

export function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export const TUBE_CSS = `
.tsearch{display:flex;gap:8px;max-width:680px;margin:6px 0 4px}
.tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:14px;margin-top:6px}
a.vcard{display:block;text-decoration:none;color:inherit;border:1px solid rgba(255,255,255,.08);border-radius:14px;
 overflow:hidden;background:rgba(255,255,255,.03);transition:border-color .14s,transform .14s,background .14s}
a.vcard:hover{border-color:rgba(157,140,255,.5);background:rgba(255,255,255,.06);transform:translateY(-1px)}
.vthumb{position:relative;aspect-ratio:16/9;background:#05080c;display:block}
.vthumb img{width:100%;height:100%;object-fit:cover;display:block}
.vdur{position:absolute;right:6px;bottom:6px;background:rgba(4,6,10,.86);border:1px solid rgba(255,255,255,.14);
 border-radius:6px;padding:1px 6px;font:11px/1.5 ui-monospace,Menlo,monospace;color:#dce7f5}
.vmeta{padding:10px 11px 12px}
.vtitle{font-size:13px;line-height:1.35;font-weight:600;color:#e9f0fa;display:-webkit-box;-webkit-line-clamp:2;
 -webkit-box-orient:vertical;overflow:hidden}
.vsub{margin-top:5px;font:11px/1.5 ui-monospace,Menlo,monospace;color:#8b9bb4}
.tbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 2px}
.chip{font:10px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#bfeaff;
 background:rgba(111,227,255,.09);border:1px solid rgba(111,227,255,.3);padding:6px 10px;border-radius:99px}
.chip.warn{color:#ffd9a8;background:rgba(255,183,96,.09);border-color:rgba(255,183,96,.34)}
.tdesc{white-space:pre-wrap;color:#a8b5c9;font-size:13px;line-height:1.6;max-height:19em;overflow:auto;
 border-left:2px solid rgba(255,255,255,.1);padding-left:12px;margin-top:6px}
.trow{display:flex;gap:10px;align-items:center;margin:14px 0 2px}
.tav{width:38px;height:38px;border-radius:99px;object-fit:cover;background:#0b1018;flex:none}
.cmt{border-top:1px solid rgba(255,255,255,.07);padding:12px 0;display:flex;gap:10px}
.cmt .tav{width:30px;height:30px}
.cmt b{color:#d8e3f2;font-size:12px}
.cmt p{margin:4px 0 0;color:#a8b5c9;font-size:13px;white-space:pre-wrap}
.verdict{margin-top:14px;padding:12px 14px;border-radius:12px;
 background:rgba(255,186,120,.08);border:1px solid rgba(255,186,120,.28)}
.verdict strong{display:block;color:#ffcf9b;font-size:14px;margin-bottom:5px}
.verdict p{margin:0;color:#d7dfea;font-size:13px;line-height:1.55}
`;

function card(v) {
  const href = 'umbra://tube/watch?v=' + encodeURIComponent(v.videoId);
  return `<a class="vcard" href="${esc(href)}">
  <span class="vthumb">${v.thumbWire ? `<img loading="lazy" src="${esc(v.thumbWire)}" alt="">` : ''}
  ${v.duration ? `<span class="vdur">${esc(fmtDur(v.duration))}</span>` : (v.isShort ? '<span class="vdur">short</span>' : '')}</span>
  <span class="vmeta"><span class="vtitle">${esc(v.title)}</span>
  <span class="vsub">${esc(v.uploader)}${v.verified ? ' ✓' : ''}${v.views ? ' · ' + esc(fmtCount(v.views)) + ' views' : ''}${v.uploaded ? ' · ' + esc(v.uploaded) : ''}</span></span></a>`;
}

export function grid(items) {
  if (!items || !items.length) return '<p class="muted">Nothing came back for this one.</p>';
  return `<div class="tgrid">${items.map(card).join('')}</div>`;
}

function searchForm(q = '') {
  return `<form class="tsearch" method="get" action="umbra://tube/search">
  <input name="q" value="${esc(q)}" placeholder="search youtube through piped" autocomplete="off" spellcheck="false">
  <button>Search</button></form>`;
}

function provenance(d) {
  const bits = [];
  if (d.instance) bits.push(`<span class="chip">via ${esc(d.instance.replace(/^https?:\/\//, ''))}</span>`);
  for (const t of (d.tried || []).slice(0, 3)) {
    bits.push(`<span class="chip warn">${esc(t.instance.replace(/^https?:\/\//, ''))} — ${esc(t.note)}</span>`);
  }
  return bits.length ? `<div class="tbar">${bits.join('')}</div>` : '';
}

export function homeDoc(t) {
  return `<main>
  <header>
    <span class="kicker">umbra tube · piped front end</span>
    <h1>Tube</h1>
    <p class="muted">YouTube's catalogue over the Piped API. Umbra runs its own instance
    (<code>/~umbra/piped/</code>), so by default nothing here involves a third party — but that instance
    extracts from <i>this</i> machine's address, so when it gets bot-gated the pool falls through to public
    instances that extract from theirs. Either way the video bytes come back over the Umbra media wire, so
    nothing in your browser talks to Google. The chip below says which instance actually served this page.</p>
    ${searchForm()}
  </header>
  ${provenance(t)}
  <h2>Trending · ${esc(t.region || 'US')}</h2>
  ${grid(t.items)}
  </main>`;
}

export function searchDoc(r) {
  return `<main>
  <header>
    <span class="kicker">umbra tube · search</span>
    <h1>${esc(r.query)}</h1>
    ${searchForm(r.query)}
  </header>
  ${provenance(r)}
  ${r.corrected && r.suggestion ? `<p class="muted">Showing results for <b>${esc(r.suggestion)}</b>.</p>` : ''}
  <h2>${r.items.length} result${r.items.length === 1 ? '' : 's'}</h2>
  ${grid(r.items)}
  </main>`;
}

export function channelDoc(c) {
  return `<main>
  <header>
    <span class="kicker">umbra tube · channel</span>
    <div class="trow">${c.avatarWire ? `<img class="tav" src="${esc(c.avatarWire)}" alt="">` : ''}
    <div><h1 style="margin:0">${esc(c.name)}${c.verified ? ' ✓' : ''}</h1>
    <p class="muted" style="margin:2px 0 0">${esc(fmtCount(c.subscribers))} subscribers</p></div></div>
    ${searchForm()}
  </header>
  ${provenance(c)}
  ${c.description ? `<h2>About</h2><div class="tdesc">${esc(c.description)}</div>` : ''}
  <h2>Videos</h2>
  ${grid(c.items)}
  </main>`;
}

/** The watch page. The player itself is mounted by player.js from data-info. */
export function watchDoc(p, info, cmts) {
  const chanHref = p.channelId ? 'umbra://tube/channel/' + encodeURIComponent(p.channelId) : null;
  return `<main style="max-width:960px">
  <header>
    <span class="kicker">umbra tube · ${p.ok ? 'native stream' : 'no stream'}</span>
    <h1>${esc(p.title)}</h1>
    <p class="muted">${chanHref ? `<a href="${esc(chanHref)}">${esc(p.channel)}</a>` : esc(p.channel)}${p.verified ? ' ✓' : ''}
    ${p.views ? ' · ' + esc(fmtCount(p.views)) + ' views' : ''}${p.likes ? ' · ' + esc(fmtCount(p.likes)) + ' likes' : ''}
    ${p.uploadDate ? ' · ' + esc(p.uploadDate) : ''}${p.duration ? ' · ' + esc(fmtDur(p.duration)) : ''}</p>
    ${searchForm()}
  </header>
  ${provenance(p)}
  ${p.ok
    ? `<div class="tbar"><span class="chip">${p.muxed.length} muxed</span><span class="chip">${p.video.length} video</span>
       <span class="chip">${p.audio.length} audio</span><span class="chip">${p.captions.length} caption track(s)</span>
       ${p.isLive ? '<span class="chip warn">live</span>' : ''}</div>`
    : `<p class="warn">${esc(p.reason || 'no playable streams')}</p>
       <p class="muted">No backend could extract this one, so the player below is the proxied embed:
       YouTube's own code, running in your browser, inside Umbra. Your browser still never talks to
       Google — every byte is fetched by this origin — and the proof of origin that player mints is
       kept and reused on the native path, which is the thing a datacentre address cannot produce
       on its own.</p>`}
  <div id="player" data-info='${info}'></div>
  ${p.desc ? `<h2>Description</h2><div class="tdesc">${esc(p.desc)}</div>` : ''}
  ${cmts && cmts.items && cmts.items.length
    ? `<h2>Comments</h2>${cmts.items.map((c) => `<div class="cmt">${c.avatarWire ? `<img class="tav" src="${esc(c.avatarWire)}" alt="">` : ''}
       <div><b>${esc(c.author)}</b> <span class="vsub">${esc(c.when)}${c.likes ? ' · ' + esc(fmtCount(c.likes)) + ' likes' : ''}${c.pinned ? ' · pinned' : ''}</span>
       <p>${esc(c.text)}</p></div></div>`).join('')}`
    : (cmts && cmts.disabled ? '<h2>Comments</h2><p class="muted">Comments are disabled on this video.</p>' : '')}
  ${p.related && p.related.length ? `<h2>Related</h2>${grid(p.related)}` : ''}
  </main>`;
}

/**
 * Render a tried-list.
 *
 * There are two shapes in play and the old code only understood one of them,
 * which is why this page used to print "undefined — no invidious instance
 * answered": provider-level entries are {provider, note, instances} and have
 * no `instance` field at all. Worse than the cosmetic bug, the nested
 * per-instance notes — the only part that says *why*, e.g. a connection
 * refusal versus a bot gate — were never shown. An error page that hides the
 * error is not worth rendering.
 */
export function explainTried(tried) {
  const lines = [];
  for (const t of (tried || [])) {
    const label = t.provider || t.instance || t.client || '?';
    lines.push(label + '  —  ' + (t.note || 'failed'));
    for (const i of (t.instances || [])) {
      lines.push('    ' + (i.instance || i.client || '?') + '  —  ' + (i.note || 'failed'));
    }
  }
  return lines.join('\n');
}

/** The conclusion, stated rather than left for the reader to infer. */
function verdictBlock(tried) {
  const v = verdict(tried, {
    hasPoToken: !!(process.env.UMBRA_YT_POTOKEN || process.env.UMBRA_POT_PROVIDER_URL),
    hasCookies: !!process.env.UMBRA_YT_COOKIES,
  });
  if (!v) return '';
  return `<div class="verdict"><strong>${esc(v.headline)}</strong><p>${esc(v.detail)}</p></div>`;
}

export function errorDoc(what, e, tried) {
  return `<main>
  <header><span class="kicker">umbra tube · unavailable</span>
  <h1>${esc(what)}</h1>
  <p class="muted">Every backend was tried and none answered. The pool is federated precisely because instances
  get blocked, rate-limited or simply go down — but when all of them fail at once it is usually YouTube squeezing
  the whole network, or this machine having no route to it. The reasons below say which.</p>
  ${searchForm()}
  ${verdictBlock(tried)}</header>
  <h2>What was tried</h2>
  <pre>${esc(explainTried(tried) || String(e && e.message || e))}</pre>
  </main>`;
}

/* ------------------------------------------------------- provider admin */

const STATUS_COLOR = {
  ONLINE: '#7ee787', DEGRADED: '#ffd9a8', COOLDOWN: '#ff9f9f',
  DISABLED: '#7d8da3', UNKNOWN: '#bfeaff',
};

/**
 * The diagnostic table. Everything the router knows, in the order it would
 * pick: which provider answers first, which instances are benched and why,
 * and what the last failure actually said.
 */
export function providersDoc(h, endpoints = []) {
  const dot = (s) => `<span style="color:${STATUS_COLOR[s] || '#bfeaff'}">●</span>`;
  const ms = (n) => (n === null || n === undefined ? '—' : n + 'ms');
  const when = (t) => (t ? esc(String(t).replace('T', ' ').slice(0, 19)) : '—');

  const provRows = h.providers.map((p) => `<tr>
    <td><b>${esc(p.name || p.id)}</b><br><span class="vsub">${esc(p.id)}</span></td>
    <td>${p.enabled ? (p.routed ? '<span class="chip">ROUTED</span>' : '<span class="chip warn">IDLE</span>')
      : '<span class="chip warn">DISABLED</span>'}</td>
    <td>${p.instances}</td>
    <td>${esc(p.capabilities.join(' '))}</td>
  </tr>`).join('');

  const instRows = h.instances.map((i) => `<tr>
    <td>${dot(i.status)} ${esc(i.id)}</td>
    <td style="color:${STATUS_COLOR[i.status] || '#bfeaff'}">${esc(i.status)}</td>
    <td>${esc(ms(i.latency))}</td>
    <td>${i.failures || 0}</td>
    <td>${i.successRate === undefined ? '—' : esc(String(i.successRate))}</td>
    <td>${when(i.lastSuccess)}</td>
    <td>${i.cooldownUntil ? when(i.cooldownUntil) : '—'}</td>
    <td class="vsub">${esc(i.lastError || '')}</td>
  </tr>`).join('');

  const logRows = (h.recent || []).slice().reverse().slice(0, 25).map((e) => `<tr>
    <td class="vsub">${when(e.at)}</td>
    <td>${e.ok ? '<span style="color:#7ee787">ok</span>' : '<span style="color:#ff9f9f">fail</span>'}</td>
    <td>${esc(e.provider || '')}${e.instance && e.instance !== e.provider ? ' <span class="vsub">' + esc(e.instance) + '</span>' : ''}</td>
    <td>${esc(e.capability || '')}</td>
    <td>${esc(ms(e.ms))}</td>
    <td class="vsub">${esc(e.error || '')}</td>
  </tr>`).join('');

  const surveyRows = (h.survey || []).map((x) => `<tr>
    <td><b>${esc(x.project)}</b></td>
    <td><span class="chip warn">${esc(x.verdict)}</span></td>
    <td>${esc(x.reason)}</td>
    <td class="vsub">${esc(x.covered_by || '')}</td>
  </tr>`).join('');

  const c = h.cache || {};
  return `<main style="max-width:1100px">
  <header>
    <span class="kicker">umbra · provider diagnostics</span>
    <h1>Backends</h1>
    <p class="muted">Every YouTube backend Umbra can reach, and what the router currently thinks of each.
    Providers are tried top to bottom; an instance that fails enough times is benched rather than retried,
    and a provider whose instances are all benched sinks below the ones that still answer.</p>
  </header>

  <h2>Providers</h2>
  <table class="ptab"><thead><tr><th>Provider</th><th>Routing</th><th>Instances</th><th>Capabilities</th></tr></thead>
  <tbody>${provRows}</tbody></table>

  <h2>Instances</h2>
  <table class="ptab"><thead><tr><th>Instance</th><th>Status</th><th>Latency</th><th>Fails</th>
  <th>Success</th><th>Last success</th><th>Cooldown until</th><th>Last error</th></tr></thead>
  <tbody>${instRows}</tbody></table>

  <h2>Metadata cache</h2>
  <div class="tbar">
    <span class="chip">${esc(String(c.entries ?? 0))} / ${esc(String(c.max ?? 0))} entries</span>
    <span class="chip">${esc(String(Math.round((c.approxBytes || 0) / 1024)))} KB</span>
    <span class="chip">hit rate ${c.hitRate === null || c.hitRate === undefined ? '—' : esc(String(c.hitRate))}</span>
    <span class="chip">${esc(String(c.hits ?? 0))} hits · ${esc(String(c.misses ?? 0))} misses</span>
    ${c.refused ? `<span class="chip warn">${esc(String(c.refused))} refused (not metadata)</span>` : ''}
  </div>

  <h2>Recent decisions</h2>
  <table class="ptab"><thead><tr><th>When</th><th></th><th>Provider</th><th>Capability</th><th>Took</th><th>Error</th></tr></thead>
  <tbody>${logRows || '<tr><td colspan="6" class="vsub">nothing yet</td></tr>'}</tbody></table>

  <h2>Projects not wired as separate backends</h2>
  <p class="muted">Several well-known front ends consume another backend rather than extracting themselves.
  Adding them would add hops, not independence, so they are recorded here instead.</p>
  <table class="ptab"><thead><tr><th>Project</th><th>Verdict</th><th>Why</th><th>Already covered by</th></tr></thead>
  <tbody>${surveyRows}</tbody></table>

  <h2>API</h2>
  <pre>${esc(endpoints.join('\n'))}</pre>
  </main>`;
}

export const ADMIN_CSS = `
table.ptab{width:100%;border-collapse:collapse;margin:8px 0 18px;font-size:12.5px}
table.ptab th{text-align:left;font:10px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.1em;
 text-transform:uppercase;color:#8b9bb4;border-bottom:1px solid rgba(255,255,255,.12);padding:6px 10px 6px 0}
table.ptab td{padding:7px 10px 7px 0;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top;color:#cfdaea}
table.ptab tr:hover td{background:rgba(255,255,255,.025)}
`;
