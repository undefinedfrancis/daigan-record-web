import type {
  BatchScope,
  CorrectionKind,
  HostingMode,
  LoginMethod,
  NumericMode,
  OrderType,
  PaymentMode,
  ProgressEventKind,
  ProgressType,
  ReceiptChannel,
  ReceiptStatus,
  Recurrence,
  ServiceMode,
} from '../contracts/tables';
import type { ProgressScope } from '../domain/progressEvents';
import type { ScopeCalendar } from '../domain/scopeCalendar';
import type { DatasetToken } from '../storage/datasetRuntime';
import type { CascadeCounts } from './cascade';

export interface AccountDraft {
  id?: string;
  ownerId: string;
  gameName: string;
  server: string;
  uid: string;
  loginAccount: string;
  loginMethod: LoginMethod;
  password: string | null;
  defaultTemplateId?: string | null;
  /** 登录设备（手机/平板/电脑/自定义），空表示未填。 */
  loginDevice?: string;
  /** 自由文本游戏资源记录（每行一项），空表示未填。 */
  resourceNotes?: string;
  /** UF-037 账号分类；null/缺省 = 未分类。 */
  categoryId?: string | null;
}

export interface ServerOptionDraft {
  id?: string;
  gameName: string;
  name: string;
}

export interface PricePresetDraft {
  amountCents: number;
  label: string | null;
}

export interface TemplateTaskDraft {
  title: string;
  progressType: ProgressType;
  startValue: string;
  targetValue: string;
  unit: string | null;
  recurrence: Recurrence;
  weekdays: string | null;
  everyNDays: number | null;
  monthDay: number | null;
  /** 每月多个固定日号（UF-025），逗号分隔 1–31；与 monthDay 至少一个有效。 */
  monthDays?: string | null;
  /** 任务生效起始日（ISO），只在该日期范围内执行；空表示随期次开始。 */
  activeFrom?: string | null;
  /** 任务生效截止日（ISO），只在该日期范围内执行；空表示随期次结束。 */
  activeUntil?: string | null;
  /** 数值口径（schema 15 模板格式 4）；null/缺省读作 PER_OCCURRENCE。 */
  numericMode?: NumericMode | null;
}

export interface TemplateCategoryDraft {
  name: string;
  tasks: TemplateTaskDraft[];
  /**
   * 分类服务模式：'dates'（或 null）表示按日期期限（显式）；缺省 undefined 表示沿用模板级旧值。
   * 服务模式下沉到分类，建单默认值取各分类的共识。
   */
  serviceMode?: ServiceMode | null;
  /** 分类服务次数（配合 serviceMode='count'）。 */
  serviceCount?: number | null;
  /** schema-15 分类托管方式；null = 继承模板（仅 vnext 写入产生）。 */
  hostingMode?: HostingMode | null;
  /** schema-15 分类目标次数。 */
  targetSessions?: number | null;
  /** schema-15 分类服务星期集合（逗号分隔 ISO 1–7）。 */
  serviceWeekdays?: string | null;
}

export interface TemplateDraft {
  id?: string;
  gameName: string;
  templateVersion: string;
  gameVersionNotes: string | null;
  zoneId: string;
  dailyRefreshMinutes: number;
  weeklyRefreshDay: number;
  weeklyRefreshMinutes: number;
  categories: TemplateCategoryDraft[];
  /** 模板价格预设（UF-015），建单时下拉选用。 */
  pricePresets?: PricePresetDraft[];
  /** 该游戏的区服选项（UF-005），模板文件可选携带。 */
  serverOptions?: string[];
  /** 建单默认服务模式；null/缺省表示按日期期限。 */
  serviceMode?: ServiceMode | null;
  /** 建单默认服务次数（配合 serviceMode='count'）。 */
  serviceCount?: number | null;
  /** schema-15 模板级托管方式镜像（分类共识）；null = 无意见/分歧。 */
  hostingMode?: HostingMode | null;
  /** schema-15 模板级目标次数。 */
  targetSessions?: number | null;
  /** schema-15 模板级服务星期集合（逗号分隔 ISO 1–7）。 */
  serviceWeekdays?: string | null;
  /** UF-036 建单默认标题；空白归一为 null，上限 60。 */
  defaultOrderTitle?: string | null;
}

export interface FirstReceiptDraft {
  amountCents: number;
  receivedAt: number;
  channel: ReceiptChannel;
  note: string | null;
}

