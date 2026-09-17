/*
 * UMBRA SHELL
 * -----------
 * The only document the browser ever navigates. It owns the mini tab system,
 * mints Umbra wire addresses, and applies the redirect policy. It deliberately
 * never calls location.assign / pushState / replaceState, so the browser's
 * typed history keeps exactly one entry for a whole session.
 */
(() => {
'use strict';

const PFX = '/~umbra/';
const ORIGIN = location.origin;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ------------------------------------------------------------------ state */
const S = {
  session: null,
  tabs: [],
  active: null,
  split: false,
  cloak: { title: 'Docs', lock: true, burnOnLeave: true, real: false },
  log: [],
  minted: new Map(),
  stats: { reqs: 0, bytes: 0 },
  booting: true,
};
window.__UMBRA_SHELL__ = true;

/* history is never extended by Umbra: prove it and refuse politely */
const historyAttempts = [];
for (const m of ['pushState', 'replaceState', 'back', 'forward', 'go']) {
  const orig = history[m] && history[m].bind(history);
  try {
    history[m] = (...a) => {
      historyAttempts.push([m, Date.now()]);
      if (m === 'pushState' || m === 'replaceState') {
        log('i', `shell refused ${m}() — Umbra keeps the browser history at one entry`);
        return;
      }
      return orig(...a);
    };
  } catch {}
}

/* ------------------------------------------------------------------- util */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B');
const hostOf = (u) => {
  try { return new URL(String(u).replace(/^umbra:\/\//, 'https://')).hostname.replace(/^www\./, ''); }
  catch { return String(u).slice(0, 40); }
};
const shortU = (u) => String(u || '').replace(/^umbra:\/\//, '').replace(/^(https?:\/\/)/, '').slice(0, 96);
const uid = () => 'T' + Math.random().toString(36).slice(2, 9);

async function api(pathname, opts = {}) {
  const r = await fetch(PFX + pathname, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || j.error || ('http ' + r.status));
  return j;
}
async function mint(url, mode = 'd', tab = null) {
  const k = mode + '|' + url + '|' + (tab || '');
  if (S.minted.has(k)) return S.minted.get(k);
  const j = await api('mint', { method: 'POST', body: JSON.stringify({ url, mode, tab }) });
  S.minted.set(k, j);
  if (S.minted.size > 400) S.minted.delete(S.minted.keys().next().value);
  return j;
}

function log(kind, text) {
  S.log.unshift({ kind, text, at: new Date() });
  if (S.log.length > 240) S.log.pop();
  renderLog();
}
function toast(html, ms = 3400, cls = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s,transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 340);
  }, ms);
}

/* --------------------------------------------------------------- tab model */
async function newTab(startUrl, opts = {}) {
  /* register with the origin FIRST: the tab id is also the key every wire
     token is bound to, so it must exist before any node or mint happens */
  let reg;
  try {
    reg = await api('tab.new?url=' + encodeURIComponent(startUrl || 'umbra://home/'), {});
  } catch (e) {
    log('e', 'tab registry failed: ' + e.message);
    reg = { tab: uid(), key: '' };
  }
  const t = {
    id: reg.tab, key: reg.key, url: startUrl || 'umbra://home/', title: 'Umbra',
    hist: [], hi: -1, fav: '', held: 0, reqs: 0, mode: 'none',
    frame: null, node: null, loading: false, native: null,
  };
  S.tabs.push(t);
  buildTabNode(t);
  if (!opts.background) select(t.id); else renderStrip();
  await goto(t, t.url, { push: false, force: !!opts.force });
  return t;
}

function buildTabNode(t) {
  const el = document.createElement('div');
  el.className = 'utab';
  el.setAttribute('role', 'tab');
  el.dataset.tab = t.id;
  el.innerHTML =
    `<span class="fav"></span><span class="t">Umbra</span><span class="u"></span>
     <span class="led"></span><button class="x" title="close (middle click)">×</button>`;
  el.addEventListener('click', (ev) => {
    if (ev.target.classList.contains('x')) return closeTab(t.id);
    if (S.split && ev.shiftKey) return selectSecond(t.id);
    select(t.id);
  });
  el.addEventListener('auxclick', (ev) => { if (ev.button === 1) { ev.preventDefault(); closeTab(t.id); } });
  el.addEventListener('contextmenu', async (ev) => {
    ev.preventDefault();
    const j = await mint(t.url, 'r', t.id).catch(() => null);
    if (j) log('i', 'raw wire address: ' + j.href);
  });
  $('#tabstrip').appendChild(el);
  t.node = el;

  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.dataset.tab = t.id;
  t.frame = null;
  pane.appendChild(Object.assign(document.createElement('div'), { className: 'ovl' }));
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.innerHTML = `<span class="k"></span><span class="v"></span>
    <span class="act"><button data-a="copy">copy umbra</button><button data-a="reload">reload</button><button data-a="raw">wire</button></span>`;
  bar.addEventListener('click', async (ev) => {
    const a = ev.target.dataset.a;
    if (!a) return;
    if (a === 'copy') { await navigator.clipboard.writeText(t.url).catch(() => {}); toast('copied <b>' + esc(shortU(t.url)) + '</b>'); }
    if (a === 'reload') goto(t, t.url, { force: true, push: false });
    if (a === 'raw') { const j = await mint(t.url, 'd', t.id).catch(() => null); log('i', 'wire: ' + (j ? ORIGIN + j.href : 'n/a')); }
  });
  pane.appendChild(bar);
  $('#panes').appendChild(pane);
  t.pane = pane;
  mountFrame(t, { src: 'about:blank' });
}

/**
 * A navigation replaces the frame element instead of re-pointing it.
 * Reusing an existing iframe puts every hop into the browser's joint session
 * history (history.length climbs, Back steps through your browsing); a fresh
 * nested browsing context is not a history entry at all. This is what keeps
 * "one history record" literally true rather than mostly true.
 */
function mountFrame(t, spec) {
  const old = t.frame;
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-downloads');
  f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('fetchpriority', 'high');
  f.addEventListener('load', () => onFrameLoad(t));
  f.addEventListener('error', () => { t.loading = false; renderTab(t); log('e', 'frame load error for ' + shortU(t.url)); });
  if (spec.srcdoc != null) f.srcdoc = spec.srcdoc;
  else f.src = spec.src;
  const ovl = t.pane.querySelector('.ovl');
  t.pane.insertBefore(f, ovl);
  t.frame = f;
  if (old) {
    try { old.src = 'about:blank'; } catch (e) {}
    old.remove();
  }
}

function select(id) {
  S.active = id;
  $$('.pane').forEach((p) => { p.style.display = 'none'; delete p.dataset.active; });
  const t = tab(id);
  if (t) { t.pane.style.display = 'block'; t.pane.dataset.active = '1'; }
  renderStrip();
  if (S.split) applySplit();
  renderAddr();
  renderStatus();
}
function selectSecond(id) {
  S.split = true;
  $('#splitBtn').style.borderColor = 'rgba(79,209,179,.5)';
  applySplit(id);
}
function applySplit(secondId) {
  const a = tab(S.active);
  if (secondId) S.splitSecond = secondId;
  const b = tab(S.splitSecond) || S.tabs.find((x) => x !== a);
  $$('.pane').forEach((p) => { p.style.display = 'none'; p.style.flex = '1'; });
  if (a) { a.pane.style.display = 'block'; }
  if (b) { b.pane.style.display = 'block'; }
  if (!b) S.split = false;
}
const tab = (id) => S.tabs.find((t) => t.id === id);
const active = () => tab(S.active);

function backgroundOpen(url) {
  /* a held redirect opens behind the tab you were reading: the target gets its
     own tab, but it does not take the stage away from you */
  return newTab(url, { background: true });
}

async function closeTab(id) {
  const t = tab(id);
  if (!t) return;
  fetch(PFX + 'tab.close?t=' + encodeURIComponent(id), { credentials: 'same-origin' }).catch(() => {});
  t.node.remove();
  t.pane.remove();
  try { t.frame && (t.frame.src = 'about:blank'); } catch {}
  S.tabs = S.tabs.filter((x) => x !== t);
  if (S.active === id) S.active = S.tabs.length ? S.tabs[Math.max(0, S.tabs.indexOf(t) - 1)].id : null;
  if (S.active) select(S.active); else { $('#empty').hidden = false; renderStrip(); }
  log('i', 'tab closed; frame destroyed');
}

/* ------------------------------------------------------------- navigation */
async function goto(t, url, opts = {}) {
  if (!t) return;
  const push = opts.push !== false;
  if (!url) return;
  t.native = null;
  let j;
  try { j = await mint(url, 'd', t.id); }
  catch (e) { log('e', 'mint refused for ' + shortU(url) + ' — ' + e.message); toast('Umbra refused that address', 2600, 'warn'); return; }
  t.url = j.umbra;
  if (push) {
    t.hist = t.hist.slice(0, t.hi + 1);
    t.hist.push(j.umbra);
    t.hi = t.hist.length - 1;
  }
  t.href = j.href;
  t.loading = true;
  t.mode = 'wire';
  renderTab(t);
  mountFrame(t, { src: ORIGIN + j.href });
  fetchFavicon(t);
  log('d', 'GET ' + t.url);
  renderAddr();
  renderStatus();
}

function onFrameLoad(t) {
  let where = null;
  try {
    const w = t.frame.contentWindow;
    where = w && w.location ? w.location.href : null;
  } catch { where = null; }
  const offOrigin = where === null && t.mode === 'wire';
  if (t.mode === 'wire' && where && !where.startsWith(ORIGIN + PFX)) {
    // a script sent the frame somewhere Umbra does not control: undo it
    t.escapes = (t.escapes || 0) + 1;
    log('r', 'off-Umbra navigation attempted — frame reverted to ' + shortU(t.url));
    toast('a script tried to move this tab off Umbra. <b>reverted</b> and opened in a new tab instead', 4200, 'warn');
    const target = t.pendingNav || t.url;
    t.pendingNav = null;
    goto(t, target, { push: false, force: true });
    return;
  }
  if (offOrigin) {
    t.escapes = (t.escapes || 0) + 1;
    log('r', 'frame went off-origin (unreadable, cross-origin). reverted.');
    toast('the page tried to leave Umbra. reverted, nothing entered your browser history', 4200, 'warn');
    goto(t, t.url, { push: false, force: true });
    return;
  }
  t.loading = false;
  renderTab(t);
  syncFromFrame(t);
}

/** pull the last wire response's Umbra-Meta out of the frame's performance log */
/**
 * After every load, pull the truth out of the frame: which logical address it
 * ended up on (a page may have navigated itself), what it wants to be called,
 * how many bytes it cost, and whether the shim installed every hook. The frame
 * is same-origin by construction, so this is a plain property read.
 */
function syncFromFrame(t) {
  try {
    const w = t.frame.contentWindow;
    const d = w.document;
    const logical = w.UMBRA && w.UMBRA.url;
    if (logical && /^umbra:\/\//.test(logical) && logical !== t.url) {
      t.url = logical;
      if (t.hist[t.hi] !== logical) {
        t.hist = t.hist.slice(0, t.hi + 1);
        t.hist.push(logical);
        t.hi = t.hist.length - 1;
      }
    }
    if (d.title) t.title = d.title.trim().slice(0, 120);
    const g = w.__UMBRA_DIAG__;
    if (g) {
      t.shim = g.version + ' · ' + g.done.length + ' hooks';
      (g.failed || []).forEach((f) => log('e', 'shim hook failed in ' + shortU(t.url) + ': ' + f));
    }
    const nav = (w.performance && w.performance.getEntriesByType('navigation') || [])[0];
    if (nav) t.bytesOut = Math.round(nav.encodedBodySize || 0);
  } catch (e) {
    log('e', 'frame sync failed: ' + (e.message || e));
  }
  renderTab(t);
  renderAddr();
  renderOuterTitle();
}

/* ------------------------------------------------------------ messages */
addEventListener('message', async (ev) => {
  const d = ev.data;
  if (!d || d.umbra !== 1) return;
  const t = tab(d.tab) || active();
  switch (d.type) {
    case 'nav': {
      if (!t) return;
      if (d.wire && !d.url) return gotoWire(t, d.wire);
      t.pendingNav = d.url;
      /* a proxied SPA calling history.pushState is an in-place replace, never
         a new entry: the umbra tab keeps its own stack instead */
      await goto(t, d.url, { push: !d.replace });
      break;
    }
    case 'blocked':
      log('r', 'shim refused ' + (d.why || 'a capability') + ' inside ' + shortU(t ? t.url : ''));
      return;
    case 'search': {
      const q = String(d.q || '').trim();
      if (!q) return;
      await runSearch(t || active(), q);
      break;
    }
    case 'open': {
      const url = d.url || 'umbra://home/';
      log('s', 'window.open / new-tab request → ' + shortU(url));
      await newTab(url);
      break;
    }
    case 'redirect': {
      const target = d.url;
      if (!target || !t) return;
      t.held++;
      log('r', `redirect held: ${shortU(d.from || t.url)} → ${shortU(target)} (${d.status}) — split into its own background tab`);
      toast(`redirect to <b>${esc(hostOf(target))}</b> was split into its own tab`, 4200);
      await backgroundOpen(target);
      const back = t.hist[t.hi - 1] || t.url;
      if (d.holdHere) { /* capsule stays visible; nothing to restore */ }
      else goto(t, back, { push: false, force: true });
      renderTab(t);
      break;
    }
    case 'restore': {
      if (!t) return;
      goto(t, t.hist[t.hi] || t.url, { push: false, force: true });
      break;
    }
    case 'title': {
      if (!t) return;
      if (d.title) t.title = d.title.trim().slice(0, 120);
      renderStrip();
      renderOuterTitle();
      break;
    }
    case 'ready': {
      if (!t) return;
      if (d.url && d.url !== t.url) { t.url = d.url; renderAddr(); }
      renderTab(t);
      break;
    }
    case 'history': {
      if (!t) return;
      const ni = Math.min(t.hist.length - 1, Math.max(0, t.hi + (d.delta | 0)));
      if (ni !== t.hi) { t.hi = ni; goto(t, t.hist[ni], { push: false, force: true }); }
      break;
    }
    case 'panic': panic(); break;
    case 'close': closeTab(t ? t.id : S.active); break;
    case 'stats': pollStats(); break;
  }
}, false);

function fetchFavicon(t) {
  const host = hostOf(t.url);
  if (!host || !/\./.test(host)) return;
  mint('https://' + host + '/favicon.ico', 's', t.id)
    .then((j) => { t.fav = ORIGIN + j.href; renderStrip(); })
    .catch(() => {});
}

/* a search through Umbra is itself an Umbra document, so results live in the
   tab strip like everything else and never touch browser history */
async function runSearch(t, q) {
  if (!t) t = await newTab();
  return gotoWire(t, PFX + 'search?q=' + encodeURIComponent(q), 'umbra://search/?q=' + encodeURIComponent(q));
}

async function gotoWire(t, wirePath, label) {
  const abs = wirePath.startsWith('umbra://') ? null : wirePath;
  if (!abs) return goto(t, wirePath);
  t.url = label || t.url;
  t.href = abs;
  t.mode = 'wire';
  t.loading = true;
  if (t.hist[t.hi] !== t.url) { t.hist = t.hist.slice(0, t.hi + 1); t.hist.push(t.url); t.hi = t.hist.length - 1; }
  renderTab(t); renderAddr();
  mountFrame(t, { src: ORIGIN + abs });
  log('d', 'GET ' + t.url + ' (wire)');
}

function closeIfPortalless() {}

/* ------------------------------------------------------------- rendering */
function renderStrip() {
  const strip = $('#tabstrip');
  $$('.utab', strip).forEach((n) => {
    const t = tab(n.dataset.tab);
    if (!t) return n.remove();
    n.setAttribute('aria-selected', t.id === S.active ? 'true' : 'false');
    n.classList.toggle('busy', !!t.loading);
    n.classList.toggle('held', t.held > 0);
    $('.t', n).textContent = t.title || hostOf(t.url) || 'Umbra';
    $('.u', n).textContent = t.held ? t.held + '↗' : hostOf(t.url);
    const fav = $('.fav', n);
    fav.style.backgroundImage = t.fav ? `url("${t.fav}")` : 'none';
    fav.textContent = t.fav ? '' : (hostOf(t.url).charAt(0) || '◈').toUpperCase();
    fav.style.fontSize = '9px';
    fav.style.display = 'grid';
    fav.style.placeItems = 'center';
    fav.style.color = '#9db0c6';
  });
}
function renderTab(t) {
  if (!t || !t.pane) return;
  t.pane.classList.toggle('loading', !!t.loading);
  $('.bar .k', t.pane).textContent = t.loading ? 'loading' : t.mode === 'srcdoc' ? 'native umbra doc' : 'proxied';
  $('.bar .v', t.pane).textContent = ' · ' + shortU(t.url) + (t.held ? ` · ${t.held} redirect${t.held > 1 ? 's' : ''} held` : '') + (t.escapes ? ` · ${t.escapes} escape blocked` : '');
  renderStrip();
}
function renderAddr() {
  const t = active();
  const a = $('#addr');
  /* do not clobber mid-typing, but do resync once the value the user submitted
     has been resolved to a canonical umbra address */
  const focusedButSubmitted = document.activeElement === a && a.value === a.dataset.submitted;
  if (document.activeElement !== a || focusedButSubmitted) a.value = t ? shortU(t.url) : '';
  $('#back').disabled = !t || t.hi <= 0;
  $('#fwd').disabled = !t || t.hi >= t.hist.length - 1;
  $('#hint').textContent = t ? (t.held ? t.held + ' held redirect(s)' : '') : '';
}
function renderStatus() {
  const t = active();
  $('#stLeft').textContent = S.session ? 'session ' + S.session.slice(0, 8) : 'booting…';
  $('#stMid').textContent = t ? `${t.url}` : 'no tab';
  $('#stRight').textContent =
    `${S.tabs.length} umbra tab${S.tabs.length === 1 ? '' : 's'} · ` +
    `${S.stats.reqs || 0} wire reqs · ${fmtBytes(S.stats.bytes || 0)} · browser history: 1 entry`;
}
function renderLog() {
  const b = $('#logBody');
  if (!b) return;
  b.innerHTML = S.log.slice(0, 90).map((e) =>
    `<div class="entry"><span class="tag ${e.kind}">${e.at.toTimeString().slice(0, 8)}</span><span class="txt">${esc(e.text)}</span></div>`).join('');
  $('#logStats').textContent = S.log.length + ' events';
}

/* ---------------------------------------------------------- outer title */
const DOC = document;
let titleMutations = 0;
const titleObs = new MutationObserver(() => {
  if (!S.cloak.lock || S.cloak.real) return;
  if (DOC.title !== S.cloak.title) { titleMutations++; DOC.title = S.cloak.title; }
});
function renderOuterTitle() {
  if (S.cloak.real) { const t = active(); DOC.title = t ? (t.title || hostOf(t.url)) : 'umbra'; return; }
  DOC.title = S.cloak.title;
}
function applyCloak() {
  titleObs.disconnect();
  titleObs.observe(DOC.querySelector('title') || DOC.head, { childList: true, characterData: true, subtree: true });
  renderOuterTitle();
  $('#cloakDot').classList.toggle('off', S.cloak.real);
  const link = DOC.querySelector("link[rel=icon]");
  if (S.cloak.real && link) link.href = 'data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%234fd1b3'/></svg>");
}

/* --------------------------------------------------------------- actions */
async function interpret(text, inNewTab) {
  const s = String(text || '').trim();
  if (!s) return;
  let url;
  if (/^umbra:\/\//i.test(s)) url = s;
  else if (/^https?:\/\//i.test(s)) url = s.replace(/^https:/, 'umbra:').replace(/^http:/, 'umbra:');
  else if (/^[^\s]+\.[a-z]{2,}(:\d+)?([\/?#].*)?$/i.test(s)) url = 'umbra://' + s;
  else {
    const t = active() || (await newTab());
    return runSearch(t, s);
  }
  if (inNewTab) await newTab(url);
  else { const t = active() || await newTab(); await goto(t, url); }
}

async function panic() {
  log('r', 'PANIC — tabs, cookie jar and ledger destroyed');
  S.tabs.forEach((t) => {
    try {
      if (t.frame) { t.frame.src = 'about:blank'; t.frame.srcdoc = '<html></html>'; t.frame.remove(); }
    } catch {}
    t.node?.remove();
    t.pane?.remove();
  });
  S.tabs = [];
  S.active = null;
  S.log = [];
  S.minted.clear();
  try { sessionStorage.clear(); } catch {}
  try { await api('burn'); } catch {}
  $('#empty').hidden = false;
  renderStrip(); renderLog(); renderStatus(); renderAddr();
  toast('burned: <b>0 tabs, 0 cookies, 0 ledger entries</b>');
}

async function pollStats() {
  try {
    const j = await api('stats', {});
    S.stats = { reqs: j.reqs, bytes: j.bytes };
    renderStatus();
  } catch {}
}

/* ------------------------------------------------------------- wiring */
function wireUI() {
  $('#newtab').onclick = () => newTab();
  $('#homeBtn').onclick = () => { const t = active(); if (t) goto(t, 'umbra://home/', { force: true }); };
  $('#back').onclick = () => { const t = active(); if (t && t.hi > 0) { t.hi--; goto(t, t.hist[t.hi], { push: false, force: true }); } };
  $('#fwd').onclick = () => { const t = active(); if (t && t.hi < t.hist.length - 1) { t.hi++; goto(t, t.hist[t.hi], { push: false, force: true }); } };
  $('#reload').onclick = () => { const t = active(); if (t) goto(t, t.url, { push: false, force: true }); };
  $('#goBtn').onclick = () => { const a = $('#addr'); a.dataset.submitted = a.value; interpret(a.value, false); };
  $('#goNew').onclick = () => { const a = $('#addr'); a.dataset.submitted = a.value; interpret(a.value, true); };
  $('#addr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.dataset.submitted = e.target.value;
      const v = e.target.value;
      interpret(v, e.ctrlKey || e.metaKey);
    }
    if (e.key === 'Escape') e.target.blur();
  });
  $('#addr').addEventListener('input', (e) => {
    const s = e.target.value.trim();
    const kind = /^umbra:\/\//i.test(s) ? 'umbra address' : /^https?:\/\//i.test(s) ? 'url → umbra' :
      /^[^\s]+\.[a-z]{2,}/i.test(s) ? 'host → umbra' : s ? 'search query' : '';
    $('#hint').textContent = kind;
  });
  $('#splitBtn').onclick = () => {
    S.split = !S.split;
    $('#splitBtn').style.borderColor = S.split ? 'rgba(79,209,179,.5)' : '';
    if (S.split) applySplit(); else { const t = active(); $$('.pane').forEach((p) => { p.style.display = p.dataset.tab === (t && t.id) ? 'block' : 'none'; }); }
  };
  $('#logToggle').onclick = () => { $('#log').hidden = !$('#log').hidden; if (!$('#log').hidden) { pollStats(); } };
  $('#logClose').onclick = () => { $('#log').hidden = true; };
  $('#logClear').onclick = () => { S.log = []; renderLog(); };
  $('#panicBtn').onclick = panic;
  $('#emptyOpen').onclick = () => newTab('umbra://home/');
  $('#cloakBtn').onclick = () => $('#cloakDlg').showModal();
  $('#cloakApply').onclick = () => {
    const preset = $('#cloakPreset').value;
    const title = preset === '__real__' ? null : ($('#cloakTitle').value.trim() || 'Docs');
    S.cloak.real = preset === '__real__';
    S.cloak.title = title || 'Docs';
    S.cloak.lock = $('#cloakTitleLock').checked;
    S.cloak.burnOnLeave = $('#cloakBurnOnLeave').checked;
    if (S.cloak.real) $('#cloakTitle').value = ''; else $('#cloakTitle').value = S.cloak.title;
    applyCloak();
    toast(S.cloak.real ? 'cloak off — outer tab now mirrors the active Umbra tab' : 'outer tab renamed to <b>' + esc(S.cloak.title) + '</b>');
  };
  $('#cloakPreset').onchange = (e) => {
    if (e.target.value !== '__real__') $('#cloakTitle').value = e.target.value;
    else $('#cloakTitle').value = '(real title)';
  };
  $('#polRedirect').onchange = (e) => api('policy', { method: 'POST', body: JSON.stringify({ follow: e.target.value }) }).then(() => toast('redirect policy: <b>' + esc(e.target.value) + '</b>'));
  $('#polReferrer').onchange = (e) => api('policy', { method: 'POST', body: JSON.stringify({ referrer: e.target.value }) }).then(() => log('i', 'referer policy → ' + e.target.value));

  addEventListener('keydown', (e) => {
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 't') { e.preventDefault(); newTab(); }
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'w') { e.preventDefault(); closeTab(S.active); }
    else if ((e.ctrlKey || e.metaKey) && k === 'Tab') { e.preventDefault(); const i = S.tabs.findIndex((t) => t.id === S.active); select(S.tabs[(i + (e.shiftKey ? -1 : 1) + S.tabs.length) % S.tabs.length].id); }
    else if (k === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#addr').focus(); $('#addr').select(); }
    else if (k === '`' || k === '~') { panicCount++; clearTimeout(panicTimer); panicTimer = setTimeout(() => (panicCount = 0), 700); if (panicCount >= 2) { panicCount = 0; panic(); } }
  }, true);

  addEventListener('pagehide', () => { if (S.cloak.burnOnLeave) navigator.sendBeacon && navigator.sendBeacon(PFX + 'burn'); });
  setInterval(pollStats, 4000);
}
let panicCount = 0, panicTimer = 0;

/* console + test surface: window.__UMBRA__ is how the lab page and the test
   suite reach the shell's internals (state is intentionally not persisted) */
window.__UMBRA__ = {
  state: S,
  get tabs() { return S.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, mode: t.mode, shim: t.shim, held: t.held })); },
  go: (u, id) => goto(tab(id || S.active) || active(), u),
  open: (u) => newTab(u),
  post: (msg) => dispatchEvent(new MessageEvent('message', { data: msg, origin: ORIGIN })),
};

/* ------------------------------------------------------------ boot */
(async () => {
  wireUI();
  try {
    const j = await api('boot');
    S.session = j.session;
    log('i', 'umbra/1 origin ready · session ' + (j.session || '').slice(0, 8) + ' · modes ' + (j.modes || []).join(','));
  } catch (e) {
    log('e', 'boot failed: ' + e.message);
  }
  applyCloak();
  $('#empty').hidden = false;
  await newTab('umbra://home/');
  S.booting = false;
  renderStatus();
  renderLog();
})();
})();
