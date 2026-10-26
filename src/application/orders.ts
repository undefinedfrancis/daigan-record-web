import { AppError } from '../contracts/errors';
import type {
  BackupDataSet,
  HostingPeriodRow,
  OrderRow,
  OrderType,
  PaymentMode,
  TaskDefinitionRow,
} from '../contracts/tables';
import { MONEY_MAX_CENTS } from '../contracts/tables';
import {
  gameDateAt,
  hostingEndDateForWeekdays,
  isISODate,
  isValidZone,
} from '../domain/gameCalendar';
import { paidForOrder, paidForPeriod } from '../domain/ledger';
import { parseMonthDays, parseWeekdays, slotFor, slotsInRange } from '../domain/occurrences';
import type { DatasetRuntime, DatasetToken, WriteContext } from '../storage/datasetRuntime';
import { colourTokenToArgb } from '../backup/normalize/localColours';
import { addCascadeCounts, deleteOrderCascade, emptyCascadeCounts } from './cascade';
import type {
  ChangeDatesCommand,
  ChangePriceCommand,
  CreateOrderCommand,
  RenewCommand,
  TemplateTaskDraft,
  UpdateOrderCommand,
  UpdateOrderTaskItem,
} from './contracts';
import { fingerprintOf } from './fingerprint';
import { assertReceivedAt } from './receipts';
import {
  assertOrderWritable,
  assertWritableAccount,
  mustFindAccount,
  mustFindOrder,
  mustFindOwner,
  optionalText,
  requireText,
} from './guards';

export interface OrderDeps {
  runtime: DatasetRuntime;
  newId: () => string;
  now: () => number;
}

function assertMoney(cents: number, label: string): number {
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MONEY_MAX_CENTS) {
    throw new AppError('AMOUNT_OUT_OF_RANGE', `${label}必须在 0.01–99,999,999.99 元之间`);
  }
  return cents;
}

function optionalDate(value: string | null | undefined, label: string): string | null {
  if (!value) return null;
  if (!isISODate(value)) throw new AppError('INVALID_INPUT', `${label}不是有效日期`);
  return value;
}