export interface CreateOrderCommand {
  operationId: string;
  ownerId: string;
  accountId: string;
  type: OrderType;
  title: string;
  notes: string | null;
  paymentMode: PaymentMode;
  /** 短期单总价；托管单为 null。 */
  priceCents: number | null;
  deadlineDate: string | null;
  gameZoneId: string;
  dailyRefreshMinutes: number;
  weeklyRefreshDay: number;
  weeklyRefreshMinutes: number;
  /** 托管单首期。 */
  startDate: string | null;
  endDate: string | null;
  periodPriceCents: number | null;
  /** 每月刷新日（逗号分隔 1–31，如 "15,24"）；null/缺省表示按周刷新。 */
  monthlyRefreshDays?: string | null;
  /**
   * UF-010 仅服务日托管：填写累计服务天数，endDate 由服务天数按服务星期推算，
   * 传入的 endDate 忽略。null 表示按日期期限。
   */
  serviceDays?: number | null;
  /**
   * 与 `serviceDays` 配套的**精确**服务星期集合（ISO 1–7，可乱序/重复）。
   *
   * 省略/null = 沿用历史“周一至周五”默认；空数组或非 1–7 的值直接拒绝，
   * 绝不猜一个集合。按日期/按次数模式忽略该字段。
   */
  serviceWeekdays?: number[] | null;
  /**
   * 按次数服务（整轮打卡累计）：本期总次数；一个游戏日整轮打卡全部任务算 1 次，
   * 不限日历期限。传入时忽略 startDate/endDate。null 表示按日期/工作日模式。
   */
  serviceCount?: number | null;
  tasks: TemplateTaskDraft[];
  firstReceipt: FirstReceiptDraft | null;
  sourceTemplateId: string | null;
  sourceTemplateName: string | null;
  sourceTemplateVersion: string | null;
}

export interface RenewCommand {
  operationId: string;
  orderId: string;
  durationDays: number;
  priceCents: number;
}

export interface ChangePriceCommand {
  orderId: string;
  /** 托管单必须指定期次；短期单忽略。 */
  periodId?: string | null;
  priceCents: number;
  /** 改价原因（写入审计），可空。 */
  reason?: string | null;
}

export interface ChangeDatesCommand {
  orderId: string;
  periodId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  deadlineDate?: string | null;
}

export interface UpdateOrderPeriodInput {
  periodId: string;
  startDate: string;
  endDate: string;
  priceCents: number;
  /**
   * UF-010 工作日累计模式：数字 = 累计服务天数（结束日按工作日推算，忽略 endDate）；
   * null = 按日期期限；undefined = 不变更模式。
   */
  serviceDays?: number | null;
  /**
   * 按次数模式：数字 = 本期总次数（忽略 endDate，startDate 仅作锚点）；
   * null = 非按次数；undefined = 不变更。与 serviceDays 互斥。
   */
  serviceCount?: number | null;
}

export interface UpdateOrderTaskItem {
  /** 已有任务 id；新增任务为 null。 */
  id: string | null;
  /** 托管任务所属期次 id；短期单任务为 null。 */
  periodId: string | null;
  task: TemplateTaskDraft;
}

/** 订单全量修改：基本信息、价格、期次日期与任务清单一次提交。 */
export interface UpdateOrderCommand {
  orderId: string;
  title: string;
  notes: string | null;
  paymentMode: PaymentMode;
  gameZoneId: string;
  dailyRefreshMinutes: number;
  weeklyRefreshDay: number;
  weeklyRefreshMinutes: number;
  /** 每月刷新日（逗号分隔 1–31）；null 表示按周刷新。 */
  monthlyRefreshDays?: string | null;
  /** 短期单总价；托管单传 null。 */
  priceCents: number | null;
  /** 短期单交付期限；托管单传 null。 */
  deadlineDate: string | null;
  /** 托管期次全量清单（与订单期次一一对应）；短期单传空数组。 */
  periods: UpdateOrderPeriodInput[];
  /** 任务全量清单；未列出的已有任务将被删除（有打卡/截图记录时拒绝删除）。 */
  tasks: UpdateOrderTaskItem[];
}

export interface ReceiptCommand {
  operationId: string;
  orderId: string;
  periodId: string | null;
  amountCents: number;
  receivedAt: number;
  channel: ReceiptChannel;
  note: string | null;
}

export interface AmendCommand {
  operationId: string;
  receiptId: string;
  amountCents: number;
  receivedAt: number;
  channel: ReceiptChannel;
  note: string | null;
  reason: string | null;
}

export interface VoidCommand {
  operationId: string;
  receiptId: string;
  reason: string | null;
}

export interface SetProgressCommand {
  taskId: string;
  gameDate: string;
  value: string | null;
  completed: boolean;
  backfilled: boolean;
}

export interface CompleteBatchCommand {
  operationId: string;
  scope: BatchScope;
  /** HOSTING_ALL 横跨订单、没有单一目标：必须为 null（历史哨兵 `'all'` 只由归一处理）。 */
  targetId: string | null;
  /** HOSTING_ALL 没有单一游戏日：必须为 null；其余范围必须是合法 ISO 游戏日。 */
  gameDate: string | null;
}

/**
 * 日历多选补录：把一批游戏日的**应做普通任务**一次性记为完成。
 *
 * - 只处理日期式托管（`serviceCount === null`）；按次数托管必须按轮次逐次操作。
 * - 累计任务不走这里（由「累计进度」记录总值），会出现在 `skipped` 里。
 * - 已完成的行保持原样，不覆盖既有完成时刻；同一请求重复提交天然幂等。
 */
export interface CompleteDatesCommand {
  orderId: string;
  /** ISO 游戏日；服务层升序去重，一次最多 366 天。 */
  dates: string[];
}

