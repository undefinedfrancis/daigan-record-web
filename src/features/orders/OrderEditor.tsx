import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Select,
  TextArea,
  TextInput,
} from '../../components/ui';
import { IconClipboard, IconPlus, IconUsers, IconWallet } from '../../components/icons';
import { MonthDayInputs } from '../../components/MonthDayInputs';
import { useApp } from '../../app/ServiceProvider';
import { toAppError } from '../../contracts/errors';
import type { OrderType, PaymentMode, ReceiptChannel } from '../../contracts/tables';
import { DEFAULT_SERVICE_WEEKDAYS } from '../../contracts/tables';
import { addDays, hostingEndDateForWeekdays, weekdayNames } from '../../domain/gameCalendar';
import {
  normalizeServiceWeekdays,
  resolveTemplateServiceDefaults,
} from '../../domain/templateServiceDefaults';
import { parseMoney } from '../../domain/money';
import {
  applyTemplateTitle,
  editedTitle,
  type TitleState,
} from '../../domain/templateTitle';
import {
  emptyTaskDraft,
  fromDateTimeInput,
  minutesFromTime,
  timeInput,
  toDateTimeInput,
} from './orderUtils';
import { TaskDraftRow, newDraftKey, type TaskDraftItem } from './TaskDraftRow';

type TaskRow = TaskDraftItem;

