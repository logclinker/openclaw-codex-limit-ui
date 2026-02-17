import { chromium } from 'playwright';
const [,, url, out, w, h] = process.argv;
if(!url||!out) { console.error('usage: node snap.mjs <url> <out> <w> <h>'); process.exit(2); }
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: parseInt(w||'1200',10), height: parseInt(h||'760',10) } });
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(200);
await page.click('#btn');
await page.waitForTimeout(900);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('Wrote', out);
