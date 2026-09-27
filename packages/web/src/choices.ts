import type { Action, ActionOption, WitchUse } from '@lrs/shared';
import type { ClientState } from '@lrs/server/protocol';
import { seatLabel } from './labels';

export interface Choice {
  key: string;
  label: string;
  action: Action;
}

/** 当前待办是否需要玩家自己输入发言文本 */
export function needsSpeech(state: ClientState | null): boolean {
  return state?.pending?.options.some((option) => option.kind === 'speak') ?? false;
}

/**
 * 把引擎给的选项摊平成一组「点一下就提交」的按钮。
 *
 * 选项本身来自引擎，所以这里生成的每个 Choice 都必定合法 ——
 * 前端不需要、也不应该知道规则。
 */
export function choicesFor(state: ClientState | null): Choice[] {
  const pending = state?.pending;
  if (!pending || pending.options.length === 0) return [];

  const actor = pending.seat;
  const choices: Choice[] = [];

  const seatChoices = (
    option: ActionOption,
    prefix: string,
    label: (seat: number) => string,
    build: (seat: number) => Action,
  ): void => {
    for (const target of option.targets) {
      choices.push({ key: `${prefix}-${target}`, label: label(target), action: build(target) });
    }
  };

  for (const option of pending.options) {
    switch (option.kind) {
      case 'speak':
        break;

      case 'chief_signup':
        choices.push({ key: 'signup-yes', label: '上警竞选', action: { kind: 'chief_signup', actor, join: true } });
        choices.push({ key: 'signup-no', label: '不上警', action: { kind: 'chief_signup', actor, join: false } });
        break;

      case 'chief_withdraw':
        choices.push({ key: 'withdraw-yes', label: '退水', action: { kind: 'chief_withdraw', actor, withdraw: true } });
        choices.push({ key: 'withdraw-no', label: '继续参选', action: { kind: 'chief_withdraw', actor, withdraw: false } });
        break;

      case 'witch_act': {
        const uses = (option.params?.['use'] ?? []) as WitchUse[];
        if (uses.includes('pass')) {
          choices.push({ key: 'witch-pass', label: '不用药', action: { kind: 'witch_act', actor, use: 'pass' } });
        }
        if (uses.includes('save')) {
          seatChoices(
            option,
            'save',
            (seat) => `用解药救 ${seatLabel(seat)}`,
            (seat) => ({ kind: 'witch_act', actor, use: 'save', target: seat }),
          );
        }
        if (uses.includes('poison')) {
          seatChoices(
            option,
            'poison',
            (seat) => `用毒药毒 ${seatLabel(seat)}`,
            (seat) => ({ kind: 'witch_act', actor, use: 'poison', target: seat }),
          );
        }
        break;
      }

      case 'hunter_shoot':
        choices.push({ key: 'shoot-none', label: '放弃开枪', action: { kind: 'hunter_shoot', actor, target: null } });
        seatChoices(
          option,
          'shoot',
          (seat) => `带走 ${seatLabel(seat)}`,
          (seat) => ({ kind: 'hunter_shoot', actor, target: seat }),
        );
        break;

      case 'chief_transfer':
        choices.push({ key: 'transfer-destroy', label: '撕毁警徽', action: { kind: 'chief_transfer', actor, target: null } });
        seatChoices(
          option,
          'transfer',
          (seat) => `移交给 ${seatLabel(seat)}`,
          (seat) => ({ kind: 'chief_transfer', actor, target: seat }),
        );
        break;

      case 'vote':
        if (option.params?.['allowAbstain']?.includes(true)) {
          choices.push({ key: 'vote-abstain', label: '弃票', action: { kind: 'vote', actor, target: 'abstain' } });
        }
        seatChoices(
          option,
          'vote',
          (seat) => `投 ${seatLabel(seat)}`,
          (seat) => ({ kind: 'vote', actor, target: seat }),
        );
        break;

      case 'guard_protect':
        seatChoices(
          option,
          'guard',
          (seat) => `守 ${seatLabel(seat)}`,
          (seat) => ({ kind: 'guard_protect', actor, target: seat }),
        );
        break;

      case 'wolf_kill':
        seatChoices(
          option,
          'kill',
          (seat) => `刀 ${seatLabel(seat)}`,
          (seat) => ({ kind: 'wolf_kill', actor, target: seat }),
        );
        break;

      case 'seer_check':
        seatChoices(
          option,
          'check',
          (seat) => `验 ${seatLabel(seat)}`,
          (seat) => ({ kind: 'seer_check', actor, target: seat }),
        );
        break;
    }
  }

  return choices;
}
