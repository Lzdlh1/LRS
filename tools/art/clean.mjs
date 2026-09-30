// 抹掉生成图右下角的「AI生成」水印。
//
// 为什么是"盖"不是"裁"：立绘是全身方图，右下角那块可能压着角色的手/脚/尾巴，
// 直接裁会把内容切掉；生成图的背景基本是平涂，把水印正上方同尺寸的一块克隆下来贴上去，
// 事后看不出来，也不损失画面。
//
// 用无头浏览器 + canvas 做，不额外引图像库。
//
// 用法：node clean.mjs <目录> [右侧比例] [下方比例]
//       node clean.mjs ../../packages/web/public/art/portraits
import puppeteer from 'puppeteer-core';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DIR = resolve(process.argv[2] || '../../packages/web/public/art/portraits');
const CW = Number(process.argv[3] || 0.20);   // 水印块宽度，占整图宽的比例
const CH = Number(process.argv[4] || 0.065);  // 水印块高度，占整图高的比例

const files = readdirSync(DIR).filter((n) => /\.(png|jpe?g)$/i.test(n));
if (files.length === 0) {
  console.log('目录里没有图片：', DIR);
  process.exit(0);
}
mkdirSync(DIR, { recursive: true });

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

for (const name of files) {
  const file = resolve(DIR, name);
  const before = statSync(file).size;
  const raw = readFileSync(file);
  // 接口返回的是 JPEG，但我们按 .png 存过 —— 别信扩展名，按魔数判断真实类型
  const isPng = raw[0] === 0x89 && raw[1] === 0x50;
  const mime = isPng ? 'image/png' : 'image/jpeg';
  const b64 = raw.toString('base64');
  const out = await page.evaluate(
    async (data, mimeType, cw, ch) => {
      const img = new Image();
      img.src = `data:${mimeType};base64,` + data;
      await img.decode();
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const bw = Math.round(w * cw);
      const bh = Math.round(h * ch);
      const x = w - bw;
      const y = h - bh;
      // 分几小步把上方的背景"滚"下来盖住水印。
      // 一步到位会有明显接缝（背景本身有渐变），分成小块每步只挪一格，色差小到看不出来。
      const steps = 4;
      const hh = Math.floor(bh / steps);
      for (let i = steps - 1; i >= 0; i--) {
        const dy = y + i * hh;
        ctx.drawImage(canvas, x, dy - hh, bw, hh, x, dy, bw, hh);
      }
      // 余数那一小条用最后一格补齐
      const rest = bh - hh * steps;
      if (rest > 0) ctx.drawImage(canvas, x, y - rest, bw, rest, x, h - rest, bw, rest);
      // 一律转成 JPEG：这些图本来就是有损来源，存 PNG 只会平白涨到十倍体积
      return canvas.toDataURL('image/jpeg', 0.92);
    },
    b64,
    mime,
    CW,
    CH,
  );
  const target = file.replace(/\.(png|jpe?g)$/i, '.jpg');
  writeFileSync(target, Buffer.from(out.split(',')[1], 'base64'));
  if (target !== file) unlinkSync(file);
  console.log(`[clean] ${name}  ${before}B -> ${statSync(target).size}B  ${target.split(/[\\/]/).pop()}`);
}

await browser.close();
console.log(`共处理 ${files.length} 张：${DIR}`);