export interface CompleteDatesResult {
  /** 实际写入的打卡条数（同一 occurrence 跨多天只算一次）。 */
  recorded: number;
  /** 实际写入过的日期数。 */
  dates: number;
  /** 跳过原因（累计任务、已移除任务、超出服务期限等），供界面提示。 */
  skipped: SkippedTask[];
}

/** UF-019 预设颜色标记。 */
export type TaskColorTag = 'red' | 'amber' | 'green' | 'blue' | 'purple' | 'gray';

/** UF-053 站内提醒：用户给订单或单条任务设定的本机提醒。 */
export interface ReminderCommand {
  orderId: string;
  /** null = 整笔订单提醒。 */
  taskId: string | null;
  /** 本地时间戳；必须晚于保存时刻。 */
  remindAt: number;
  note: string | null;
}

export interface ReminderView {
  id: string;
  orderId: string;
  taskId: string | null;
  /** 任务标题；订单级提醒为 null。任务已被移除时为 null。 */
  taskTitle: string | null;
  remindAt: number;
  note: string | null;
  acknowledgedAt: number | null;
}

/** 到期未读提醒：带上订单与老板，供全局弹窗直接展示。 */
export interface DueReminderView extends ReminderView {
  orderTitle: string;
  ownerNickname: string;
}

export const TASK_COLOR_TAGS: TaskColorTag[] = ['red', 'amber', 'green', 'blue', 'purple', 'gray'];

export interface TodayTaskItem {
  taskId: string;
  orderId: string;
  orderTitle: string;
  /** 所属老板 id：本周期任务按老板折叠分组用的稳定标识（昵称可重名，不能用它分组）。 */
  ownerId: string;
  ownerName: string;
  accountName: string;
  /** UF-019 任务颜色标记，null 表示未标记。 */
  colorTag: string | null;
  periodId: string | null;
  occurrenceId: string | null;
  occurrenceKey: string | null;
  title: string;
  progressType: ProgressType;
  currentValue: string;
  targetValue: string;
  unit: string | null;
  completed: boolean;
  backfilled: boolean;
  windowStart: string | null;
  windowEnd: string | null;
  attachmentCount: number;
  batchId: string | null;
  /** 所属期次按次数服务的总次数；null 表示按日期/工作日模式。 */
  serviceCount: number | null;
  /** 所属期次按次数服务已完成轮次（整轮打卡算 1 次）；非按次数为 0。 */
  serviceRounds: number;
  /** 数值口径；null 读作 PER_OCCURRENCE。 */
  numericMode: NumericMode | null;
  /** true = 累计目标：输入的是**当前累计总值**，不是本次增量。 */
  cumulative: boolean;
  /** 累计总值是否已达标（普通任务等于 completed）。 */
  reachedTarget: boolean;
  /** 计次托管的轮次；非计次为 null。 */
  sessionId: string | null;
  sessionIndex: number | null;
  /** 轮次行尚未创建（待建行）：写入时在同一事务内 ensure，读操作绝不建行。 */
  awaitingSession: boolean;
  /** 轮次归属游戏日（可能早于今日，用于历史应做集展示）。 */
  roundDate: string | null;
  /**
   * 该任务**累计提交**的权威归属日（读时快照）。
   *
   * 按 scope 自己的日历换算（TASK 订单 / PERIOD 任务期次 / SESSION 轮次期次，
   * 等待中的轮次用活动期次），与命令层 `assertScopeForWrite` 同源；页面级的
   * `TodayView.gameDate` 只用于标题展示，绝不作为各订单的提交日期。
   */
  gameDate: string;
  /** 权威日历快照：提交时按它在提交边界现算归属日，避免表单带着过期日期。 */
  calendar: ScopeCalendar;
  /**
   * 托管「一次性」任务（本期只做一次，哪天打卡都算）。
   *
   * 这类条目**不属于**每日应做集：完成即从今日事项消失，也不参与整单/全部完成的批量勾选。
   * 缺省（undefined）读作 false，历史读取路径无需关心。
   */
  singleShot?: boolean;
}

export interface TodayView {
  gameDate: string;
  /**
   * 该时区下的**公历**今天（不按每日刷新回退）。
   *
   * 页头返图日期用它；未到每日刷新时间时它会比 `gameDate` 晚一天，两者都要展示清楚。
   */
  todayDate: string;
  /** `gameDate` / `todayDate` 的换算时区（取活动订单，缺省 Asia/Shanghai）。 */
  timeZoneId: string;
  hosting: TodayTaskItem[];
  shortTasks: TodayTaskItem[];
  /**
   * 今天不是触发日、但仍在周期窗口内的任务（每月 / 每 N 天）。
   * 只用于查看本周期是否已完成与补录，`gameDate` 是触发日，不参与"今日完成"计数与批量完成。
   */
  periodic: TodayTaskItem[];
  staleOrders: { orderId: string; title: string; reason: string }[];
}

