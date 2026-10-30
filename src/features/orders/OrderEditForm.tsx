import { useState } from 'react';
import {
  Button,
  ErrorText,
  Field,
  Select,
  TextArea,
  TextInput,
} from '../../components/ui';
import { IconClipboard, IconList, IconPlus, IconSettings, IconWallet } from '../../components/icons';
import { MonthDayInputs } from '../../components/MonthDayInputs';
import { SortableList } from '../../components/SortableList';
import { toAppError } from '../../contracts/errors';
import type {
  OrderDetailView,
  UpdateOrderCommand,
} from '../../application/contracts';
import type { PaymentMode } from '../../contracts/tables';
import { hostingEndDateForWeekdays, weekdayNames } from '../../domain/gameCalendar';
import { formatMoney, parseMoney, yuanInput } from '../../domain/money';
import { parseWeekdays } from '../../domain/occurrences';
import { emptyTaskDraft, minutesFromTime, timeInput } from './orderUtils';
import { TaskDraftRow, newDraftKey, type TaskDraftItem } from './TaskDraftRow';

interface EditTaskItem extends TaskDraftItem {
  id: string | null;
  periodId: string | null;
}

interface PeriodEditState {
  id: string;
  periodIndex: number;
  serviceMode: 'dates' | 'weekdays' | 'count';
  startDate: string;
  endDate: string;
  serviceDaysText: string;
  serviceCountText: string;
  priceText: string;
  paidCents: number;
  /** 该期次已持久化的服务星期（ISO 1–7 逗号文本）；预览必须用它推算结束日。 */
  serviceWeekdays: string | null;
}

interface TaskGroupState {
  periodId: string | null;
  label: string;
  items: EditTaskItem[];
}

function toEditItem(task: OrderDetailView['tasks'][number]): EditTaskItem {
  return {
    key: newDraftKey(),
    id: task.id,
    periodId: task.periodId,
    title: task.title,
    progressType: task.progressType,
    startValue: task.startValue,
    targetValue: task.targetValue,
    unit: task.unit,
    recurrence: task.recurrence,
    weekdays: task.weekdays,
    everyNDays: task.everyNDays,
    monthDay: task.monthDay,
    monthDays: task.monthDays,
    activeFrom: task.activeFrom,
    activeUntil: task.activeUntil,
    // 编辑表单必须带住数值口径：否则保存会把累计目标悄悄改回逐次。
    numericMode: task.numericMode,
  };
}

