import type {
  BackupDataSet,
  HostingPeriodRow,
  OrderRow,
  ReceiptRow,
} from '../contracts/tables';
import { monthRange } from './gameCalendar';

export interface Receivable {
  key: string;
  orderId: string;
  periodId: string | null;
  orderTitle: string;
  ownerName: string;
  accountName: string;
  priceCents: number;
  paidCents: number;
  /** 已录入但到账时间还没到的收款（闲鱼等第三方在途），不冲抵待收。 */
  pendingCents: number;
  outstandingCents: number;
  cancelled: boolean;
}

export interface LedgerSummary {
  month: string;
  receivedCents: number;
  /** 全时段在途（`receivedAt` 在未来）的有效收款总额。 */
  pendingCents: number;
  outstandingCents: number;
  orderCount: number;
  receivables: Receivable[];
  activeReceipts: ReceiptRow[];
  receiptsInMonth: ReceiptRow[];
}

/** 全部有效收款（含尚未到账的在途款），用于历史展示与备份口径。 */
export function activeReceipts(data: BackupDataSet): ReceiptRow[] {
  return data.receipts.filter((receipt) => receipt.status === 'ACTIVE');
}

/**
 * 已经真正到账的有效收款：`receivedAt <= now`。
 *
 * 允许提前录入未来到账时间（闲鱼担保交易），但在时间到达前绝不能当成已收：
 * 否则待收会瞬间清零、而本月实收又落在未来月份。
 */
export function settledReceipts(data: BackupDataSet, nowMs: number = Date.now()): ReceiptRow[] {
  return activeReceipts(data).filter((receipt) => receipt.receivedAt <= nowMs);
}

/** 在途收款：有效但到账时间在未来。 */
export function pendingReceipts(data: BackupDataSet, nowMs: number = Date.now()): ReceiptRow[] {
  return activeReceipts(data).filter((receipt) => receipt.receivedAt > nowMs);
}

export function paidForOrder(
  data: BackupDataSet,
  orderId: string,
  nowMs: number = Date.now(),
): number {
  return settledReceipts(data, nowMs)
    .filter((receipt) => receipt.orderId === orderId)
    .reduce((sum, receipt) => sum + receipt.amountCents, 0);
}

export function paidForPeriod(
  data: BackupDataSet,
  periodId: string,
  nowMs: number = Date.now(),
): number {
  return settledReceipts(data, nowMs)
    .filter((receipt) => receipt.periodId === periodId)
    .reduce((sum, receipt) => sum + receipt.amountCents, 0);
}

function pendingForPeriod(data: BackupDataSet, periodId: string, nowMs: number): number {
  return pendingReceipts(data, nowMs)
    .filter((receipt) => receipt.periodId === periodId)
    .reduce((sum, receipt) => sum + receipt.amountCents, 0);
}

function pendingForOrder(data: BackupDataSet, orderId: string, nowMs: number): number {
  return pendingReceipts(data, nowMs)
    .filter((receipt) => receipt.orderId === orderId)
    .reduce((sum, receipt) => sum + receipt.amountCents, 0);
}

function ownerAndAccount(data: BackupDataSet, order: OrderRow): { owner: string; account: string } {
  const account = data.game_accounts.find((item) => item.id === order.accountId);
  const owner = account ? data.owners.find((item) => item.id === account.ownerId) : undefined;
  return {
    owner: owner ? `#${owner.number} ${owner.nickname}` : '未知老板',
    account: account ? `${account.gameName}·${account.server}` : '未知账号',
  };
}

function receivable(
  data: BackupDataSet,
  order: OrderRow,
  period: HostingPeriodRow | null,
  priceCents: number,
  nowMs: number,
): Receivable {
  const paid = period
    ? paidForPeriod(data, period.id, nowMs)
    : paidForOrder(data, order.id, nowMs);
  const pending = period
    ? pendingForPeriod(data, period.id, nowMs)
    : pendingForOrder(data, order.id, nowMs);
  const names = ownerAndAccount(data, order);
  return {
    key: period ? `${order.id}:${period.id}` : order.id,
    orderId: order.id,
    periodId: period ? period.id : null,
    orderTitle: order.title,
    ownerName: names.owner,
    accountName: names.account,
    priceCents,
    paidCents: paid,
    pendingCents: pending,
    outstandingCents: Math.max(0, priceCents - paid),
    cancelled: order.cancelledAt !== null,
  };
}

/** 全部应收项（作废订单退出待收，但历史实收保留）；在途款单列，不冲抵待收。 */
export function receivablesOf(data: BackupDataSet, nowMs: number = Date.now()): Receivable[] {
  const result: Receivable[] = [];
  for (const order of data.orders) {
    if (order.cancelledAt !== null) continue;
    if (order.type === 'SHORT_TASK') {
      result.push(receivable(data, order, null, order.priceCents ?? 0, nowMs));
      continue;
    }
    const periods = data.hosting_periods
      .filter((period) => period.orderId === order.id)
      .sort((left, right) => left.periodIndex - right.periodIndex);
    for (const period of periods) {
      result.push(receivable(data, order, period, period.priceCents, nowMs));
    }
  }
  return result;
}

export function outstandingOf(data: BackupDataSet, nowMs: number = Date.now()): Receivable[] {
  return receivablesOf(data, nowMs).filter((item) => item.outstandingCents > 0);
}

export function ledgerFor(
  data: BackupDataSet,
  report: { month: string; zoneId: string },
  nowMs: number = Date.now(),
): LedgerSummary {
  const { start, end } = monthRange(report.month, report.zoneId);
  const settled = settledReceipts(data, nowMs);
  const inMonth = settled.filter(
    (receipt) => receipt.receivedAt >= start && receipt.receivedAt < end,
  );
  const receivables = receivablesOf(data, nowMs);
  const orderCount = data.orders.filter(
    (order) => order.createdAt >= start && order.createdAt < end,
  ).length;
  return {
    month: report.month,
    receivedCents: inMonth.reduce((sum, receipt) => sum + receipt.amountCents, 0),
    pendingCents: pendingReceipts(data, nowMs).reduce(
      (sum, receipt) => sum + receipt.amountCents,
      0,
    ),
    outstandingCents: outstandingOf(data, nowMs).reduce(
      (sum, item) => sum + item.outstandingCents,
      0,
    ),
    orderCount,
    receivables,
    activeReceipts: settled,
    receiptsInMonth: inMonth,
  };
}