export interface OwnerSummary {
  id: string;
  number: number;
  nickname: string;
  archived: boolean;
  accountCount: number;
  activeOrderCount: number;
  outstandingCents: number;
}

export interface AccountSummary {
  id: string;
  ownerId: string;
  gameName: string;
  server: string;
  uid: string;
  loginAccount: string;
  loginMethod: LoginMethod;
  password: string | null;
  loginDevice: string | null;
  resourceNotes: string | null;
  archived: boolean;
  defaultTemplateId: string | null;
  /** UF-037 分类；null = 未分类。 */
  categoryId: string | null;
  categoryName: string | null;
  orders: OrderSummary[];
}

/** UF-037 账号分类（全局扁平；一个账号最多属于一个分类）。 */
export interface AccountCategorySummary {
  id: string;
  name: string;
  sortOrder: number;
  /** 未归档 + 已归档的全部账号数（删除影响预览用）。 */
  accountCount: number;
}

export interface AccountViewFilter {
  /** null = 只看未分类；undefined = 不过滤。 */
  categoryId?: string | null;
  includeArchived?: boolean;
  keyword?: string;
}

/** UF-037 跨老板账号视图的一行；身份始终是 accountId。 */
export interface AccountViewRow {
  accountId: string;
  ownerId: string;
  ownerNumber: number;
  ownerName: string;
  ownerLabel: string;
  gameName: string;
  server: string;
  uid: string;
  loginAccount: string;
  archived: boolean;
  categoryId: string | null;
  categoryName: string | null;
  orderCount: number;
  activeOrderCount: number;
}

export interface OrderSummary {
  id: string;
  type: OrderType;
  title: string;
  /** 订单颜色标记（本机 order_color_marks，不进备份）；null 表示未标记。 */
  colorTag: string | null;
  ownerId: string;
  ownerName: string;
  accountId: string;
  accountName: string;
  priceCents: number | null;
  outstandingCents: number;
  paidCents: number;
  cancelled: boolean;
  completed: boolean;
  deadlineDate: string | null;
  currentPeriodEnd: string | null;
  /** 最新期次按次数服务的总次数；null 表示按日期/工作日模式。 */
  currentServiceCount: number | null;
  createdAt: number;
  gameZoneId: string;
  dailyRefreshMinutes: number;
}

export interface OwnerDetailView {
  owner: OwnerSummary;
  accounts: AccountSummary[];
  archivedAccounts: AccountSummary[];
  orders: OrderSummary[];
  templates: TemplateSummary[];
}

export interface TemplateSummary {
  id: string;
  gameName: string;
  templateVersion: string;
  origin: string;
  zoneId: string;
  builtInKey: string | null;
  taskCount: number;
}

export interface PeriodView {
  id: string;
  periodIndex: number;
  startDate: string;
  endDate: string;
  priceCents: number;
  paidCents: number;
  /** 已录入但到账时间还没到的在途款；不冲抵待收。 */
  pendingCents: number;
  outstandingCents: number;
  /** UF-010：非 null 表示仅服务日累计模式。 */
  serviceDays: number | null;
  /** 该期次的服务星期（逗号分隔 ISO 1–7）；按日期/按次数期次为 null。 */
  serviceWeekdays: string | null;
  /** 计划口径已消耗天数（非服务日不计）。 */
  serviceDaysUsed: number;
  /** 剩余计划天数。 */
  serviceDaysRemaining: number;
  /** 按次数模式：本期总次数；null 表示按日期/工作日模式。 */
  serviceCount: number | null;
  /** 按次数模式：已完成轮次（一个游戏日整轮打卡算 1 次）；非按次数为 0。 */
  serviceRounds: number;
}

