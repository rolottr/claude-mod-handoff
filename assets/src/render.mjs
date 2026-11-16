// Renders assets/src/<name>.html to assets/<name>.webp, frame by frame.
// Usage: node render.mjs <name> [fps]   (needs playwright-core and Google Chrome, plus img2webp from libwebp)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [name, fpsArg] = process.argv.slice(2);
const fps = Number(fpsArg ?? 20);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.addInitScript(() => { window.FRAME_MODE = true; });
await page.goto(pathToFileURL(join(here, `${name}.html`)).href);
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => DURATION);
const dir = mkdtempSync(join(tmpdir(), `frames-${name}-`));
const step = 1000 / fps;
const frames = [];
for (let i = 0, t = 0; t <= duration; i++, t = i * step) {
  await page.evaluate((tt) => render(tt), t);
  const file = join(dir, `${String(i).padStart(5, '0')}.png`);
  writeFileSync(file, await page.screenshot({ type: 'png' }));
  frames.push(file);
}
await browser.close();
const out = join(here, '..', `${name}.webp`);
execFileSync('img2webp', ['-loop', '0', '-min_size', '-lossy', '-q', '80', '-m', '6', '-d', String(Math.round(step)), ...frames, '-o', out], { stdio: 'inherit' });
rmSync(dir, { recursive: true, force: true });
console.log(`${out}: ${frames.length} frames`);
