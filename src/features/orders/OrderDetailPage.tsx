import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Field,
  Modal,
  Select,
  TextInput,
  useToast,
} from '../../components/ui';
import {
  IconBell,
  IconCalendar,
  IconCamera,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconList,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '../../components/icons';
import { ColorTagPicker, colorHexOf } from '../../components/ColorTagPicker';
import { formatMoney, parseMoney, yuanInput } from '../../domain/money';
import {
  addDays,
  countServiceDaysUsed,
  diffDays,
  gameDateAt,
  hostingEndDateForWeekdays,
  weekdayNames,
} from '../../domain/gameCalendar';
import { parseWeekdays } from '../../domain/occurrences';
import { useApp } from '../../app/ServiceProvider';
import { useQuery } from '../../app/useQuery';
import { navigate } from '../../app/Router';
import { toAppError } from '../../contracts/errors';
import { beginOperation } from '../../pwa/updateSafety';
import type { OrderDetailView, ReminderView } from '../../application/contracts';
import type { CascadeCounts } from '../../application/cascade';
import type { ReceiptChannel } from '../../contracts/tables';
import { RECURRENCE_LABELS, fromDateTimeInput, toDateTimeInput, weekdayText } from './orderUtils';
import { OrderEditForm } from './OrderEditForm';
import { CumulativePanel, RetiredHistoryPanel } from './CumulativePanel';
import { ReminderDialog } from '../reminders/ReminderDialog';

/** 月历网格（周一开头）：返回当月每日 ISO 日期，前置空位为 null。 */
function monthCells(month: string): (string | null)[] {
  const [year, monthNum] = month.split('-').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(monthNum)) return [];
  const count = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(year, monthNum - 1, 1)).getUTCDay() + 6) % 7;
  return [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`),
  ];
}

/** 提醒时间按设备本地时区显示（与 datetime-local 输入一致）。 */
function reminderStamp(epochMs: number): string {
  return new Date(epochMs).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shiftMonthOf(month: string, delta: number): string {
  const [year, monthNum] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, monthNum - 1 + delta, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
}

const CHANNEL_LABELS: Record<ReceiptChannel, string> = {
  WECHAT: '微信',
  ALIPAY: '支付宝',
  BANK: '银行卡',
  CASH: '现金',
  OTHER: '其他',
};

function RenewForm({
  latestEnd,
  gameDate,
  serviceDaysMode,
  serviceWeekdays,
  countMode,
  onSubmit,
  onCancel,
}: {
  latestEnd: string | null;
  gameDate: string;
  /** UF-010：true 时「续期天数」为服务日天数。 */
  serviceDaysMode: boolean;
  /** 上一期的精确服务星期（ISO 1–7）；为空时按历史默认周一至周五预览。 */
  serviceWeekdays: readonly number[];
  /** 按次数期次：「续期天数」即续期次数，无日历期限。 */
  countMode: boolean;
  onSubmit: (durationDays: number, priceCents: number) => Promise<void>;
  onCancel: () => void;
}) {
  // 预览必须与命令层用同一集合推算结束日，否则会“预览一套、落库另一套”。
  const weekdaySet = new Set(serviceWeekdays.length > 0 ? serviceWeekdays : [1, 2, 3, 4, 5]);
  const [mode, setMode] = useState<'days' | 'date'>('days');
  const [days, setDays] = useState('30');
  const [endDate, setEndDate] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // UF-020 预览：提前续期从上期结束次日开始；到期后续期从当前游戏日开始。
  const early = latestEnd !== null && gameDate <= latestEnd;
  const previewStart = early ? addDays(latestEnd as string, 1) : gameDate;

  // 两种方式统一换算成续期天数：按日期时，工作日模式数服务日，普通模式数自然日。
  // 按次数期次：只有「续期次数」一种方式，无日历期限。
  const effectiveMode: 'days' | 'date' = countMode ? 'days' : mode;
  let durationDays: number | null = null;
  if (effectiveMode === 'days') {
    const value = Number(days);
    durationDays = Number.isInteger(value) && value > 0 ? value : null;
  } else if (endDate) {
    const count = serviceDaysMode
      ? countServiceDaysUsed(previewStart, endDate, endDate, weekdaySet)
      : endDate >= previewStart
        ? diffDays(previewStart, endDate) + 1
        : 0;
    durationDays = count >= 1 ? count : null;
  }
  const previewEnd =
    !countMode && durationDays !== null
      ? serviceDaysMode
        ? hostingEndDateForWeekdays(previewStart, durationDays, weekdaySet)
        : addDays(previewStart, durationDays - 1)
      : null;
  const calendarDays = previewEnd ? diffDays(previewStart, previewEnd) + 1 : 0;
  const modeHint = countMode
    ? '不指定时间：整轮打卡累计，上一期攒满次数后接续'
    : early
      ? '当前期未到期：提前续期，新期不截断当前期'
      : '已到期：新期从当前游戏日开始';

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void (async () => {
          try {
            if (durationDays === null) {
              throw new Error(
                countMode
                  ? '请填写续期次数'
                  : mode === 'date'
                    ? '请选择有效的新期结束日期'
                    : '请填写续期天数',
              );
            }
            await onSubmit(durationDays, parseMoney(price));
          } catch (reason) {
            setError(toAppError(reason).message);
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      {!countMode ? (
        <Field label="续期方式">
          <div className="flex flex-wrap gap-2">
            {(
              [
                { value: 'days', label: '按天数' },
                { value: 'date', label: '按结束日期' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={mode === option.value}
                className={`min-w-20 rounded-full border px-3 py-1.5 text-xs ${
                  mode === option.value
                    ? 'border-sage-deep bg-sage text-[#1f3a2a] font-semibold'
                    : 'border-line bg-white text-ink-soft'
                }`}
                onClick={() => setMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </Field>
      ) : null}
      {effectiveMode === 'days' ? (
        <Field
          label={
            countMode
              ? '续期次数'
              : serviceDaysMode
                ? `续期服务天数（${weekdayNames(serviceWeekdays) || '周一至周五'}）`
                : '续期天数'
          }
          hint={modeHint}
        >
          <TextInput
            value={days}
            inputMode="numeric"
            onChange={(event) => setDays(event.target.value)}
          />
        </Field>
      ) : (
        <Field
          label="新期结束日期"
          hint={`${modeHint}；从 ${previewStart} 起${
            serviceDaysMode
              ? `，按 ${weekdayNames(serviceWeekdays) || '周一至周五'} 计服务天数`
              : '，首尾均含'
          }`}
        >
          <TextInput
            type="date"
            value={endDate}
            min={previewStart}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </Field>
      )}
      {countMode && durationDays !== null ? (
        <div className="rounded-xl border border-sage-deep/30 bg-[#eaf3e6] px-3 py-2 text-sm">
          新期次：按次数共 {durationDays} 次打卡（上一期攒满后接续）
          <span className="block text-xs text-ink-soft">
            旧期次价格、打卡、截图与收款流水均不改动；新期收款独立记录。
          </span>
        </div>
      ) : previewEnd ? (
        <div className="rounded-xl border border-sage-deep/30 bg-[#eaf3e6] px-3 py-2 text-sm">
          新期次：{previewStart} 至 {previewEnd}（
          {serviceDaysMode
            ? `服务日 ${weekdayNames(serviceWeekdays) || '周一至周五'} ${durationDays} 天 · 含首尾 ${calendarDays} 天`
            : `含首尾共 ${calendarDays} 天`}
          ）
          {mode === 'date' && serviceDaysMode && endDate !== previewEnd ? (
            <span className="block text-xs text-ink-soft">
              仅服务日计服务天数，结束日按同一组服务星期推算为 {previewEnd}。
            </span>
          ) : null}
          <span className="block text-xs text-ink-soft">
            旧期次价格、打卡、截图与收款流水均不改动；新期收款独立记录。
          </span>
        </div>
      ) : mode === 'date' && endDate ? (
        <p className="muted">
          {endDate < previewStart
            ? `结束日期不能早于新期开始日 ${previewStart}。`
            : '所选范围没有工作日，请换一个结束日期。'}
        </p>
      ) : null}
      <Field label="新期价格（元）">
        <TextInput value={price} inputMode="decimal" onChange={(event) => setPrice(event.target.value)} />
      </Field>
      <ErrorText message={error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          确认续期
        </Button>
      </div>
    </form>
  );
}

function ReceiptForm({
  detail,
  initial,
  onSubmit,
  onCancel,
}: {
  detail: OrderDetailView;
  initial?: { amountCents: number; receivedAt: number; channel: ReceiptChannel; note: string | null; id: string };
  onSubmit: (payload: {
    amountCents: number;
    receivedAt: number;
    channel: ReceiptChannel;
    note: string | null;
    reason: string | null;
    periodId: string | null;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(initial ? yuanInput(initial.amountCents) : '');
  const [channel, setChannel] = useState<ReceiptChannel>(initial?.channel ?? 'WECHAT');
  const [note, setNote] = useState(initial?.note ?? '');
  const [receivedAt, setReceivedAt] = useState(toDateTimeInput(initial?.receivedAt ?? Date.now()));
  const [reason, setReason] = useState('');
  const [periodId, setPeriodId] = useState(detail.periods.at(-1)?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void (async () => {
          try {
            await onSubmit({
              amountCents: parseMoney(amount),
              receivedAt: fromDateTimeInput(receivedAt),
              channel,
              note: channel === 'OTHER' ? note || null : null,
              reason: reason.trim() || null,
              periodId: detail.order.type === 'HOSTING' ? periodId : null,
            });
          } catch (reason2) {
            setError(toAppError(reason2).message);
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      {detail.order.type === 'HOSTING' && !initial ? (
        <Field label="收款期次" hint="托管收款必须指定期次">
          <Select value={periodId} onChange={(event) => setPeriodId(event.target.value)}>
            {detail.periods.map((period) => (
              <option key={period.id} value={period.id}>
                第 {period.periodIndex + 1} 期 · 待收 ¥{formatMoney(period.outstandingCents)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="金额（元）">
          <TextInput value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field label="渠道">
          <Select value={channel} onChange={(event) => setChannel(event.target.value as ReceiptChannel)}>
            {Object.entries(CHANNEL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="到账时间"
          hint="可填未来时间（如闲鱼担保交易）；到账前只记为“待到账”，不计入实收"
        >
          <TextInput
            type="datetime-local"
            value={receivedAt}
            onChange={(event) => setReceivedAt(event.target.value)}
          />
        </Field>
        {initial ? (
          <Field label="更正原因">
            <TextInput value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        ) : null}
        {channel === 'OTHER' ? (
          <Field label="备注">
            <TextInput value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        ) : null}
      </div>
      <ErrorText message={error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {initial ? '保存更正' : '记录收款'}
        </Button>
      </div>
    </form>
  );
}

export function OrderDetailPage({ orderId }: { orderId: string }) {
  const { services, token, refresh } = useApp();
  const toast = useToast();
  const detail = useQuery(() => services.queries.orderDetail(orderId), [orderId]);
  // UF-053 站内提醒：本机表，随 revision 自动刷新。
  const reminders = useQuery<ReminderView[]>(() => services.reminders.list(orderId), [orderId]);
  const [error, setError] = useState<string | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  const [modal, setModal] = useState<
    'renew' | 'receipt' | 'photos' | 'cancel' | 'delete' | 'edit' | null
  >(null);
  const [amendTarget, setAmendTarget] = useState<string | null>(null);
  const [calMonth, setCalMonth] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  // 日历多选：迁移历史时一次补录多个日期，避免逐日逐项点击。
  const [batchMode, setBatchMode] = useState(false);
  const [batchDates, setBatchDates] = useState<string[]>([]);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminderTaskId, setReminderTaskId] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<CascadeCounts | null>(null);
  const [photoUrls, setPhotoUrls] = useState<
    { id: string; url: string; taskDefinitionId: string | null; occurrenceId: string | null }[]
  >([]);
  const [photoTick, setPhotoTick] = useState(0);
  const [uploadTarget, setUploadTarget] = useState('');
  const [photoTaskId, setPhotoTaskId] = useState<string | null>(null);
  const [taskPhotoUrls, setTaskPhotoUrls] = useState<
    { id: string; url: string; occurrenceId: string | null }[]
  >([]);

  const data = detail.data;
  const order = data?.order;

  const today = useMemo(() => {
    if (!order) return '';
    return gameDateAt(Date.now(), order.gameZoneId, order.dailyRefreshMinutes);
  }, [order]);

  const taskTitleById = useMemo(
    () => new Map((data?.tasks ?? []).map((task) => [task.id, task.title])),
    [data],
  );
  const occurrenceDateById = useMemo(() => {
    const map = new Map<string, string>();
    for (const day of data?.calendar ?? []) {
      for (const task of day.tasks) {
        // 周期任务会在窗口内多天出现（同一条 occurrence）：保留最早一天，避免附件日期漂移。
        if (task.occurrenceId && !map.has(task.occurrenceId)) {
          map.set(task.occurrenceId, task.attributedDate);
        }
      }
    }
    return map;
  }, [data]);
  // 同一游戏日可能有两轮打卡：按日期分组为数组，绝不塌缩成一条。
  const calendarByDate = useMemo(() => {
    const map = new Map<string, OrderDetailView['calendar']>();
    for (const day of data?.calendar ?? []) {
      const list = map.get(day.gameDate) ?? [];
      list.push(day);
      map.set(day.gameDate, list);
    }
    return map;
  }, [data]);

  function photoCaption(photo: {
    taskDefinitionId: string | null;
    occurrenceId: string | null;
  }): string {
    const title = photo.taskDefinitionId
      ? (taskTitleById.get(photo.taskDefinitionId) ?? '任务截图')
      : '任务截图';
    const gameDate = photo.occurrenceId ? (occurrenceDateById.get(photo.occurrenceId) ?? null) : null;
    return gameDate ? `${title} · ${gameDate}` : title;
  }

  useEffect(() => {
    if (modal !== 'delete') return;
    setDeletion(null);
    void services.orders
      .previewDeletion(orderId)
      .then(setDeletion)
      .catch(() => setDeletion(null));
  }, [modal, orderId, services]);

  useEffect(() => {
    if (modal !== 'photos' || !data) return;
    let disposed = false;
    const created: string[] = [];
    void services.attachments.list(orderId).then(async (list) => {
      const urls: {
        id: string;
        url: string;
        taskDefinitionId: string | null;
        occurrenceId: string | null;
      }[] = [];
      for (const item of list) {
        const blob = await services.attachments.load(item.id);
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        created.push(url);
        urls.push({
          id: item.id,
          url,
          taskDefinitionId: item.taskDefinitionId,
          occurrenceId: item.occurrenceId,
        });
      }
      if (!disposed) setPhotoUrls(urls);
    });
    return () => {
      disposed = true;
      created.forEach((url) => URL.revokeObjectURL(url));
      setPhotoUrls([]);
    };
  }, [modal, data, orderId, services, photoTick]);

  async function run<T>(action: () => Promise<T>, message?: string): Promise<T> {
    // 截图上传、收款、删除等写操作期间登记更新阻塞，避免刷新打断。
    const endOperation = beginOperation('order-detail-op');
    setOpBusy(true);
    setError(null);
    try {
      const result = await action();
      refresh();
      if (message) toast(message, 'success');
      return result;
    } catch (reason) {
      const text = toAppError(reason).message;
      setError(text);
      toast(text, 'error');
      throw reason;
    } finally {
      setOpBusy(false);
      endOperation();
    }
  }

  async function saveReminder(input: {
    taskId: string | null;
    remindAt: number;
    note: string | null;
  }) {
    const endOperation = beginOperation('order-detail-op');
    setOpBusy(true);
    try {
      await services.reminders.save({ orderId, ...input }, token);
      refresh();
      toast('已设置提醒', 'success');
    } finally {
      setOpBusy(false);
      endOperation();
    }
  }

  async function removeReminder(id: string) {
    await run(() => services.reminders.remove(id, token), '提醒已删除').catch(() => undefined);
  }

  useEffect(() => {
    if (!photoTaskId) return;
    let disposed = false;
    const created: string[] = [];
    void services.attachments.listTask(photoTaskId).then(async (list) => {
      const urls: { id: string; url: string; occurrenceId: string | null }[] = [];
      for (const item of list) {
        const blob = await services.attachments.load(item.id);
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        created.push(url);
        urls.push({ id: item.id, url, occurrenceId: item.occurrenceId });
      }
      if (!disposed) setTaskPhotoUrls(urls);
    });
    return () => {
      disposed = true;
      created.forEach((url) => URL.revokeObjectURL(url));
      setTaskPhotoUrls([]);
    };
  }, [photoTaskId, services, photoTick]);

  async function uploadTaskScreenshots(taskId: string, files: File[]) {
    await run(async () => {
      for (const file of files) {
        await services.attachments.put({ taskId }, file, token);
      }
    }, files.length > 1 ? `已上传 ${files.length} 张截图` : '截图已上传');
    setPhotoTick((value) => value + 1);
  }

  async function uploadScreenshots(files: File[]) {
    const taskId = uploadTarget || data?.tasks[0]?.id || '';
    if (!taskId) throw new Error('请先在「修改」中添加任务');
    await run(async () => {
      for (const file of files) {
        await services.attachments.put({ taskId }, file, token);
      }
    }, files.length > 1 ? `已上传 ${files.length} 张截图` : '截图已上传');
    setPhotoTick((value) => value + 1);
  }

  async function removeScreenshot(attachmentId: string) {
    await run(() => services.attachments.remove(attachmentId, token), '截图已删除');
    setPhotoTick((value) => value + 1);
  }

  if (detail.loading && !data) return <p className="muted">加载中…</p>;
  if (!data || !order) {
    return (
      <EmptyState
        title="找不到该订单"
        description={detail.error ?? undefined}
        action={<Button onClick={() => navigate('/orders')}>返回订单列表</Button>}
      />
    );
  }

  const month = calMonth || (today ? today.slice(0, 7) : '');
  const cells = monthCells(month);
  const selectedDayDate =
    selectedDate && cells.includes(selectedDate)
      ? selectedDate
      : cells.includes(today)
        ? today
        : (cells.find((date): date is string => date !== null && calendarByDate.has(date)) ?? '');
  const selectedEntries = selectedDayDate ? (calendarByDate.get(selectedDayDate) ?? []) : [];
  const amendEntry = amendTarget ? data.receipts.find((item) => item.id === amendTarget) : null;
  // 在途款：已录入但到账时间还没到（例如闲鱼担保交易），不冲抵待收。
  const pendingCents = data.receipts
    .filter((receipt) => receipt.pending)
    .reduce((sum, receipt) => sum + receipt.amountCents, 0);
  const selectedTasks = selectedEntries.flatMap((entry) => entry.tasks);
  const selectedDueTasks = selectedTasks.filter((task) => !task.inWindow);
  const selectedWindowTasks = selectedTasks.filter((task) => task.inWindow);

  // 多选补录：只有"当天应做、尚未完成的普通任务"才可被一键完成，
  // 累计任务与周期覆盖行（inWindow）不在此列——前者走累计进度，后者归触发日。
  const countMode = data.periods.some((period) => period.serviceCount !== null);
  const batchPendingByDate = new Map<string, number>();
  for (const date of cells) {
    if (!date || date > today) continue;
    const pending = (calendarByDate.get(date) ?? [])
      .flatMap((entry) => entry.tasks)
      .filter(
        (task) =>
          !task.inWindow &&
          !task.cumulative &&
          !task.completed &&
          task.attributedDate <= today,
      );
    if (pending.length > 0) batchPendingByDate.set(date, pending.length);
  }
  const batchPendingCount = batchDates.reduce(
    (sum, date) => sum + (batchPendingByDate.get(date) ?? 0),
    0,
  );

  function toggleBatchDate(date: string) {
    setBatchDates((current) =>
      current.includes(date)
        ? current.filter((item) => item !== date)
        : [...current, date].sort(),
    );
  }

  function exitBatchMode() {
    setBatchMode(false);
    setBatchDates([]);
  }

  async function completeSelectedDates() {
    const dates = [...batchDates].sort();
    if (dates.length === 0) return;
    const result = await run(() => services.tasks.completeDates({ orderId, dates }, token));
    if (result.recorded > 0) {
      toast(`已补录 ${result.dates} 天 · ${result.recorded} 项完成`, 'success');
    }
    if (result.skipped.length > 0) {
      const unique = [...new Set(result.skipped.map((item) => `${item.title}：${item.reason}`))];
      toast(unique.slice(0, 2).join('；'), 'info');
    }
    exitBatchMode();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => navigate('/orders')}>
          <IconChevronLeft size={18} /> 订单列表
        </Button>
        <div className="flex items-center gap-2">
          {opBusy ? (
            <span data-testid="page-busy">
              <Badge tone="warn">处理中…</Badge>
            </span>
          ) : null}
          <Button variant="ghost" onClick={detail.reload} aria-label="刷新">
            <IconRefresh size={18} />
          </Button>
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="page-title">{order.title}</h1>
              <ColorTagPicker
                value={order.colorTag}
                label={order.title}
                onChange={(color) => {
                  void run(() => services.orders.setOrderColor(orderId, color, token)).catch(
                    () => undefined,
                  );
                }}
              />
              <Badge>{order.type === 'HOSTING' ? '托管' : '短期单'}</Badge>
              {data.status === 'NOT_STARTED' ? <Badge>未开始</Badge> : null}
              {order.cancelled ? <Badge tone="danger">已作废</Badge> : null}
              {order.completed ? <Badge>已完成</Badge> : null}
            </div>
            <p className="muted mt-1">
              {order.ownerName} · {order.accountName} · {order.gameZoneId}
            </p>
            <p className="mt-1 text-sm">
              实收 ¥{formatMoney(order.paidCents)} · 待收{' '}
              {order.outstandingCents > 0 ? (
                <span className="font-semibold text-warn">¥{formatMoney(order.outstandingCents)}</span>
              ) : (
                '¥0.00'
              )}
              {pendingCents > 0 ? ` · 待到账 ¥${formatMoney(pendingCents)}` : ''}
            </p>
            {order.deadlineDate ? <p className="muted">交付期限 {order.deadlineDate}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {!order.cancelled ? (
              <>
                <Button variant="primary" onClick={() => setModal('receipt')}>
                  记录收款
                </Button>
                {order.type === 'HOSTING' ? (
                  <Button onClick={() => setModal('renew')}>续期</Button>
                ) : null}
                <Button onClick={() => setModal('edit')}>修改</Button>
                <Button onClick={() => setModal('photos')}>
                  <IconCamera size={16} /> 截图
                </Button>
                <Button variant="danger" onClick={() => setModal('cancel')}>
                  作废
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => setModal('photos')}>
                  <IconCamera size={16} /> 历史截图
                </Button>
                <Button variant="danger" onClick={() => setModal('delete')}>
                  删除订单
                </Button>
              </>
            )}
            {!order.cancelled ? (
              <Button variant="ghost" onClick={() => setModal('delete')}>
                删除空单
              </Button>
            ) : null}
          </div>
        </div>
        <ErrorText message={error} />
      </Card>

      {data.periods.length > 0 ? (
        <Card>
          <div className="section-title">
            <h2>期次</h2>
            <span className="muted">{data.periods.length} 期</span>
          </div>
          <ul className="flex flex-col gap-2">
            {data.periods.map((period) => (
              <li key={period.id} className="rounded-xl border border-line bg-white/70 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    第 {period.periodIndex + 1} 期 ·{' '}
                    {period.serviceCount != null
                      ? `按次数 ${period.serviceCount} 次`
                      : `${period.startDate} ~ ${period.endDate}`}
                    {period.serviceCount != null ? (
                      <span className="ml-2 text-xs text-ink-soft">
                        已打卡 {period.serviceRounds} 次 · 剩余{' '}
                        {Math.max(0, period.serviceCount - period.serviceRounds)}
                      </span>
                    ) : null}
                    {period.serviceDays !== null ? (
                      <span className="ml-2 text-xs text-ink-soft">
                        服务日 {weekdayNames(parseWeekdays(period.serviceWeekdays)) || '周一至周五'} ·
                        累计 {period.serviceDays} 天 · 已用 {period.serviceDaysUsed} · 剩余{' '}
                        {period.serviceDaysRemaining}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    {period.status === 'NOT_STARTED' ? <Badge>未开始</Badge> : null}
                    <span className="text-ink-soft">¥{formatMoney(period.priceCents)}</span>
                    {period.pendingCents > 0 ? (
                      <Badge>待到账 ¥{formatMoney(period.pendingCents)}</Badge>
                    ) : null}
                    {period.outstandingCents > 0 ? (
                      <Badge tone="warn">待收 ¥{formatMoney(period.outstandingCents)}</Badge>
                    ) : (
                      <Badge>已结清</Badge>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {data.rounds.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-soft">
              {data.rounds.map((round) => (
                <li key={round.sessionId}>
                  第 {round.sessionIndex} 次打卡 · 归属 {round.attributedDate ?? '—'} ·{' '}
                  {round.completedAt !== null
                    ? '已完成'
                    : `未完成（${round.completedTaskIds.length}/${round.dueTaskIds.length}）`}
                  {round.hasCumulative ? ' · 含累计目标' : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      <CumulativePanel detail={data} onChanged={detail.reload} />

      <Card>
        <div className="section-title">
          <h2>任务</h2>
          <span className="muted">{data.tasks.length} 个</span>
        </div>
        {data.tasks.length === 0 ? (
          <EmptyState title="没有任务" />
        ) : (
          <ul className="divide-y divide-line">
            {data.tasks.map((task) => (
              <li
                key={task.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                style={
                  colorHexOf(task.colorTag)
                    ? { borderLeft: `3px solid ${colorHexOf(task.colorTag)}`, paddingLeft: 6 }
                    : undefined
                }
              >
                <span className="flex items-center gap-2">
                  <ColorTagPicker
                    value={task.colorTag}
                    label={task.title}
                    onChange={(color) =>
                      run(() => services.tasks.setTaskColor(task.id, color, token))
                    }
                  />
                  <span>
                  <span className="block">{task.title}</span>
                  <span className="block text-xs text-ink-soft">
                    {RECURRENCE_LABELS[task.recurrence]}
                    {task.recurrence === 'SELECTED_WEEKDAYS' ? ` · 周${weekdayText(task.weekdays)}` : ''}
                    {task.recurrence === 'EVERY_N_DAYS' ? ` · 每 ${task.everyNDays} 天` : ''}
                    {task.recurrence === 'MONTHLY'
                      ? ` · 每月 ${(task.monthDays ?? String(task.monthDay ?? '')).split(',').filter(Boolean).join('、')} 日`
                      : ''}
                  </span>
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {order.type === 'HOSTING' && task.recurrence === 'ONE_TIME' && !task.cumulative ? (
                    <Badge>本期一次</Badge>
                  ) : null}
                  {task.cumulative ? <Badge>累计</Badge> : null}
                  {task.progressType === 'NUMERIC' ? (
                    <span className="text-xs text-ink-soft">
                      {task.currentValue} / {task.targetValue}
                      {task.unit ?? ''}
                    </span>
                  ) : null}
                  {order.cancelled ? null : (
                    <Button
                      variant="ghost"
                      style={{ minHeight: 28, padding: '0 6px' }}
                      title="给该任务设提醒"
                      aria-label={`${task.title} 提醒`}
                      onClick={() => {
                        setReminderTaskId(task.id);
                        setReminderOpen(true);
                      }}
                    >
                      <IconBell size={15} />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    style={{ minHeight: 28, padding: '0 6px' }}
                    title={task.attachmentCount > 0 ? '查看或添加截图' : '上传截图'}
                    aria-label={`${task.title} 截图`}
                    onClick={() => setPhotoTaskId(task.id)}
                  >
                    <IconCamera size={15} />
                    {task.attachmentCount > 0 ? (
                      <span className="text-xs">{task.attachmentCount}</span>
                    ) : null}
                  </Button>
                  {data.status === 'NOT_STARTED' ? (
                    // 预订单：任务还没生效，不能用"今日未完成"让人以为漏做。
                    <Badge>未开始</Badge>
                  ) : task.cumulative ? (
                    task.reachedTarget ? (
                      <Badge>已达标</Badge>
                    ) : (
                      <Badge tone="warn">未达标</Badge>
                    )
                  ) : task.completed ? (
                    <Badge>今日已完成</Badge>
                  ) : (
                    <Badge tone="warn">今日未完成</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="section-title flex-wrap gap-y-2">
          <h2 className="whitespace-nowrap">
            <IconBell size={17} /> 提醒
          </h2>
          {order.cancelled ? null : (
            <Button
              style={{ minHeight: 32, padding: '0 10px' }}
              onClick={() => {
                setReminderTaskId(null);
                setReminderOpen(true);
              }}
            >
              <IconPlus size={15} />
              <span className="ml-1 text-xs">设提醒</span>
            </Button>
          )}
        </div>
        {(reminders.data ?? []).length === 0 ? (
          <p className="muted">
            还没有提醒。可以给整笔订单或单条任务设一个时间，到点后打开网站会弹窗提示。
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {(reminders.data ?? []).map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line/70 bg-white/60 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    {item.acknowledgedAt !== null ? (
                      <Badge>已提醒</Badge>
                    ) : item.remindAt <= Date.now() ? (
                      <Badge tone="warn">待提醒</Badge>
                    ) : (
                      <Badge>未到点</Badge>
                    )}
                    <span className="font-medium tabular-nums">{reminderStamp(item.remindAt)}</span>
                    <span className="text-xs text-ink-soft">
                      {item.taskTitle ? `任务：${item.taskTitle}` : '整笔订单'}
                    </span>
                  </span>
                  {item.note ? (
                    <span className="mt-0.5 block text-xs text-ink-soft">{item.note}</span>
                  ) : null}
                </span>
                <Button
                  variant="ghost"
                  style={{ minHeight: 28, padding: '0 6px' }}
                  title="删除提醒"
                  aria-label={`删除提醒 ${reminderStamp(item.remindAt)}`}
                  onClick={() => void removeReminder(item.id)}
                >
                  <IconTrash size={15} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <RetiredHistoryPanel detail={data} onChanged={detail.reload} />

      <Card>
        <div className="section-title flex-wrap gap-y-2">
          <h2 className="whitespace-nowrap">
            <IconCalendar size={17} /> 打卡日历
          </h2>
          <div className="flex flex-wrap items-center justify-end gap-1">
            {data.calendar.length > 0 && !countMode ? (
              <Button
                variant={batchMode ? 'primary' : 'ghost'}
                aria-pressed={batchMode}
                aria-label={batchMode ? '退出多选' : '多选日期批量完成'}
                title="一次勾选多个日期，批量补录完成"
                style={{ minHeight: 32, padding: '0 8px' }}
                onClick={() => (batchMode ? exitBatchMode() : setBatchMode(true))}
              >
                <IconList size={16} />
                <span className="ml-1 text-xs">{batchMode ? '退出多选' : '多选'}</span>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              aria-label="上个月"
              style={{ minHeight: 32, padding: '0 6px' }}
              onClick={() => {
                setCalMonth(shiftMonthOf(month, -1));
                // 多选只针对当前可见月份，翻月清空避免选到看不见的日期。
                setBatchDates([]);
              }}
            >
              <IconChevronLeft size={16} />
            </Button>
            <span className="min-w-24 whitespace-nowrap text-center text-[15px] font-semibold tabular-nums">
              {month ? `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月` : '—'}
            </span>
            <Button
              variant="ghost"
              aria-label="下个月"
              style={{ minHeight: 32, padding: '0 6px' }}
              onClick={() => {
                setCalMonth(shiftMonthOf(month, 1));
                setBatchDates([]);
              }}
            >
              <IconChevronRight size={16} />
            </Button>
          </div>
        </div>
        {data.status === 'NOT_STARTED' ? (
          <p className="muted mb-2 text-xs">
            本期尚未开始：日历只是预排，开始当天才会进入今日事项，之前不能打卡或补录。
          </p>
        ) : null}
        {data.calendar.length === 0 ? (
          <EmptyState title="本期还没有可执行的打卡项" />
        ) : (
          <>
            <div className="rounded-2xl border border-line/60 bg-white/45 px-2 pb-2.5 pt-1.5">
              <div className="grid grid-cols-7 gap-x-1 gap-y-1.5 text-center">
                {['一', '二', '三', '四', '五', '六', '日'].map((label) => (
                  <span key={label} className="py-1 text-xs font-semibold text-ink">
                    {label}
                  </span>
                ))}
                {cells.map((date, index) => {
                  if (!date) return <span key={`blank-${index}`} />;
                  const dayEntries = calendarByDate.get(date) ?? [];
                  const everyTask = dayEntries.flatMap((entry) => entry.tasks);
                  // 格子只按"当天触发"的任务着色：周期覆盖展示（每月 / 每 N 天的其他日子）
                  // 不参与完成度，否则整月都会变成"待完成/部分完成"。
                  const allTasks = everyTask.filter((task) => !task.inWindow);
                  const windowOnly = everyTask.length > 0 && allTasks.length === 0;
                  const scheduled = allTasks.length > 0;
                  const doneCount = allTasks.filter((task) => task.completed).length;
                  const fullDone = allTasks.length > 0 && doneCount === allTasks.length;
                  const partDone = doneCount > 0 && !fullDone;
                  const isFuture = date > today;
                  const picked = batchDates.includes(date);
                  const pendingCount = batchPendingByDate.get(date) ?? 0;
                  // 多选模式下不能选未来日与"当天没有应做任务/已全部完成"的格子。
                  const batchDisabled = batchMode && (isFuture || pendingCount === 0);
                  return (
                    <span key={date} className="flex items-center justify-center">
                      <button
                        type="button"
                        onClick={() =>
                          batchMode ? toggleBatchDate(date) : setSelectedDate(date)
                        }
                        disabled={batchDisabled}
                        aria-pressed={batchMode ? picked : undefined}
                        aria-label={`${date}${fullDone ? ' 已完成' : partDone ? ' 部分完成' : ''}${
                          batchMode ? (picked ? ' 已选' : pendingCount > 0 ? ' 可多选' : ' 无待完成') : ''
                        }`}
                        title={
                          batchMode
                            ? pendingCount > 0
                              ? `点击${picked ? '取消选择' : '选择'}：${pendingCount} 项待完成`
                              : scheduled
                                ? '该日没有待完成的普通任务'
                                : '无任务'
                            : scheduled
                              ? `${doneCount}/${allTasks.length} 完成`
                              : windowOnly
                                ? `${everyTask.length} 个本周期任务（当天不是触发日）`
                                : '无任务'
                        }
                        className={[
                          'day-cell',
                          !scheduled
                            ? 'day-cell-empty'
                            : fullDone
                              ? 'day-cell-done'
                              : partDone
                                ? 'day-cell-partial'
                                : isFuture
                                  ? 'day-cell-future'
                                  : '',
                          date === today ? 'day-cell-today' : '',
                          !batchMode && date === selectedDayDate ? 'day-cell-selected' : '',
                          picked ? 'day-cell-picked' : '',
                          batchDisabled ? 'opacity-40' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {Number(date.slice(8, 10))}
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
            {batchMode ? (
              <div className="mt-3 rounded-xl border border-sage/60 bg-[#f3f8ef] px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    已选 {batchDates.length} 天 · 待完成 {batchPendingCount} 项
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      style={{ minHeight: 32, padding: '0 8px' }}
                      disabled={batchPendingByDate.size === 0}
                      onClick={() => setBatchDates([...batchPendingByDate.keys()].sort())}
                    >
                      全选未完成（{batchPendingByDate.size} 天）
                    </Button>
                    <Button
                      style={{ minHeight: 32, padding: '0 8px' }}
                      disabled={batchDates.length === 0}
                      onClick={() => setBatchDates([])}
                    >
                      清空
                    </Button>
                    <Button
                      variant="primary"
                      style={{ minHeight: 32, padding: '0 10px' }}
                      disabled={batchDates.length === 0 || batchPendingCount === 0 || opBusy}
                      onClick={() => void completeSelectedDates().catch(() => undefined)}
                    >
                      <IconCheck size={15} />
                      <span className="ml-1">完成所选</span>
                    </Button>
                  </div>
                </div>
                <p className="muted mt-1.5">
                  点击日期加入或移出选择；只补录尚未完成的普通打卡并标注为补录，已完成的日期不会重复记录。
                  累计任务请到「累计进度」记录。
                </p>
              </div>
            ) : (
            <div className="mt-3 rounded-xl border border-line bg-white/60 px-3 py-2">
              {selectedEntries.length > 0 ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {selectedDayDate}
                      {selectedDayDate > today ? (
                        <span className="ml-1 text-xs text-ink-soft">未来</span>
                      ) : null}
                      {selectedEntries.length > 1 ? (
                        <span className="ml-1 text-xs text-ink-soft">
                          （同日 {selectedEntries.length} 次打卡）
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs text-ink-soft">
                      当日 {selectedDueTasks.filter((task) => task.completed).length}/
                      {selectedDueTasks.length} 完成
                      {selectedWindowTasks.length > 0
                        ? ` · 本周期任务 ${selectedWindowTasks.filter((task) => task.completed).length}/${selectedWindowTasks.length}`
                        : ''}
                    </span>
                  </div>
                  {selectedEntries.map((entry) => (
                    <div
                      key={`${entry.gameDate}-${entry.sessionIndex ?? 'date'}`}
                      className="mt-1"
                    >
                      {entry.sessionIndex !== null ? (
                        <p className="text-xs font-medium text-ink-soft">
                          第 {entry.sessionIndex} 次打卡
                        </p>
                      ) : null}
                      <ul className="mt-1 flex flex-wrap gap-1">
                        {entry.tasks.map((task) => (
                          <li key={`${entry.gameDate}-${entry.sessionIndex ?? 'd'}-${task.taskId}`}>
                            {task.cumulative ? (
                              <span
                                className="badge bg-white"
                                title={`累计目标当日真实值；点击打卡不适用于累计任务，请到累计进度里记录/更正`}
                              >
                                {task.title} · {task.value ?? '—'}
                                {task.reachedTarget ? ' ✓' : ''}
                                {task.eventCount > 0 ? `（${task.eventCount} 条记录）` : ''}
                              </span>
                            ) : (
                              <button
                                type="button"
                                disabled={task.attributedDate > today || order.cancelled}
                                onClick={() =>
                                  void run(
                                    () =>
                                      services.tasks.setProgress(
                                        {
                                          taskId: task.taskId,
                                          // 周期任务在窗口内的其他日子展示：写入一律归到触发日。
                                          gameDate: task.attributedDate,
                                          value: task.value ?? '1',
                                          completed: !task.completed,
                                          backfilled: task.attributedDate < today,
                                        },
                                        token,
                                      ),
                                    task.completed ? '已取消打卡' : '已记录打卡',
                                  ).catch(() => undefined)
                                }
                                className={`badge ${
                                  task.completed ? 'border-sage-deep/40 bg-[#eaf3e6]' : 'bg-white'
                                } ${task.inWindow ? 'border-dashed border-sage' : ''} ${
                                  task.attributedDate > today ? 'opacity-50' : ''
                                }`}
                                title={
                                  task.inWindow
                                    ? `本周期任务，归属 ${task.attributedDate}；${
                                        task.completed ? '点击取消该次打卡' : '点击补录到该日'
                                      }`
                                    : task.completed
                                      ? '点击取消该次打卡'
                                      : '点击完成该次打卡'
                                }
                              >
                                {task.completed ? '✓ ' : ''}
                                {task.inWindow ? `本周期 ${task.attributedDate.slice(5)} · ` : ''}
                                {task.title}
                                {task.backfilled ? '（补录）' : ''}
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </>
              ) : (
                <p className="muted">该日没有安排任务。</p>
              )}
            </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-medium text-ink">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-sage ring-1 ring-sage-deep" />
                全部完成
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#d5e2cb] ring-1 ring-sage" />
                部分完成
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full border border-[rgba(48,79,61,0.28)] bg-white" />
                待完成
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full border border-line/60 bg-cream-deep" />
                无任务
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full border-2 border-sage-deep bg-white" />
                今天
              </span>
              {batchMode ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#eaf3e6] ring-2 ring-sage-deep" />
                  已选
                </span>
              ) : null}
              <span className="muted">
                {batchMode ? '点击日期加入或移出多选，再点「完成所选」' : '点击日期可查看、打卡或补录'}
              </span>
            </div>
          </>
        )}
      </Card>

      <Card>
        <div className="section-title">
          <h2>收款记录</h2>
          <span className="muted">{data.receipts.length} 条</span>
        </div>
        {data.receipts.length === 0 ? (
          <EmptyState title="还没有收款" />
        ) : (
          <ul className="divide-y divide-line">
            {data.receipts.map((receipt) => (
              <li key={receipt.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-medium">¥{formatMoney(receipt.amountCents)}</span>
                  <span className="ml-2 text-xs text-ink-soft">
                    {CHANNEL_LABELS[receipt.channel]} · {new Date(receipt.receivedAt).toLocaleString('zh-CN')}
                    {receipt.note ? ` · ${receipt.note}` : ''}
                  </span>
                  <span className="ml-2">
                    {receipt.status === 'VOIDED' ? <Badge tone="danger">已作废</Badge> : null}
                    {receipt.status === 'REPLACED' ? <Badge>已更正</Badge> : null}
                    {receipt.status === 'ACTIVE' ? (
                      receipt.pending ? <Badge tone="warn">待到账</Badge> : <Badge>有效</Badge>
                    ) : null}
                  </span>
                </span>
                {receipt.status === 'ACTIVE' && !order.cancelled ? (
                  <span className="flex gap-1">
                    {receipt.pending ? (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void run(
                            () =>
                              services.receipts.amend(
                                {
                                  operationId: `confirm-${receipt.id}-${Date.now()}`,
                                  receiptId: receipt.id,
                                  amountCents: receipt.amountCents,
                                  receivedAt: Date.now(),
                                  channel: receipt.channel,
                                  note: receipt.note,
                                  reason: '确认到账',
                                },
                                token,
                              ),
                            '已确认到账',
                          ).catch(() => undefined)
                        }
                      >
                        确认到账
                      </Button>
                    ) : null}
                    <Button variant="ghost" onClick={() => setAmendTarget(receipt.id)}>
                      更正
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void run(
                          () =>
                            services.receipts.void(
                              {
                                operationId: `void-${receipt.id}-${Date.now()}`,
                                receiptId: receipt.id,
                                reason: null,
                              },
                              token,
                            ),
                          '收款已作废',
                        ).catch(() => undefined)
                      }
                    >
                      作废
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {data.corrections.length > 0 ? (
          <div className="mt-3 border-t border-line pt-2">
            <p className="label mb-1">更正审计</p>
            <ul className="flex flex-col gap-1 text-xs text-ink-soft">
              {data.corrections.map((correction) => (
                <li key={correction.id}>
                  {new Date(correction.createdAt).toLocaleString('zh-CN')} ·{' '}
                  {correction.kind === 'AMEND' ? '更正' : '作废'} · ¥
                  {correction.previousAmountCents !== null
                    ? formatMoney(correction.previousAmountCents)
                    : '—'}
                  {correction.newAmountCents !== null
                    ? ` → ¥${formatMoney(correction.newAmountCents)}`
                    : ''}
                  {correction.reason ? ` · ${correction.reason}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <ReminderDialog
        open={reminderOpen}
        tasks={data.tasks.map((task) => ({ id: task.id, title: task.title }))}
        initialTaskId={reminderTaskId}
        onClose={() => setReminderOpen(false)}
        onSave={saveReminder}
      />

      <Modal open={modal === 'renew'} title="续期" onClose={() => setModal(null)} guardUpdates>
        <RenewForm
          latestEnd={order.currentPeriodEnd}
          gameDate={gameDateAt(Date.now(), order.gameZoneId, order.dailyRefreshMinutes)}
          serviceDaysMode={(data?.periods ?? []).some((item) => item.serviceDays !== null)}
          serviceWeekdays={parseWeekdays((data?.periods ?? []).at(-1)?.serviceWeekdays ?? null)}
          countMode={(data?.periods ?? []).at(-1)?.serviceCount != null}
          onCancel={() => setModal(null)}
          onSubmit={async (durationDays, priceCents) => {
            await run(
              () =>
                services.orders.renew(
                  {
                    operationId: `renew-${orderId}-${Date.now()}`,
                    orderId,
                    durationDays,
                    priceCents,
                  },
                  token,
                ),
              '已续期',
            );
            setModal(null);
          }}
        />
      </Modal>

      <Modal open={modal === 'edit'} title="修改订单" onClose={() => setModal(null)} wide guardUpdates>
        <OrderEditForm
          detail={data}
          onCancel={() => setModal(null)}
          onSubmit={async (command) => {
            await run(() => services.orders.update(command, token), '订单已更新');
            setModal(null);
          }}
        />
      </Modal>

      <Modal open={modal === 'receipt' || Boolean(amendEntry)} title={amendEntry ? '更正收款' : '记录收款'} onClose={() => { setModal(null); setAmendTarget(null); }} guardUpdates>
        <ReceiptForm
          detail={data}
          initial={amendEntry ?? undefined}
          onCancel={() => {
            setModal(null);
            setAmendTarget(null);
          }}
          onSubmit={async (payload) => {
            if (amendEntry) {
              await run(
                () =>
                  services.receipts.amend(
                    {
                      operationId: `amend-${amendEntry.id}-${Date.now()}`,
                      receiptId: amendEntry.id,
                      amountCents: payload.amountCents,
                      receivedAt: payload.receivedAt,
                      channel: payload.channel,
                      note: payload.note,
                      reason: payload.reason,
                    },
                    token,
                  ),
                '已保存更正',
              );
              setAmendTarget(null);
              return;
            }
            await run(
              () =>
                services.receipts.record(
                  {
                    operationId: `receipt-${orderId}-${Date.now()}`,
                    orderId,
                    periodId: payload.periodId,
                    amountCents: payload.amountCents,
                    receivedAt: payload.receivedAt,
                    channel: payload.channel,
                    note: payload.note,
                  },
                  token,
                ),
              '已记录收款',
            );
            setModal(null);
          }}
        />
      </Modal>

      <Modal
        open={photoTaskId !== null}
        title="任务截图"
        onClose={() => setPhotoTaskId(null)}
        wide
      >
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-dashed border-sage-deep/40 bg-white/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="muted flex-1 text-sm">
                可按住多选一次上传多张，上传后追加展示；托管单的按日截图也可在「今日事项」打卡时上传。
              </p>
              <label className="btn btn-primary cursor-pointer" style={{ minHeight: 38 }}>
                <IconCamera size={16} /> 选择图片上传
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    if (files.length > 0 && photoTaskId) {
                      void uploadTaskScreenshots(photoTaskId, files).catch(() => undefined);
                    }
                    event.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>
          {taskPhotoUrls.length === 0 ? (
            <p className="muted">该任务还没有截图。</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {taskPhotoUrls.map((photo) => (
                <figure
                  key={photo.id}
                  className="overflow-hidden rounded-xl border border-line bg-white"
                >
                  <img
                    src={photo.url}
                    alt="任务截图"
                    className="h-36 w-full bg-[#f7f4ea] object-contain"
                  />
                  <figcaption className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-ink-soft">
                    <span className="truncate">{photo.occurrenceId ? '按日截图' : '任务截图'}</span>
                    <Button
                      variant="ghost"
                      style={{ minHeight: 26, padding: '0 6px' }}
                      aria-label="删除截图"
                      onClick={() => void removeScreenshot(photo.id).catch(() => undefined)}
                    >
                      <IconTrash size={14} />
                    </Button>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <Modal open={modal === 'photos'} title="截图" onClose={() => setModal(null)} wide>
        <div className="flex flex-col gap-3">
          {data.tasks.length > 0 ? (
            <div className="rounded-xl border border-dashed border-sage-deep/40 bg-white/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex min-w-48 flex-1 items-center gap-2 text-sm">
                  <span className="text-ink-soft">挂靠任务</span>
                  <Select
                    value={uploadTarget || data.tasks[0].id}
                    onChange={(event) => setUploadTarget(event.target.value)}
                  >
                    {data.tasks.map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="btn btn-primary cursor-pointer" style={{ minHeight: 38 }}>
                  <IconCamera size={16} /> 选择图片上传
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="sr-only"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (files.length > 0) void uploadScreenshots(files).catch(() => undefined);
                      event.target.value = '';
                    }}
                  />
                </label>
              </div>
              <p className="muted mt-2 text-xs">
                可按住多选一次上传多张，上传后追加展示；托管单的按日截图也可在「今日事项」打卡时上传。
              </p>
            </div>
          ) : (
            <p className="muted">这张订单还没有任务，先在「修改」中添加任务后才能挂截图。</p>
          )}
          {photoUrls.length === 0 ? (
            <p className="muted">还没有截图。选择上方任务与图片即可上传。</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {photoUrls.map((photo) => (
                <figure
                  key={photo.id}
                  className="overflow-hidden rounded-xl border border-line bg-white"
                >
                  <img
                    src={photo.url}
                    alt="任务截图"
                    className="h-36 w-full bg-[#f7f4ea] object-contain"
                  />
                  <figcaption className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-ink-soft">
                    <span className="truncate">{photoCaption(photo)}</span>
                    <Button
                      variant="ghost"
                      style={{ minHeight: 26, padding: '0 6px' }}
                      aria-label="删除截图"
                      onClick={() => void removeScreenshot(photo.id).catch(() => undefined)}
                    >
                      <IconTrash size={14} />
                    </Button>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={modal === 'cancel'}
        title="作废订单"
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                void run(() => services.orders.cancel(orderId, token), '订单已作废')
                  .then(() => setModal(null))
                  .catch(() => undefined);
              }}
            >
              确认作废
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed">
          作废后停止任务与提醒，并取消剩余待收款；历史打卡、截图与实收流水全部保留，已收金额仍计入收入。
          作废不可撤销。
        </p>
      </Modal>

      <Modal
        open={modal === 'delete'}
        title={order.cancelled ? '删除已作废订单' : '删除空订单'}
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                void run(
                  () =>
                    order.cancelled
                      ? services.orders.deleteCancelled(orderId, token).then(() => undefined)
                      : services.orders.deleteEmpty(orderId, token),
                  '订单已删除',
                )
                  .then(() => navigate('/orders'))
                  .catch(() => undefined);
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        {order.cancelled ? (
          <div className="flex flex-col gap-2 text-sm leading-relaxed">
            <p className="rounded-lg border border-danger/30 bg-[#fbe4dc] px-3 py-2 text-danger">
              删除不可撤销：该订单的打卡、截图、收款与更正记录会一并删除，实收统计会相应减少。
            </p>
            {deletion ? (
              <dl className="grid grid-cols-2 gap-1">
                <div>
                  <dt className="muted">打卡记录</dt>
                  <dd>{deletion.occurrences} 条</dd>
                </div>
                <div>
                  <dt className="muted">截图</dt>
                  <dd>{deletion.attachments} 张</dd>
                </div>
                <div>
                  <dt className="muted">收款</dt>
                  <dd>{deletion.receipts} 笔</dd>
                </div>
                <div>
                  <dt className="muted">期次 / 任务</dt>
                  <dd>
                    {deletion.periods} / {deletion.tasks}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="muted">正在统计影响范围…</p>
            )}
            <ErrorText message={error} />
          </div>
        ) : (
          <p className="text-sm leading-relaxed">
            仅删除没有任何打卡、截图、收款或续期记录的误建订单。已有业务记录的订单请先作废，
            作废后再执行删除。
          </p>
        )}
      </Modal>
    </div>
  );
}