export interface OrderDetailView {
  order: OrderSummary;
  /** 编辑表单回填用：订单备注。 */
  notes: string | null;
  /** 编辑表单回填用：付款方式。 */
  paymentMode: PaymentMode;
  /** 编辑表单回填用：每周刷新设置。 */
  weeklyRefreshDay: number;
  weeklyRefreshMinutes: number;
  /** 编辑表单回填用：每月刷新日（逗号分隔 1–31）；null 表示按周刷新。 */
  monthlyRefreshDays: string | null;
  account: AccountSummary | null;
  periods: PeriodView[];
  tasks: {
    id: string;
    title: string;
    /** UF-019 任务颜色标记，null 表示未标记。 */
    colorTag: string | null;
    progressType: ProgressType;
    startValue: string;
    targetValue: string;
    currentValue: string;
    unit: string | null;
    /** 数值口径；null 读作 PER_OCCURRENCE。 */
    numericMode: NumericMode | null;
    /** true = 累计目标：currentValue 是该 scope 的当前累计总值。 */
    cumulative: boolean;
    /** 当前值是否已达到目标（普通任务等同于已完成）。 */
    reachedTarget: boolean;
    recurrence: Recurrence;
    weekdays: string | null;
    everyNDays: number | null;
    monthDay: number | null;
    monthDays: string | null;
    /** 任务生效起止日期（ISO），空表示随期次。 */
    activeFrom: string | null;
    activeUntil: string | null;
    completed: boolean;
    periodId: string | null;
    occurrenceId: string | null;
    completedAt: number | null;
    backfilled: boolean;
    attachmentCount: number;
  }[];
  receipts: {
    id: string;
    amountCents: number;
    receivedAt: number;
    channel: ReceiptChannel;
    note: string | null;
    status: ReceiptStatus;
    periodId: string | null;
    createdAt: number;
    operationId: string;
    /** 有效但到账时间还没到：显示为"待到账"，不计入已收。 */
    pending: boolean;
  }[];
  corrections: {
    id: string;
    receiptId: string;
    kind: CorrectionKind;
    reason: string | null;
    createdAt: number;
    previousAmountCents: number | null;
    newAmountCents: number | null;
  }[];
  calendar: {
    gameDate: string;
    /** 计次托管的日历行：多个轮次可能落在同一游戏日，必须逐轮展示。 */
    sessionIndex: number | null;
    tasks: {
      taskId: string;
      title: string;
      occurrenceId: string | null;
      completed: boolean;
      backfilled: boolean;
      value: string | null;
      attachmentCount: number;
      /** 累计任务：该游戏日截至的历史真值（asOfGameDate）。 */
      cumulative: boolean;
      reachedTarget: boolean;
      /** 该日是否有可更正的归属事件（累计任务）。 */
      eventCount: number;
      /** 该行的真实归属日：周期任务在非触发日展示时，写入仍落在触发日。 */
      attributedDate: string;
      /**
       * true = 当天不是本任务的触发日，但仍在它的周期窗口内（每月 / 每 N 天的覆盖展示）。
       * 这类行只用于查看状态与补录，不参与日历格子的完成度着色。
       */
      inWindow: boolean;
    }[];
  }[];
  /** 计次托管的轮次（按 sessionIndex 升序）；非计次为空数组。 */
  rounds: RoundView[];
  /** 计次托管的派生活动状态。 */
  activeCount: ActiveCountSummary;
  /** UF-038 累计任务视图（scope + 当前总值 + 事件历史）。 */
  cumulative: CumulativeTaskView[];
  /** 已移除任务的历史入口（仅当仍属于历史应做集或已有轮次）。 */
  historicalTasks: HistoricalTaskView[];
}

/** 累计 scope 的写入输入；SESSION 省略 sessionId 表示"在事务内 ensure 当前轮次"。 */
export type ProgressScopeInput =
  | { kind: 'TASK' }
  | { kind: 'PERIOD'; periodId: string }
  | { kind: 'SESSION'; sessionId?: string | null };

export interface SubmitProgressCommand {
  taskId: string;
  /** 当前累计总值（不是增量）；合法十进制，禁止浮点累加。 */
  totalValue: string;
  gameDate: string;
  operationId: string;
  scope: ProgressScopeInput;
}

export interface CorrectProgressCommand {
  operationId: string;
  correctsEventId: string;
  kind: 'CORRECT' | 'RETRACT';
  totalValue: string | null;
  gameDate: string;
  scope?: ProgressScopeInput;
}

export interface ProgressEventResult {
  eventId: string;
  taskId: string;
  kind: ProgressEventKind;
  scope: ProgressScope;
  totalValue: string | null;
  currentTotal: string;
  reachedTarget: boolean;
  /** true = 同一 operationId 的成功重试，返回的是首次结果。 */
  alreadyApplied: boolean;
}

export interface ProgressHistoryEntry {
  id: string;
  kind: ProgressEventKind;
  scope: ProgressScope;
  /** scope 的人类可读标签（"第 N 次打卡" / "第 N 期" / "整单目标"）。 */
  scopeLabel: string;
  gameDate: string;
  totalValue: string | null;
  sequence: number;
  correctsEventId: string | null;
  recordedAt: number;
  /** 被后续事件取代（含被撤回）。 */
  supersededBy: string | null;
  /**
   * 该事件是否为**当前显示总值**的决定者。
   *
   * 与可编辑性无关：较早日期未被取代的观测会因为更晚的绝对值失去 `effective`，
   * 但它仍然可以按单后继规则被更正/撤销。
   */
  effective: boolean;
  /**
   * 是否可作为新 CORRECT/RETRACT 的目标：未被任何事件取代，且自身不是 RETRACT
   * （撤回不复活旧值，不提供"撤销的撤销"）。
   */
  correctable: boolean;
}

export interface RoundView {
  sessionId: string;
  sessionIndex: number;
  periodId: string;
  attributedDate: string | null;
  completedAt: number | null;
  dueTaskIds: string[];
  completedTaskIds: string[];
  missingTaskIds: string[];
  /** 该轮是否含累计任务（撤销本轮不能靠勾选，必须走事件更正）。 */
  hasCumulative: boolean;
}

export type ActiveCountSummary =
  | { kind: 'ACTIVE_SESSION'; periodId: string; sessionIndex: number; sessionId: string }
  | { kind: 'AWAITING_SESSION_ROW'; periodId: string; sessionIndex: number }
  | { kind: 'ALL_PERIODS_COMPLETE' }
  | { kind: 'INDEX_SPACE_EXHAUSTED'; periodId: string }
  | { kind: 'NOT_COUNT_BASED' };

