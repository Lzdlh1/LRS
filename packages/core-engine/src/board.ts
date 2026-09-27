import { ROLES, type Role } from '@lrs/shared';

/** 板子的角色构成。用显式字段而不是 Record，保证少写一个角色就会被类型检查抓到。 */
export interface BoardComposition {
  werewolf: number;
  seer: number;
  witch: number;
  hunter: number;
  guard: number;
  villager: number;
}

export interface Board {
  id: string;
  name: string;
  seatCount: number;
  /** 本板子是否有警长竞选环节 */
  hasChiefElection: boolean;
  composition: BoardComposition;
}

/**
 * 9 人预女猎守：3 狼人 + 预言家 / 女巫 / 猎人 / 守卫 + 2 平民 = 9
 */
export const PRESET_BOARDS: Record<string, Board> = {
  '9p-pre-witch-hunter-guard': {
    id: '9p-pre-witch-hunter-guard',
    name: '9 人预女猎守',
    seatCount: 9,
    hasChiefElection: true,
    composition: {
      werewolf: 3,
      seer: 1,
      witch: 1,
      hunter: 1,
      guard: 1,
      villager: 2,
    },
  },
};

export const DEFAULT_BOARD: Board = PRESET_BOARDS['9p-pre-witch-hunter-guard']!;

/** 板子校验。返回错误说明列表，空数组表示合法。 */
export function validateBoard(board: Board): string[] {
  const errors: string[] = [];

  const total = ROLES.reduce((sum, role) => sum + board.composition[role], 0);
  if (total !== board.seatCount) {
    errors.push(`角色总数 ${total} 与座位数 ${board.seatCount} 不一致`);
  }

  if (board.composition.werewolf < 1) {
    errors.push('至少需要 1 个狼人');
  }

  const goodCount = board.seatCount - board.composition.werewolf;
  if (goodCount < 1) {
    errors.push('至少需要 1 个好人');
  } else if (board.composition.werewolf >= goodCount) {
    errors.push(`狼人数 ${board.composition.werewolf} 不少于好人数 ${goodCount}，局面不平衡`);
  }

  if (board.seatCount < 6) {
    errors.push('座位数少于 6，不足以构成有效对局');
  }

  return errors;
}

/** 按板子组成打出身份牌堆（未洗牌）。顺序固定，洗牌由开局流程负责。 */
export function buildRoleDeck(board: Board): Role[] {
  const deck: Role[] = [];
  for (const role of ROLES) {
    for (let i = 0; i < board.composition[role]; i += 1) {
      deck.push(role);
    }
  }
  return deck;
}
