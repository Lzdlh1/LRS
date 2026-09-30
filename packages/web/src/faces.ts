import type { Role } from '@lrs/shared';

/**
 * 角色立绘的圆形头像取景。
 *
 * 立绘是**全身方图**：直接把它塞进 44px 圆里，人会缩成指甲盖大，只能看出一团颜色。
 * 所以放大 340% 再靠背景定位把镜头对到脸上。
 *
 * 取景为什么不能一刀切居中：狼人的头偏画面右侧（约 60%），居中裁会把脸切掉一半；
 * 其余五个角色都在中间偏上，用同一组值就行。位置值的算法（缩放固定 340%，写在组件的 CSS 里）：
 *   P = (zoom * target - 0.5) / (zoom - 1)   —— target 是想摆到圆心处的画面比例
 */
const FACE_CROP: Partial<Record<Role, string>> = {
  werewolf: '64% -4%',
};

export function faceCrop(role: Role): string {
  return FACE_CROP[role] ?? '50% -2%';
}

export function faceUrl(role: Role): string {
  return `url('/art/portraits/${role}.jpg')`;
}
