import { chromium } from '/home/user/browsertest/node_modules/playwright/index.mjs';
const b = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'], executablePath: process.env.PWEXE });
const p = await b.newPage();
await p.goto('about:blank');
console.log('LAUNCH OK', await p.evaluate(() => 1 + 1));
await b.close();