/** 每月刷新日（逗号分隔 1–31）；空表示按周刷新。归一化为升序去重的日号串。 */
function optionalRefreshDays(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  const days = trimmed
    .split(/[,，、\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 31);
  if (days.length === 0) {
    throw new AppError('INVALID_INPUT', '每月刷新日必须为 1–31 的日号');
  }
  return [...new Set(days)].sort((left, right) => left - right).join(',');
}

function assertRefresh(daily: number, weeklyDay: number, weeklyMinutes: number): void {
  if (!Number.isInteger(daily) || daily < 0 || daily > 1439) {
    throw new AppError('INVALID_INPUT', '每日刷新时间越界');
  }
  if (!Number.isInteger(weeklyDay) || weeklyDay < 1 || weeklyDay > 7) {
    throw new AppError('INVALID_INPUT', '每周刷新星期必须为 1–7');
  }
  if (!Number.isInteger(weeklyMinutes) || weeklyMinutes < 0 || weeklyMinutes > 1439) {
    throw new AppError('INVALID_INPUT', '每周刷新时间越界');
  }
}

function validateTasks(tasks: TemplateTaskDraft[]): void {
  if (tasks.length > 100) throw new AppError('INVALID_INPUT', '任务最多 100 个');
  tasks.forEach((task) => {
    requireText(task.title, '任务标题', 1, 40);
    if (task.recurrence === 'MONTHLY') {
      const days = parseMonthDays(task.monthDay ?? null, task.monthDays ?? null);
      if (days.length === 0) {
        throw new AppError('INVALID_INPUT', '每月任务必须填写 1–31 的日号');
      }
    }
    if (task.recurrence === 'EVERY_N_DAYS' && (!task.everyNDays || task.everyNDays < 1)) {
      throw new AppError('INVALID_INPUT', '每隔 N 天必须填写 1–365');
    }
    if (task.recurrence === 'SELECTED_WEEKDAYS' && !task.weekdays) {
      throw new AppError('INVALID_INPUT', '指定星期任务必须选择星期');
    }
    const activeFrom = optionalDate(task.activeFrom ?? null, '任务生效起始日');
    const activeUntil = optionalDate(task.activeUntil ?? null, '任务生效截止日');
    if (activeFrom !== null && activeUntil !== null && activeUntil < activeFrom) {
      throw new AppError('INVALID_INPUT', '任务生效截止日不能早于生效起始日');
    }
  });
}

/**
 * 托管任务不允许"一次性"周期：它不产生任何打卡槽（`slotFor` 恒为 null），
 * 备份契约也明确拒绝（`validateSnapshot` "托管任务不得使用一次性周期"）。
 * 必须在写入时拒绝，否则用户会得到一个永远不能打卡、且无法恢复的任务。
 */
function assertHostingRecurrences(tasks: TemplateTaskDraft[]): void {
  const oneTime = tasks.find((task) => task.recurrence === 'ONE_TIME');
  if (oneTime) {
    throw new AppError(
      'INVALID_INPUT',
      `托管任务「${oneTime.title}」不能使用一次性周期，请改为每日；只做一次可改用累计目标 0 → 1`,
    );
  }
}

/** 任务草稿 → 定义行字段（建单与全量修改共用同一套归一化规则）。 */
function taskDraftFields(task: TemplateTaskDraft) {
  return {
    title: task.title,
    progressType: task.progressType,
    startValue: task.progressType === 'CHECKBOX' ? '0' : task.startValue,
    targetValue: task.progressType === 'CHECKBOX' ? '1' : task.targetValue,
    unit: task.progressType === 'CHECKBOX' ? null : task.unit,
    recurrence: task.recurrence,
    weekdays: task.recurrence === 'SELECTED_WEEKDAYS' ? task.weekdays : null,
    everyNDays: task.recurrence === 'EVERY_N_DAYS' ? task.everyNDays : null,
    monthDay: task.recurrence === 'MONTHLY' ? task.monthDay : null,
    monthDays: task.recurrence === 'MONTHLY' ? (task.monthDays ?? null) : null,
    activeFrom: optionalDate(task.activeFrom ?? null, '任务生效起始日'),
    activeUntil: optionalDate(task.activeUntil ?? null, '任务生效截止日'),
    // 普通任务保持 legacy 口径（null = PER_OCCURRENCE），绝不批量改成累计。
    numericMode: task.numericMode ?? null,
  };
}

/**
 * 订单级托管镜像：`orders.hostingMode/targetSessions` 只是**最高 periodIndex 计次期次**
 * 的摘要，永不用来终止某个期次。
 */
function hostingMirrorOf(periods: HostingPeriodRow[]): {
  hostingMode: OrderRow['hostingMode'];
  targetSessions: number | null;
} {
  const countPeriods = periods.filter((row) => row.serviceCount !== null);
  if (countPeriods.length === 0) return { hostingMode: 'DATE_RANGE', targetSessions: null };
  const highest = countPeriods.reduce((left, right) =>
    right.periodIndex > left.periodIndex ||
    (right.periodIndex === left.periodIndex && right.id > left.id)
      ? right
      : left,
  );
  return { hostingMode: 'COUNT_BASED', targetSessions: highest.serviceCount };
}

/**
 * 建单期次的服务星期集合。
 *
 * 显式传入就必须合法且非空（不猜一个集合）；省略/null 才沿用历史“周一至周五”默认，
 * 以保持普通（无模板）建单的既有行为。去重升序后直接拼成持久化字符串。
 */
function createServiceWeekdays(value: number[] | null | undefined): number[] {
  if (value === null || value === undefined) return [1, 2, 3, 4, 5];
  const unique = [...new Set(value)];
  if (unique.length === 0) {
    throw new AppError('INVALID_INPUT', '仅服务日托管必须至少选择一个服务星期');
  }
  if (unique.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new AppError('INVALID_INPUT', '服务星期必须是 1–7');
  }
  return unique.sort((left, right) => left - right);
}

function buildTaskRows(
  orderId: string,
  periodId: string | null,
  tasks: TemplateTaskDraft[],
  sortStart: number,
  newId: () => string,
  now: () => number,
): TaskDefinitionRow[] {
  return tasks.map((task, index) => ({
    id: newId(),
    orderId,
    periodId,
    ...taskDraftFields(task),
    // 累计目标的缓存从起始值开始（续期即"新 scope 起始值"语义）；普通任务保持 0。
    currentValue: task.progressType === 'NUMERIC' ? task.startValue : '0',
    sortOrder: sortStart + index,
    completedAt: null,
    completionBatchId: null,
    createdAt: now(),
    updatedAt: now(),
    retiredAt: null,
    // 新任务默认不设自身颜色：显示时继承订单色（colorArgb null = 继承）。
    colorArgb: null,
    // activeFrom/activeUntil 由 taskDraftFields 提供（任务生效起止日期）。
  }));
}

/** 删除任务守卫：已有打卡、截图或批次记录的任务不能删。 */
function assertTaskDeletable(data: BackupDataSet, task: TaskDefinitionRow): void {
  const occurrences = data.task_occurrences.filter((row) => row.taskDefinitionId === task.id);
  const occurrenceIds = new Set(occurrences.map((row) => row.id));
  const hasOccurrenceRecords = occurrences.some(
    (row) => row.completedAt !== null || row.recordedAt !== null || row.value !== null,
  );
  const shortRecorded =
    task.periodId === null && (task.completedAt !== null || task.currentValue !== '0');
  const hasAttachments = data.attachments.some(
    (row) =>
      (row.taskDefinitionId !== null && row.taskDefinitionId === task.id) ||
      (row.occurrenceId !== null && occurrenceIds.has(row.occurrenceId)),
  );
  const hasBatches = data.completion_batch_items.some(
    (row) =>
      (row.taskDefinitionId !== null && row.taskDefinitionId === task.id) ||
      (row.occurrenceId !== null && occurrenceIds.has(row.occurrenceId)),
  );
  const hasEvents = data.task_progress_events.some(
    (row) => row.taskDefinitionId === task.id,
  );
  if (hasOccurrenceRecords || shortRecorded || hasAttachments || hasBatches || hasEvents) {
    throw new AppError('CONFLICT', `任务「${task.title}」已有打卡或截图记录，不能删除`);
  }
}

/**
 * 按最新任务定义与期次重建打卡项：有记录/有截图的历史行保留，
 * 无记录行仅在仍匹配新排期时保留（并同步窗口），缺失排期补齐。
 * 注意 ctx.data 是写前快照，本函数显式维护视图，不依赖 generateOccurrences。
 */
async function syncTaskOccurrences(
  ctx: WriteContext,
  period: HostingPeriodRow,
  tasks: TaskDefinitionRow[],
  newId: () => string,
  now: () => number,
  attachmentOccurrenceIds: Set<string>,
): Promise<void> {
  // 计次期次的打卡行只在真实写入时按 `N:<轮次>` 生成（G1 懒建行）：
  // 这里绝不预铺行，否则会写出已退役的 `C:` 键，让本机导出被自己的校验拒绝。
  if (period.serviceCount != null) return;
  const taskIds = new Set(tasks.map((task) => task.id));
  const desired = new Map<string, ReturnType<typeof slotsInRange>>();
  const scheduleEnd = period.endDate;
  for (const task of tasks) {
    if (!task.periodId || task.periodId !== period.id) continue;
    if (task.recurrence === 'ONE_TIME') continue;
    desired.set(task.id, slotsInRange(task, period, period.startDate, scheduleEnd));
  }
  const covered = new Set<string>();
  const existingRows = ctx.data.task_occurrences.filter((row) => taskIds.has(row.taskDefinitionId));
  for (const row of existingRows) {
    const slots = desired.get(row.taskDefinitionId);
    const slot = slots?.find((item) => item.key === row.occurrenceKey) ?? null;
    const protectedRow =
      row.completedAt !== null ||
      row.recordedAt !== null ||
      row.value !== null ||
      row.completionBatchId !== null ||
      attachmentOccurrenceIds.has(row.id);
    if (slot) {
      covered.add(`${row.taskDefinitionId}:${row.occurrenceKey}`);
      if (
        !protectedRow &&
        (row.windowStart !== slot.windowStart || row.windowEnd !== slot.windowEnd)
      ) {
        await ctx.table('task_occurrences').put({
          ...row,
          windowStart: slot.windowStart,
          windowEnd: slot.windowEnd,
        });
      }
      continue;
    }
    if (!protectedRow) {
      await ctx.table('task_occurrences').delete(row.id);
      continue;
    }
    // 受保护行：同一天仍有新排期时改挂新键保留打卡记录；否则作为历史行保留。
    const sameDay =
      slots?.find(
        (item) => item.gameDate === row.gameDate && !covered.has(`${row.taskDefinitionId}:${item.key}`),
      ) ?? null;
    if (sameDay) {
      covered.add(`${row.taskDefinitionId}:${sameDay.key}`);
      await ctx.table('task_occurrences').put({
        ...row,
        occurrenceKey: sameDay.key,
        windowStart: sameDay.windowStart,
        windowEnd: sameDay.windowEnd,
      });
    }
  }
  for (const [taskId, slots] of desired) {
    for (const slot of slots) {
      const composite = `${taskId}:${slot.key}`;
      if (covered.has(composite)) continue;
      covered.add(composite);
      await ctx.table('task_occurrences').add({
        id: newId(),
        taskDefinitionId: taskId,
        occurrenceKey: slot.key,
        gameDate: slot.gameDate,
        windowStart: slot.windowStart,
        windowEnd: slot.windowEnd,
        completedAt: null,
        recordedAt: null,
        backfilled: 0,
        completionBatchId: null,
        value: null,
        createdAt: now(),
      });
    }
  }
}

export async function generateOccurrences(
  ctx: WriteContext,
  period: HostingPeriodRow,
  tasks: TaskDefinitionRow[],
  newId: () => string,
  now: () => number,
): Promise<number> {
  // 计次期次不存在"预排期"：轮次行与 `N:` 打卡行都由写入事务懒建（契约 G1）。
  // 预铺 `C:` 行会让导出被 `validateSnapshot` 当成已退役键整份拒绝。
  if (period.serviceCount != null) return 0;
  const existing = new Set(
    ctx.data.task_occurrences
      .filter((row) => tasks.some((task) => task.id === row.taskDefinitionId))
      .map((row) => `${row.taskDefinitionId}:${row.occurrenceKey}`),
  );
  const scheduleEnd = period.endDate;
  let created = 0;
  for (const task of tasks) {
    if (!task.periodId || task.periodId !== period.id) continue;
    if (task.recurrence === 'ONE_TIME') continue;
    let cursor = period.startDate;
    let guard = 0;
    while (cursor <= scheduleEnd && guard < 1200) {
      const slot = slotFor(task, period, cursor);
      if (slot) {
        const key = `${task.id}:${slot.key}`;
        if (!existing.has(key)) {
          existing.add(key);
          await ctx.table('task_occurrences').add({
            id: newId(),
            taskDefinitionId: task.id,
            occurrenceKey: slot.key,
            gameDate: slot.gameDate,
            windowStart: slot.windowStart,
            windowEnd: slot.windowEnd,
            completedAt: null,
            recordedAt: null,
            backfilled: 0,
            completionBatchId: null,
            value: null,
            createdAt: now(),
          });
          created += 1;
        }
      }
      cursor = nextDay(cursor);
      guard += 1;
    }
  }
  return created;
}

function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, day + 1));
  return `${stamp.getUTCFullYear()}-${String(stamp.getUTCMonth() + 1).padStart(2, '0')}-${String(
    stamp.getUTCDate(),
  ).padStart(2, '0')}`;
}

