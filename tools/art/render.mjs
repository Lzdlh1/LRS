// 用无头 Edge 跑 studio.html（p5 + p5.brush 的 WEBGL 画布），把结果截成 PNG。
// 只出静帧，不需要 ffmpeg；驱动用本机 Edge，不额外装 Chrome。
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = resolve(process.argv[2] || 'out/sheet.png');
// 第三个参数：本地文件（可带 query，如 "style.html?only=1"）或完整 http 地址
const raw = process.argv[3] || 'studio.html';
let PAGE_URL;
if (/^https?:\/\//i.test(raw)) PAGE_URL = raw;
else {
  const [pageFile, pageQuery] = raw.split('?');
  PAGE_URL = pathToFileURL(resolve(pageFile)).href + (pageQuery ? '?' + pageQuery : '');
}
mkdirSync(dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',   // 无 GPU 时用软件 WebGL2
    '--use-angle=default',
    '--hide-scrollbars',
    // 缓存/配置全放 D 盘：既避开沙箱对系统缓存目录的拦截，也不往 C 盘堆东西
    `--user-data-dir=${resolve('.edge-profile')}`,
    `--disk-cache-dir=${resolve('.edge-cache')}`,
  ],
});

const page = await browser.newPage();
// --page：截整页（没有 canvas 的普通页面用这个）；--w=/--h= 覆盖视口
const FULL = process.argv.includes('--page');
const vw = Number((process.argv.find((a) => a.startsWith('--w=')) || '--w=1400').slice(4));
const vh = Number((process.argv.find((a) => a.startsWith('--h=')) || '--h=1400').slice(4));
await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 1 });
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));

const t0 = Date.now();
await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
if (FULL) {
  const delay = Number((process.argv.find((a) => a.startsWith('--delay=')) || '--delay=800').slice(8));
  await new Promise((r) => setTimeout(r, delay));
  await page.screenshot({ path: OUT, fullPage: true });
  console.log('[ok]', OUT, Math.round((Date.now() - t0) / 100) / 10 + 's');
  await browser.close();
} else {
  try {
    await page.waitForFunction('window.__ready === true', { timeout: 120000 });
  } catch (e) {
    console.log('[warn] 等到超时，仍然截图（可能是画得太慢或脚本报错）');
  }

  const info = await page.evaluate(() => ({
    ready: !!window.__ready,
    err: window.__err || null,
    w: window.__w || null,
    h: window.__h || null,
    gl: (() => {
      const cv = document.querySelector('canvas');
      if (!cv) return 'no-canvas';
      const g = cv.getContext('webgl2');
      return g ? g.getParameter(g.VERSION) : 'no-webgl2';
    })(),
  }));
  console.log('[info]', JSON.stringify(info));

  // 只认 p5 自己建的那个画布（id='c'）。页面里千万别再放一个静态 canvas：
  // 截图会先抓到它，出一个永远没画过的空图。
  const el = (await page.$('#c')) || (await page.$('canvas'));
  if (!el) throw new Error('页面上没有 canvas（普通页面请加 --page）');
  await el.screenshot({ path: OUT });
  console.log('[ok]', OUT, Math.round((Date.now() - t0) / 100) / 10 + 's');

  await browser.close();
}
