import type { OrderRow, TaskDefinitionRow } from '../../contracts/tables';
import { bailAll, type MigrationDiagnostic } from './diagnostics';

/**
 * 命名色 → 不透明 ARGB（与契约 `conventions.colour.namedPaletteToArgb` 完全一致）。
 * 这些值来自历史网页调色板，必须逐值保留，不得重新取色。
 */
export const NAMED_COLOUR_ARGB: Readonly<Record<string, number>> = {
  red: 4292437084,
  amber: 4292449340,
  green: 4285179983,
  blue: 4283076825,
  purple: 4288375751,
  gray: 4288320908,
};

/**
 * ARGB → 命名色 token。
 *
 * UI 仍然使用六个预设 token 展示颜色；非预设 ARGB（例如安卓端自定义色）返回 null，
 * 数据本身保留在 `orders.orderColor` / `task_definitions.colorArgb` 中，不丢色。
 */
export function argbToColourToken(argb: number | null): string | null {
  if (argb === null) return null;
  for (const [token, value] of Object.entries(NAMED_COLOUR_ARGB)) {
    if (value === argb) return token;
  }
  return null;
}

/** 命名色 token → ARGB；未知 token 返回 null（调用方负责拒绝或忽略）。 */
export function colourTokenToArgb(token: string | null): number | null {
  if (token === null) return null;
  return NAMED_COLOUR_ARGB[token] ?? null;
}

export interface OrderColourMark {
  orderId: string;
  color: string;
}

export interface TaskColourMark {
  taskId: string;
  color: string;
  source?: 'order' | undefined;
}

export interface LocalColourResult {
  orderColours: number;
  taskColours: number;
  /** `source: 'order'` 的跟随标记：丢弃（可由订单色重算）。 */
  derivedDropped: number;
  /** 指向已不存在订单/任务的孤儿标记：丢弃并计数。 */
  orphansDropped: number;
}

/**
 * `web-local-colour-migration`：本机颜色表 → `orders.orderColor` / `task_definitions.colorArgb`。
 *
 * 规则：
 * - 已知命名色按固定 ARGB 转换；未知 token 逐条诊断并中止（绝不静默丢色）；
 * - `source: 'order'` 是整单色的显示派生物，丢弃而不是固化成任务自身覆盖；
 * - 指向缺失订单/任务的标记本来就是本机孤儿，丢弃并计数。
 */
export function applyLocalColourMarks(
  orders: OrderRow[],
  tasks: TaskDefinitionRow[],
  orderMarks: OrderColourMark[],
  taskMarks: TaskColourMark[],
): LocalColourResult {
  const diagnostics: MigrationDiagnostic[] = [];
  const orderById = new Map(orders.map((row) => [row.id, row]));
  const taskById = new Map(tasks.map((row) => [row.id, row]));
  const result: LocalColourResult = {
    orderColours: 0,
    taskColours: 0,
    derivedDropped: 0,
    orphansDropped: 0,
  };

  for (const mark of orderMarks) {
    const argb = NAMED_COLOUR_ARGB[mark.color];
    if (argb === undefined) {
      diagnostics.push({
        code: 'UNKNOWN_COLOUR_TOKEN',
        objects: { orderId: mark.orderId, colour: mark.color },
        reason: '未知的颜色 token，不能静默丢弃',
      });
      continue;
    }
    const order = orderById.get(mark.orderId);
    if (!order) {
      result.orphansDropped += 1;
      continue;
    }
    order.orderColor = argb;
    result.orderColours += 1;
  }

  for (const mark of taskMarks) {
    if (mark.source === 'order') {
      // 整单色的显示派生：跟着 orders.orderColor 重算，不写成任务覆盖。
      result.derivedDropped += 1;
      continue;
    }
    const argb = NAMED_COLOUR_ARGB[mark.color];
    if (argb === undefined) {
      diagnostics.push({
        code: 'UNKNOWN_COLOUR_TOKEN',
        objects: { taskId: mark.taskId, colour: mark.color },
        reason: '未知的颜色 token，不能静默丢弃',
      });
      continue;
    }
    const task = taskById.get(mark.taskId);
    if (!task) {
      result.orphansDropped += 1;
      continue;
    }
    task.colorArgb = argb;
    result.taskColours += 1;
  }

  if (diagnostics.length > 0) bailAll(diagnostics, '本机颜色标记无法安全迁移');
  return result;
}
