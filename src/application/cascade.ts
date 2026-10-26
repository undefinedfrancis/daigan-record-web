import type { WriteContext } from '../storage/datasetRuntime';

export interface CascadeCounts {
  orders: number;
  periods: number;
  tasks: number;
  occurrences: number;
  receipts: number;
  attachments: number;
  batches: number;
}

export function emptyCascadeCounts(): CascadeCounts {
  return { orders: 0, periods: 0, tasks: 0, occurrences: 0, receipts: 0, attachments: 0, batches: 0 };
}

export function addCascadeCounts(target: CascadeCounts, source: CascadeCounts): CascadeCounts {
  return {
    orders: target.orders + source.orders,
    periods: target.periods + source.periods,
    tasks: target.tasks + source.tasks,
    occurrences: target.occurrences + source.occurrences,
    receipts: target.receipts + source.receipts,
    attachments: target.attachments + source.attachments,
    batches: target.batches + source.batches,
  };
}

/**
 * 彻底删除一张订单及其派生的全部记录（打卡、截图、收款、更正、批量撤销项）。
 * 金额会从实收与待收中移除，调用方必须先让用户确认影响范围。
 */
export async function deleteOrderCascade(
  ctx: WriteContext,
  orderId: string,
): Promise<CascadeCounts> {
  const taskIds = new Set(
    ctx.data.task_definitions.filter((task) => task.orderId === orderId).map((task) => task.id),
  );
  const occurrences = ctx.data.task_occurrences.filter((row) =>
    taskIds.has(row.taskDefinitionId),
  );
  const occurrenceIds = new Set(occurrences.map((row) => row.id));
  const attachments = ctx.data.attachments.filter(
    (row) =>
      (row.taskDefinitionId !== null && taskIds.has(row.taskDefinitionId)) ||
      (row.occurrenceId !== null && occurrenceIds.has(row.occurrenceId)),
  );
  const receipts = ctx.data.receipts.filter((row) => row.orderId === orderId);
  const receiptIds = new Set(receipts.map((row) => row.id));
  const periods = ctx.data.hosting_periods.filter((row) => row.orderId === orderId);

  const isOurItem = (item: (typeof ctx.data.completion_batch_items)[number]): boolean =>
    (item.occurrenceId !== null && occurrenceIds.has(item.occurrenceId)) ||
    (item.occurrenceId === null &&
      item.taskDefinitionId !== null &&
      taskIds.has(item.taskDefinitionId));

  const ourItems = ctx.data.completion_batch_items.filter(isOurItem);
  const touchedBatchIds = new Set(ourItems.map((item) => item.batchId));
  // 只删除仅属于本订单的批次头；跨订单批量（全部完成）保留，避免影响其他订单的撤销。
  const removableBatchIds = new Set(
    ctx.data.completion_batches
      .filter(
        (batch) =>
          batch.targetId === orderId ||
          (touchedBatchIds.has(batch.id) &&
            ctx.data.completion_batch_items
              .filter((item) => item.batchId === batch.id)
              .every(isOurItem)),
      )
      .map((batch) => batch.id),
  );

  for (const attachment of attachments) {
    await ctx.table('attachments').delete(attachment.id);
    await ctx.db.attachmentBlobs.delete(attachment.id);
  }
  // 本机站内提醒是订单派生数据：随订单删除，避免留下指向不存在订单的弹窗。
  await ctx.db.local_reminders.where('orderId').equals(orderId).delete();
  // 累计事件（自引用更正链）先于任务删除，避免留下孤儿链。
  for (const event of ctx.data.task_progress_events.filter((row) =>
    taskIds.has(row.taskDefinitionId),
  )) {
    await ctx.table('task_progress_events').delete(event.id);
  }
  for (const occurrence of occurrences) {
    await ctx.table('task_occurrences').delete(occurrence.id);
  }
  for (const item of ourItems) {
    await ctx.table('completion_batch_items').delete(item.id);
  }
  for (const batchId of removableBatchIds) {
    await ctx.table('completion_batches').delete(batchId);
  }
  for (const session of ctx.data.hosting_sessions.filter((row) => row.orderId === orderId)) {
    await ctx.table('hosting_sessions').delete(session.id);
  }
  for (const taskId of taskIds) {
    await ctx.table('task_definitions').delete(taskId);
  }
  for (const period of periods) {
    await ctx.table('hosting_periods').delete(period.id);
  }
  for (const correction of ctx.data.receipt_corrections.filter((row) =>
    receiptIds.has(row.receiptId),
  )) {
    await ctx.table('receipt_corrections').delete(correction.id);
  }
  for (const receipt of receipts) {
    await ctx.table('receipts').delete(receipt.id);
  }
  for (const change of ctx.data.order_price_changes.filter((row) => row.orderId === orderId)) {
    await ctx.table('order_price_changes').delete(change.id);
  }
  for (const operation of ctx.data.order_creation_operations.filter(
    (row) => row.orderId === orderId,
  )) {
    await ctx.table('order_creation_operations').delete(operation.operationId);
  }
  await ctx.table('orders').delete(orderId);

  return {
    orders: 1,
    periods: periods.length,
    tasks: taskIds.size,
    occurrences: occurrences.length,
    receipts: receipts.length,
    attachments: attachments.length,
    batches: ourItems.length,
  };
}
