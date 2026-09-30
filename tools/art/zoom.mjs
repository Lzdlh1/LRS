// 把一张图里的某块区域裁出来放大，用来"拿着放大镜看截图"。
// 用法：node zoom.mjs <输入> <输出> <x> <y> <宽> <高> <放大倍数>
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const [input, output, x, y, w, h, scale] = process.argv.slice(2);
if (!input || !output) {
  console.log('用法：node zoom.mjs <输入> <输出> <x> <y> <宽> <高> <放大倍数>');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    `--user-data-dir=${resolve('.edge-profile')}`,
    `--disk-cache-dir=${resolve('.edge-cache')}`,
  ],
});
const page = await browser.newPage();
await page.goto('about:blank');

const raw = readFileSync(resolve(input));
const isPng = raw[0] === 0x89 && raw[1] === 0x50;
const b64 = raw.toString('base64');
const out = await page.evaluate(
  async (data, mime, cx, cy, cw, ch, k) => {
    const img = new Image();
    img.src = `data:${mime};base64,` + data;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cw * k);
    canvas.height = Math.round(ch * k);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false; // 放大小截图时保留像素块，别糊成一片
    ctx.drawImage(img, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  },
  b64,
  isPng ? 'image/png' : 'image/jpeg',
  Number(x || 0),
  Number(y || 0),
  Number(w || 200),
  Number(h || 200),
  Number(scale || 4),
);

writeFileSync(resolve(output), Buffer.from(out.split(',')[1], 'base64'));
console.log('[zoom]', output, `${w}x${h} x${scale}`);
await browser.close();