export function OrderEditor({
  open,
  ownerIdInitial,
  accountIdInitial,
  onClose,
  onCreated,
}: {
  open: boolean;
  ownerIdInitial?: string;
  /** 预选游戏账号（老板详情页直接下单时传入）。 */
  accountIdInitial?: string;
  onClose: () => void;
  onCreated: (orderId: string) => void;
}) {
  const { services, token, refresh } = useApp();
  const [operationId, setOperationId] = useState(() => `order-${crypto.randomUUID()}`);
  const [ownerId, setOwnerId] = useState(ownerIdInitial ?? '');
  const [accountId, setAccountId] = useState(accountIdInitial ?? '');
  const [type, setType] = useState<OrderType>('HOSTING');
  // UF-036：标题来源是显式状态（none/auto/manual），不靠字符串比较猜测。
  const [titleState, setTitleState] = useState<TitleState>({ value: '', provenance: 'none' });
  const title = titleState.value;
  const titleProvenance = titleState.provenance;
  const [notes, setNotes] = useState('');
  const [zoneId, setZoneId] = useState('Asia/Shanghai');
  const [dailyRefresh, setDailyRefresh] = useState('05:00');
  const [weeklyDay, setWeeklyDay] = useState(1);
  const [weeklyTime, setWeeklyTime] = useState('05:00');
  // 刷新周期：配置每月刷新日后，每周任务按「刷新日 → 下一刷新日前一天」取窗。
  const [refreshCycle, setRefreshCycle] = useState<'weekly' | 'monthly'>('weekly');
  const [monthlyRefreshDays, setMonthlyRefreshDays] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(addDays(new Date().toISOString().slice(0, 10), 0));
  const [endDate, setEndDate] = useState(addDays(new Date().toISOString().slice(0, 10), 29));
  // UF-010：仅服务日累计托管；按次数：整轮打卡累计，不限日历期限。
  const [serviceMode, setServiceMode] = useState<'dates' | 'weekdays' | 'count'>('dates');
  // 精确服务星期集合（ISO 1–7）。普通建单默认周一至周五；模板带入的自定义集合原样保留。
  const [serviceWeekdays, setServiceWeekdays] = useState<number[]>(() =>
    normalizeServiceWeekdays(DEFAULT_SERVICE_WEEKDAYS),
  );
  const [serviceDays, setServiceDays] = useState('20');
  const [serviceCount, setServiceCount] = useState('30');
  // 模板各分类托管方式不一致时不替用户选：保留当前值并明确提示。
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  const [periodPrice, setPeriodPrice] = useState('');
  const [shortPrice, setShortPrice] = useState('');
  const [deadlineDate, setDeadlineDate] = useState('');
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('INSTALLMENTS');
  const [templateId, setTemplateId] = useState('');
  const [pricePresets, setPricePresets] = useState<{ amountCents: number; label: string | null }[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [firstReceiptOn, setFirstReceiptOn] = useState(true);
  const [receiptAmount, setReceiptAmount] = useState('');
  const [receiptChannel, setReceiptChannel] = useState<ReceiptChannel>('WECHAT');
  const [receiptNote, setReceiptNote] = useState('');
  const [receiptAt, setReceiptAt] = useState(toDateTimeInput(Date.now()));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failedOnce = useRef(false);

  const owners = useMemo(() => services.queries.owners(false), [services]);
  const templates = useMemo(() => services.queries.templates(), [services]);

  const [ownerOptions, setOwnerOptions] = useState<{ id: string; number: number; nickname: string }[]>([]);
  const [templateOptions, setTemplateOptions] = useState<{ id: string; gameName: string; templateVersion: string }[]>([]);
  const [accountOptions, setAccountOptions] = useState<
    { id: string; gameName: string; server: string; defaultTemplateId: string | null }[]
  >([]);

  useEffect(() => {
    if (!open) return;
    void owners.then(setOwnerOptions);
    void templates.then(setTemplateOptions);
  }, [open, owners, templates]);

  useEffect(() => {
    if (!ownerId) {
      setAccountOptions([]);
      return;
    }
    void services.queries.ownerDetail(ownerId).then((detail) => {
      const options = (detail?.accounts ?? []).map((account) => ({
        id: account.id,
        gameName: account.gameName,
        server: account.server,
        defaultTemplateId: account.defaultTemplateId,
      }));
      setAccountOptions(options);
      // 预选账号时自动套用其默认模板，与手动选择账号行为一致。
      if (accountIdInitial) {
        const preset = options.find((item) => item.id === accountIdInitial);
        if (preset?.defaultTemplateId && !templateId) void applyTemplate(preset.defaultTemplateId);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, services]);

  function markDirty() {
    if (failedOnce.current) {
      failedOnce.current = false;
      setOperationId(`order-${crypto.randomUUID()}`);
    }
  }

  /**
   * 模板带入标题（UF-036 / D-01 / D-03）：显式来源状态决定是否覆盖 ——
   * manual 不动、none/auto 跟随；用户主动清空后回到 none，可再次带入。
   */
  function applyAutoTitle(next: string) {
    setTitleState((current) => applyTemplateTitle(current, next));
    markDirty();
  }

  async function applyTemplate(id: string) {
    setTemplateId(id);
    markDirty();
    setPricePresets([]);
    setTemplateNotice(null);
    if (!id) return;
    const detail = await services.queries.templateDetail(id);
    if (!detail) return;
    setPricePresets(detail.pricePresets ?? []);
    setZoneId(detail.zoneId);
    setDailyRefresh(timeInput(detail.dailyRefreshMinutes));
    setWeeklyDay(detail.weeklyRefreshDay);
    setWeeklyTime(timeInput(detail.weeklyRefreshMinutes));
    // 建单默认服务模式：显式的模板级托管方式优先（与安卓同一口径），见 domain 解析器。
    const serviceDefaults = resolveTemplateServiceDefaults(detail);
    if (serviceDefaults.serviceMode === null) {
      // 分类彼此不一致且模板级没有声明：保留用户当前选择，明确告知，不静默挑一个分类。
      setTemplateNotice(
        serviceDefaults.conflict
          ? '该模板各分类的托管方式不一致；已保留当前服务模式，请手动确认'
          : '该模板没有声明托管方式；已保留当前服务模式',
      );
    } else {
      setServiceMode(serviceDefaults.serviceMode);
      // 精确服务星期原样带入；无限制的按日期与按次数都清空，切模板不会残留上一个集合。
      setServiceWeekdays(serviceDefaults.serviceWeekdays);
      if (serviceDefaults.serviceMode === 'count' && serviceDefaults.serviceCount != null) {
        setServiceCount(String(serviceDefaults.serviceCount));
      }
    }
    const drafts = detail.categories.flatMap((category) => category.tasks);
    const filtered = type === 'HOSTING' ? drafts.filter((task) => task.recurrence !== 'ONE_TIME') : drafts;
    setTasks(filtered.map((task) => ({ ...task, key: newDraftKey() })));
    const templateTitle = detail.defaultOrderTitle?.trim();
    applyAutoTitle(
      templateTitle && templateTitle.length > 0
        ? templateTitle
        : `${detail.gameName} ${type === 'HOSTING' ? '托管' : '短期单'}`,
    );
  }

  function updateTask(key: string, patch: Partial<TaskRow>) {
    markDirty();
    setTasks((current) => current.map((task) => (task.key === key ? { ...task, ...patch } : task)));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (!ownerId) throw new Error('请选择老板');
      if (!accountId) throw new Error('请选择游戏账号');
      if (!title.trim()) throw new Error('请填写订单标题');
      if (tasks.some((task) => !task.title.trim())) throw new Error('任务标题不能为空');
      if (type === 'HOSTING' && refreshCycle === 'monthly' && !monthlyRefreshDays) {
        throw new Error('请至少填写一个每月刷新日');
      }
      if (type === 'HOSTING' && serviceMode === 'count') {
        const count = Number(serviceCount);
        if (!Number.isInteger(count) || count < 1 || count > 3650) {
          throw new Error('服务次数必须为 1–3650');
        }
      }
      if (type === 'HOSTING' && serviceMode === 'weekdays' && serviceWeekdays.length === 0) {
        throw new Error('请至少选择一个服务星期');
      }
      if (type === 'HOSTING' && tasks.some((task) => task.recurrence === 'ONE_TIME')) {
        throw new Error('托管任务不能使用一次性周期，请改为每日或累计目标 0 → 1');
      }
      const priceCents = type === 'SHORT_TASK' ? parseMoney(shortPrice) : null;
      const periodPriceCents = type === 'HOSTING' ? parseMoney(periodPrice) : null;
      let firstReceipt = null;
      if (firstReceiptOn) {
        firstReceipt = {
          amountCents: parseMoney(receiptAmount),
          receivedAt: fromDateTimeInput(receiptAt),
          channel: receiptChannel,
          note: receiptChannel === 'OTHER' ? receiptNote || null : null,
        };
      }
      const result = await services.orders.create(
        {
          operationId,
          ownerId,
          accountId,
          type,
          title: title.trim(),
          notes: notes.trim() || null,
          paymentMode,
          priceCents,
          deadlineDate: type === 'SHORT_TASK' ? deadlineDate || null : null,
          gameZoneId: zoneId.trim(),
          dailyRefreshMinutes: minutesFromTime(dailyRefresh),
          weeklyRefreshDay: weeklyDay,
          weeklyRefreshMinutes: minutesFromTime(weeklyTime),
          monthlyRefreshDays:
            type === 'HOSTING' && refreshCycle === 'monthly' ? monthlyRefreshDays : null,
          startDate: type === 'HOSTING' && serviceMode !== 'count' ? startDate : null,
          endDate: type === 'HOSTING' && serviceMode === 'dates' ? endDate : null,
          periodPriceCents,
          serviceDays: type === 'HOSTING' && serviceMode === 'weekdays' ? Number(serviceDays) : null,
          serviceWeekdays:
            type === 'HOSTING' && serviceMode === 'weekdays' ? serviceWeekdays : null,
          serviceCount: type === 'HOSTING' && serviceMode === 'count' ? Number(serviceCount) : null,
          tasks: tasks.map(({ key, ...task }) => {
            void key;
            return task;
          }),
          firstReceipt,
          sourceTemplateId: templateId || null,
          sourceTemplateName:
            templateOptions.find((item) => item.id === templateId)?.gameName ?? null,
          sourceTemplateVersion:
            templateOptions.find((item) => item.id === templateId)?.templateVersion ?? null,
        },
        token,
      );
      refresh();
      onCreated(result.orderId);
    } catch (reason) {
      failedOnce.current = true;
      setError(toAppError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-4">
        <h3 className="form-step-title">
          <span className="step-chip">1</span>
          老板与账号
          <IconUsers size={16} className="text-ink-soft" />
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="老板">
            <Select
              value={ownerId}
              onChange={(event) => {
                markDirty();
                setOwnerId(event.target.value);
                setAccountId('');
              }}
            >
              <option value="">请选择</option>
              {ownerOptions.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  #{owner.number} {owner.nickname}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="游戏账号" hint={ownerId && accountOptions.length === 0 ? '该老板还没有账号' : undefined}>
            <Select
              value={accountId}
              onChange={(event) => {
                markDirty();
                setAccountId(event.target.value);
                const account = accountOptions.find((item) => item.id === event.target.value);
                if (account?.defaultTemplateId && !templateId) void applyTemplate(account.defaultTemplateId);
              }}
            >
              <option value="">请选择</option>
              {accountOptions.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.gameName} · {account.server}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h3 className="form-step-title">
          <span className="step-chip">2</span>
          服务与任务
          <IconClipboard size={16} className="text-ink-soft" />
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="订单类型">
            <Select
              value={type}
              onChange={(event) => {
                markDirty();
                setType(event.target.value as OrderType);
              }}
            >
              <option value="HOSTING">托管</option>
              <option value="SHORT_TASK">短期单</option>
            </Select>
          </Field>
          <Field
            label="订单标题"
            hint={
              titleProvenance === 'auto'
                ? '已按模板带入；直接修改即作为本单手填标题（切换模板不再覆盖）'
                : undefined
            }
          >
            <TextInput
              value={title}
              onChange={(event) => {
                markDirty();
                setTitleState(editedTitle(event.target.value));
              }}
              maxLength={60}
              placeholder="例如 2 月托管"
            />
          </Field>
          {type === 'HOSTING' ? (
            <>
              <Field label="服务模式">
                <Select
                  value={serviceMode}
                  onChange={(event) => {
                    markDirty();
                    const next = event.target.value as 'dates' | 'weekdays' | 'count';
                    setServiceMode(next);
                    // 进入“仅服务日”时若还没有任何集合（普通建单或刚从其它模式切来），
                    // 用历史默认周一至周五；已有自定义集合则保留用户/模板的选择。
                    if (next === 'weekdays' && serviceWeekdays.length === 0) {
                      setServiceWeekdays(normalizeServiceWeekdays(DEFAULT_SERVICE_WEEKDAYS));
                    }
                  }}
                >
                  <option value="dates">按日期期限</option>
                  <option value="weekdays">按服务星期累计天数（仅服务日提供服务）</option>
                  <option value="count">按次数（整轮打卡累计）</option>
                </Select>
              </Field>
              {serviceMode !== 'count' ? (
                <Field label="开始日期">
                  <TextInput
                    type="date"
                    value={startDate}
                    onChange={(event) => {
                      markDirty();
                      setStartDate(event.target.value);
                    }}
                  />
                </Field>
              ) : (
                <Field
                  label="服务次数"
                  hint="不指定时间：一个游戏日整轮打卡全部任务算 1 次，攒满次数本期结束"
                >
                  <TextInput
                    value={serviceCount}
                    inputMode="numeric"
                    onChange={(event) => {
                      markDirty();
                      setServiceCount(event.target.value);
                    }}
                  />
                </Field>
              )}
              {serviceMode === 'dates' ? (
                <Field label="结束日期" hint="首尾均含在服务期内">
                  <TextInput
                    type="date"
                    value={endDate}
                    onChange={(event) => {
                      markDirty();
                      setEndDate(event.target.value);
                    }}
                  />
                </Field>
              ) : null}
              {serviceMode === 'weekdays' ? (
                <>
                  <div className="field sm:col-span-2">
                    <span className="label">服务星期</span>
                    <div className="flex flex-wrap gap-1" role="group" aria-label="服务星期">
                      {['一', '二', '三', '四', '五', '六', '日'].map((label, index) => {
                        const day = index + 1;
                        const active = serviceWeekdays.includes(day);
                        return (
                          <button
                            key={label}
                            type="button"
                            aria-pressed={active}
                            aria-label={`服务周${label}`}
                            className={`min-w-9 rounded-full border px-2 py-1 text-xs ${
                              active
                                ? 'border-sage-deep bg-sage text-[#1f3a2a]'
                                : 'border-line bg-white text-ink-soft'
                            }`}
                            onClick={() => {
                              markDirty();
                              setServiceWeekdays((current) =>
                                current.includes(day)
                                  ? current.filter((item) => item !== day)
                                  : [...current, day].sort((left, right) => left - right),
                              );
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <span className="muted">
                      {serviceWeekdays.length > 0
                        ? `当前仅在 ${weekdayNames(serviceWeekdays)} 提供服务`
                        : '至少选择一个服务星期'}
                    </span>
                  </div>
                  <Field
                    label="累计服务天数"
                    hint={`只在所选服务星期（${
                      weekdayNames(serviceWeekdays) || '未选择'
                    }）提供服务；结束日按同一集合推算`}
                  >
                    <TextInput
                      value={serviceDays}
                      inputMode="numeric"
                      onChange={(event) => {
                        markDirty();
                        setServiceDays(event.target.value);
                      }}
                    />
                    {(() => {
                      const days = Number(serviceDays);
                      if (!Number.isInteger(days) || days < 1) return null;
                      try {
                        const end = hostingEndDateForWeekdays(
                          startDate,
                          days,
                          new Set(serviceWeekdays),
                        );
                        return (
                          <span className="mt-1 block text-xs text-ink-soft">
                            预计 {startDate} 至 {end}（含首尾，服务日 {weekdayNames(serviceWeekdays)}）
                          </span>
                        );
                      } catch {
                        return null;
                      }
                    })()}
                  </Field>
                </>
              ) : null}
            </>
          ) : (
            <Field label="交付期限（可选）">
              <TextInput
                type="date"
                value={deadlineDate}
                onChange={(event) => {
                  markDirty();
                  setDeadlineDate(event.target.value);
                }}
              />
            </Field>
          )}
          <Field label="游戏时区">
            <TextInput
              value={zoneId}
              onChange={(event) => {
                markDirty();
                setZoneId(event.target.value);
              }}
              placeholder="Asia/Shanghai"
            />
          </Field>
          {type === 'HOSTING' ? (
            <>
              <Field label="每日刷新时间">
                <TextInput
                  type="time"
                  value={dailyRefresh}
                  onChange={(event) => {
                    markDirty();
                    setDailyRefresh(event.target.value);
                  }}
                />
              </Field>
              <Field
                label="刷新周期"
                hint="按月刷新时，每周任务按「刷新日 → 下一刷新日前一天」计算窗口"
              >
                <Select
                  value={refreshCycle}
                  onChange={(event) => {
                    markDirty();
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
                      onChange={(event) => {
                        markDirty();
                        setWeeklyDay(Number(event.target.value));
                      }}
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
                      onChange={(event) => {
                        markDirty();
                        setWeeklyTime(event.target.value);
                      }}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <div className="sm:col-span-2">
                    <Field label="每月刷新日" hint="可填写多个日号；当月没有该日号时跳过该月">
                      <MonthDayInputs
                        value={monthlyRefreshDays}
                        onChange={(days) => {
                          markDirty();
                          setMonthlyRefreshDays(days);
                        }}
                      />
                    </Field>
                  </div>
                  <Field label="刷新时间" hint="每月刷新日在该时刻切换窗口">
                    <TextInput
                      type="time"
                      value={weeklyTime}
                      onChange={(event) => {
                        markDirty();
                        setWeeklyTime(event.target.value);
                      }}
                    />
                  </Field>
                </>
              )}
            </>
          ) : null}
        </div>

        <Field label="套用模板" hint="只填充表单默认值，之后修改模板不会影响已建订单">
          <Select value={templateId} onChange={(event) => void applyTemplate(event.target.value)}>
            <option value="">不使用模板</option>
            {templateOptions.map((template) => (
              <option key={template.id} value={template.id}>
                {template.gameName} · {template.templateVersion}
              </option>
            ))}
          </Select>
          {templateNotice ? <span className="muted">{templateNotice}</span> : null}
        </Field>

        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">任务（{tasks.length}）</p>
          <Button
            variant="ghost"
            onClick={() => {
              markDirty();
              setTasks((current) => [...current, { ...emptyTaskDraft(), key: newDraftKey() }]);
            }}
          >
            <IconPlus size={16} /> 添加任务
          </Button>
        </div>

        <ul className="flex flex-col gap-2">
          {tasks.map((task) => (
            <TaskDraftRow
              key={task.key}
              task={task}
              allowOneTime={type !== 'HOSTING'}
              onChange={(patch) => updateTask(task.key, patch)}
              onRemove={() => {
                markDirty();
                setTasks((current) => current.filter((item) => item.key !== task.key));
              }}
            />
          ))}
        </ul>
        {tasks.length === 0 ? <p className="muted">还没有任务，请添加或套用模板。</p> : null}
      </section>

      <section className="flex flex-col gap-4">
        <h3 className="form-step-title">
          <span className="step-chip">3</span>
          价格与首笔收款
          <IconWallet size={16} className="text-ink-soft" />
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={type === 'HOSTING' ? '本期价格（元）' : '整单总价（元）'}
            hint={pricePresets.length > 0 ? '可从模板预设中下拉选择' : undefined}
          >
            <div className="flex gap-2">
              <TextInput
                value={type === 'HOSTING' ? periodPrice : shortPrice}
                inputMode="decimal"
                placeholder="0.00"
                onChange={(event) => {
                  markDirty();
                  if (type === 'HOSTING') setPeriodPrice(event.target.value);
                  else setShortPrice(event.target.value);
                }}
              />
              {pricePresets.length > 0 ? (
                <Select
                  aria-label="选择价格预设"
                  className="w-36"
                  value=""
                  onChange={(event) => {
                    const preset = pricePresets[Number(event.target.value)];
                    if (!preset) return;
                    markDirty();
                    const text = (preset.amountCents / 100).toFixed(2);
                    if (type === 'HOSTING') setPeriodPrice(text);
                    else setShortPrice(text);
                  }}
                >
                  <option value="">价格预设…</option>
                  {pricePresets.map((preset, index) => (
                    <option key={index} value={index}>
                      {preset.label ? `${preset.label} · ` : ''}
                      {(preset.amountCents / 100).toFixed(2)} 元
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
          </Field>
          <Field label="付款方式">
            <Select
              value={paymentMode}
              onChange={(event) => {
                markDirty();
                setPaymentMode(event.target.value as PaymentMode);
              }}
            >
              <option value="INSTALLMENTS">分期 / 部分收款</option>
              <option value="ONE_TIME">一次性结清</option>
            </Select>
          </Field>
        </div>

        <label className="flex min-h-[44px] items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={firstReceiptOn}
            onChange={(event) => setFirstReceiptOn(event.target.checked)}
          />
          同时记录首笔收款
        </label>

        {firstReceiptOn ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="金额（元）">
              <TextInput
                value={receiptAmount}
                inputMode="decimal"
                placeholder="0.00"
                onChange={(event) => {
                  markDirty();
                  setReceiptAmount(event.target.value);
                }}
              />
            </Field>
            <Field label="渠道">
              <Select
                value={receiptChannel}
                onChange={(event) => setReceiptChannel(event.target.value as ReceiptChannel)}
              >
                <option value="WECHAT">微信</option>
                <option value="ALIPAY">支付宝</option>
                <option value="BANK">银行卡</option>
                <option value="CASH">现金</option>
                <option value="OTHER">其他</option>
              </Select>
            </Field>
            <Field
              label="到账时间"
              hint="可填未来时间（如闲鱼担保交易）；到账前记为“待到账”，不计入实收"
            >
              <TextInput
                type="datetime-local"
                value={receiptAt}
                onChange={(event) => setReceiptAt(event.target.value)}
              />
            </Field>
            {receiptChannel === 'OTHER' ? (
              <Field label="备注">
                <TextInput value={receiptNote} onChange={(event) => setReceiptNote(event.target.value)} />
              </Field>
            ) : null}
          </div>
        ) : null}

        <Field label="订单备注">
          <TextArea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} />
        </Field>
      </section>

      <ErrorText message={error} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge>操作编号 {operationId.slice(0, 14)}…</Badge>
        <div className="flex gap-2">
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? '保存中…' : '创建订单'}
          </Button>
        </div>
      </div>
    </div>
  );
}

