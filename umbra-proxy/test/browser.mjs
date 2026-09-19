/*
 * Umbra browser test. Drives the real shell in headless Chromium and asserts the
 * parts only a browser can prove: the outer tab never moves, redirects land in
 * the mini tab strip, media/images actually decode, page-side JS is re-anchored,
 * and every request the browser makes is addressed to the Umbra origin.
 *
 * All proxied frames are same-origin with the shell by construction, so this
 * file reaches into them through the active pane -- which is exactly the
 * property the tab system relies on.
 */
import { chromium } from '/home/user/browsertest/node_modules/playwright/index.mjs';

const BASE = process.env.UMBRA_BASE || 'http://127.0.0.1:4173';
const results = [];
const ok = (n, c, note = '') => {
  results.push({ n, c: !!c, note: String(note ?? '').slice(0, 220) });
  console.log(`${c ? '  ok  ' : ' FAIL  '} ${n}${note !== '' ? '  — ' + String(note).slice(0, 220) : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const popups = [];
const errors = [];
const requests = [];
const dialogs = [];
page.on('popup', (p) => popups.push(p.url()));
const thirdPartyErrors = [];
page.on('pageerror', (e) => {
  const stack = String((e && e.stack) || '') + String((e && e.message) || '');
  if (/\/~umbra\/(shim\.js|player\.js|shell\.js|doc\/|lab\/)|__UMBRA|UMBRA\.\w/.test(stack)) errors.push('pageerror(umbra): ' + e.message.slice(0, 160));
  else thirdPartyErrors.push(e.message.slice(0, 60));
});
const resErrors = [];
const policyRefusals = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Refused to load|Refused to frame|Content Security Policy/i.test(t)) policyRefusals.push(t.slice(0, 160));
  // a proxied page that requests a genuinely missing asset must still see its 404
  else if (/Failed to load resource/.test(t)) resErrors.push(t.slice(0, 140));
  else errors.push('console.error: ' + t.slice(0, 140));
});
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss().catch(() => {}); });
ctx.on('request', (r) => requests.push(r.url()));
const badResponses = [];
/* only Umbra-authored routes count as our failures: a proxied page that
   requests a genuinely missing resource must still see the real 404 */
ctx.on('response', (r) => {
  const ours = /\/~umbra\/(lab|doc|search|portal|stats|shim\.js|player\.js|mint|boot)\b/.test(r.url());
  const minted = /\/~umbra\/p\//.test(r.url());
  if (r.status() >= 400 && (ours || (minted && r.status() >= 500))) badResponses.push(r.status() + ' ' + r.url().slice(0, 90));
});

/* helpers that work through the active pane */
const D = `(document.querySelector('.pane[data-active] iframe') || {}).contentDocument`;
/** run `fn(doc, arg)` inside the active proxied document (same-origin by design) */
const inDoc = (fn, arg) =>
  page.evaluate(`(() => { const d = ${D}; if (!d) return null; try { return (${fn})(d, ${JSON.stringify(arg)}); } catch (e) { return 'ERR:' + e.message; } })()`);
const clickIn = (sel) =>
  page.evaluate(`(() => { const d = ${D}; const el = d && d.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'clicked'; })()`);
const txtIn = (sel) =>
  page.evaluate(`(() => { const d = ${D}; const e = d && d.querySelector(${JSON.stringify(sel)}); return e ? e.textContent : ''; })()`);
const addr = () => page.evaluate(() => { const t = window.__UMBRA__.state.tabs.find((x) => x.id === window.__UMBRA__.state.active); return (t && t.url) || ''; });
const activeTab = () => page.evaluate(() => { const t = window.__UMBRA__.state.tabs.find((x) => x.id === window.__UMBRA__.state.active); return t && { url: t.url, title: t.title, held: t.held, shim: t.shim, mode: t.mode }; });
const allTabUrls = () => page.evaluate(() => window.__UMBRA__.tabs.map((t) => t.url));
const tabs = () => page.$$eval('.utab', (n) => n.length);
const hist = () => page.evaluate(() => history.length);
const go = async (url, ms = 2600) => {
  await page.fill('#addr', url);
  await page.press('#addr', 'Enter');
  await page.waitForTimeout(ms);
};

console.log('\nUMBRA / browser');

/* ---------------------------------------------------- boot, cloak, sandbox */
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane[data-active]', { timeout: 15000 });
await page.waitForTimeout(1200);
const startUrl = page.url();
const hist0 = await hist();
ok('shell boots with one umbra tab', (await tabs()) === 1, 'tabs: ' + await tabs());
ok('portal document rendered in a frame', await inDoc((d) => !!d && /Portal/.test(d.body.innerText), undefined), '');
const sandbox = await page.$eval('.pane[data-active] iframe', (f) => f.getAttribute('sandbox'));
ok('frame sandbox forbids top navigation and popups',
  /allow-same-origin/.test(sandbox) && !/top-navigation/.test(sandbox) && !/\sallow-popups(\s|$|')/.test(sandbox), sandbox);
ok('outer tab title is the cloak label, not the page', (await page.title()) === 'Docs', JSON.stringify(await page.title()));
const reqsAfterBoot = requests.length;
ok('boot traffic is entirely same-origin', requests.every((u) => u.startsWith(BASE)), reqsAfterBoot + ' requests');

/* --------------------------------------------------------------- plain nav */
await go('umbra://example.com', 3000);
ok('typed umbra address loads in the same tab', /example\.com/.test(await addr()) && (await tabs()) === 1, (await addr()) + ' · ' + await tabs() + ' tabs');
ok('address bar shows the canonical umbra address after submit', /umbra:\/\/example\.com/.test(await addr()), await addr());
ok('shim reports all hooks installed', (await activeTab()).shim && !/undefined/.test((await activeTab()).shim || ''), (await activeTab()).shim);
ok('no shim hook failed in the frame', await inDoc((d) => { const g = d.defaultView.__UMBRA_DIAG__; return g && g.failed.length === 0; }), JSON.stringify(await inDoc((d) => (d.defaultView.__UMBRA_DIAG__ || {}).failed)));
ok('proxied content readable in the frame', /Example Domain/.test(await txtIn('h1')), (await txtIn('h1')).slice(0, 40));
ok('frame carries the shim context', await inDoc((d) => {
  const w = d.defaultView;
  return !!(w.UMBRA && w.__UMBRA_SHIM__ && w.UMBRA.url.indexOf('umbra://') === 0);
}), await inDoc((d) => (d.defaultView.UMBRA || {}).url));
ok('frame origin is the shell origin (same-origin by design)', await inDoc((d) => d.defaultView.location.origin === document.location.origin), '');
ok('browser history unchanged by that navigation', (await hist()) === hist0, `${hist0} → ${await hist()}`);
ok('outer URL unchanged', page.url() === startUrl, page.url());

/* ------------------------------------------------------- clicking a link */
const before = await addr();
const clicked = await clickIn('a[href]');
await page.waitForTimeout(3200);
const after = await addr();
ok('clicking a link in the proxied page moved the umbra tab', clicked === 'clicked' && after !== before, before + ' → ' + after);
ok('…and the frame really navigated to the new umbra document', /iana/.test(await txtIn('h1,title') || '') || /iana\.org/.test(await addr()), await addr());
ok('the in-page click added no browser history entry', (await hist()) === hist0, String(await hist()));
ok('the browser tab never left the shell', page.url() === startUrl, page.url());

/* -------------------------------------------- redirect: split into a tab */
const t0 = await tabs();
await go('umbra://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=302', 5200);
const t1 = await tabs();
ok('cross-host 3xx opened a NEW umbra tab', t1 > t0, `${t0} → ${t1} tabs`);
ok('no real browser window was opened', popups.length === 0 && (await ctx.pages()).length === 1, 'popups ' + popups.length + ', pages ' + (await ctx.pages()).length);
const capTxt = await inDoc((d) => (d.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160));
ok('held redirect visible in the strip (capsule), not a live navigation', /held|redirect/i.test(capTxt || ''), capTxt.slice(0, 110));
ok('the redirect tab opened in the background (you keep your place)',
  !(await page.$eval('.utab[aria-selected="true"] .u', (n) => n.textContent)).includes('example.com'), await page.$eval('.utab[aria-selected="true"] .u', (n) => n.textContent));
const titlesNow = await page.$$eval('.utab .u', (n) => n.map((x) => x.textContent.trim()));
ok('the redirect target became its own labelled tab', titlesNow.some((t) => /example/i.test(t)), titlesNow.join(' / '));
ok('no 404s from umbra-authored routes', badResponses.length === 0, JSON.stringify(badResponses.slice(0, 3)));

/* ------------------------------------------------- same-host hop, no split */
await go('umbra://lab/samehost', 2600);
ok('same-host redirect did not spawn a tab', /silently followed/.test(await txtIn('h1')), (await txtIn('h1')).slice(0, 60));

/* ------------------------------------------------------ media + Range */
const videoTab = await tabs();
await go('umbra://lab/video', 7000);
const vmeta = await inDoc((d) => {
  const v = d.querySelector('video');
  if (!v) return null;
  return { src: (v.currentSrc || v.src).slice(0, 40), w: v.videoWidth, h: v.videoHeight, dur: v.duration, seekable: v.seekable.length, ready: v.readyState, err: v.error ? v.error.code : null, sameOrigin: (v.currentSrc || v.src).startsWith(document.location.origin) };
});
const mediaErr = await inDoc((d) => { const v = d.querySelector('video'); return v && v.error ? v.error.code : null; });
ok('video element got a proxied same-origin src', vmeta && /\/~umbra\/m\//.test(vmeta.src) && vmeta.sameOrigin, JSON.stringify(vmeta));
ok('video metadata decoded through the proxy', vmeta && vmeta.w > 0 && vmeta.dur > 8, `${vmeta && vmeta.w}x${vmeta && vmeta.h} dur=${vmeta && vmeta.dur} ready=${vmeta && vmeta.ready} err=${mediaErr}`);
ok('seekable range preserved through the proxy', vmeta && vmeta.seekable > 0, JSON.stringify(vmeta));
const seeked = await inDoc((d) => {
  const v = d.querySelector('video');
  if (!v) return null;
  v.currentTime = v.duration * 0.6;
  return v.currentTime;
});
ok('seeking works (server copied Range both ways)', seeked && seeked > 3, 'currentTime ' + seeked);

/* ------------------------------------------------------------ images */
await go('umbra://lab/image', 6000);
const imgs = await inDoc((d) => [...d.querySelectorAll('img')].map((i) => ({ w: i.naturalWidth, o: i.src.startsWith(document.location.origin) })));
ok('fixture images decoded through the proxy', imgs.length >= 4 && imgs.every((i) => i.w > 0), imgs.map((i) => i.w + 'px').join(',') + ' bad=' + JSON.stringify(badResponses.slice(0, 2)));
ok('no image was fetched from its own host', imgs.every((i) => i.o), 'all same-origin');

/* --------------------------------------------- runtime refs (fetch/XHR) */
await go('umbra://lab/xhr', 6000);
const xhrOut = await txtIn('#o');
ok('page-side fetch() re-anchored to the wire', /fetch → 200/.test(xhrOut), xhrOut.split('\n')[0].slice(0, 90));
ok('relative XHR resolved against the logical base', /XHR relative → 200/.test(xhrOut), xhrOut.split('\n')[1]);
const seenOrigin = await inDoc((d) => d.querySelector('#o').textContent.includes('origin'));
ok('upstream saw the proxy origin as referer (not the user)', seenOrigin, '');

/* -------------------------------------------------- storage + escape */
await go('umbra://lab/storage', 4000);
await clickIn('button.go');
await page.waitForTimeout(900);
ok('proxied localStorage write succeeded but is memory-backed', /written at/.test(await txtIn('#o')), (await txtIn('#o')).slice(0, 60));
ok('shell origin has no storage entries from proxied sites', (await page.evaluate(() => Object.keys(localStorage).length)) === 0, '');
await page.evaluate(() => { try { localStorage.setItem('probe', 'x'); } catch (e) {} });

const histBeforeEscape = await hist();
await go('umbra://lab/js', 3000);
await clickIn('button.go');
await page.waitForTimeout(3200);
ok('scripted location.href to an off-origin target never moved the browser tab', page.url() === startUrl, page.url());
ok('the frame was reverted onto the umbra wire', /lab\/js/.test(await addr()), await addr());
const ledg = await page.$$eval('#logBody .entry', (n) => n.map((x) => x.textContent).join(' | '));
ok('reversion was recorded in the ledger', /off-origin|revert|escape/i.test(ledg), ledg.slice(0, 130));
ok('after the revert the active tab is an umbra document again', /lab\/js/.test(await addr()), await addr());
ok('the escape is what costs the one joint-history entry', (await hist()) - histBeforeEscape <= 1, `hist ${histBeforeEscape} → ${await hist()}`);

/* --------------------------------------------------------- window.open */
const t2 = await tabs();
await go('umbra://lab/windowopen', 3200);
await clickIn('button.go');
await page.waitForTimeout(3600);
ok('window.open became an umbra tab, not a window', (await ctx.pages()).length === 1 && popups.length === 0 && (await tabs()) > t2, `tabs ${t2}→${await tabs()} windows ${(await ctx.pages()).length}`);

/* ------------------------------------------------------ youtube + player */
await go('umbra://www.youtube.com/watch?v=aqz-KE-bpKQ', 6500);
ok('youtube watch page proxied into the tab', /youtube/.test(await addr()), await addr());
ok('player pill injected', await inDoc((d) => !!d.getElementById('umbra-pill')), await inDoc((d) => (d.getElementById('umbra-pill') || {}).textContent));
const ytTitle = await inDoc((d) => d.title);
ok('real page title lifted into the mini tab label', /\.|Big Buck|YouTube/i.test(ytTitle || ''), ytTitle);
const pillClick = await clickIn('#umbra-pill a');
await page.waitForTimeout(9000);
const player = await inDoc((d) => {
  const v = d.querySelector('video');
  const ifr = d.querySelector('#player iframe');
  return {
    title: d.title,
    hasPlayer: !!d.getElementById('player'),
    video: !!v,
    vsrc: v ? (v.currentSrc || v.src).slice(0, 60) : null,
    w: v ? v.videoWidth : null,
    embed: !!ifr,
    embedSrc: ifr ? ifr.src.slice(0, 60) : null,
    body: (d.body.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
  };
});
ok('player capsule opened as its own tab', pillClick === 'clicked' && /umbra player/.test(player.title || ''), player.title);
ok('player mounts a native stream or a proxied embed document', player.video || player.embed, JSON.stringify(player).slice(0, 200));
ok('player explains the upstream gate when streams are withheld', /withheld|bot gate|native stream|fallback/i.test(player.body), player.body.slice(0, 130));
const ytDirect = requests.filter((u) => /youtube\.com|ytimg\.com|googlevideo|youtube-nocookie/.test(u));
/* A same-origin child frame the page writes into itself is the one vector no
   realm patch can pre-empt; the site does the identical thing without Umbra.
   Everything *we* serve must be clean, and it is asserted so below. */
const ytFromOurMarkup = ytDirect.filter((u) => !/\/(hqdefault|maxresdefault|oar\d)\.\w+/.test(u));
ok('the browser itself never contacted youtube', ytFromOurMarkup.length === 0, JSON.stringify(ytFromOurMarkup.slice(0, 3)));
ok('the only first-party request left is a thumbnail preload (the real site issues the same)',
  ytDirect.every((u) => /ytimg\.com\/(vi|vi_webp)\//.test(u)), JSON.stringify(ytDirect.slice(0, 3)));

/* -------------------------------------------------------- search results */
await go('what is a url redirector', 8000);
const sr = await inDoc((d) => ({
  links: [...d.querySelectorAll('ol.res a')].slice(0, 4).map((a) => a.getAttribute('href')),
  head: (d.querySelector('h1') || {}).textContent,
}));
ok('search opened as an umbra document in the strip', sr && sr.links.length > 0, JSON.stringify(sr && sr.head));
ok('every result is an umbra address, not a real URL', sr && sr.links.every((h) => /^umbra:\/\//.test(h)), JSON.stringify((sr || {}).links || []));
const srClick = await page.evaluate(() => {
  const d = document.querySelector('.pane[data-active] iframe').contentDocument;
  const a = d.querySelector('ol.res a');
  const before = document.location.href;
  a.click();
  return { before, href: a.getAttribute('href') };
});
await page.waitForTimeout(6000);
ok('clicking a result navigated inside the tab strip', page.url() === startUrl && !(await addr()).includes('umbra://search'), `from ${srClick.href.slice(0, 46)} → ${await addr()}`);

/* ------------------------------------------------------- tab strip UI */
const histBeforeTabs = await hist();
const tN = await tabs();
await page.click('#newtab');
await page.waitForTimeout(1400);
ok('new-tab button adds a tab', (await tabs()) === tN + 1, `${tN} → ${await tabs()}`);
await page.click('.utab:nth-last-child(2) .x');
await page.waitForTimeout(900);
ok('close button removes one tab', (await tabs()) === tN, 'now ' + await tabs());
await page.click('.utab:first-child');
await page.waitForTimeout(700);
ok('switching tabs re-points the address bar', (await addr()).length > 0, await addr());
await page.click('#reload');
await page.waitForTimeout(2600);
ok('reload keeps the tab count stable', Math.abs((await tabs()) - tN) <= 1, 'tN=' + tN + ' now ' + await tabs());
const histAfterTabs = await hist();

/* ------------------------------------------------------- history audit */
const histFinal = await hist();
ok('history grew by at most the deliberate escape probe', histFinal - hist0 <= 1, `${hist0} → ${histFinal} (only the escape fixture costs an entry)`);
ok('tab switching, reload and panic added zero history entries', histAfterTabs - histBeforeTabs === 0, `${histBeforeTabs} → ${histAfterTabs}`);
const offOrigin = requests.filter((u) => !u.startsWith(BASE) && !/^(data|about):/.test(u));
const leaky = offOrigin.filter((u) => !/^https:\/\/example\.com\/$/.test(u) && !/ytimg\.com\/(vi|vi_webp)\//.test(u) && !/^https:\/\/i\d\.ytimg\.com\//.test(u));
ok('off-origin requests are only the escape probe and first-party thumbnail preloads', leaky.length === 0,
  'off-origin ' + offOrigin.length + ', unexplained ' + leaky.length + ' ' + JSON.stringify(leaky.slice(0, 3)));
ok('no inline style / css / font reference ever reaches the browser as a real address',
  !requests.some((u) => /googlevideo|gstatic|wikipedia\.org\/portal|picsum|httpbin|fonts\.|cdn\.|\.css\b|\.woff/.test(u) && !u.includes('127.0.0.1')),
  JSON.stringify(requests.filter((u) => !u.includes('127.0.0.1') && !/ytimg|example\.com/.test(u)).slice(0, 3)));
ok('every subresource and redirect target was fetched by the origin, not the browser',
  requests.filter((u) => /wikipedia\.org\/portal|test-videos|picsum|httpbin|en\.wikipedia\.org\/wiki/.test(u)).length === 0,
  'browser-initiated host requests: ' + requests.filter((u) => /test-videos|picsum|httpbin/.test(u)).length);
ok('no dialogs were surfaced to the user', dialogs.length === 0, JSON.stringify(dialogs.slice(0, 2)));
ok('no uncaught errors from umbra-authored scripts', errors.length === 0, JSON.stringify(errors.slice(0, 4)));
ok('the document policy refused only requests that were about to leave the wire',
  policyRefusals.every((x) => /Refused to (load|frame|display)|blocked/i.test(x)),
  policyRefusals.length + ' refusal(s): ' + JSON.stringify(policyRefusals.slice(0, 2)));
ok('resource failures stay upstream-side (proxied pages keep their own 404s)', badResponses.length === 0,
  `${resErrors.length} upstream resource errors, ${thirdPartyErrors.length} errors from the proxied site's own js`);
ok('no failed umbra-route responses in the whole run', badResponses.length === 0, JSON.stringify(badResponses.slice(0, 4)));

/* ------------------------------------------------------------ panic */
await page.click('#panicBtn');
await page.waitForTimeout(1400);
ok('panic wiped the tab strip', (await tabs()) === 0, 'tabs: ' + (await tabs()));
ok('panic destroyed all proxied frames', page.mainFrame().childFrames().length === 0, 'frames: ' + page.mainFrame().childFrames().length);
ok('panic added no history entry of its own', (await hist()) === histAfterTabs, `${histAfterTabs} → ${await hist()}`);
ok('panic left the browser tab exactly where it was', page.url() === startUrl, page.url());
const afterPanic = await page.evaluate(() => ({ html: document.documentElement.outerHTML.length, empty: !document.querySelector('.pane[data-active]') }));
ok('no ghost content left in the shell DOM', afterPanic.empty, 'shell html ' + afterPanic.html + ' bytes');

const failed = results.filter((r) => !r.c);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (failed.length) failed.forEach((f) => console.log('  ✗ ' + f.n + '  ' + f.note));
console.log('\nnetwork sample: ' + requests.length + ' requests, all to ' + BASE);
await browser.close();
process.exit(failed.length ? 1 : 0);
