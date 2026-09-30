// 诊断：把座位卡在 DOM 里的真实状态 dump 出来（渲染了什么、算出来的尺寸是多少）。
// 看图只能看出"空白"，看不出是 background 没生效、还是取景对到空白区域上。
//
// 用法：node probe.mjs [url]
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 输出目录按脚本位置算，不按 cwd —— 否则从仓库根跑就会写到不存在的 out/ 去 */
const OUT = fileURLToPath(new URL('./out/', import.meta.url));

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TARGET = process.argv[2] || 'http://localhost:5173/';
const VW = Number(process.argv[3] || 1280);
const VH = Number(process.argv[4] || 880);

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-angle=default',
    '--hide-scrollbars',
    `--user-data-dir=${resolve('.edge-profile')}`,
    `--disk-cache-dir=${resolve('.edge-cache')}`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(TARGET, { waitUntil: 'load', timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));

// 先暂停：无头浏览器连上去也算一个观看端，真人回合会走超时兜底，AI 会一路打到结束（烧 key）
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /暂停/.test(b.textContent));
  if (btn) btn.click();
});
await new Promise((r) => setTimeout(r, 800));
console.log('[pause] 已点暂停（如果有这个按钮）');

await new Promise((r) => setTimeout(r, 2200));

// 座位列单独截一张（2 倍精度）：光看 dump 看不出"空白和坐标错"长什么样
const wantGod = process.argv.includes('god');
if (wantGod) {
  const clickByText = async (re, note) => {
    await page.evaluate(() => document.querySelector('.bar button')?.click()); // 展开折叠栏
    await new Promise((r) => setTimeout(r, 400));
    const h = await page.evaluateHandle((src) => {
      const re2 = new RegExp(src);
      return [...document.querySelectorAll('button')].find((b) => re2.test(b.textContent)) || null;
    }, re.source);
    const el = h.asElement();
    if (!el) {
      console.log(`[god] 点不到「${note}」`);
      return false;
    }
    await el.click();
    console.log(`[god] 已点「${note}」`);
    return true;
  };

  // 先开一局新的：上一局已经结束，视角开关在终局状态多半是失效的
  await clickByText(/新开一局/, '新开一局');
  await new Promise((r) => setTimeout(r, 9000));
  await clickByText(/知道了/, '知道了（关掉看牌卡）');
  await new Promise((r) => setTimeout(r, 800));
  await clickByText(/视角/, '视角开关');
  await new Promise((r) => setTimeout(r, 1500));
}

const board = await page.$('.board');
if (board) await board.screenshot({ path: resolve(OUT, 'probe-board.png') });

// day：强制把 app 切成白天主题（改类名即可，令牌全在 .app.day 里），用来单独看换皮效果
if (process.argv.includes('day')) {
  await page.evaluate(() => {
    const app = document.querySelector('.app');
    if (app) {
      app.classList.remove('night');
      app.classList.add('day');
    }
  });
  await new Promise((r) => setTimeout(r, 500));
  // 看牌卡/弹窗的遮罩会把整屏压暗，先藏掉再截，否则看不出换皮效果
  const tokens = await page.evaluate(() => {
    document.querySelectorAll('.mask').forEach((el) => {
      el.style.display = 'none';
    });
    const app = document.querySelector('.app');
    const log = document.querySelector('.center > *');
    return {
      panel: app ? getComputedStyle(app).getPropertyValue('--panel').trim() : null,
      accent: app ? getComputedStyle(app).getPropertyValue('--accent').trim() : null,
      text: app ? getComputedStyle(app).getPropertyValue('--text').trim() : null,
      logBg: log ? getComputedStyle(log).backgroundImage.slice(0, 70) : null,
    };
  });
  console.log('[day tokens]', JSON.stringify(tokens));
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: resolve(OUT, 'probe-day.png') });
  console.log('[shot] out/probe-day.png');
}
const col = await page.$('.col');
if (col) await col.screenshot({ path: resolve(OUT, 'probe-col.png') });
console.log('[shot] out/probe-board.png');

const layout = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    app: box('.app'),
    board: box('.board'),
    cols: [...document.querySelectorAll('.col')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), scrollW: el.scrollWidth, clientW: el.clientWidth };
    }),
    center: box('.center'),
    firstSeat: box('.seat'),
    firstAvatar: box('.avatar'),
    firstCard: box('.seat .head'),
  };
});
console.log('[layout]', JSON.stringify(layout, null, 1));

const out = await page.evaluate(() => {
  const seats = [...document.querySelectorAll('.seat')];
  return seats.map((seat) => {
    const avatar = seat.querySelector('.avatar');
    const face = seat.querySelector('.face');
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const cs = face ? getComputedStyle(face) : null;
    const sc = getComputedStyle(seat);
    return {
      seat: (seat.querySelector('.num')?.textContent || '').trim(),
      cls: seat.className,
      outline: `${sc.outlineStyle} ${sc.outlineWidth} ${sc.outlineColor}`,
      border: `${sc.borderTopStyle} ${sc.borderTopWidth} ${sc.borderTopColor}`,
      shadow: sc.boxShadow.slice(0, 64),
      texts: [...seat.querySelectorAll('span')].map((s) => s.textContent.trim()).filter(Boolean),
      avatar: rect(avatar),
      face: rect(face),
      faceBg: cs ? cs.backgroundImage.slice(0, 90) : null,
      faceSize: cs ? cs.backgroundSize : null,
      facePos: cs ? cs.backgroundPosition : null,
      faceClass: face ? face.className : null,
    };
  });
});

console.log(JSON.stringify(out, null, 1));
await browser.close();
