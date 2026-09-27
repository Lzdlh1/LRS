import type { ActionOption, Role, SeatId } from '@lrs/shared';
import type { GameState, PlayerState } from './types.ts';

export function playerAt(state: GameState, seat: SeatId): PlayerState {
  const player = state.players.find((p) => p.seat === seat);
  if (!player) throw new Error(`座位 ${seat} 不存在`);
  return player;
}

/** 真实存活 */
export function aliveSeats(state: GameState): SeatId[] {
  return state.players.filter((p) => p.death === null).map((p) => p.seat);
}

/**
 * 在场上。
 * 变体 A 下，首夜死者在死讯公布之前仍算「在场」—— 他照常上警、照常投警长票。
 */
export function onBoardSeats(state: GameState): SeatId[] {
  return state.players
    .filter((p) => p.death === null || !p.deathAnnounced)
    .map((p) => p.seat);
}

export function seatsWithRole(state: GameState, role: Role, aliveOnly = true): SeatId[] {
  return state.players
    .filter((p) => p.role === role && (!aliveOnly || p.death === null))
    .map((p) => p.seat);
}

/** 守卫：排除连守目标；按规则决定能否自守 */
export function guardOptions(state: GameState, guardSeat: SeatId): ActionOption[] {
  const { guardCanSelfProtect, guardNoRepeatTarget } = state.rules;
  const targets = aliveSeats(state).filter((seat) => {
    if (!guardCanSelfProtect && seat === guardSeat) return false;
    if (guardNoRepeatTarget && seat === state.lastNightGuardTarget) return false;
    return true;
  });
  return [{ kind: 'guard_protect', targets, label: '守护一名玩家' }];
}

/** 狼人：允许自刀（自刀是常见战术），因此目标是所有存活玩家 */
export function wolfOptions(state: GameState): ActionOption[] {
  return [{ kind: 'wolf_kill', targets: aliveSeats(state), label: '选择今晚要刀的玩家' }];
}

/** 女巫：受药水存量与自救规则约束 */
export function witchOptions(state: GameState, witchSeat: SeatId): ActionOption[] {
  const options: ActionOption[] = [];
  const killed = state.night.wolfTarget;

  if (state.witchPotions.antidote > 0 && killed !== null) {
    if (state.rules.witchCanSelfSave || killed !== witchSeat) {
      options.push({
        kind: 'witch_act',
        targets: [killed],
        params: { use: ['save'] },
        label: `使用解药救 ${killed} 号`,
      });
    }
  }

  if (state.witchPotions.poison > 0) {
    options.push({
      kind: 'witch_act',
      targets: aliveSeats(state).filter((seat) => seat !== witchSeat),
      params: { use: ['poison'] },
      label: '使用毒药',
    });
  }

  options.push({ kind: 'witch_act', targets: [], params: { use: ['pass'] }, label: '不使用药水' });
  return options;
}

/** 预言家：查验其他存活玩家（查自己无意义） */
export function seerOptions(state: GameState, seerSeat: SeatId): ActionOption[] {
  return [
    {
      kind: 'seer_check',
      targets: aliveSeats(state).filter((seat) => seat !== seerSeat),
      label: '查验一名玩家',
    },
  ];
}

/** 上警：同时报名，引擎按座位依次询问 */
export function chiefSignupOptions(): ActionOption[] {
  return [
    {
      kind: 'chief_signup',
      targets: [],
      params: { join: [true, false] },
      label: '是否上警竞选警长',
    },
  ];
}
