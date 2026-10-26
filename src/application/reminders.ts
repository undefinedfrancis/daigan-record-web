import { AppError } from '../contracts/errors';
import type { BackupDataSet } from '../contracts/tables';
import type { LocalReminderRow } from '../storage/businessDb';
import type { DatasetRuntime, DatasetToken } from '../storage/datasetRuntime';
import type { DueReminderView, ReminderCommand, ReminderView } from './contracts';

const MAX_ACTIVE_PER_ORDER = 20;
const MAX_NOTE_LENGTH = 200;

interface ReminderDeps {
  runtime: DatasetRuntime;
  now: () => number;
  newId: () => string;
}

interface OrderContext {
  nickname: string;
  archived: boolean;
}

/** 订单所在的老板/账号上下文：归档的老板或账号不再打扰（与安卓提醒口径一致）。 */
function orderContext(data: BackupDataSet, orderId: string): OrderContext {
  const order = data.orders.find((row) => row.id === orderId);
  const account = order ? data.game_accounts.find((row) => row.id === order.accountId) : null;
  const owner = account ? data.owners.find((row) => row.id === account.ownerId) : null;
  return {
    nickname: owner?.nickname ?? '未知老板',
    archived:
      !order ||
      !account ||
      !owner ||
      order.archivedAt !== null ||
      account.archivedAt !== null ||
      owner.archivedAt !== null,
  };
}

/**
 * UF-053 站内提醒。
 *
 * 存在数据集内的本机表 `local_reminders`：不进入 `.dgbk`、不同步安卓，恢复备份时清空。
 * 到期判断只在读取时做一次（打开站点 / 每分钟轮询 / 返回页面），没有后台常驻任务。
 */
export function createReminderServices({ runtime, now, newId }: ReminderDeps) {
  function toView(data: BackupDataSet, row: LocalReminderRow): ReminderView {
    const task = row.taskId
      ? data.task_definitions.find((item) => item.id === row.taskId)
      : null;
    return {
      id: row.id,
      orderId: row.orderId,
      taskId: row.taskId,
      taskTitle: task?.title ?? null,
      remindAt: row.remindAt,
      note: row.note,
      acknowledgedAt: row.acknowledgedAt,
    };
  }

  return {
    async save(input: ReminderCommand, token: DatasetToken): Promise<string> {
      return runtime.write(token, async (ctx) => {
        const order = ctx.data.orders.find((row) => row.id === input.orderId);
        if (!order) throw new AppError('NOT_FOUND', '订单不存在或已被删除');
        if (order.cancelledAt !== null) throw new AppError('ORDER_CANCELLED', '已作废的订单不能设置提醒');
        if (orderContext(ctx.data, order.id).archived) {
          throw new AppError('ARCHIVED_ORDER', '已归档的订单不能设置提醒');
        }

        if (!Number.isFinite(input.remindAt)) {
          throw new AppError('INVALID_INPUT', '请选择提醒时间');
        }
        const stamp = now();
        if (input.remindAt < stamp) {
          throw new AppError('INVALID_INPUT', '提醒时间需晚于当前时间');
        }

        if (input.taskId !== null) {
          const task = ctx.data.task_definitions.find((row) => row.id === input.taskId);
          if (!task || task.orderId !== order.id) {
            throw new AppError('NOT_FOUND', '任务不存在或不属于该订单');
          }
          if (task.retiredAt !== null) {
            throw new AppError('INVALID_INPUT', '该任务已移除，不能设置提醒');
          }
        }

        const note = input.note?.trim() ? input.note.trim() : null;
        if (note && note.length > MAX_NOTE_LENGTH) {
          throw new AppError('INVALID_INPUT', `备注最多 ${MAX_NOTE_LENGTH} 字`);
        }

        const existing = await ctx.db.local_reminders
          .where('orderId')
          .equals(order.id)
          .toArray();
        const active = existing.filter((row) => row.acknowledgedAt === null);
        if (active.length >= MAX_ACTIVE_PER_ORDER) {
          throw new AppError('INVALID_INPUT', `单笔订单最多保留 ${MAX_ACTIVE_PER_ORDER} 条未读提醒`);
        }

        const id = newId();
        await ctx.db.local_reminders.add({
          id,
          orderId: order.id,
          taskId: input.taskId,
          remindAt: input.remindAt,
          note,
          createdAt: stamp,
          acknowledgedAt: null,
        });
        return id;
      });
    },

    async remove(id: string, token: DatasetToken): Promise<void> {
      await runtime.write(token, async (ctx) => {
        await ctx.db.local_reminders.delete(id);
      });
    },

    async acknowledge(ids: string[], token: DatasetToken): Promise<number> {
      if (ids.length === 0) return 0;
      return runtime.write(token, async (ctx) => {
        const stamp = now();
        let changed = 0;
        for (const id of ids) {
          const row = await ctx.db.local_reminders.get(id);
          if (!row || row.acknowledgedAt !== null) continue;
          await ctx.db.local_reminders.put({ ...row, acknowledgedAt: stamp });
          changed += 1;
        }
        return changed;
      });
    },

    async list(orderId: string): Promise<ReminderView[]> {
      return runtime.read(async (ctx) => {
        const rows = await ctx.db.local_reminders.where('orderId').equals(orderId).toArray();
        return rows
          .sort((left, right) => left.remindAt - right.remindAt)
          .map((row) => toView(ctx.data, row));
      });
    },

    async due(): Promise<DueReminderView[]> {
      return runtime.read(async (ctx) => {
        const stamp = now();
        const rows = await ctx.db.local_reminders
          .where('remindAt')
          .belowOrEqual(stamp)
          .toArray();
        const result: DueReminderView[] = [];
        for (const row of rows.sort((left, right) => left.remindAt - right.remindAt)) {
          if (row.acknowledgedAt !== null) continue;
          const order = ctx.data.orders.find((item) => item.id === row.orderId);
          // 订单被删除/作废/归档（含老板或账号归档）后不再打扰；任务被移除的提醒同样失效。
          if (!order || order.cancelledAt !== null) continue;
          const context = orderContext(ctx.data, order.id);
          if (context.archived) continue;
          if (row.taskId !== null) {
            const task = ctx.data.task_definitions.find((item) => item.id === row.taskId);
            if (!task || task.retiredAt !== null) continue;
          }
          result.push({
            ...toView(ctx.data, row),
            orderTitle: order.title,
            ownerNickname: context.nickname,
          });
        }
        return result;
      });
    },
  };
}
