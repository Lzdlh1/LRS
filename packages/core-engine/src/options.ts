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

/** 退水：退水者失去被选举权，同时也失去警下投票权 */
export function chiefWithdrawOptions(): ActionOption[] {
  return [
    {
      kind: 'chief_withdraw',
      targets: [],
      params: { withdraw: [true, false] },
      label: '是否退水（退水后不再参选，也不能投票）',
    },
  ];
}

/** 警徽转移：移交给一名存活玩家，或撕毁警徽 */
export function chiefTransferOptions(state: GameState, chiefSeat: SeatId): ActionOption[] {
  return [
    {
      kind: 'chief_transfer',
      targets: aliveSeats(state).filter((seat) => seat !== chiefSeat),
      params: { allowDestroy: [true] },
      label: '移交警徽给一名存活玩家，或撕毁警徽',
    },
  ];
}

/** 竞选投票：只能投给仍在竞选的人 */
export function chiefVoteOptions(candidates: SeatId[]): ActionOption[] {
  return [{ kind: 'vote', targets: candidates, label: '投票给一名竞选者' }];
}

/** 发言 */
export function speakOptions(label: string): ActionOption[] {
  return [{ kind: 'speak', targets: [], label }];
}

/**
 * 放逐投票。
 * - 首轮：可选任意其他存活玩家，也可弃票
 * - PK 轮：只能投 PK 台上的候选者，不能弃票
 */
export function dayVoteOptions(state: GameState, voterSeat: SeatId, pkCandidates?: SeatId[]): ActionOption[] {
  if (pkCandidates) {
    return [
      {
        kind: 'vote',
        targets: pkCandidates.filter((seat) => seat !== voterSeat),
        label: '在 PK 的两人中选一个',
      },
    ];
  }
  return [
    {
      kind: 'vote',
      targets: aliveSeats(state).filter((seat) => seat !== voterSeat),
      params: { allowAbstain: [true] },
      label: '投票放逐一名玩家（也可弃票）',
    },
  ];
}

/** 猎人开枪：可带走任意存活玩家，也可放弃 */
export function hunterShootOptions(state: GameState, hunterSeat: SeatId): ActionOption[] {
  return [
    {
      kind: 'hunter_shoot',
      targets: aliveSeats(state).filter((seat) => seat !== hunterSeat),
      params: { allowPass: [true] },
      label: '开枪带走一名玩家，或放弃开枪',
    },
  ];
}
