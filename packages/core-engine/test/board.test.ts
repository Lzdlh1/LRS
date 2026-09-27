import { describe, expect, it } from 'vitest';
import {
  buildRoleDeck,
  DEFAULT_BOARD,
  PRESET_BOARDS,
  validateBoard,
  type Board,
} from '../src/board.ts';
import { DEFAULT_RULES, resolveRules, validateRules } from '../src/rules.ts';

describe('板子', () => {
  it('9 人预女猎守 = 3 狼 + 4 神 + 2 民', () => {
    expect(DEFAULT_BOARD.seatCount).toBe(9);
    expect(DEFAULT_BOARD.composition).toMatchObject({
      werewolf: 3,
      seer: 1,
      witch: 1,
      hunter: 1,
      guard: 1,
      villager: 2,
    });
  });

  it('预置板子全部通过校验', () => {
    for (const board of Object.values(PRESET_BOARDS)) {
      expect(validateBoard(board), `板子 ${board.id} 未通过校验`).toEqual([]);
    }
  });

  it('打出的牌堆张数与座位数一致，且每种角色数量正确', () => {
    const deck = buildRoleDeck(DEFAULT_BOARD);
    expect(deck).toHaveLength(DEFAULT_BOARD.seatCount);

    const count = (role: string) => deck.filter((r) => r === role).length;
    expect(count('werewolf')).toBe(3);
    expect(count('seer')).toBe(1);
    expect(count('witch')).toBe(1);
    expect(count('hunter')).toBe(1);
    expect(count('guard')).toBe(1);
    expect(count('villager')).toBe(2);
  });

  it('抓出角色总数与座位数不一致', () => {
    const board: Board = {
      ...DEFAULT_BOARD,
      composition: { ...DEFAULT_BOARD.composition, villager: 3 },
    };
    expect(validateBoard(board).join()).toContain('角色总数 10 与座位数 9 不一致');
  });

  it('抓出没有狼人', () => {
    const board: Board = {
      ...DEFAULT_BOARD,
      composition: { ...DEFAULT_BOARD.composition, werewolf: 0, villager: 5 },
    };
    expect(validateBoard(board)).toContain('至少需要 1 个狼人');
  });

  it('抓出狼人不少于好人', () => {
    const board: Board = {
      seatCount: 6,
      id: 'bad',
      name: '失衡局',
      hasChiefElection: false,
      composition: { werewolf: 3, seer: 1, witch: 1, hunter: 0, guard: 0, villager: 1 },
    };
    expect(validateBoard(board).join()).toContain('局面不平衡');
  });

  it('抓出座位数过少', () => {
    const board: Board = {
      seatCount: 4,
      id: 'tiny',
      name: '四人局',
      hasChiefElection: false,
      composition: { werewolf: 1, seer: 1, witch: 0, hunter: 0, guard: 0, villager: 2 },
    };
    expect(validateBoard(board)).toContain('座位数少于 6，不足以构成有效对局');
  });
});

describe('规则参数', () => {
  it('默认值与设计文档 4.3 一致', () => {
    expect(resolveRules()).toMatchObject({
      guardNoRepeatTarget: true,
      guardCanSelfProtect: true,
      witchAntidoteCount: 1,
      witchPoisonCount: 1,
      witchOnePotionPerNight: true,
      witchCanSelfSave: false,
      guardedAndSavedDies: true,
      hunterCanShootWhenPoisoned: false,
      chiefVoteWeight: 1.5,
      chiefBadgeLostOnSecondTie: true,
      chiefElectionBeforeDawnAnnounce: true,
      firstNightDeathsHaveLastWords: true,
      votedOutHasLastWords: true,
      nightDeathsHaveLastWordsFromNight2: false,
      wolfKillTakesPriority: true,
      tieMeansNoElimination: true,
    });
  });

  it('默认时限全部为正数', () => {
    for (const value of Object.values(DEFAULT_RULES.timeoutMs)) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it('可以覆盖标量参数', () => {
    const rules = resolveRules({ witchCanSelfSave: true, chiefVoteWeight: 2 });
    expect(rules.witchCanSelfSave).toBe(true);
    expect(rules.chiefVoteWeight).toBe(2);
    // 未覆盖的字段保持默认
    expect(rules.guardedAndSavedDies).toBe(true);
  });

  it('可以只覆盖部分时限', () => {
    const rules = resolveRules({ timeoutMs: { daySpeech: 1 } });
    expect(rules.timeoutMs.daySpeech).toBe(1);
    expect(rules.timeoutMs.dayVote).toBe(DEFAULT_RULES.timeoutMs.dayVote);
  });

  it('resolveRules 不会污染默认值', () => {
    resolveRules({ timeoutMs: { daySpeech: 1 } });
    expect(DEFAULT_RULES.timeoutMs.daySpeech).toBe(90_000);
  });

  it('抓出非正时限', () => {
    const rules = resolveRules({ timeoutMs: { dayVote: -1 } });
    expect(validateRules(rules).join()).toContain('时限 dayVote 必须是正数');
  });

  it('抓出过低的警长票权', () => {
    const rules = resolveRules({ chiefVoteWeight: 0.5 });
    expect(validateRules(rules).join()).toContain('警长票权');
  });

  it('默认规则本身合法', () => {
    expect(validateRules(DEFAULT_RULES)).toEqual([]);
  });
});
