import { refreshOrderDerived, type OrderDerivedChanges } from '../domain/derivedState';
import type { WriteContext } from '../storage/datasetRuntime';

/**
 * 在同一写事务内把派生值落库（八步重算的 3/5/6/7 步已在 `refreshOrderDerived` 内定序）。
 *
 * 只写派生列：轮次完成态、累计任务缓存、订单完成标志。绝不改写事件、occurrence 历史、
 * 收款、附件或批次。
 */
export async function persistOrderDerived(
  ctx: WriteContext,
  orderId: string,
): Promise<OrderDerivedChanges> {
  const changes = refreshOrderDerived(ctx.data, orderId);
  const order = ctx.data.orders.find((row) => row.id === orderId);
  if (order) await ctx.table('orders').put(order);
  for (const session of ctx.data.hosting_sessions.filter((row) => row.orderId === orderId)) {
    await ctx.table('hosting_sessions').put(session);
  }
  for (const task of ctx.data.task_definitions.filter((row) => row.orderId === orderId)) {
    if (task.progressType === 'NUMERIC') await ctx.table('task_definitions').put(task);
  }
  return changes;
}
