import { useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorText, Select, TextInput, useToast } from '../../components/ui';
import { IconCamera, IconCheck, IconChevronRight, IconRefresh } from '../../components/icons';
import { COLOR_SWATCHES, ColorTagPicker, colorHexOf } from '../../components/ColorTagPicker';
import { useApp } from '../../app/ServiceProvider';
import { useQuery } from '../../app/useQuery';
import { navigate } from '../../app/Router';
import { toAppError } from '../../contracts/errors';
import { beginOperation } from '../../pwa/updateSafety';
import type { SkippedTask, TodayTaskItem } from '../../application/contracts';
import { cumulativeScopeOf, submissionGameDate } from '../orders/cumulativeSubmission';
import {
  clearPendingOperation,
  cumulativeOperationPayload,
  operationIdFor,
} from '../orders/pendingOperations';

function groupByOrder(items: TodayTaskItem[]): { orderId: string; title: string; items: TodayTaskItem[] }[] {
  const map = new Map<string, { orderId: string; title: string; items: TodayTaskItem[] }>();
  for (const item of items) {
    const entry = map.get(item.orderId) ?? { orderId: item.orderId, title: item.orderTitle, items: [] };
    entry.items.push(item);
    map.set(item.orderId, entry);
  }
  return [...map.values()];
}

type OrderGroupModel = { orderId: string; title: string; items: TodayTaskItem[] };

const COLLAPSED_KEY = 'daigan.today.collapsed';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // 隐私模式等写入失败时只影响本次记忆
  }
}

function TaskRow({
  item,
  onToggle,
  onSaveValue,
  onUpload,
  onColor,
}: {
  item: TodayTaskItem;
  onToggle: () => void;
  onSaveValue: (value: string) => void;
  onUpload: (files: File[]) => void;
  onColor: (color: string | null) => void;
}) {
  const [value, setValue] = useState(item.currentValue);
  const numeric = item.progressType === 'NUMERIC';
  const stripe = colorHexOf(item.colorTag);

  // UF-018/026：紧凑待办行；UF-019：色块标记便于分组查找。
  return (
    <li
      className="flex items-center gap-2 border-b border-line/60 py-0.5 pl-1 last:border-b-0"
      style={stripe ? { borderLeft: `3px solid ${stripe}` } : undefined}
    >
      <ColorTagPicker value={item.colorTag} onChange={onColor} label={item.title} />
      <label
        className={`flex min-h-[32px] min-w-0 flex-1 items-center gap-2 ${
          item.cumulative ? 'cursor-default' : 'cursor-pointer'
        }`}
      >
        <input
          type="checkbox"
          className="sr-only"
          checked={item.completed}
          disabled={item.cumulative}
          onChange={onToggle}
          aria-label={`${item.title}${item.completed ? ' 已达成' : ' 未达成'}`}
        />
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
            item.completed ? 'border-sage-deep bg-sage text-[#1f3a2a]' : 'border-line bg-white'
          }`}
        >
          {item.completed ? <IconCheck size={13} /> : null}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-sm leading-tight ${
            item.completed ? 'text-ink-soft line-through' : ''
          }`}
          title={item.title}
        >
          {item.title}
          {item.cumulative ? (
            <span className="ml-1 text-[11px] text-ink-soft">累计</span>
          ) : null}
          {item.sessionIndex !== null ? (
            <span className="ml-1 text-[11px] text-ink-soft">第 {item.sessionIndex} 次</span>
          ) : null}
        </span>
      </label>

      {numeric ? (
        <div className="flex shrink-0 items-center gap-1">
          <TextInput
            aria-label={item.cumulative ? `${item.title} 当前累计总值` : `${item.title} 进度`}
            className="w-16"
            style={{ minHeight: 28 }}
            value={value}
            inputMode="decimal"
            onChange={(event) => setValue(event.target.value)}
          />
          <span className="whitespace-nowrap text-xs text-ink-soft">
            /{item.targetValue}
            {item.unit ?? ''}
          </span>
          <Button
            variant="ghost"
            style={{ minHeight: 28, padding: '0 6px', fontSize: 12 }}
            onClick={() => onSaveValue(value)}
            disabled={value === item.currentValue}
            title={
              item.cumulative
                ? '填写当前累计总值（不是本次增加量），达标前每天都能更新'
                : undefined
            }
          >
            {item.cumulative ? '记录总值' : '保存'}
          </Button>
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-1">
        {item.attachmentCount > 0 ? (
          <Badge>
            <IconCamera size={11} /> {item.attachmentCount}
          </Badge>
        ) : null}
        <label
          className="btn btn-ghost cursor-pointer"
          style={{ minHeight: 28, minWidth: 28, padding: '0 4px' }}
        >
          <IconCamera size={15} />
          <span className="sr-only">上传截图</span>
          <input
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) onUpload(files);
              event.target.value = '';
            }}
          />
        </label>
      </div>
    </li>
  );
}

