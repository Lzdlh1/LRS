import { z } from 'zod';

export const ROLES = ['werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

export const ROLE_LABELS: Record<Role, string> = {
  werewolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
  villager: '平民',
};

/** 阵营 */
export const CAMPS = ['wolf', 'good'] as const;
export type Camp = (typeof CAMPS)[number];
export const campSchema = z.enum(CAMPS);

export function roleCamp(role: Role): Camp {
  return role === 'werewolf' ? 'wolf' : 'good';
}

/**
 * 神职。屠边判定里「神」的一方，被杀光则狼胜。
 * 平民在屠边判定里单独算一方，被杀光同样狼胜。
 */
export const GOD_ROLES = ['seer', 'witch', 'hunter', 'guard'] as const;
export type GodRole = (typeof GOD_ROLES)[number];

export function isGodRole(role: Role): role is GodRole {
  return (GOD_ROLES as readonly Role[]).includes(role);
}

export function isVillager(role: Role): boolean {
  return role === 'villager';
}