/** 订单全量修改表单：基本字段、期次日期与价格、任务清单（含增删改）。 */
export function OrderEditForm({
  detail,
  onCancel,
  onSubmit,
}: {
  detail: OrderDetailView;
  onCancel: () => void;
  onSubmit: (command: UpdateOrderCommand) => Promise<void>;
}) {
  const hosting = detail.order.type === 'HOSTING';
  const [title, setTitle] = useState(detail.order.title);
  const [notes, setNotes] = useState(detail.notes ?? '');
  const [paymentMode, setPaymentMode] = useState<PaymentMode>(detail.paymentMode);
  const [zoneId, setZoneId] = useState(detail.order.gameZoneId);
  const [dailyRefresh, setDailyRefresh] = useState(timeInput(detail.order.dailyRefreshMinutes));
  const [weeklyDay, setWeeklyDay] = useState(detail.weeklyRefreshDay);
  const [weeklyTime, setWeeklyTime] = useState(timeInput(detail.weeklyRefreshMinutes));
  // 刷新周期：已配置每月刷新日时按「刷新日 → 下一刷新日前一天」取窗。
  const [refreshCycle, setRefreshCycle] = useState<'weekly' | 'monthly'>(
    detail.monthlyRefreshDays ? 'monthly' : 'weekly',
  );
  const [monthlyRefreshDays, setMonthlyRefreshDays] = useState<string | null>(
    detail.monthlyRefreshDays,
  );
  const [shortPrice, setShortPrice] = useState(yuanInput(detail.order.priceCents ?? 0));
  const [deadline, setDeadline] = useState(detail.order.deadlineDate ?? '');
  const [periodStates, setPeriodStates] = useState<PeriodEditState[]>(() =>
    detail.periods.map((period) => ({
      id: period.id,
      periodIndex: period.periodIndex,
      serviceMode:
        period.serviceCount != null ? 'count' : period.serviceDays !== null ? 'weekdays' : 'dates',
      startDate: period.startDate,
      endDate: period.endDate,
      serviceDaysText: String(period.serviceDays ?? 20),
      serviceCountText: String(period.serviceCount ?? 30),
      priceText: yuanInput(period.priceCents),
      paidCents: period.paidCents,
      serviceWeekdays: period.serviceWeekdays,
    })),
  );
  const [taskGroups, setTaskGroups] = useState<TaskGroupState[]>(() =>
    hosting
      ? detail.periods.map((period) => ({
          periodId: period.id,
          label:
            period.serviceCount != null
              ? `第 ${period.periodIndex + 1} 期任务（按次数 ${period.serviceCount} 次）`
              : `第 ${period.periodIndex + 1} 期任务（${period.startDate} ~ ${period.endDate}）`,
          items: detail.tasks
            .filter((task) => task.periodId === period.id)
            .map(toEditItem),
        }))
      : [
          {
            periodId: null,
            label: '任务',
            items: detail.tasks.filter((task) => task.periodId === null).map(toEditItem),
          },
        ],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function updatePeriod(periodId: string, patch: Partial<PeriodEditState>) {
    setPeriodStates((current) =>
      current.map((item) => (item.id === periodId ? { ...item, ...patch } : item)),
    );
  }

  function updateGroup(periodId: string | null, items: EditTaskItem[]) {
    setTaskGroups((current) =>
      current.map((group) => (group.periodId === periodId ? { ...group, items } : group)),
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (!title.trim()) throw new Error('请填写订单标题');
      if (hosting && refreshCycle === 'monthly' && !monthlyRefreshDays) {
        throw new Error('请至少填写一个每月刷新日');
      }
      const command: UpdateOrderCommand = {
        orderId: detail.order.id,
        title: title.trim(),
        notes: notes.trim() || null,
        paymentMode,
        gameZoneId: zoneId.trim(),
        dailyRefreshMinutes: minutesFromTime(dailyRefresh),
        weeklyRefreshDay: weeklyDay,
        weeklyRefreshMinutes: minutesFromTime(weeklyTime),
        monthlyRefreshDays: hosting && refreshCycle === 'monthly' ? monthlyRefreshDays : null,
        priceCents: hosting ? null : parseMoney(shortPrice),
        deadlineDate: hosting ? null : deadline || null,
        periods: periodStates.map((item) => ({
          periodId: item.id,
          startDate: item.startDate,
          endDate: item.endDate,
          priceCents: parseMoney(item.priceText),
          serviceDays: item.serviceMode === 'weekdays' ? Number(item.serviceDaysText) : null,
          serviceCount: item.serviceMode === 'count' ? Number(item.serviceCountText) : null,
        })),
        tasks: taskGroups.flatMap((group) =>
          group.items.map((item) => ({
            id: item.id,
            periodId: item.periodId,
            task: {
              title: item.title,
              progressType: item.progressType,
              startValue: item.startValue,
              targetValue: item.targetValue,
              unit: item.unit,
              recurrence: item.recurrence,
              weekdays: item.weekdays,
              everyNDays: item.everyNDays,
              monthDay: item.monthDay,
              monthDays: item.monthDays,
              activeFrom: item.activeFrom ?? null,
              activeUntil: item.activeUntil ?? null,
              numericMode: item.numericMode ?? null,
            },
          })),
        ),
      };
      await onSubmit(command);
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <section className="flex flex-col gap-4">
        <h3 className="form-step-title">
          <span className="step-chip">1</span>
          订单信息
          <IconClipboard size={16} className="text-ink-soft" />
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="订单标题">
            <TextInput
              value={title}
              maxLength={60}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="付款方式">
            <Select
              value={paymentMode}
              onChange={(event) => setPaymentMode(event.target.value as PaymentMode)}
            >
              <option value="INSTALLMENTS">分期 / 部分收款</option>
              <option value="ONE_TIME">一次性结清</option>
            </Select>
          </Field>
        </div>
        <Field label="订单备注">
          <TextArea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} />
        </Field>
        <p className="muted">
          {detail.order.ownerName} · {detail.order.accountName} ·{' '}
          {hosting ? '托管' : '短期单'}（老板、账号与订单类型不可更改）
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h3 className="form-step-title">
          <span className="step-chip">2</span>
          日期与价格
          <IconWallet size={16} className="text-ink-soft" />
        </h3>
        {hosting ? (
          periodStates.map((period) => {
            const days = Number(period.serviceDaysText);
            // 预览与命令层同源：用该期次真实的星期集合，缺省才退回周一至周五。
            const weekdays = parseWeekdays(period.serviceWeekdays);
            const weekdaySet = new Set(weekdays.length > 0 ? weekdays : [1, 2, 3, 4, 5]);
            const previewEnd =
              period.serviceMode === 'weekdays' &&
              Number.isInteger(days) &&
              days >= 1 &&
              period.startDate
                ? (() => {
                    try {
                      return hostingEndDateForWeekdays(period.startDate, days, weekdaySet);
                    } catch {
                      return null;
                    }
                  })()
                : null;
            return (
              <div key={period.id} className="rounded-2xl border border-line/80 bg-white/75 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">第 {period.periodIndex + 1} 期</p>
                  <span className="text-xs text-ink-soft">
                    已收 ¥{formatMoney(period.paidCents)}
                  </span>
                </div>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <Field label="服务模式">
                    <Select
                      value={period.serviceMode}
                      onChange={(event) =>
                        updatePeriod(period.id, {
                          serviceMode: event.target.value as 'dates' | 'weekdays' | 'count',
                        })
                      }
                    >
                      <option value="dates">按日期期限</option>
                      <option value="weekdays">按服务星期累计天数（仅服务日提供服务）</option>
                      <option value="count">按次数（整轮打卡累计）</option>
                    </Select>
                  </Field>
                  {period.serviceMode !== 'count' ? (
                    <Field
                      label="开始日期"
                      hint="可填未来日期做预订单；开始前不生成今日任务，也不能提前打卡"
                    >
                      <TextInput
                        type="date"
                        value={period.startDate}
                        onChange={(event) => updatePeriod(period.id, { startDate: event.target.value })}
                      />
                    </Field>
                  ) : (
                    <Field
                      label="服务次数"
                      hint="一个游戏日整轮打卡全部任务算 1 次，不限日历期限"
                    >
                      <TextInput
                        value={period.serviceCountText}
                        inputMode="numeric"
                        onChange={(event) =>
                          updatePeriod(period.id, { serviceCountText: event.target.value })
                        }
                      />
                    </Field>
                  )}
                  {period.serviceMode === 'dates' ? (
                    <Field label="结束日期" hint="首尾均含在服务期内">
                      <TextInput
                        type="date"
                        value={period.endDate}
                        onChange={(event) => updatePeriod(period.id, { endDate: event.target.value })}
                      />
                    </Field>
                  ) : null}
                  {period.serviceMode === 'weekdays' ? (
                    <Field
                      label="累计服务天数"
                      hint={`只在 ${weekdayNames([...weekdaySet])} 提供服务；结束日按同一集合推算`}
                    >
                      <TextInput
                        value={period.serviceDaysText}
                        inputMode="numeric"
                        onChange={(event) =>
                          updatePeriod(period.id, { serviceDaysText: event.target.value })
                        }
                      />
                      {previewEnd ? (
                        <span className="mt-1 block text-xs text-ink-soft">
                          预计 {period.startDate} 至 {previewEnd}（含首尾，服务日{' '}
                          {weekdayNames([...weekdaySet])}）
                        </span>
                      ) : null}
                    </Field>
                  ) : null}
                  <Field label="期次价格（元）" hint="不能低于该期已收金额">
                    <TextInput
                      value={period.priceText}
                      inputMode="decimal"
                      onChange={(event) => updatePeriod(period.id, { priceText: event.target.value })}
                    />
                  </Field>
                </div>
              </div>
            );
          })
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="整单总价（元）" hint="不能低于已收金额">
              <TextInput
                value={shortPrice}
                inputMode="decimal"
                onChange={(event) => setShortPrice(event.target.value)}
              />
            </Field>
            <Field label="交付期限" hint="留空表示不设期限">
              <TextInput
                type="date"
                value={deadline}
                onChange={(event) => setDeadline(event.target.value)}
              />
            </Field>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h3 className="form-step-title">
          <span className="step-chip">3</span>
          任务
          <IconList size={16} className="text-ink-soft" />
        </h3>
        {taskGroups.map((group) => (
          <div
            key={group.periodId ?? 'short'}
            className="rounded-2xl border border-line/80 bg-white/75 p-3.5"
          >
            <div className="flex items-center justify-between">
              <p className="label">{group.label}</p>
              <Button
                variant="ghost"
                onClick={() =>
                  updateGroup(group.periodId, [
                    ...group.items,
                    { ...emptyTaskDraft(), key: newDraftKey(), id: null, periodId: group.periodId },
                  ])
                }
              >
                <IconPlus size={16} /> 添加任务
              </Button>
            </div>
            {group.items.length === 0 ? (
              <p className="muted">还没有任务，请添加。</p>
            ) : (
              <SortableList
                items={group.items}
                keyOf={(task) => task.key}
                labelOf={(task) => task.title || '未命名任务'}
                testId={`edit-sort-${group.periodId ?? 'short'}`}
                listClassName="mt-2 gap-2"
                onReorder={(orderedKeys) => {
                  const byKey = new Map(group.items.map((item) => [item.key, item]));
                  updateGroup(
                    group.periodId,
                    orderedKeys
                      .map((key) => byKey.get(key))
                      .filter((item): item is EditTaskItem => Boolean(item)),
                  );
                }}
                renderItem={(task, control) => (
                  <TaskDraftRow
                    key={task.key}
                    task={task}
                    sortControl={control}
                    onChange={(patch) =>
                      updateGroup(
                        group.periodId,
                        group.items.map((item) =>
                          item.key === task.key ? { ...item, ...patch } : item,
                        ),
                      )
                    }
                    onRemove={() =>
                      updateGroup(
                        group.periodId,
                        group.items.filter((item) => item.key !== task.key),
                      )
                    }
                  />
                )}
              />
            )}
            <p className="mt-2 text-xs text-ink-soft">
              已有打卡或截图记录的任务不能删除；改排期后历史记录保留。这里的顺序就是今日事项的显示顺序。
            </p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-4">
        <h3 className="form-step-title">
          <span className="step-chip">4</span>
          服务设置
          <IconSettings size={16} className="text-ink-soft" />
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="游戏时区">
            <TextInput
              value={zoneId}
              onChange={(event) => setZoneId(event.target.value)}
              placeholder="Asia/Shanghai"
            />
          </Field>
          {hosting ? (
            <>
              <Field label="每日刷新时间">
                <TextInput
                  type="time"
                  value={dailyRefresh}
                  onChange={(event) => setDailyRefresh(event.target.value)}
                />
              </Field>
              <Field
                label="刷新周期"
                hint="按月刷新时，每周任务按「刷新日 → 下一刷新日前一天」计算窗口"
              >
                <Select
                  value={refreshCycle}
                  onChange={(event) => {
                    const next = event.target.value as 'weekly' | 'monthly';
                    setRefreshCycle(next);
                    if (next === 'monthly' && !monthlyRefreshDays) setMonthlyRefreshDays('1');
                  }}
                >
                  <option value="weekly">按周刷新</option>
                  <option value="monthly">按每月日号刷新</option>
                </Select>
              </Field>
              {refreshCycle === 'weekly' ? (
                <>
                  <Field label="每周刷新星期">
                    <Select
                      value={weeklyDay}
                      onChange={(event) => setWeeklyDay(Number(event.target.value))}
                    >
                      {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label, index) => (
                        <option key={label} value={index + 1}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="每周刷新时间">
                    <TextInput
                      type="time"
                      value={weeklyTime}
                      onChange={(event) => setWeeklyTime(event.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <div className="sm:col-span-2">
                    <Field label="每月刷新日" hint="可填写多个日号；当月没有该日号时跳过该月">
                      <MonthDayInputs
                        value={monthlyRefreshDays}
                        onChange={(days) => setMonthlyRefreshDays(days)}
                      />
                    </Field>
                  </div>
                  <Field label="刷新时间" hint="每月刷新日在该时刻切换窗口">
                    <TextInput
                      type="time"
                      value={weeklyTime}
                      onChange={(event) => setWeeklyTime(event.target.value)}
                    />
                  </Field>
                </>
              )}
            </>
          ) : null}
        </div>
      </section>

      <ErrorText message={error} />

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? '保存中…' : '保存修改'}
        </Button>
      </div>
    </form>
  );
}