export function createOrderServices({ runtime, newId, now }: OrderDeps) {
  return {
    async create(
      input: CreateOrderCommand,
      token: DatasetToken,
    ): Promise<{ orderId: string; receiptId: string | null }> {
      const title = requireText(input.title, '订单标题', 1, 60);
      const notes = optionalText(input.notes, 500, '备注');
      const zoneId = input.gameZoneId;
      if (!isValidZone(zoneId)) throw new AppError('INVALID_INPUT', '游戏时区不合法');
      assertRefresh(input.dailyRefreshMinutes, input.weeklyRefreshDay, input.weeklyRefreshMinutes);
      validateTasks(input.tasks);
      if (input.type === 'HOSTING') assertHostingRecurrences(input.tasks);

      let priceCents: number | null = null;
      let hostingEndDate: string | null = null;
      const serviceDays = input.serviceDays ?? null;
      const serviceCount = input.serviceCount ?? null;
      // 精确服务星期：只有“仅服务日累计天数”模式才带限制；按次数/按日期一律为 null，
      // 所以模板切到按次数时，上一个模板的星期不会漏进新期次。
      const serviceWeekdaySet = serviceDays !== null ? createServiceWeekdays(input.serviceWeekdays) : [];
      const serviceWeekdays = serviceDays !== null ? serviceWeekdaySet.join(',') : null;
      if (input.type === 'SHORT_TASK') {
        priceCents = assertMoney(input.priceCents ?? 0, '订单价格');
      } else if (serviceCount !== null) {
        // 按次数服务（整轮打卡累计）：不指定时间，不需要开始和结束日期。
        if (!Number.isInteger(serviceCount) || serviceCount < 1 || serviceCount > 3650) {
          throw new AppError('INVALID_INPUT', '服务次数必须为 1–3650');
        }
        if (serviceDays !== null) {
          throw new AppError('INVALID_INPUT', '按次数模式不能同时累计工作日天数');
        }
        assertMoney(input.periodPriceCents ?? 0, '期次价格');
      } else {
        if (!input.startDate || (!input.endDate && serviceDays === null)) {
          throw new AppError('INVALID_INPUT', '托管订单必须填写服务起止日期');
        }
        if (serviceDays !== null) {
          // UF-010：仅服务日托管，结束日由累计服务天数按**同一套**服务星期推算。
          if (!Number.isInteger(serviceDays) || serviceDays < 1 || serviceDays > 3650) {
            throw new AppError('INVALID_INPUT', '累计服务天数必须为 1–3650');
          }
          hostingEndDate = hostingEndDateForWeekdays(
            input.startDate,
            serviceDays,
            new Set(serviceWeekdaySet),
          );
        } else {
          hostingEndDate = input.endDate as string;
          if (input.startDate > hostingEndDate) {
            throw new AppError('INVALID_INPUT', '开始日期不能晚于结束日期');
          }
        }
        assertMoney(input.periodPriceCents ?? 0, '期次价格');
      }
      const deadlineDate = input.type === 'SHORT_TASK' ? optionalDate(input.deadlineDate, '截止日期') : null;
      const monthlyRefreshDays =
        input.type === 'HOSTING' ? optionalRefreshDays(input.monthlyRefreshDays ?? null) : null;
      if (input.firstReceipt) assertMoney(input.firstReceipt.amountCents, '首笔收款金额');

      const fingerprint = await fingerprintOf({
        type: input.type,
        accountId: input.accountId,
        ownerId: input.ownerId,
        title,
        notes,
        paymentMode: input.paymentMode,
        priceCents,
        deadlineDate,
        zoneId,
        dailyRefreshMinutes: input.dailyRefreshMinutes,
        weeklyRefreshDay: input.weeklyRefreshDay,
        weeklyRefreshMinutes: input.weeklyRefreshMinutes,
        monthlyRefreshDays,
        serviceCount,
        // 服务天数与服务星期决定期次结束日，必须参与同一操作的去重指纹。
        serviceDays,
        serviceWeekdays,
        startDate: input.startDate,
        endDate: input.endDate,
        periodPriceCents: input.periodPriceCents,
        tasks: input.tasks,
        firstReceipt: input.firstReceipt,
        sourceTemplateId: input.sourceTemplateId,
        sourceTemplateName: input.sourceTemplateName,
        sourceTemplateVersion: input.sourceTemplateVersion,
      });

      return runtime.write(token, async (ctx) => {
        const existingOperation = await ctx
          .table('order_creation_operations')
          .get(input.operationId);
        if (existingOperation) {
          if (existingOperation.fingerprint !== fingerprint) {
            throw new AppError('CONFLICT', '同一操作编号的建单内容不同，已拒绝');
          }
          return { orderId: existingOperation.orderId, receiptId: existingOperation.receiptId };
        }

        assertWritableAccount(ctx.data, input.ownerId, input.accountId);

        const orderId = newId();
        const order: OrderRow = {
          id: orderId,
          accountId: input.accountId,
          type: input.type,
          title,
          priceCents,
          paymentMode: input.paymentMode as PaymentMode,
          deadlineDate,
          notes,
          gameZoneId: zoneId,
          dailyRefreshMinutes: input.dailyRefreshMinutes,
          weeklyRefreshDay: input.weeklyRefreshDay,
          weeklyRefreshMinutes: input.weeklyRefreshMinutes,
          monthlyRefreshDays,
          createdAt: now(),
          updatedAt: now(),
          completedAt: null,
          sourceTemplateId: input.sourceTemplateId,
          sourceTemplateName: input.sourceTemplateName,
          sourceTemplateVersion: input.sourceTemplateVersion,
          cancelledAt: null,
          archivedAt: null,
          // 托管模式在期次写入后由 hostingMirrorOf 统一回填；此处先给出新建默认，
          // 保证非托管订单已符合契约（short order 必须为 null）。
          hostingMode: input.type === 'HOSTING' ? 'DATE_RANGE' : null,
          targetSessions: null,
          orderColor: null,
        };
        await ctx.table('orders').add(order);

        let period: HostingPeriodRow | null = null;
        if (input.type === 'HOSTING') {
          // 按次数模式无日历期限：起止同为创建游戏日（内部锚点），次数由 serviceCount 表达。
          const anchorDate =
            serviceCount !== null
              ? gameDateAt(now(), zoneId, input.dailyRefreshMinutes)
              : (input.startDate as string);
          period = {
            id: newId(),
            orderId,
            periodIndex: 0,
            startDate: anchorDate,
            endDate: serviceCount !== null ? anchorDate : (hostingEndDate as string),
            priceCents: input.periodPriceCents ?? 0,
            gameZoneId: zoneId,
            dailyRefreshMinutes: input.dailyRefreshMinutes,
            weeklyRefreshDay: input.weeklyRefreshDay,
            weeklyRefreshMinutes: input.weeklyRefreshMinutes,
            createdAt: now(),
            renewalOperationId: null,
            serviceDays: serviceCount !== null ? null : serviceDays,
            serviceWeekdays: serviceCount !== null ? null : serviceWeekdays,
            monthlyRefreshDays,
            serviceCount,
          };
          await ctx.table('hosting_periods').add(period);
          // 期次写入后回填订单级镜像（计次订单的目标次数）。
          const mirror = hostingMirrorOf([period]);
          await ctx.table('orders').put({
            ...order,
            hostingMode: mirror.hostingMode,
            targetSessions: mirror.targetSessions,
          });
        }

        const taskRows = buildTaskRows(
          orderId,
          period ? period.id : null,
          input.tasks,
          0,
          newId,
          now,
        );
        for (const row of taskRows) await ctx.table('task_definitions').add(row);

        if (period) {
          await generateOccurrences(ctx, period, taskRows, newId, now);
        }

        let receiptId: string | null = null;
        if (input.firstReceipt) {
          const receipt = input.firstReceipt;
          const ceiling = period ? period.priceCents : (order.priceCents ?? 0);
          if (receipt.amountCents > ceiling) {
            throw new AppError('AMOUNT_EXCEEDS_BALANCE', '首笔收款不能超过应收金额');
          }
          if (receipt.channel !== 'OTHER' && receipt.note) {
            throw new AppError('INVALID_INPUT', '只有“其他”渠道可以填写备注');
          }
          assertReceivedAt(receipt.receivedAt, now());
          receiptId = newId();
          await ctx.table('receipts').add({
            id: receiptId,
            operationId: input.operationId,
            orderId,
            periodId: period ? period.id : null,
            amountCents: receipt.amountCents,
            receivedAt: receipt.receivedAt,
            channel: receipt.channel,
            note: receipt.channel === 'OTHER' ? receipt.note : null,
            status: 'ACTIVE',
            replacedByReceiptId: null,
            createdAt: now(),
          });
        }

        await ctx.table('order_creation_operations').add({
          operationId: input.operationId,
          orderType: input.type as OrderType,
          fingerprint,
          orderId,
          receiptId,
          createdAt: now(),
        });
        return { orderId, receiptId };
      });
    },

    async renew(input: RenewCommand, token: DatasetToken): Promise<string> {
      if (!Number.isInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 3650) {
        throw new AppError('INVALID_INPUT', '续期天数必须为 1–3650');
      }
      assertMoney(input.priceCents, '续期价格');
      return runtime.write(token, async (ctx) => {
        const duplicate = ctx.data.hosting_periods.find(
          (period) => period.renewalOperationId === input.operationId,
        );
        if (duplicate) return duplicate.id;

        const order = assertOrderWritable(ctx.data, input.orderId);
        if (order.type !== 'HOSTING') {
          throw new AppError('INVALID_INPUT', '短期单不需要续期');
        }
        const periods = ctx.data.hosting_periods
          .filter((period) => period.orderId === order.id)
          .sort((left, right) => left.periodIndex - right.periodIndex);
        const latest = periods[periods.length - 1];
        if (!latest) throw new AppError('NOT_FOUND', '订单缺少托管期次');
        // 已有后续期次时不允许重复续期（重试幂等除外，上面已拦截）。
        const today = gameDateAt(now(), order.gameZoneId, order.dailyRefreshMinutes);
        // 按次数期次：durationDays 即续期次数，新期无日历期限，接续上一期完成后的游戏日。
        const countMode = latest.serviceCount != null;
        // UF-020：未到期也可提前续期，新期从上一期结束次日开始；到期后从当前游戏日开始。
        const startDate = countMode
          ? today
          : today > latest.endDate
            ? today
            : addDaysDate(latest.endDate, 1);
        // UF-010：工作日累计模式下 durationDays 为服务天数，结束日按工作日推算。
        const serviceMode = latest.serviceDays !== null;
        const serviceWeekdays = parseWeekdays(latest.serviceWeekdays);
        const actualEnd = countMode
          ? startDate
          : serviceMode
            ? hostingEndDateForWeekdays(
                startDate,
                input.durationDays,
                new Set(serviceWeekdays.length > 0 ? serviceWeekdays : [1, 2, 3, 4, 5]),
              )
            : addDaysDate(startDate, input.durationDays - 1);

        const period: HostingPeriodRow = {
          id: newId(),
          orderId: order.id,
          periodIndex: latest.periodIndex + 1,
          startDate,
          endDate: actualEnd,
          priceCents: input.priceCents,
          gameZoneId: order.gameZoneId,
          dailyRefreshMinutes: order.dailyRefreshMinutes,
          weeklyRefreshDay: order.weeklyRefreshDay,
          weeklyRefreshMinutes: order.weeklyRefreshMinutes,
          createdAt: now(),
          renewalOperationId: input.operationId,
          serviceDays: !countMode && serviceMode ? input.durationDays : null,
          serviceWeekdays: countMode ? null : latest.serviceWeekdays,
          monthlyRefreshDays: latest.monthlyRefreshDays,
          serviceCount: countMode ? input.durationDays : null,
        };
        await ctx.table('hosting_periods').add(period);

        const sourceTasks = ctx.data.task_definitions.filter(
          (task) => task.orderId === order.id && task.periodId === latest.id,
        );
        // 续期克隆保留任务自身颜色（`colorArgb` 随 `...task` 一起复制）；
        // 继承自订单的颜色无需复制，续期后仍然继承。
        const cloned: TaskDefinitionRow[] = sourceTasks.map((task) => ({
          ...task,
          id: newId(),
          periodId: period.id,
          // 续期是新的 scope：累计目标从起始值重新开始，绝不继承上一期的总值。
          currentValue: task.progressType === 'NUMERIC' ? task.startValue : '0',
          completedAt: null,
          completionBatchId: null,
          createdAt: now(),
          updatedAt: now(),
        }));
        for (const task of cloned) await ctx.table('task_definitions').add(task);
        await generateOccurrences(ctx, period, cloned, newId, now);
        // 新期次意味着订单重新进行中；订单级目标镜像跟随最新期次（F3）。
        const mirror = hostingMirrorOf([...periods, period]);
        await ctx.table('orders').put({
          ...order,
          completedAt: null,
          hostingMode: mirror.hostingMode,
          targetSessions: mirror.targetSessions,
          updatedAt: now(),
        });
        return period.id;
      });
    },

    async changeDates(input: ChangeDatesCommand, token: DatasetToken): Promise<void> {
      await runtime.write(token, async (ctx) => {
        const order = mustFindOrder(ctx.data, input.orderId);
        if (order.cancelledAt !== null) {
          throw new AppError('ORDER_CANCELLED', '订单已作废，不能修改日期');
        }
        if (order.type === 'SHORT_TASK') {
          if (input.deadlineDate !== undefined) {
            const deadline = optionalDate(input.deadlineDate, '截止日期');
            await ctx.table('orders').put({ ...order, deadlineDate: deadline, updatedAt: now() });
          }
          return;
        }
        const periodId = input.periodId;
        if (!periodId) throw new AppError('INVALID_INPUT', '托管订单需要指定期次');
        const periods = ctx.data.hosting_periods
          .filter((period) => period.orderId === order.id)
          .sort((left, right) => left.periodIndex - right.periodIndex);
        const index = periods.findIndex((period) => period.id === periodId);
        if (index < 0) throw new AppError('NOT_FOUND', '期次不存在');
        const period = periods[index];
        if (period.serviceCount != null) {
          throw new AppError('INVALID_INPUT', '按次数期次没有服务日期，请在「修改」中调整服务次数');
        }
        const startDate = optionalDate(input.startDate, '开始日期') ?? period.startDate;
        const endDate = optionalDate(input.endDate, '结束日期') ?? period.endDate;
        if (startDate > endDate) throw new AppError('INVALID_INPUT', '开始日期不能晚于结束日期');

        const previous = periods[index - 1];
        const next = periods[index + 1];
        if (previous && startDate <= previous.endDate) {
          throw new AppError('PERIOD_OVERLAP', '开始日期与上一期重叠');
        }
        if (next && endDate >= next.startDate) {
          throw new AppError('PERIOD_OVERLAP', '结束日期与下一期重叠');
        }

        const occurrences = ctx.data.task_occurrences.filter((row) =>
          ctx.data.task_definitions.some(
            (task) => task.periodId === period.id && task.id === row.taskDefinitionId,
          ),
        );
        const hasRecords = occurrences.some((row) => row.completedAt !== null || row.recordedAt !== null);
        if (hasRecords && startDate !== period.startDate) {
          throw new AppError('CONFLICT', '本期已有打卡记录，不能移动开始日期');
        }
        if (
          hasRecords &&
          occurrences.some((row) => row.gameDate < startDate || row.gameDate > endDate)
        ) {
          throw new AppError('CONFLICT', '已有打卡记录不在新的服务期限内');
        }

        await ctx.table('hosting_periods').put({ ...period, startDate, endDate });
        const stillValid = occurrences.filter(
          (row) => row.gameDate >= startDate && row.gameDate <= endDate,
        );
        const removedIds = new Set(
          occurrences.filter((row) => !stillValid.includes(row)).map((row) => row.id),
        );
        for (const occurrence of occurrences) {
          if (removedIds.has(occurrence.id)) {
            await ctx.table('task_occurrences').delete(occurrence.id);
          }
        }
        const updatedPeriod: HostingPeriodRow = { ...period, startDate, endDate };
        const tasks = ctx.data.task_definitions.filter((task) => task.periodId === period.id);
        await generateOccurrences(ctx, updatedPeriod, tasks, newId, now);
      });
    },

    async cancel(id: string, token: DatasetToken): Promise<void> {
      await runtime.write(token, async (ctx) => {
        const order = mustFindOrder(ctx.data, id);
        if (order.cancelledAt !== null) return;
        await ctx.table('orders').put({
          ...order,
          cancelledAt: now(),
          completedAt: order.completedAt ?? null,
          updatedAt: now(),
        });
      });
    },

    async deleteEmpty(id: string, token: DatasetToken): Promise<void> {
      await runtime.write(token, async (ctx) => {
        mustFindOrder(ctx.data, id);
        const taskIds = new Set(
          ctx.data.task_definitions.filter((task) => task.orderId === id).map((task) => task.id),
        );
        const occurrences = ctx.data.task_occurrences.filter((row) =>
          taskIds.has(row.taskDefinitionId),
        );
        const hasWork = occurrences.some(
          (row) => row.completedAt !== null || row.recordedAt !== null || row.value !== null,
        );
        const hasAttachments = ctx.data.attachments.some(
          (row) =>
            (row.taskDefinitionId && taskIds.has(row.taskDefinitionId)) ||
            (row.occurrenceId && occurrences.some((item) => item.id === row.occurrenceId)),
        );
        const hasReceipts = ctx.data.receipts.some((row) => row.orderId === id);
        const periods = ctx.data.hosting_periods.filter((row) => row.orderId === id);
        const hasBatches = ctx.data.completion_batches.some((row) => row.targetId === id);
        const hasSessions = ctx.data.hosting_sessions.some((row) => row.orderId === id);
        const hasEvents = ctx.data.task_progress_events.some((row) => taskIds.has(row.taskDefinitionId));

        if (
          hasWork ||
          hasAttachments ||
          hasReceipts ||
          hasBatches ||
          hasSessions ||
          hasEvents ||
          periods.length > 1
        ) {
          throw new AppError(
            'ORDER_HAS_RECORDS',
            '该订单已有业务记录，只能作废，不能删除',
          );
        }

        for (const occurrence of occurrences) {
          await ctx.table('task_occurrences').delete(occurrence.id);
        }
        for (const taskId of taskIds) await ctx.table('task_definitions').delete(taskId);
        for (const period of periods) await ctx.table('hosting_periods').delete(period.id);
        const operations = ctx.data.order_creation_operations.filter((row) => row.orderId === id);
        for (const operation of operations) {
          await ctx.table('order_creation_operations').delete(operation.operationId);
        }
        await ctx.table('orders').delete(id);
      });
    },

    async rename(id: string, title: string, token: DatasetToken): Promise<void> {
      const nextTitle = requireText(title, '订单名称', 1, 60);
      await runtime.write(token, async (ctx) => {
        const order = mustFindOrder(ctx.data, id);
        await ctx.table('orders').put({ ...order, title: nextTitle, updatedAt: now() });
      });
    },

    async changePrice(input: ChangePriceCommand, token: DatasetToken): Promise<void> {
      if (
        !Number.isSafeInteger(input.priceCents) ||
        input.priceCents < 1 ||
        input.priceCents > MONEY_MAX_CENTS
      ) {
        throw new AppError('AMOUNT_OUT_OF_RANGE', '价格必须在 0.01–99,999,999.99 元之间');
      }
      await runtime.write(token, async (ctx) => {
        const order = mustFindOrder(ctx.data, input.orderId);
        if (order.cancelledAt !== null) {
          throw new AppError('ORDER_CANCELLED', '订单已作废，不能修改价格');
        }
        if (order.type === 'SHORT_TASK') {
          const paid = paidForOrder(ctx.data, order.id, now());
          if (input.priceCents < paid) {
            throw new AppError(
              'AMOUNT_EXCEEDS_BALANCE',
              `该订单已收款 ${(paid / 100).toFixed(2)} 元，价格不能低于已收金额`,
            );
          }
          const previousPriceCents = order.priceCents ?? 0;
          await ctx.table('orders').put({
            ...order,
            priceCents: input.priceCents,
            updatedAt: now(),
          });
          await ctx.table('order_price_changes').add({
            id: newId(),
            operationId: `price-${input.orderId}-${now()}`,
            orderId: order.id,
            periodId: null,
            previousPriceCents,
            newPriceCents: input.priceCents,
            reason: input.reason ?? null,
            createdAt: now(),
          });
          return;
        }
        if (!input.periodId) throw new AppError('PERIOD_REQUIRED', '托管订单需要指定期次');
        const period = ctx.data.hosting_periods.find(
          (row) => row.id === input.periodId && row.orderId === order.id,
        );
        if (!period) throw new AppError('NOT_FOUND', '期次不属于该订单');
        const paid = paidForPeriod(ctx.data, period.id, now());
        if (input.priceCents < paid) {
          throw new AppError(
            'AMOUNT_EXCEEDS_BALANCE',
            `本期已收款 ${(paid / 100).toFixed(2)} 元，价格不能低于已收金额`,
          );
        }
        await ctx.table('hosting_periods').put({ ...period, priceCents: input.priceCents });
        await ctx.table('orders').put({ ...order, updatedAt: now() });
        await ctx.table('order_price_changes').add({
          id: newId(),
          operationId: `price-${input.orderId}-${period.id}-${now()}`,
          orderId: order.id,
          periodId: period.id,
          previousPriceCents: period.priceCents,
          newPriceCents: input.priceCents,
          reason: input.reason ?? null,
          createdAt: now(),
        });
      });
    },

    async update(input: UpdateOrderCommand, token: DatasetToken): Promise<void> {
      const title = requireText(input.title, '订单标题', 1, 60);
      const notes = optionalText(input.notes, 500, '备注');
      const zoneId = input.gameZoneId;
      if (!isValidZone(zoneId)) throw new AppError('INVALID_INPUT', '游戏时区不合法');
      assertRefresh(input.dailyRefreshMinutes, input.weeklyRefreshDay, input.weeklyRefreshMinutes);
      if (input.tasks.length > 100) throw new AppError('INVALID_INPUT', '任务最多 100 个');
      validateTasks(input.tasks.map((item) => item.task));

      await runtime.write(token, async (ctx) => {
        const order = assertOrderWritable(ctx.data, input.orderId);
        const periods = ctx.data.hosting_periods
          .filter((row) => row.orderId === order.id)
          .sort((left, right) => left.periodIndex - right.periodIndex);
        const periodIds = new Set(periods.map((row) => row.id));
        const existingTasks = ctx.data.task_definitions.filter((row) => row.orderId === order.id);
        const existingById = new Map(existingTasks.map((row) => [row.id, row]));

        // 价格与期限按订单类型解释
        const priceCents =
          order.type === 'SHORT_TASK' ? assertMoney(input.priceCents ?? 0, '订单价格') : null;
        const deadlineDate =
          order.type === 'SHORT_TASK' ? optionalDate(input.deadlineDate, '截止日期') : null;
        const monthlyRefreshDays = optionalRefreshDays(
          input.monthlyRefreshDays !== undefined
            ? input.monthlyRefreshDays
            : order.monthlyRefreshDays,
        );
        if (order.type === 'HOSTING') {
          if (input.periods.length !== periods.length) {
            throw new AppError('INVALID_INPUT', '托管期次清单与订单不一致');
          }
          for (const item of input.periods) {
            if (!periodIds.has(item.periodId)) throw new AppError('NOT_FOUND', '期次不属于该订单');
          }
        } else if (input.periods.length > 0) {
          throw new AppError('INVALID_INPUT', '短期单没有期次');
        }

        // 任务清单校验
        for (const item of input.tasks) {
          if (order.type === 'HOSTING') {
            if (!item.periodId || !periodIds.has(item.periodId)) {
              throw new AppError('INVALID_INPUT', '托管任务必须挂有效期次');
            }
            // 存量脏数据（历史版本允许写入）在这里必须改掉才能保存，避免继续产出不可恢复数据。
            if (item.task.recurrence === 'ONE_TIME') {
              throw new AppError(
                'INVALID_INPUT',
                `托管任务「${item.task.title}」不能使用一次性周期，请改为每日；只做一次可改用累计目标 0 → 1`,
              );
            }
          } else if (item.periodId !== null) {
            throw new AppError('INVALID_INPUT', '短期单任务不能挂期次');
          }
          if (item.id) {
            const row = existingById.get(item.id);
            if (!row) throw new AppError('NOT_FOUND', '任务不存在');
            if ((row.periodId ?? null) !== (item.periodId ?? null)) {
              throw new AppError('INVALID_INPUT', '任务所属期次不能变更');
            }
          }
        }
        const keptIds = new Set(
          input.tasks.map((item) => item.id).filter((id): id is string => id !== null),
        );
        for (const row of existingTasks) {
          if (!keptIds.has(row.id)) assertTaskDeletable(ctx.data, row);
        }

        // 短期单价格不得低于已收
        if (order.type === 'SHORT_TASK' && priceCents !== null) {
          const paid = paidForOrder(ctx.data, order.id, now());
          if (priceCents < paid) {
            throw new AppError(
              'AMOUNT_EXCEEDS_BALANCE',
              `该订单已收款 ${(paid / 100).toFixed(2)} 元，价格不能低于已收金额`,
            );
          }
        }

        // 期次解析（UF-010：工作日累计模式结束日按工作日推算；按次数模式无日历期限）
        const periodInputs = new Map(input.periods.map((item) => [item.periodId, item]));
        const resolvedPeriods = periods.map((period) => {
          const item = periodInputs.get(period.id);
          if (!item) throw new AppError('INVALID_INPUT', '托管期次清单与订单不一致');
          const nextServiceDays = item.serviceDays !== undefined ? item.serviceDays : period.serviceDays;
          const nextServiceCount =
            item.serviceCount !== undefined ? item.serviceCount : period.serviceCount;
          if (nextServiceCount !== null && nextServiceDays !== null) {
            throw new AppError('INVALID_INPUT', '期次不能同时按工作日天数和次数服务');
          }
          const startDate = optionalDate(item.startDate, '开始日期') ?? period.startDate;
          const countMode = nextServiceCount !== null;
          if (countMode) {
            if (!Number.isInteger(nextServiceCount) || nextServiceCount < 1 || nextServiceCount > 3650) {
              throw new AppError('INVALID_INPUT', '服务次数必须为 1–3650');
            }
          }
          let endDate: string;
          if (countMode) {
            // 按次数：起止同为内部锚点日，不限日历期限。
            endDate = startDate;
          } else if (nextServiceDays !== null) {
            if (!Number.isInteger(nextServiceDays) || nextServiceDays < 1 || nextServiceDays > 3650) {
              throw new AppError('INVALID_INPUT', '累计服务天数必须为 1–3650');
            }
            const serviceWeekdays = parseWeekdays(period.serviceWeekdays);
            const recompute =
              startDate !== period.startDate ||
              (item.serviceDays !== undefined && item.serviceDays !== period.serviceDays);
            endDate = recompute
              ? hostingEndDateForWeekdays(
                  startDate,
                  nextServiceDays,
                  new Set(serviceWeekdays.length > 0 ? serviceWeekdays : [1, 2, 3, 4, 5]),
                )
              : period.endDate;
          } else {
            endDate = optionalDate(item.endDate, '结束日期') ?? period.endDate;
          }
          if (!countMode && startDate > endDate) {
            throw new AppError('INVALID_INPUT', '开始日期不能晚于结束日期');
          }
          const periodPriceCents = assertMoney(item.priceCents, '期次价格');
          const paid = paidForPeriod(ctx.data, period.id, now());
          if (periodPriceCents < paid) {
            throw new AppError(
              'AMOUNT_EXCEEDS_BALANCE',
              `第 ${period.periodIndex + 1} 期已收款 ${(paid / 100).toFixed(2)} 元，价格不能低于已收金额`,
            );
          }
          return {
            period,
            startDate,
            endDate,
            priceCents: periodPriceCents,
            serviceDays: countMode ? null : nextServiceDays,
            serviceCount: nextServiceCount,
            countMode,
          };
        });
        for (let index = 0; index < resolvedPeriods.length; index += 1) {
          const current = resolvedPeriods[index];
          const previous = resolvedPeriods[index - 1];
          const next = resolvedPeriods[index + 1];
          // 按次数期次无日历期限，不参与日期重叠校验。
          if (previous && !current.countMode && !previous.countMode && current.startDate <= previous.endDate) {
            throw new AppError('PERIOD_OVERLAP', '开始日期与上一期重叠');
          }
          if (next && !current.countMode && !next.countMode && current.endDate >= next.startDate) {
            throw new AppError('PERIOD_OVERLAP', '结束日期与下一期重叠');
          }
        }

        const attachmentOccurrenceIds = new Set(
          ctx.data.attachments
            .map((row) => row.occurrenceId)
            .filter((id): id is string => id !== null),
        );
        const refreshChanged =
          zoneId !== order.gameZoneId ||
          input.dailyRefreshMinutes !== order.dailyRefreshMinutes ||
          input.weeklyRefreshDay !== order.weeklyRefreshDay ||
          input.weeklyRefreshMinutes !== order.weeklyRefreshMinutes ||
          monthlyRefreshDays !== order.monthlyRefreshDays;

        // 落库：期次（日期/价格/工作日模式/服务设置副本）
        let scheduleDirty = false;
        const updatedPeriods = new Map<string, HostingPeriodRow>();
        for (const item of resolvedPeriods) {
          const period = item.period;
          const datesChanged = item.countMode
            ? item.startDate !== period.startDate
            : item.startDate !== period.startDate || item.endDate !== period.endDate;
          const priceChanged = item.priceCents !== period.priceCents;
          const serviceChanged =
            item.serviceDays !== period.serviceDays || item.serviceCount !== period.serviceCount;
          if (datesChanged && !item.countMode) {
            const rows = ctx.data.task_occurrences.filter((row) =>
              existingTasks.some(
                (task) => task.periodId === period.id && task.id === row.taskDefinitionId,
              ),
            );
            const recorded = rows.filter(
              (row) => row.completedAt !== null || row.recordedAt !== null,
            );
            if (recorded.length > 0 && item.startDate !== period.startDate) {
              throw new AppError('CONFLICT', '本期已有打卡记录，不能移动开始日期');
            }
            if (recorded.some((row) => row.gameDate < item.startDate || row.gameDate > item.endDate)) {
              throw new AppError('CONFLICT', '已有打卡记录不在新的服务期限内');
            }
          }
          const nextPeriod: HostingPeriodRow = {
            ...period,
            startDate: item.startDate,
            endDate: item.endDate,
            priceCents: item.priceCents,
            serviceDays: item.serviceDays,
            serviceWeekdays:
              item.serviceDays !== null ? (period.serviceWeekdays ?? '1,2,3,4,5') : null,
            serviceCount: item.serviceCount,
            gameZoneId: zoneId,
            dailyRefreshMinutes: input.dailyRefreshMinutes,
            weeklyRefreshDay: input.weeklyRefreshDay,
            weeklyRefreshMinutes: input.weeklyRefreshMinutes,
            monthlyRefreshDays,
          };
          updatedPeriods.set(period.id, nextPeriod);
          if (datesChanged || priceChanged || serviceChanged || refreshChanged) {
            await ctx.table('hosting_periods').put(nextPeriod);
          }
          if (datesChanged || serviceChanged) scheduleDirty = true;
          if (priceChanged) {
            await ctx.table('order_price_changes').add({
              id: newId(),
              operationId: `price-${order.id}-${period.id}-${now()}-${newId()}`,
              orderId: order.id,
              periodId: period.id,
              previousPriceCents: period.priceCents,
              newPriceCents: item.priceCents,
              reason: null,
              createdAt: now(),
            });
          }
        }

        // 落库：订单基本字段（改价写审计）
        if (order.type === 'SHORT_TASK' && priceCents !== null && priceCents !== (order.priceCents ?? 0)) {
          await ctx.table('order_price_changes').add({
            id: newId(),
            operationId: `price-${order.id}-${now()}-${newId()}`,
            orderId: order.id,
            periodId: null,
            previousPriceCents: order.priceCents ?? 0,
            newPriceCents: priceCents,
            reason: null,
            createdAt: now(),
          });
        }
        // 订单级托管镜像：期次目标改变后必须同步，否则导出/恢复时目标与实际期次不一致。
        const hostingMirror = order.type === 'HOSTING'
          ? hostingMirrorOf([...updatedPeriods.values()])
          : { hostingMode: null as OrderRow['hostingMode'], targetSessions: null as number | null };
        await ctx.table('orders').put({
          ...order,
          title,
          notes,
          paymentMode: input.paymentMode,
          priceCents: order.type === 'SHORT_TASK' ? priceCents : order.priceCents,
          deadlineDate: order.type === 'SHORT_TASK' ? deadlineDate : order.deadlineDate,
          gameZoneId: zoneId,
          dailyRefreshMinutes: input.dailyRefreshMinutes,
          weeklyRefreshDay: input.weeklyRefreshDay,
          weeklyRefreshMinutes: input.weeklyRefreshMinutes,
          monthlyRefreshDays,
          hostingMode: hostingMirror.hostingMode,
          targetSessions: hostingMirror.targetSessions,
          updatedAt: now(),
        });

        // 落库：任务清单（未列出的删除）
        let tasksDirty = false;
        const workingTasks: TaskDefinitionRow[] = [];
        for (let index = 0; index < input.tasks.length; index += 1) {
          const item: UpdateOrderTaskItem = input.tasks[index];
          const fields = taskDraftFields(item.task);
          if (item.id) {
            const row = existingById.get(item.id) as TaskDefinitionRow;
            const scheduleChanged =
              row.recurrence !== fields.recurrence ||
              row.weekdays !== fields.weekdays ||
              row.everyNDays !== fields.everyNDays ||
              row.monthDay !== fields.monthDay ||
              row.monthDays !== fields.monthDays;
            // 数值口径不能就地带历史切换：旧记录不能被重新解释成累计总值。
            if ((row.numericMode ?? null) !== (fields.numericMode ?? null)) {
              const hasOccurrences = ctx.data.task_occurrences.some(
                (item) => item.taskDefinitionId === row.id,
              );
              const hasEvents = ctx.data.task_progress_events.some(
                (item) => item.taskDefinitionId === row.id,
              );
              if (hasOccurrences || hasEvents) {
                throw new AppError(
                  'CONFLICT',
                  `任务「${row.title}」已有进度记录，不能切换数值口径；请新建任务并保留旧任务`,
                );
              }
            }
            const nextTask: TaskDefinitionRow = { ...row, ...fields, sortOrder: index, updatedAt: now() };
            await ctx.table('task_definitions').put(nextTask);
            workingTasks.push(nextTask);
            if (scheduleChanged) tasksDirty = true;
          } else {
            const nextTask = buildTaskRows(order.id, item.periodId, [item.task], index, newId, now)[0];
            await ctx.table('task_definitions').add(nextTask);
            // 新增任务 `colorArgb` 为 null → 显示时自动继承订单色，无需额外的跟随标记。
            workingTasks.push(nextTask);
            tasksDirty = true;
          }
        }
        for (const row of existingTasks) {
          if (keptIds.has(row.id)) continue;
          tasksDirty = true;
          for (const occurrence of ctx.data.task_occurrences.filter(
            (item) => item.taskDefinitionId === row.id,
          )) {
            await ctx.table('task_occurrences').delete(occurrence.id);
          }
          for (const event of ctx.data.task_progress_events.filter(
            (item) => item.taskDefinitionId === row.id,
          )) {
            await ctx.table('task_progress_events').delete(event.id);
          }
          await ctx.table('task_definitions').delete(row.id);
          // 任务级提醒随任务删除，避免弹窗指向已不存在的任务。
          await ctx.db.local_reminders.where('taskId').equals(row.id).delete();
        }

        // 重建打卡项（托管单；有记录/截图的历史行保留）
        if (order.type === 'HOSTING' && (tasksDirty || scheduleDirty || refreshChanged)) {
          for (const period of periods) {
            await syncTaskOccurrences(
              ctx,
              updatedPeriods.get(period.id) ?? period,
              workingTasks.filter((task) => task.periodId === period.id),
              newId,
              now,
              attachmentOccurrenceIds,
            );
          }
        }
      });
    },

    /**
     * 订单颜色（schema 15 起写入 `orders.orderColor`，随备份往返）。
     *
     * 颜色归属订单：任务未设自身颜色（`task_definitions.colorArgb === null`）时继承该色，
     * 任务自身颜色保留为显式覆盖。取消整单只需清空订单色 —— 继承它的任务随之恢复无色，
     * 不需要（也不应该）把"跟随"固化成任务级覆盖。
     */
    async setOrderColor(orderId: string, color: string | null, token: DatasetToken): Promise<void> {
      const argb = colourTokenToArgb(color);
      if (color !== null && argb === null) {
        throw new AppError('INVALID_INPUT', '颜色标记不合法');
      }
      await runtime.write(token, async (ctx) => {
        const order = mustFindOrder(ctx.data, orderId);
        await ctx.table('orders').put({ ...order, orderColor: argb });
      });
    },

    async previewDeletion(id: string) {
      return runtime.read((ctx) => {
        mustFindOrder(ctx.data, id);
        const taskIds = new Set(
          ctx.data.task_definitions.filter((task) => task.orderId === id).map((task) => task.id),
        );
        const occurrences = ctx.data.task_occurrences.filter((row) =>
          taskIds.has(row.taskDefinitionId),
        );
        const occurrenceIds = new Set(occurrences.map((row) => row.id));
        return addCascadeCounts(emptyCascadeCounts(), {
          orders: 1,
          periods: ctx.data.hosting_periods.filter((row) => row.orderId === id).length,
          tasks: taskIds.size,
          occurrences: occurrences.length,
          receipts: ctx.data.receipts.filter((row) => row.orderId === id).length,
          attachments: ctx.data.attachments.filter(
            (row) =>
              (row.taskDefinitionId !== null && taskIds.has(row.taskDefinitionId)) ||
              (row.occurrenceId !== null && occurrenceIds.has(row.occurrenceId)),
          ).length,
          batches: ctx.data.completion_batch_items.filter(
            (item) =>
              (item.occurrenceId !== null && occurrenceIds.has(item.occurrenceId)) ||
              (item.occurrenceId === null &&
                item.taskDefinitionId !== null &&
                taskIds.has(item.taskDefinitionId)),
          ).length,
        });
      });
    },

    async deleteCancelled(id: string, token: DatasetToken) {
      return runtime.write(token, async (ctx) => {
        const order = mustFindOrder(ctx.data, id);
        if (order.cancelledAt === null) {
          throw new AppError('CONFLICT', '只有已作废订单可以这样删除；未作废订单请先作废');
        }
        return deleteOrderCascade(ctx, id);
      });
    },
  };
}

function addDaysDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, day + days));
  return `${stamp.getUTCFullYear()}-${String(stamp.getUTCMonth() + 1).padStart(2, '0')}-${String(
    stamp.getUTCDate(),
  ).padStart(2, '0')}`;
}

export { mustFindAccount, mustFindOwner, nextDay };
