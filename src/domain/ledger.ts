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
  outstandingCents: number;
  cancelled: boolean;
}

export interface LedgerSummary {
  month: string;
  receivedCents: number;
  outstandingCents: number;
  orderCount: number;
  receivables: Receivable[];
  activeReceipts: ReceiptRow[];
  receiptsInMonth: ReceiptRow[];
}

export function activeReceipts(data: BackupDataSet): ReceiptRow[] {
  return data.receipts.filter((receipt) => receipt.status === 'ACTIVE');
}

export function paidForOrder(data: BackupDataSet, orderId: string): number {
  return activeReceipts(data)
    .filter((receipt) => receipt.orderId === orderId)
    .reduce((sum, receipt) => sum + receipt.amountCents, 0);
}

export function paidForPeriod(data: BackupDataSet, periodId: string): number {
  return activeReceipts(data)
    .filter((receipt) => receipt.periodId === periodId)
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
): Receivable {
  const paid = period ? paidForPeriod(data, period.id) : paidForOrder(data, order.id);
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
    outstandingCents: Math.max(0, priceCents - paid),
    cancelled: order.cancelledAt !== null,
  };
}

/** 全部应收项（作废订单退出待收，但历史实收保留）。 */
export function receivablesOf(data: BackupDataSet): Receivable[] {
  const result: Receivable[] = [];
  for (const order of data.orders) {
    if (order.cancelledAt !== null) continue;
    if (order.type === 'SHORT_TASK') {
      result.push(receivable(data, order, null, order.priceCents ?? 0));
      continue;
    }
    const periods = data.hosting_periods
      .filter((period) => period.orderId === order.id)
      .sort((left, right) => left.periodIndex - right.periodIndex);
    for (const period of periods) {
      result.push(receivable(data, order, period, period.priceCents));
    }
  }
  return result;
}

export function outstandingOf(data: BackupDataSet): Receivable[] {
  return receivablesOf(data).filter((item) => item.outstandingCents > 0);
}

export function ledgerFor(
  data: BackupDataSet,
  report: { month: string; zoneId: string },
): LedgerSummary {
  const { start, end } = monthRange(report.month, report.zoneId);
  const active = activeReceipts(data);
  const inMonth = active.filter(
    (receipt) => receipt.receivedAt >= start && receipt.receivedAt < end,
  );
  const receivables = receivablesOf(data);
  const orderCount = data.orders.filter(
    (order) => order.createdAt >= start && order.createdAt < end,
  ).length;
  return {
    month: report.month,
    receivedCents: inMonth.reduce((sum, receipt) => sum + receipt.amountCents, 0),
    outstandingCents: outstandingOf(data).reduce((sum, item) => sum + item.outstandingCents, 0),
    orderCount,
    receivables,
    activeReceipts: active,
    receiptsInMonth: inMonth,
  };
}