export interface CumulativeTaskView {
  taskId: string;
  title: string;
  unit: string | null;
  startValue: string;
  targetValue: string;
  currentValue: string;
  reachedTarget: boolean;
  /** 该 scope 是否已达成（普通任务 = 完成）。 */
  completed: boolean;
  /** null = 计次任务还没有任何轮次行（待建立本轮，写入时 ensure）。 */
  scope: ProgressScope | null;
  /** scope 的人类可读标签（第 N 期 / 第 N 次打卡 / 整单目标）。 */
  scopeLabel: string;
  /**
   * 权威归属日（读时快照）：TASK 用订单日历，PERIOD 用任务期次，SESSION 用轮次期次，
   * 等待中的轮次用活动期次。提交时按 `calendar` 在提交边界现算，两者同源。
   */
  gameDate: string;
  /** 权威日历快照（提交时用）。 */
  calendar: ScopeCalendar;
  /**
   * 任务已被移除：不在"当前动作"列表里提供按今天/当前轮次的新观测，
   * 只能按历史轮次补记或经事件历史更正（R2-10）。
   */
  retired: boolean;
  history: ProgressHistoryEntry[];
}

export interface HistoricalRoundView {
  sessionId: string;
  sessionIndex: number;
  attributedDate: string | null;
  completed: boolean;
  /** 该轮内是否存在任何归属行（累计任务：原始事件行，含被取代/已撤销的行）。 */
  hasObservation: boolean;
  /**
   * 该轮内是否存在**逻辑上有效**的观测（累计任务：有效事件赢家）。
   *
   * 与 `hasObservation` 分开是刻意的：撤回只追加事件、不删行，所以被撤回的轮次
   * 仍然"有行"但已没有有效观测。写入路由按本字段判断"能否在该轮补记首次观测"，
   * 否则被撤回的轮次会变成无法补记的死角。
   */
  hasEffectiveObservation: boolean;
  currentValue: string;
}

export interface HistoricalTaskView {
  taskId: string;
  title: string;
  unit: string | null;
  startValue: string;
  targetValue: string;
  cumulative: boolean;
  retiredAt: number | null;
  /** 退休**游戏日**（按期次刷新快照换算）；退休日当天仍可归属。 */
  retiredDate: string | null;
  rounds: HistoricalRoundView[];
}

export interface SkippedTask {
  taskId: string;
  title: string;
  reason: string;
}

export interface BatchCompletionResult {
  batchId: string;
  skipped: SkippedTask[];
}

export interface BatchCompletionDetailedResult {
  batchId: string | null;
  skipped: SkippedTask[];
}

export interface LedgerViewEntry {
  receiptId: string;
  orderId: string;
  orderTitle: string;
  ownerName: string;
  periodId: string | null;
  amountCents: number;
  receivedAt: number;
  channel: ReceiptChannel;
  note: string | null;
  status: ReceiptStatus;
  createdAt: number;
}

export interface LedgerView {
  month: string;
  zoneId: string;
  receivedCents: number;
  /** 全时段在途（到账时间在未来）的有效收款总额；不计入实收、不冲抵待收。 */
  pendingCents: number;
  outstandingCents: number;
  orderCount: number;
  entries: LedgerViewEntry[];
  /** 待到账明细（按预计到账时间升序）。 */
  pending: LedgerViewEntry[];
  outstanding: {
    key: string;
    orderId: string;
    periodId: string | null;
    orderTitle: string;
    ownerName: string;
    priceCents: number;
    paidCents: number;
    pendingCents: number;
    outstandingCents: number;
  }[];
  monthlyTotals: { month: string; receivedCents: number }[];
}

export interface SettingsView {
  ownerCount: number;
  accountCount: number;
  orderCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  datasetDatabase: string;
  generation: number;
  reminderSettings: {
    shortDeadlineEnabled: boolean;
    shortDeadlineMinutes: number;
    hostingExpiryEnabled: boolean;
    hostingExpiryMinutes: number;
    unfinishedTasksEnabled: boolean;
    unfinishedTasksMinutes: number;
  };
  revision: number;
}