/** 单个订单的任务组：可折叠，组头带「整单完成」勾选。 */
function OrderGroup({
  group,
  busy,
  collapsed,
  onToggleCollapse,
  onToggleItem,
  onSaveValue,
  onUpload,
  onColor,
  onSetWhole,
}: {
  group: OrderGroupModel;
  busy: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onToggleItem: (item: TodayTaskItem) => void;
  onSaveValue: (item: TodayTaskItem, value: string) => void;
  onUpload: (item: TodayTaskItem, files: File[]) => void;
  onColor: (item: TodayTaskItem, color: string | null) => void;
  /** true = 整单完成，false = 整单取消完成。 */
  onSetWhole: (completed: boolean) => void;
}) {
  const doneCount = group.items.filter((item) => item.completed).length;
  const allDone = group.items.length > 0 && doneCount === group.items.length;
  const someDone = doneCount > 0 && !allDone;
  const first = group.items[0];
  return (
    <div className="rounded-2xl border border-line bg-white/60 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pb-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <Button
            variant="ghost"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开任务列表' : '收起任务列表'}
            style={{ minHeight: 28, minWidth: 28, padding: '0 4px' }}
            onClick={onToggleCollapse}
          >
            <IconChevronRight
              size={16}
              className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
            />
          </Button>
          <button
            type="button"
            className="min-w-0 max-w-full truncate text-left text-sm font-semibold"
            onClick={() => navigate(`/orders/${group.orderId}`)}
            title={group.title}
          >
            {group.title}
          </button>
          {/* 老板标识放大：一眼能分清是哪位老板的单。 */}
          {first ? (
            <span
              className="min-w-0 max-w-[11rem] truncate rounded-full bg-sage-soft px-2.5 py-0.5 text-sm font-bold leading-tight text-ink"
              title={first.ownerName}
            >
              {first.ownerName}
            </span>
          ) : null}
          {/* 游戏 · 区服做成日期样式的小标签：浅底、等宽数字、弱化层级。 */}
          {first ? (
            <span
              className="shrink-0 whitespace-nowrap rounded-md bg-cream-deep px-1.5 py-0.5 text-[11px] font-medium leading-tight tabular-nums text-ink-soft"
              title={first.accountName}
            >
              {first.accountName}
            </span>
          ) : null}
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-ink-soft">
            {first?.sessionIndex != null ? `第 ${first.sessionIndex} 次打卡 · ` : ''}
            {doneCount}/{group.items.length}
            {first?.serviceCount != null
              ? ` · 已打卡 ${first.serviceRounds}/${first.serviceCount} 次`
              : ''}
          </span>
        </div>
        <label
          className="flex min-h-[32px] shrink-0 cursor-pointer items-center gap-1.5 text-xs"
          title="勾选后本单今日事项全部完成；取消勾选整单回退"
        >
          <input
            type="checkbox"
            className="sr-only"
            checked={allDone}
            disabled={busy || group.items.length === 0}
            ref={(element) => {
              if (element) element.indeterminate = someDone;
            }}
            onChange={(event) => onSetWhole(event.target.checked)}
            aria-label={`${group.title} 整单完成`}
          />
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
              allDone
                ? 'border-sage-deep bg-sage text-[#1f3a2a]'
                : someDone
                  ? 'border-sage-deep/60 bg-white text-ink-soft'
                  : 'border-line bg-white'
            }`}
          >
            {allDone ? <IconCheck size={13} /> : someDone ? '–' : null}
          </span>
          <span className="text-ink-soft">整单完成</span>
        </label>
      </div>
      {!collapsed ? (
        <ul>
          {group.items.map((item) => (
            <TaskRow
              key={item.occurrenceId ?? item.taskId}
              item={item}
              onToggle={() => onToggleItem(item)}
              onColor={(color) => onColor(item, color)}
              onSaveValue={(value) => onSaveValue(item, value)}
              onUpload={(files) => onUpload(item, files)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TodayPage() {
  const { services, token, refresh } = useApp();
  const toast = useToast();
  const [ownerFilter, setOwnerFilter] = useState('');
  const [colorFilter, setColorFilter] = useState('');
  const [showExpired, setShowExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastBatch, setLastBatch] = useState<string | null>(null);
  const [lastSkipped, setLastSkipped] = useState<SkippedTask[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);

  const owners = useQuery(() => services.queries.owners(false), []);
  const today = useQuery(
    () =>
      services.queries.today({
        ...(ownerFilter ? { ownerId: ownerFilter } : {}),
        includeExpired: showExpired,
      }),
    [ownerFilter, showExpired],
  );

  const groups = useMemo(
    () =>
      groupByOrder(
        (today.data?.hosting ?? []).filter((item) => !colorFilter || item.colorTag === colorFilter),
      ),
    [today.data, colorFilter],
  );
  const periodicGroups = useMemo(() => {
    const map = new Map<
      string,
      { orderId: string; orderTitle: string; gameDate: string; items: TodayTaskItem[] }
    >();
    for (const item of (today.data?.periodic ?? []).filter(
      (entry) => !colorFilter || entry.colorTag === colorFilter,
    )) {
      const key = `${item.orderId}:${item.gameDate}`;
      const group = map.get(key) ?? {
        orderId: item.orderId,
        orderTitle: item.orderTitle,
        gameDate: item.gameDate,
        items: [],
      };
      group.items.push(item);
      map.set(key, group);
    }
    return [...map.values()];
  }, [today.data, colorFilter]);
  const shortGroups = useMemo(
    () =>
      groupByOrder(
        (today.data?.shortTasks ?? []).filter(
          (item) => !colorFilter || item.colorTag === colorFilter,
        ),
      ),
    [today.data, colorFilter],
  );

  async function run(action: () => Promise<unknown>, successMessage?: string) {
    // 打卡、批量完成、截图上传等写操作期间登记更新阻塞，避免刷新打断。
    const endOperation = beginOperation('today-op');
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
      if (successMessage) toast(successMessage, 'success');
    } catch (reason) {
      const message = toAppError(reason).message;
      setError(message);
      toast(message, 'error');
    } finally {
      setBusy(false);
      endOperation();
    }
  }

  async function toggle(item: TodayTaskItem) {
    if (item.cumulative) {
      toast('累计任务请填写“当前累计总值”，不要用勾选完成', 'error');
      return;
    }
    const completed = !item.completed;
    // 归属日必须取任务自己的（计次轮次 / 周期触发日可能不同于页面游戏日）。
    const gameDate = item.gameDate || (today.data?.gameDate ?? '');
    await run(() =>
      services.tasks.setProgress(
        {
          taskId: item.taskId,
          gameDate,
          value: item.progressType === 'CHECKBOX' ? (completed ? '1' : null) : item.currentValue,
          completed,
          backfilled: gameDate < (today.data?.gameDate ?? ''),
        },
        token,
      ),
    );
  }

  /**
   * UF-038：累计任务提交的是“当前累计总值”，scope 由订单模式决定。
   *
   * 归属日**不用**页面级的 `today.data.gameDate`（那是把全部订单按第一单的日历折成
   * 一个日期）：每个条目带着自己 scope 的权威日历，提交时现算（R5）。
   */
  async function submitCumulative(item: TodayTaskItem, value: string) {
    const gameDate = submissionGameDate(item.calendar);
    const scope = cumulativeScopeOf(item);
    const scopeKey = `${item.taskId}:${item.periodId ?? 'task'}:${item.sessionId ?? item.sessionIndex ?? 'none'}`;
    const payload = cumulativeOperationPayload({
      kind: 'SUBMIT',
      taskId: item.taskId,
      scope,
      gameDate,
      value,
    });
    const operationId = operationIdFor(scopeKey, payload);
    await run(async () => {
      const result = await services.progress.submit(
        {
          taskId: item.taskId,
          totalValue: value,
          gameDate,
          operationId,
          // null = 待建轮次：写入事务内 ensure，读/算日期阶段绝不建行。
          scope: scope ?? { kind: 'SESSION' },
        },
        token,
      );
      clearPendingOperation(scopeKey);
      if (result.reachedTarget) toast('已记录当前累计总值，目标已达成', 'success');
    });
  }

  async function setTaskColor(item: TodayTaskItem, color: string | null) {
    await run(() => services.tasks.setTaskColor(item.taskId, color, token));
  }

  function toggleCollapse(orderId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      saveCollapsed(next);
      return next;
    });
  }

  async function saveValue(item: TodayTaskItem, value: string) {
    if (item.cumulative) {
      await submitCumulative(item, value);
      return;
    }
    const gameDate = item.gameDate || (today.data?.gameDate ?? '');
    await run(() =>
      services.tasks.setProgress(
        {
          taskId: item.taskId,
          gameDate,
          value,
          completed: true,
          backfilled: gameDate < (today.data?.gameDate ?? ''),
        },
        token,
      ),
    );
  }

  /** 整单完成：批量勾选；取消勾选优先整批撤销，否则逐项回退。 */
  async function setWhole(group: OrderGroupModel, completed: boolean) {
    if (completed) {
      await completeBatch(
        group.items.some((item) => item.periodId !== null) ? 'HOSTING_ORDER' : 'SHORT_ORDER',
        group.orderId,
      );
      return;
    }
    const doneItems = group.items.filter((item) => item.completed);
    if (doneItems.length === 0) return;
    const batchIds = [
      ...new Set(
        doneItems.map((item) => item.batchId).filter((id): id is string => id !== null),
      ),
    ];
    await run(async () => {
      if (batchIds.length === 1 && doneItems.every((item) => item.batchId === batchIds[0])) {
        await services.tasks.undoBatch(batchIds[0], token);
        return;
      }
      for (const item of doneItems) {
        // 累计目标不能用普通勾选回退：请到累计历史里更正/撤销。
        if (item.cumulative) continue;
        await services.tasks.setProgress(
          {
            taskId: item.taskId,
            gameDate: today.data?.gameDate ?? '',
            value: item.progressType === 'CHECKBOX' ? null : item.currentValue,
            completed: false,
            backfilled: false,
          },
          token,
        );
      }
      if (doneItems.some((item) => item.cumulative)) {
        toast('累计目标需在订单详情的累计历史中更正/撤销', 'error');
      }
    }, '已取消整单完成');
  }

  async function upload(item: TodayTaskItem, files: File[]) {
    await run(async () => {
      for (const file of files) {
        if (item.occurrenceId) {
          await services.attachments.put({ occurrenceId: item.occurrenceId }, file, token);
        } else {
          await services.attachments.put({ taskId: item.taskId }, file, token);
        }
      }
    }, files.length > 1 ? `已保存 ${files.length} 张截图` : '截图已保存');
  }

  async function completeBatch(
    scope: 'HOSTING_ORDER' | 'HOSTING_ALL' | 'SHORT_ORDER',
    targetId: string | null,
  ) {
    await run(async () => {
      // HOSTING_ALL 按契约没有单一目标订单与游戏日：新写入必须是规范的 null/null，
      // 否则应用会产出一份自己的读取路径拒绝的备份（D-21 / S2-R5）。
      const canonicalTarget = scope === 'HOSTING_ALL' ? null : targetId;
      const operationId = `batch-${scope}-${canonicalTarget ?? 'all'}-${Date.now()}`;
      const result = await services.tasks.completeBatchDetailed(
        {
          operationId,
          scope,
          targetId: canonicalTarget,
          gameDate: scope === 'HOSTING_ALL' ? null : (today.data?.gameDate ?? null),
        },
        token,
      );
      setLastSkipped(result.skipped);
      if (result.batchId === null) {
        const detail = result.skipped
          .map((item) => `${item.title}：${item.reason}`)
          .slice(0, 3)
          .join('；');
        throw new Error(`没有可完成的事项${detail ? `（${detail}）` : ''}`);
      }
      setLastBatch(result.batchId);
      if (result.skipped.length > 0) {
        toast(`已批量完成，跳过 ${result.skipped.length} 个累计目标（未达标，不会虚构进度）`, 'error');
      }
    }, '已批量完成');
  }

  const totalTasks = (today.data?.hosting.length ?? 0) + (today.data?.shortTasks.length ?? 0);
  const doneTasks =
    (today.data?.hosting.filter((item) => item.completed).length ?? 0) +
    (today.data?.shortTasks.filter((item) => item.completed).length ?? 0);

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">今日事项</h1>
          <p className="muted">
            游戏日 {today.data?.gameDate ?? '—'} · 已完成 {doneTasks}/{totalTasks}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="today-owner-filter">
            按老板筛选
          </label>
          <Select
            id="today-owner-filter"
            value={ownerFilter}
            onChange={(event) => setOwnerFilter(event.target.value)}
            className="w-40"
          >
            <option value="">全部老板</option>
            {(owners.data ?? []).map((owner) => (
              <option key={owner.id} value={owner.id}>
                #{owner.number} {owner.nickname}
              </option>
            ))}
          </Select>
          <Select
            value={colorFilter}
            aria-label="按颜色筛选"
            className="w-28"
            onChange={(event) => setColorFilter(event.target.value)}
          >
            <option value="">全部颜色</option>
            {COLOR_SWATCHES.map((swatch) => (
              <option key={swatch.value} value={swatch.value}>
                {swatch.label}
              </option>
            ))}
          </Select>
          <label className="flex min-h-[38px] cursor-pointer items-center gap-1.5 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={showExpired}
              onChange={(event) => setShowExpired(event.target.checked)}
            />
            显示已到期
          </label>
          <Button variant="ghost" onClick={today.reload} aria-label="刷新">
            <IconRefresh size={18} />
          </Button>
        </div>
      </header>

      <ErrorText message={error ?? today.error} />

      {lastBatch ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sage-deep/30 bg-[#eaf3e6] px-3 py-2 text-sm">
          <span>刚刚批量完成了一批事项，可以撤销。</span>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const result = await services.tasks.undoBatch(lastBatch, token);
                setLastBatch(null);
                toast(
                  `已撤销 ${result.restored} 项${result.conflicts ? `，${result.conflicts} 项已被修改保留` : ''}`,
                  'success',
                );
              })
            }
          >
            撤销
          </Button>
        </div>
      ) : null}

      {lastSkipped.length > 0 ? (
        <div className="rounded-xl border border-warn/40 bg-[#fdf3e2] px-3 py-2 text-sm">
          <p className="font-semibold">已跳过 {lastSkipped.length} 个累计目标</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-ink-soft">
            {lastSkipped.map((item) => (
              <li key={`${item.taskId}-${item.title}`}>
                {item.title}：{item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {today.data && today.data.staleOrders.length > 0 ? (
        <Card className="border-warn/40">
          <div className="section-title">
            <h2>需要处理</h2>
          </div>
          <ul className="flex flex-col gap-2">
            {today.data.staleOrders.map((item) => (
              <li key={item.orderId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {item.title} · <span className="text-warn">{item.reason}</span>
                </span>
                <Button variant="ghost" onClick={() => navigate(`/orders/${item.orderId}`)}>
                  去处理
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <Card>
          <div className="section-title">
            <h2>托管任务</h2>
            {groups.length > 0 ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => completeBatch('HOSTING_ALL', null)}
              >
                全部完成
              </Button>
            ) : null}
          </div>
          {groups.length === 0 ? (
            <EmptyState
              title={colorFilter ? '没有符合颜色筛选的托管任务' : '今天没有待做的托管任务'}
              description={
                colorFilter ? '换一个颜色，或清除筛选查看全部。' : '创建托管订单后，按每日刷新时间生成今天的事项。'
              }
              action={
                colorFilter ? (
                  <Button onClick={() => setColorFilter('')}>清除筛选</Button>
                ) : (
                  <Button onClick={() => navigate('/orders')}>去订单页</Button>
                )
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((group) => (
                <OrderGroup
                  key={group.orderId}
                  group={group}
                  busy={busy}
                  collapsed={collapsed.has(group.orderId)}
                  onToggleCollapse={() => toggleCollapse(group.orderId)}
                  onToggleItem={toggle}
                  onSaveValue={saveValue}
                  onUpload={upload}
                  onColor={(item, color) => setTaskColor(item, color)}
                  onSetWhole={(completed) => setWhole(group, completed)}
                />
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="section-title">
            <h2>短期单</h2>
          </div>
          {shortGroups.length === 0 ? (
            <EmptyState
              title={colorFilter ? '没有符合颜色筛选的短期单任务' : '没有进行中的短期单'}
              action={colorFilter ? <Button onClick={() => setColorFilter('')}>清除筛选</Button> : undefined}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {shortGroups.map((group) => (
                <OrderGroup
                  key={group.orderId}
                  group={group}
                  busy={busy}
                  collapsed={collapsed.has(group.orderId)}
                  onToggleCollapse={() => toggleCollapse(group.orderId)}
                  onToggleItem={toggle}
                  onSaveValue={saveValue}
                  onUpload={upload}
                  onColor={(item, color) => setTaskColor(item, color)}
                  onSetWhole={(completed) => setWhole(group, completed)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      {periodicGroups.length > 0 ? (
        <Card>
          <div className="section-title">
            <h2>本周期任务</h2>
            <span className="muted">今天不是触发日 · 勾选会补录到周期起点</span>
          </div>
          <div className="flex flex-col gap-3">
            {periodicGroups.map((group) => (
              <div
                key={`${group.orderId}:${group.gameDate}`}
                className="rounded-2xl border border-dashed border-line bg-white/40 px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                  <button
                    type="button"
                    className="min-w-0 max-w-full truncate text-left text-sm font-semibold"
                    title={group.orderTitle}
                    onClick={() => navigate(`/orders/${group.orderId}`)}
                  >
                    {group.orderTitle}
                  </button>
                  <span className="text-xs text-ink-soft">本周期归属 {group.gameDate}</span>
                </div>
                <ul>
                  {group.items.map((item) => (
                    <TaskRow
                      key={item.occurrenceId ?? item.taskId}
                      item={item}
                      onToggle={() => toggle(item)}
                      onColor={(color) => setTaskColor(item, color)}
                      onSaveValue={(value) => saveValue(item, value)}
                      onUpload={(files) => upload(item, files)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
