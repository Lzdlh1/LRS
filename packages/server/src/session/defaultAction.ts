import type { Action, ActionKind, ActionOption, SeatId, WitchUse } from '@lrs/shared';
import type { PendingRequest } from '@lrs/core-engine';

/**
 * 超时兜底动作。
 *
 * 原则：挑一个「尽量不改变局面」的选择 —— 不发言、不用药、不上警、弃票、放弃开枪。
 * 这样即使某个玩家掉线，其余人的体验也不会被一个随机决策打乱。
 */
export function defaultActionFor(pending: PendingRequest): Action {
  const actor = pending.seat;
  const first = (kind: ActionKind): ActionOption | undefined =>
    pending.options.find((option) => option.kind === kind);

  if (first('speak')) return { kind: 'speak', actor, text: '（超时未发言）' };

  const witchPass = pending.options.find(
    (option) => option.kind === 'witch_act' && option.params?.['use']?.includes('pass'),
  );
  if (witchPass) return { kind: 'witch_act', actor, use: 'pass' };

  const witchOther = first('witch_act');
  if (witchOther) {
    const use = (witchOther.params?.['use']?.[0] ?? 'pass') as WitchUse;
    const target = witchOther.targets[0];
    if (use !== 'pass' && target !== undefined) return { kind: 'witch_act', actor, use, target };
    return { kind: 'witch_act', actor, use: 'pass' };
  }

  if (first('chief_signup')) return { kind: 'chief_signup', actor, join: false };
  if (first('chief_withdraw')) return { kind: 'chief_withdraw', actor, withdraw: false };
  if (first('hunter_shoot')) return { kind: 'hunter_shoot', actor, target: null };

  const transfer = first('chief_transfer');
  if (transfer) return { kind: 'chief_transfer', actor, target: transfer.targets[0] ?? null };

  const vote = first('vote');
  if (vote) {
    if (vote.params?.['allowAbstain']?.includes(true)) return { kind: 'vote', actor, target: 'abstain' };
    const target = vote.targets[0];
    if (target !== undefined) return { kind: 'vote', actor, target };
  }

  const guard = first('guard_protect');
  if (guard?.targets[0] !== undefined) return { kind: 'guard_protect', actor, target: guard.targets[0] };

  const wolf = first('wolf_kill');
  if (wolf?.targets[0] !== undefined) return { kind: 'wolf_kill', actor, target: wolf.targets[0] };

  const seer = first('seer_check');
  if (seer?.targets[0] !== undefined) return { kind: 'seer_check', actor, target: seer.targets[0] };

  throw new Error(`无法为 ${actor} 号生成超时兜底动作（可选：${pending.options.map((o) => o.kind).join(',')}）`);
}

/** 调试面板用：从待办里随机挑一个合法动作，方便快速跑完一局 */
export function randomActionFor(pending: PendingRequest, rng: () => number = Math.random): Action {
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(rng() * items.length)];
    if (item === undefined) throw new Error('从空集合取值');
    return item;
  };

  const actor: SeatId = pending.seat;
  const option = pick(pending.options);

  switch (option.kind) {
    case 'speak':
      return { kind: 'speak', actor, text: `${actor} 号发言` };
    case 'chief_signup':
      return { kind: 'chief_signup', actor, join: rng() < 0.5 };
    case 'chief_withdraw':
      return { kind: 'chief_withdraw', actor, withdraw: rng() < 0.3 };
    case 'chief_transfer':
      return rng() < 0.8 && option.targets.length > 0
        ? { kind: 'chief_transfer', actor, target: pick(option.targets) }
        : { kind: 'chief_transfer', actor, target: null };
    case 'hunter_shoot':
      return rng() < 0.7 && option.targets.length > 0
        ? { kind: 'hunter_shoot', actor, target: pick(option.targets) }
        : { kind: 'hunter_shoot', actor, target: null };
    case 'witch_act': {
      const uses = (option.params?.['use'] ?? []) as WitchUse[];
      const usable = uses.filter((use) => use === 'pass' || option.targets.length > 0);
      const use = pick(usable.length > 0 ? usable : uses);
      return use === 'pass'
        ? { kind: 'witch_act', actor, use }
        : { kind: 'witch_act', actor, use, target: pick(option.targets) };
    }
    case 'vote':
      return option.params?.['allowAbstain']?.includes(true) && rng() < 0.15
        ? { kind: 'vote', actor, target: 'abstain' }
        : { kind: 'vote', actor, target: pick(option.targets) };
    case 'guard_protect':
      return { kind: 'guard_protect', actor, target: pick(option.targets) };
    case 'wolf_kill':
      return { kind: 'wolf_kill', actor, target: pick(option.targets) };
    case 'seer_check':
      return { kind: 'seer_check', actor, target: pick(option.targets) };
  }
}
