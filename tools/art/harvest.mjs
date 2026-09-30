// 把 IDE 生图接口的成品抓成静态资源。
//
// 关键：URL 必须与「在 IDE 预览里成功出图的那次」逐字一致 —— 接口按 URL 缓存，
// 自己先请求只会拿到 "The image is generating..." 占位图，等 IDE 那边兑现后，
// 用同一个 URL 再来一次就能拿到真图。
//
// 用法：node harvest.mjs            抓所有还缺的
//       node harvest.mjs --probe    只看状态，不落盘
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BASE = 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image';
const OUT_DIR = resolve('../../packages/web/public/art/portraits');
const STYLE = 'comic book illustration, clean ink line art, cel shading, dramatic side lighting, full body, plain flat two tone background';

/** 立绘清单。prompt 必须与 tools/art/gen-preview.html 里的逐字一致，否则缓存命中不了 */
const ITEMS = [
  ['werewolf', 'full body anthropomorphic werewolf character, muscular wolf man with grey fur and glowing yellow eyes, torn dark clothes, digitigrade legs with claws, ' + STYLE],
  ['seer', 'full body illustration of a young seer woman in a hooded robe holding a glowing crystal ball, mysterious, ' + STYLE],
  ['witch', 'full body illustration of a witch woman with potion bottles and a wooden staff, dark green cloak, ' + STYLE],
  ['hunter', 'full body illustration of a hunter man in a long leather coat with a shotgun over his shoulder, ' + STYLE],
  ['guard', 'full body illustration of an armored knight guard holding a tower shield, ' + STYLE],
  ['villager', 'full body illustration of an ordinary young villager holding a lantern, simple clothes, ' + STYLE],
];

const SIZE = 'portrait_16_9';
// 占位图的 sha1（"The image is generating..." 那张）。同尺寸下它是固定资源。
const PLACEHOLDER_SHA1 = process.env.PLACEHOLDER_SHA1 || '';

const probe = process.argv.includes('--probe');
if (!probe) mkdirSync(OUT_DIR, { recursive: true });

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');
let ok = 0;
let waiting = 0;

for (const [name, prompt] of ITEMS) {
  const url = `${BASE}?prompt=${encodeURIComponent(prompt)}&image_size=${SIZE}`;
  const file = resolve(OUT_DIR, `${name}.png`);
  if (!probe && existsSync(file)) {
    console.log(`[skip] ${name} 已有文件`);
    ok += 1;
    continue;
  }
  try {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = sha1(buf);
    const isPlaceholder = PLACEHOLDER_SHA1 ? hash === PLACEHOLDER_SHA1 : buf.length === 176626;
    if (isPlaceholder) {
      waiting += 1;
      console.log(`[wait] ${name} 还是占位图（${buf.length}B）—— 先在 IDE 预览里把这张刷出来`);
      continue;
    }
    if (probe) {
      console.log(`[ok]   ${name} 真图 ${buf.length}B sha1=${hash.slice(0, 8)}`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buf);
      console.log(`[ok]   ${name} -> ${file} (${buf.length}B)`);
    }
    ok += 1;
  } catch (e) {
    console.log(`[fail] ${name} ${e.message}`);
  }
}

console.log(`\n合计：就绪 ${ok} / 待生成 ${waiting} / 共 ${ITEMS.length}`);
