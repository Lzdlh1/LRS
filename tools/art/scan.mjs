// 量头部位置：逐行扫描立绘的非背景像素范围，别再靠肉眼估 3% 还是 5%。
// 用法：node scan.mjs            —— 打印每 2% 高度的前景 x 范围
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
/** 仓库根，按脚本位置算，不按 cwd */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = resolve(ROOT, 'packages/web/public/art/portraits');
const ROLES = ['werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager'];

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.goto('about:blank');

for (const role of ROLES) {
  const b64 = readFileSync(resolve(DIR, `${role}.jpg`)).toString('base64');
  const res = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + data;
    await img.decode();
    const cv = document.createElement('canvas');
    const W = (cv.width = img.naturalWidth);
    const H = (cv.height = img.naturalHeight);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    const at = (x, y) => [(y * W + x) * 4, (y * W + x) * 4 + 1, (y * W + x) * 4 + 2];
    // 背景色只作参考；真正的判据用「每行最左 3px 与最右 3px 的平均」——
    // 立绘的背景可能是渐变或有噪点，四角取值会整行判成前景（seer / hunter 就栽在这）
    const bg = [0, 1, 2].map((k) => {
      const cs = [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3]].map(([x, y]) => {
        const i = at(x, y);
        return d[i[k]];
      });
      return Math.round(cs.reduce((s, v) => s + v, 0) / 4);
    });
    const rowBg = (y) => {
      const a = at(2, y);
      const b = at(W - 3, y);
      return [
        (d[a[0]] + d[b[0]]) / 2,
        (d[a[1]] + d[b[1]]) / 2,
        (d[a[2]] + d[b[2]]) / 2,
      ];
    };
    const isFg = (x, y, rb) => {
      const i = at(x, y);
      return (
        Math.abs(d[i[0]] - rb[0]) + Math.abs(d[i[1]] - rb[1]) + Math.abs(d[i[2]] - rb[2]) > 70
      );
    };
    const rows = [];
    for (let p = 0; p < 100; p += 2) {
      const y = Math.min(H - 1, Math.round((H * p) / 100));
      const rb = rowBg(y);
      let min = -1;
      let max = -1;
      let cnt = 0;
      for (let x = 0; x < W; x++) {
        if (isFg(x, y, rb)) {
          if (min < 0) min = x;
          max = x;
          cnt++;
        }
      }
      rows.push({
        p,
        min: min < 0 ? null : +((min / W) * 100).toFixed(1),
        max: max < 0 ? null : +((max / W) * 100).toFixed(1),
        w: +((cnt / W) * 100).toFixed(1),
      });
    }
    return { W, H, bg, rows };
  }, b64);

  console.log(`=== ${role}  ${res.W}x${res.H}  bg=rgb(${res.bg.join(',')})`);
  for (const r of res.rows) {
    if (r.min === null) console.log(`  ${String(r.p).padStart(2)}%  ——`);
    else
      console.log(
        `  ${String(r.p).padStart(2)}%  x ${String(r.min).padStart(4)}~${String(r.max).padStart(4)}  宽${String(r.w).padStart(4)}%  中${((r.min + r.max) / 2).toFixed(1)}`,
      );
  }
}
await browser.close();
