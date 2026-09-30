import type { CSSProperties } from 'vue';
import type { Role } from '@lrs/shared';

/**
 * 角色立绘的圆形头像取景。
 *
 * 立绘是 768x1368 的**竖构图全身像**（比例 1.781）。直接塞进 44px 圆里，人只有指甲盖大，
 * 只能看出一团颜色；而且六个角色的头在画面里的位置和大小各不相同 —— 统一一组参数必然
 * 有的偏左、有的把脸切在圆外。所以每个角色单独记一组取景参数。
 *
 * 圆取景窗是正方形：覆盖画面宽度 100/z %、高度 56.15/z %。
 *   z  —— 放大倍数（`background-size: z% auto`，按宽度定标）
 *   tx —— 要摆到圆心的画面横向比例（0~1）
 *   ty —— 要摆到圆心的画面纵向比例（0~1，从画面顶部往下）
 *
 * 换算成 CSS 位置值：
 *   图宽 W = 0.44z，图高 H = 0.7836z
 *   Px = (W*tx - 22) / (W - 44)
 *   Py = (H*ty - 22) / (H - 44)
 *
 * 这些数是拿 tools/art/scan.mjs 逐行扫非背景像素、量出头的位置后定的；
 * 验证台是 tools/art/portrait-sheet.html（同一段规则渲染成 44px / 132px 圆）。
 */
const FACE_CROP: Record<Role, { z: number; tx: number; ty: number }> = {
  werewolf: { z: 263, tx: 0.55, ty: 0.11 },
  seer: { z: 222, tx: 0.47, ty: 0.13 },
  witch: { z: 210, tx: 0.6, ty: 0.145 },
  hunter: { z: 380, tx: 0.54, ty: 0.11 },
  guard: { z: 374, tx: 0.45, ty: 0.145 },
  villager: { z: 340, tx: 0.45, ty: 0.175 },
};

export function faceUrl(role: Role): string {
  return `url('/art/portraits/${role}.jpg')`;
}

export function faceStyle(role: Role): CSSProperties {
  const c = FACE_CROP[role];
  const w = 0.44 * c.z;
  const h = 0.7836 * c.z;
  const px = (w * c.tx - 22) / (w - 44);
  const py = (h * c.ty - 22) / (h - 44);
  return {
    backgroundImage: faceUrl(role),
    backgroundSize: `${c.z}% auto`,
    backgroundPosition: `${(px * 100).toFixed(1)}% ${(py * 100).toFixed(1)}%`,
  };
}