export interface Services {
  accounts: {
    saveOwner(input: { id?: string; nickname: string }, token: DatasetToken): Promise<string>;
    saveAccount(input: AccountDraft, token: DatasetToken): Promise<string>;
    archive(kind: 'owner' | 'account', id: string, token: DatasetToken): Promise<void>;
    restore(kind: 'owner' | 'account', id: string, token: DatasetToken): Promise<void>;
    /** 删除账号及其全部订单、打卡、截图、收款与更正记录。 */
    deleteAccount(id: string, token: DatasetToken): Promise<CascadeCounts>;
    /** 删除账号前的影响预览，不做修改。 */
    previewAccountDeletion(id: string): Promise<CascadeCounts>;
    /** 删除已归档老板及其全部账号、订单、打卡、截图、收款与更正记录；未归档的老板必须先归档。 */
    deleteOwner(id: string, token: DatasetToken): Promise<CascadeCounts>;
    /** 删除老板前的影响预览，不做修改。 */
    previewOwnerDeletion(id: string): Promise<CascadeCounts>;
    /** UF-037 全部分类（含账号数）。 */
    categories(): Promise<AccountCategorySummary[]>;
    createCategory(
      input: { name: string; sortOrder?: number },
      token: DatasetToken,
    ): Promise<{ categoryId: string }>;
    renameCategory(input: { categoryId: string; name: string }, token: DatasetToken): Promise<void>;
    /** 删除分类只把账号置为未分类，绝不删除账号、订单或历史。 */
    deleteCategory(
      input: { categoryId: string },
      token: DatasetToken,
    ): Promise<{ unclassifiedAccounts: number }>;
    setAccountCategory(
      input: { accountId: string; categoryId: string | null },
      token: DatasetToken,
    ): Promise<void>;
    /** 跨老板账号视图（身份始终是 accountId）。 */
    accountView(filter: AccountViewFilter): Promise<AccountViewRow[]>;
  };
  serverOptions: {
    /** 某游戏的区服选项（UF-005），按 sortOrder 返回。 */
    list(gameName: string): Promise<{ id: string; gameName: string; name: string; sortOrder: number }[]>;
    /** 全部区服选项按游戏分组，供管理界面使用。 */
    listAll(): Promise<{ gameName: string; options: { id: string; name: string; sortOrder: number }[] }[]>;
    save(input: ServerOptionDraft, token: DatasetToken): Promise<string>;
    remove(id: string, token: DatasetToken): Promise<void>;
  };
  templates: {
    save(input: TemplateDraft, token: DatasetToken): Promise<string>;
    remove(id: string, token: DatasetToken): Promise<void>;
    importFile(file: Blob, mode: 'copy' | 'replace', token: DatasetToken): Promise<string>;
    exportFile(id: string): Promise<Blob>;
    ensureBuiltIns(): Promise<void>;
  };
  orders: {
    create(
      input: CreateOrderCommand,
      token: DatasetToken,
    ): Promise<{ orderId: string; receiptId: string | null }>;
    renew(input: RenewCommand, token: DatasetToken): Promise<string>;
    changeDates(input: ChangeDatesCommand, token: DatasetToken): Promise<void>;
    cancel(id: string, token: DatasetToken): Promise<void>;
    deleteEmpty(id: string, token: DatasetToken): Promise<void>;
    /** 改名只影响展示，不改变订单身份与业务记录。 */
    rename(id: string, title: string, token: DatasetToken): Promise<void>;
    /** 修改托管期次价格或短期单总价；不得低于该款项已收金额。 */
    changePrice(input: ChangePriceCommand, token: DatasetToken): Promise<void>;
    /** 全量修改订单：基本字段、价格（写审计）、期次日期与任务清单。 */
    update(input: UpdateOrderCommand, token: DatasetToken): Promise<void>;
    /**
     * 订单颜色标记（本机保存，便于列表管理；不进入备份）。
     * 标注/改色统一下发到该单任务：无标记/跟随标记的任务改为该色，任务自身标记保留原色；取消时清除跟随标记。
     */
    setOrderColor(orderId: string, color: string | null, token: DatasetToken): Promise<void>;
    /** 删除已作废订单及其全部派生记录。 */
    deleteCancelled(id: string, token: DatasetToken): Promise<CascadeCounts>;
    /** 删除前的影响预览，不做修改。 */
    previewDeletion(id: string): Promise<CascadeCounts>;
  };
  receipts: {
    record(input: ReceiptCommand, token: DatasetToken): Promise<string>;
    amend(input: AmendCommand, token: DatasetToken): Promise<string>;
    void(input: VoidCommand, token: DatasetToken): Promise<string>;
  };
  tasks: {
    setProgress(input: SetProgressCommand, token: DatasetToken): Promise<void>;
    /** 兼容入口：返回 batchId；没有任何可完成项时抛 CONFLICT（含跳过原因）。 */
    completeBatch(input: CompleteBatchCommand, token: DatasetToken): Promise<string>;
    /** 批量完成（含跳过说明）：累计任务未达标时跳过，绝不虚构进度。 */
    completeBatchDetailed(
      input: CompleteBatchCommand,
      token: DatasetToken,
    ): Promise<BatchCompletionDetailedResult>;
    /** 日历多选补录：按日期批量完成普通打卡（仅日期式托管，累计任务跳过）。 */
    completeDates(input: CompleteDatesCommand, token: DatasetToken): Promise<CompleteDatesResult>;
    undoBatch(batchId: string, token: DatasetToken): Promise<{ restored: number; conflicts: number }>;
    /** UF-019：设置或清除单个任务的颜色标记（本机保存）。设置为任务自身标记，覆盖整单下发的跟随标记。 */
    setTaskColor(taskId: string, color: string | null, token: DatasetToken): Promise<void>;
    /**
     * 手动排序（2026-10-27 用户反馈）：把页面看到的条目顺序写回 `task_definitions.sortOrder`。
     *
     * `orderedTaskIds` 只需给出**本次可见**的条目；看不见的任务槽位原地保留，
     * 因此今日事项（只看今天）与订单编辑页（看全部）可以共用同一个顺序。
     */
    reorderTasks(
      input: { orderId: string; orderedTaskIds: string[] },
      token: DatasetToken,
    ): Promise<void>;
    /**
     * 已移除任务的**历史**补记/撤销（计次托管）。
     *
     * 只作用于已移除任务、已存在的轮次、归属日不晚于退休日；普通数值任务沿用正常完成
     * 语义（至少达到目标、保留更高值、缺失值以起始值代入）；累计任务仍走事件链。
     */
    setHistoricalRoundCompletion(
      input: { orderId: string; sessionIndex: number; taskId: string; completed: boolean },
      token: DatasetToken,
    ): Promise<void>;
  };
  /**
   * UF-053 站内提醒（本机保存，不进入备份、不同步安卓）。
   *
   * 只在用户打开网站时检查：到期未读的提醒由全局弹窗展示，点「知道了」后
   * 写入 `acknowledgedAt`，不再重复弹出。
   */
  reminders: {
    save(input: ReminderCommand, token: DatasetToken): Promise<string>;
    remove(id: string, token: DatasetToken): Promise<void>;
    /** 标记已读（幂等）；用于弹窗的「知道了」与「查看订单」。 */
    acknowledge(ids: string[], token: DatasetToken): Promise<number>;
    /** 某订单的提醒清单（含已读），按时间升序。 */
    list(orderId: string): Promise<ReminderView[]>;
    /** 到期未读：跳过已归档/已作废订单与已移除任务。 */
    due(): Promise<DueReminderView[]>;
  };
  /** UF-038 累计进度命令与查询（显式 scope + 追加式事件历史）。 */
  progress: {
    submit(input: SubmitProgressCommand, token: DatasetToken): Promise<ProgressEventResult>;
    correct(input: CorrectProgressCommand, token: DatasetToken): Promise<ProgressEventResult>;
    currentTotal(input: {
      taskId: string;
      scope: ProgressScopeInput;
    }): Promise<{ total: string; reachedTarget: boolean }>;
    totalAsOf(input: {
      taskId: string;
      scope: ProgressScopeInput;
      asOfGameDate: string;
    }): Promise<{ total: string; reachedTarget: boolean }>;
    updateNumericMode(
      input: { taskId: string; mode: NumericMode },
      token: DatasetToken,
    ): Promise<void>;
    history(taskId: string): Promise<ProgressHistoryEntry[]>;
    ensureSession(
      input: { orderId: string; periodId: string; requestedSessionIndex?: number | null },
      token: DatasetToken,
    ): Promise<{ sessionId: string; sessionIndex: number; created: boolean }>;
    /** 重开一个已有轮次（证据仍完整时会拒绝，累计任务必须走事件更正）。 */
    reopenSession(
      input: { orderId: string; sessionIndex: number },
      token: DatasetToken,
    ): Promise<void>;
  };
  attachments: {
    /** 上传一张截图（追加语义）：同一任务/打卡日可挂多张，不再互相替换。 */
    put(
      target: { taskId: string } | { occurrenceId: string },
      file: Blob,
      token: DatasetToken,
    ): Promise<string>;
    remove(id: string, token: DatasetToken): Promise<void>;
    load(id: string): Promise<Blob | null>;
    list(orderId: string): Promise<
      { id: string; taskDefinitionId: string | null; occurrenceId: string | null; mimeType: string; sizeBytes: number }[]
    >;
    /** 某任务的全部截图（任务级 + 各打卡日）。 */
    listTask(taskId: string): Promise<
      { id: string; taskDefinitionId: string | null; occurrenceId: string | null; mimeType: string; sizeBytes: number }[]
    >;
  };
  queries: {
    today(filter: {
      ownerId?: string;
      accountId?: string;
      includeExpired?: boolean;
    }): Promise<TodayView>;
    /** UF-023：跨老板搜索账号（游戏/区服/UID/登录账号），不含密码。 */
    searchAccounts(keyword: string): Promise<
      {
        id: string;
        ownerId: string;
        ownerLabel: string;
        gameName: string;
        server: string;
        uid: string;
        archived: boolean;
      }[]
    >;
    owners(includeArchived: boolean): Promise<OwnerSummary[]>;
    ownerDetail(ownerId: string): Promise<OwnerDetailView | null>;
    orders(filter: { ownerId?: string; type?: OrderType; includeCancelled?: boolean }): Promise<OrderSummary[]>;
    orderDetail(orderId: string): Promise<OrderDetailView | null>;
    ledger(report: { month: string; zoneId: string }): Promise<LedgerView>;
    templates(): Promise<TemplateSummary[]>;
    templateDetail(id: string): Promise<TemplateDraft | null>;
    settings(): Promise<SettingsView>;
  };
  exportSnapshot(): Promise<import('../contracts/backup').Snapshot>;
}

export type { DatasetToken };
