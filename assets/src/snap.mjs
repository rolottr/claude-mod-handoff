// Preview: node snap.mjs <name> <t1,t2,...> → PNGs in the given directory.
import { chromium } from 'playwright-core';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [name, times, outDir] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => { window.FRAME_MODE = true; });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(pathToFileURL(join(here, `${name}.html`)).href);
for (const t of times.split(',')) {
  await page.evaluate((tt) => render(tt), Number(t));
  await page.screenshot({ path: join(outDir, `${name}-${t}.png`) });
}
await browser.close();
