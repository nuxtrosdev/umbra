#!/usr/bin/env node
/*
 * Umbra offline browser test. Drives the real shell in headless Chromium and
 * asserts the parts only a browser can prove — same-origin frames, shim
 * behaviour, redirect following, media decode, detached-frame adoption, the
 * many-frames perf guard — with every byte served from loopback (mock
 * upstream + Umbra origin are spawned automatically).
 *
 * Browser resolution: `playwright` with bundled browsers first (dev
 * machines), otherwise @sparticuz/chromium + playwright-core (works with
 * nothing but npm registry access):
 *
 *   node umbra-proxy/test/browser-offline.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = Number(process.env.MOCK_PORT || 4181);
const UMBRA_PORT = Number(process.env.UMBRA_PORT || 4174);
const BASE = `http://127.0.0.1:${UMBRA_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const U = (p) => `umbra://127.0.0.1:${MOCK_PORT}${p}`;

const results = [];
const ok = (n, c, note = '') => {
  results.push({ n, c: !!c, note: String(note ?? '').slice(0, 200) });
  console.log(`${c ? '  ok  ' : ' FAIL  '} ${n}${note !== '' ? '  — ' + String(note).slice(0, 200) : ''}`);
};

const kids = [];
async function waitFor(url, label) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(label + ' never came up at ' + url);
}

async function launchBrowser() {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url + '/driver-scope.cjs');
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'];
  try {
    const pw = require('playwright');
    try {
      return await pw.chromium.launch({ args });
    } catch {
      console.log('(playwright has no usable bundled browser here; trying @sparticuz/chromium)');
    }
  } catch {}
  let sparticuz, core;
  try {
    sparticuz = require('@sparticuz/chromium');
    core = require('playwright-core');
  } catch {
    console.error('\nno browser driver found. Install one of:\n  npm i -D playwright && npx playwright install chromium   (dev machines)\n  npm i -D @sparticuz/chromium playwright-core              (registry-only sandboxes)\n');
    process.exit(2);
  }
  const Chromium = sparticuz.default || sparticuz;
  const exe = await Chromium.executablePath();
  const entry = require.resolve('@sparticuz/chromium');
  await sparticuz.inflate(path.join(path.dirname(entry), '..', 'bin', 'al2023.tar.br'));
  sparticuz.setupLambdaEnvironment(path.join(tmpdir(), 'al2023', 'lib'));
  return core.chromium.launch({ executablePath: exe, args });
}

const browser = await (async () => {
  kids.push(spawn(process.execPath, [path.join(HERE, 'mock-upstream.mjs'), String(MOCK_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] }));
  kids.push(spawn(process.execPath, [path.join(HERE, '..', 'server', 'index.mjs')],
    { env: { ...process.env, PORT: String(UMBRA_PORT), UMBRA_YT_BASE: MOCK }, stdio: ['ignore', 'pipe', 'pipe'] }));
  await waitFor(`${MOCK}/health`, 'mock upstream');
  await waitFor(`${BASE}/~umbra/boot`, 'umbra origin');
  return launchBrowser();
})();

const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const page = await ctx.newPage();
const popups = [];
const errors = [];
const requests = [];
const dialogs = [];
page.on('popup', (p) => popups.push(p.url()));
page.on('pageerror', (e) => {
  const stack = String((e && e.stack) || '') + String((e && e.message) || '');
  if (/\/~umbra\/(shim\.js|player\.js|shell\.js|doc\/|lab\/)|__UMBRA|UMBRA\.\w/.test(stack)) errors.push('pageerror(umbra): ' + e.message.slice(0, 160));
});
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (!/Failed to load resource|Refused to load|Content Security Policy|net::|favicon/i.test(t)) {
    errors.push('console.error: ' + t.slice(0, 140));
  }
});
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss().catch(() => {}); });
ctx.on('request', (r) => requests.push(r.url()));
const badResponses = [];
ctx.on('response', (r) => {
  if (r.status() >= 400 && /\/~umbra\/(lab|doc|search|shim\.js|mint|boot)\b/.test(r.url())) {
    badResponses.push(r.status() + ' ' + r.url().slice(0, 90));
  }
});

const D = `(document.querySelector('.pane[data-active] iframe') || {}).contentDocument`;
const inDoc = (fn, arg) =>
  page.evaluate(`(() => { const d = ${D}; if (!d) return null; try { return (${fn})(d, ${JSON.stringify(arg)}); } catch (e) { return 'ERR:' + e.message; } })()`);
const clickIn = (sel) =>
  page.evaluate(`(() => { const d = ${D}; const el = d && d.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'clicked'; })()`);
const txtIn = (sel) =>
  page.evaluate(`(() => { const d = ${D}; const e = d && d.querySelector(${JSON.stringify(sel)}); return e ? e.textContent : ''; })()`);
const addr = () => page.evaluate(() => { const t = window.__UMBRA__.state.tabs.find((x) => x.id === window.__UMBRA__.state.active); return (t && t.url) || ''; });
const tabs = () => page.$$eval('.utab', (n) => n.length);
const hist = () => page.evaluate(() => history.length);
const go = async (url, ms = 2500) => {
  await page.fill('#addr', url);
  await page.press('#addr', 'Enter');
  await page.waitForTimeout(ms);
};

console.log('\nUMBRA / browser-offline');

try {
  /* -------------------------------------------------- boot + cloak */
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane[data-active]', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const startUrl = page.url();
  const hist0 = await hist();
  ok('shell boots with one umbra tab', (await tabs()) === 1, 'tabs: ' + await tabs());
  ok('portal rendered in a frame', await inDoc((d) => !!d && /Portal/.test(d.body.innerText)));
  const sandbox = await page.$eval('.pane[data-active] iframe', (f) => f.getAttribute('sandbox'));
  ok('frame sandbox forbids top navigation and popups',
    /allow-same-origin/.test(sandbox) && !/top-navigation/.test(sandbox) && !/\sallow-popups(\s|$|')/.test(sandbox), sandbox);
  ok('outer title is the cloak label', (await page.title()) === 'Docs', JSON.stringify(await page.title()));
  ok('boot traffic entirely same-origin', requests.every((u) => u.startsWith(BASE)), requests.length + ' requests');

  /* -------------------------------------------------- mock document */
  await go(U('/'), 3200);
  ok('mock doc loads in the same tab', new RegExp(`127\\.0\\.0\\.1:${MOCK_PORT}`).test(await addr()) && (await tabs()) === 1, await addr());
  ok('no shim hook failed', await inDoc((d) => { const g = d.defaultView.__UMBRA_DIAG__; return g && g.failed.length === 0; }),
    JSON.stringify(await inDoc((d) => (d.defaultView.__UMBRA_DIAG__ || {}).failed)));
  ok('content readable, frame same-origin with shell',
    /Mock Origin/.test(await txtIn('h1')) && await inDoc((d) => d.defaultView.location.origin === document.location.origin));
  ok('navigation added no history entry', (await hist()) === hist0, `${hist0} → ${await hist()}`);
  ok('outer URL unchanged', page.url() === startUrl, page.url());

  const before = await addr();
  await clickIn('a[href]');
  await page.waitForTimeout(2800);
  ok('in-page link click moved the umbra tab', (await addr()) !== before, before + ' → ' + await addr());
  ok('click added no history entry', (await hist()) === hist0, String(await hist()));

  /* -------------------------------------------------- images decode */
  await go(U('/'), 3500);
  const imgs = await inDoc((d) => [...d.querySelectorAll('img')].map((i) => ({ w: i.naturalWidth, o: i.currentSrc.startsWith(document.location.origin) || i.currentSrc.startsWith('data:') })));
  ok('images decoded through the proxy', imgs.length >= 4 && imgs.filter((i) => i.w > 0).length >= 4,
    imgs.map((i) => i.w + 'px').join(','));
  ok('no image fetched from its own host', imgs.every((i) => i.o), 'all same-origin');

  /* -------------------------------------------------- media: tone + clip */
  await go(U('/media'), 5000);
  const audio = await inDoc((d) => {
    const a = d.querySelector('#tone');
    if (!a) return null;
    return { src: a.currentSrc.slice(0, 50), dur: a.duration, seekable: a.seekable.length, sameOrigin: a.currentSrc.startsWith(document.location.origin) };
  });
  ok('audio got a proxied same-origin src', audio && audio.sameOrigin && /\/~umbra\//.test(audio.src), JSON.stringify(audio));
  ok('audio decoded through the proxy (duration ~1s)', audio && Math.abs(audio.dur - 1) < 0.25, 'dur=' + (audio && audio.dur));
  const seeked = await inDoc((d) => {
    const a = d.querySelector('#tone');
    return new Promise((res) => {
      if (!a) return res(null);
      a.addEventListener('seeked', () => res(a.currentTime), { once: true });
      setTimeout(() => res('timeout:' + a.currentTime), 6000);
      a.currentTime = 0.5;
    });
  });
  ok('audio seek works (Range survived the proxy)', typeof seeked === 'number' && Math.abs(seeked - 0.5) < 0.2, 'currentTime ' + seeked);
  const vinfo = await inDoc((d) => {
    const v = d.querySelector('#clip');
    return v ? { sameOrigin: v.currentSrc.startsWith(document.location.origin), err: v.error ? v.error.code : 0 } : null;
  });
  ok('video src on the wire and the tab intact', vinfo && vinfo.sameOrigin, JSON.stringify(vinfo));

  /* -------------------------------------------------- runtime net refs */
  await go(U('/probe-net'), 5000);
  const netOut = await txtIn('#o');
  ok('page-side fetch() re-anchored to the wire', /fetch -> 200/.test(netOut), netOut.split('\n')[0]);
  ok('relative XHR resolved against the logical base', /XHR relative -> 200/.test(netOut), netOut.split('\n')[1]);
  ok('beacon re-anchored', /beacon sent/.test(netOut));

  /* -------------------------------------------------- forms through mode f */
  await go(U('/'), 3000);
  await clickIn('form[method="get"] button');
  await page.waitForTimeout(2800);
  ok('GET submit serialised into an umbra navigation', new RegExp(`umbra://127\\.0\\.0\\.1:${MOCK_PORT}/get\\?q=x`).test(await addr()), await addr());
  await go(U('/'), 3000);
  await clickIn('form[method="post"] button');
  await page.waitForTimeout(2800);
  ok('POST submit forwarded, response rendered in-frame', /hello from umbra/.test(await inDoc((d) => d.body.innerText)), (await txtIn('body')).slice(0, 80));

  /* -------------------------------------------------- redirect: same tab */
  const t0 = await tabs();
  await go(U(`/redirect-to?url=${encodeURIComponent(`http://localhost:${MOCK_PORT}/other`)}&status_code=302`), 5500);
  ok('cross-host 3xx lands in the SAME umbra tab', (await tabs()) === t0, `${t0} → ${await tabs()} tabs`);
  ok('no real browser window opened', popups.length === 0 && (await ctx.pages()).length === 1, 'popups ' + popups.length);
  ok('address bar shows the final address', new RegExp(`umbra://localhost:${MOCK_PORT}/other`).test(await addr()), await addr());
  ok('final document rendered in the tab', /other host doc/.test(await txtIn('body')), (await txtIn('body')).slice(0, 60));
  ok('hop count recorded on the tab', await page.evaluate(() => {
    const s = window.__UMBRA__.state; const t = s.tabs.find((x) => x.id === s.active);
    return !!(t && t.hops && t.hops.length === 2);
  }), JSON.stringify(await page.evaluate(() => {
    const s = window.__UMBRA__.state; const t = s.tabs.find((x) => x.id === s.active);
    return t && t.hops;
  })));
  await go('umbra://lab/samehost', 2500);
  ok('same-host redirect spawns no tab', /silently followed/.test(await txtIn('body')));

  /* -------------------------------------------------- storage cloak */
  await go('umbra://lab/storage', 3500);
  await clickIn('button.go');
  await page.waitForTimeout(800);
  ok('localStorage write works but is memory-backed', /written at/.test(await txtIn('#o')), (await txtIn('#o')).slice(0, 50));
  ok('shell origin kept no storage from proxied sites', (await page.evaluate(() => Object.keys(localStorage).length)) === 0);

  /* -------------------------------------------------- escape revert */
  const histBeforeEscape = await hist();
  await go('umbra://lab/js', 3000);
  await clickIn('button.go');
  await page.waitForTimeout(3500);
  ok('scripted off-origin location.href never moved the browser tab', page.url() === startUrl, page.url());
  ok('frame reverted onto the wire', /lab\/js/.test(await addr()), await addr());
  const ledg = await page.$$eval('#logBody .entry', (n) => n.map((x) => x.textContent).join(' | '));
  ok('reversion recorded in the ledger', /off-origin|revert|escape/i.test(ledg), ledg.slice(0, 120));
  ok('escape costs at most one joint-history entry', (await hist()) - histBeforeEscape <= 1);

  /* -------------------------------------------------- window.open */
  const t2 = await tabs();
  await go('umbra://lab/windowopen', 3000);
  await clickIn('button.go');
  await page.waitForTimeout(3500);
  ok('window.open became an umbra tab, not a window', (await ctx.pages()).length === 1 && popups.length === 0 && (await tabs()) > t2,
    `tabs ${t2}→${await tabs()}`);

  /* -------------------------------------------------- scheme policy */
  await go('umbra://lab/schemes', 3000);
  const schemeOut = await txtIn('#out');
  ok('js: inerted, data: kept, http rewired (live DOM)', /umbra:inert/.test(schemeOut) && /data src kept=true/.test(schemeOut) && /ext href on wire=true/.test(schemeOut), schemeOut.slice(0, 120));

  /* -------------------------------------------------- meta refresh */
  const t3 = await tabs();
  await go('umbra://lab/meta', 8000);
  ok('meta refresh stays in the same tab', (await tabs()) === t3, `${t3} → ${await tabs()} tabs`);
  ok('meta refresh moved the tab to the target', /umbra:\/\/en\.wikipedia\.org/.test(await addr()), await addr());
  ok('meta target shows a document, never a blank tab', (await inDoc((d) => (d.body.innerText || '').trim().length)) > 40);

  /* ------------------------------------------ detached-frame adoption */
  await go(U('/'), 3000);
  const adopted = await inDoc((d, mockPort) => {
    const f = d.createElement('iframe');
    d.body.appendChild(f);
    /* a detached frame has no document in this engine (contentDocument reads
       null until insertion), so the earliest writable moment is right here —
       and the realm must already be adopted by then. */
    f.contentDocument.open();
    f.contentDocument.write('<body><img src="http://127.0.0.1:' + mockPort + '/photo.jpg"></body>');
    f.contentDocument.close();
    const img = f.contentDocument.querySelector('img');
    return img ? img.src : 'no-img';
  }, MOCK_PORT);
  ok('write() into a detached frame is rewired on first touch', String(adopted).startsWith(BASE + '/~umbra/'), String(adopted).slice(0, 80));

  /* ------------------------------------------ many-frames perf guard */
  const perfT0 = Date.now();
  await go(U('/many?n=60'), 14000);
  const perfMs = Date.now() - perfT0;
  const kids2 = await inDoc((d) => {
    const fs = [...d.querySelectorAll('iframe')];
    let shimmed = 0;
    for (const f of fs) { try { if (f.contentWindow && f.contentWindow.__UMBRA_SHIM__) shimmed++; } catch (e) {} }
    return { n: fs.length, shimmed };
  });
  ok('60 nested frames settle quickly (adoption is O(1) per frame)', kids2.n === 60 && perfMs < 30000, `${kids2.n} frames in ${(perfMs / 1000).toFixed(1)}s`);
  ok('nested wire frames carry the server shim', kids2.shimmed >= 50, kids2.shimmed + '/60');
  ok('top frame diag still clean after the storm', await inDoc((d) => { const g = d.defaultView.__UMBRA_DIAG__; return g && g.failed.length === 0; }));

  /* -------------------------------------------------- tab strip ops */
  const histBeforeTabs = await hist();
  const tN = await tabs();
  await page.click('#newtab');
  await page.waitForTimeout(1500);
  ok('new-tab button adds a tab', (await tabs()) === tN + 1, `${tN} → ${await tabs()}`);
  await page.click('.utab:nth-last-child(2) .x');
  await page.waitForTimeout(900);
  ok('close button removes one tab', (await tabs()) === tN, 'now ' + await tabs());
  await page.click('#reload');
  await page.waitForTimeout(2500);
  ok('reload keeps the tab count stable', Math.abs((await tabs()) - tN) <= 1);
  const histAfterTabs = await hist();

  /* -------------------------------------------------- audits */
  const histFinal = await hist();
  ok('history grew by at most the deliberate escape probe', histFinal - hist0 <= 1, `${hist0} → ${histFinal}`);
  ok('tab switching + reload added zero history entries', histAfterTabs - histBeforeTabs === 0, `${histBeforeTabs} → ${histAfterTabs}`);
  const offOrigin = requests.filter((u) => !u.startsWith(BASE) && !/^(data|about|blob):/.test(u));
  const leaky = offOrigin.filter((u) => !/^https:\/\/example\.com\/$/.test(u));
  ok('off-origin requests are only the deliberate escape probe', leaky.length === 0,
    'off-origin ' + offOrigin.length + ' unexplained ' + leaky.length + ' ' + JSON.stringify(leaky.slice(0, 2)));
  ok('wire carried subresources (runtime mint + media seen)', requests.some((u) => /\/~umbra\/(p|m)\//.test(u)),
    requests.filter((u) => /\/~umbra\/(p|m)\//.test(u)).length + ' wire subrequests');
  ok('no dialogs surfaced', dialogs.length === 0, JSON.stringify(dialogs.slice(0, 2)));
  ok('no uncaught errors from umbra-authored scripts', errors.length === 0, JSON.stringify(errors.slice(0, 4)));
  ok('no failed umbra-authored responses', badResponses.length === 0, JSON.stringify(badResponses.slice(0, 3)));

  /* -------------------------------------------------- panic */
  await page.click('#panicBtn');
  await page.waitForTimeout(1300);
  ok('panic wiped the tab strip', (await tabs()) === 0, 'tabs: ' + await tabs());
  ok('panic destroyed all frames', page.mainFrame().childFrames().length === 0);
  ok('panic added no history entry', (await hist()) === histAfterTabs);
  ok('panic left the browser tab where it was', page.url() === startUrl, page.url());

  const failed = results.filter((r) => !r.c);
  console.log(`\n${results.length - failed.length}/${results.length} browser-offline checks passed`);
  if (failed.length) failed.forEach((f) => console.log('  ✗ ' + f.n + '  ' + f.note));
  console.log(`\nnetwork: ${requests.length} requests, all same-origin except the escape probe`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close().catch(() => {});
  for (const k of kids) { try { k.kill('SIGTERM'); } catch {} }
}
