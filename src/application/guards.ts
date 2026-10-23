import { AppError } from '../contracts/errors';
import type { BackupDataSet, GameAccountRow, OrderRow, OwnerRow } from '../contracts/tables';
import { gameDateAt } from '../domain/gameCalendar';

export function requireText(value: string, label: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min) throw new AppError('INVALID_INPUT', `${label}至少 ${min} 个字符`);
  if (trimmed.length > max) throw new AppError('INVALID_INPUT', `${label}最多 ${max} 个字符`);
  return trimmed;
}

export function optionalText(value: string | null | undefined, max: number, label: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new AppError('INVALID_INPUT', `${label}最多 ${max} 个字符`);
  return trimmed;
}

export function mustFindOwner(data: BackupDataSet, ownerId: string): OwnerRow {
  const owner = data.owners.find((row) => row.id === ownerId);
  if (!owner) throw new AppError('NOT_FOUND', '老板不存在');
  return owner;
}

export function mustFindAccount(data: BackupDataSet, accountId: string): GameAccountRow {
  const account = data.game_accounts.find((row) => row.id === accountId);
  if (!account) throw new AppError('NOT_FOUND', '游戏账号不存在');
  return account;
}

export function mustFindOrder(data: BackupDataSet, orderId: string): OrderRow {
  const order = data.orders.find((row) => row.id === orderId);
  if (!order) throw new AppError('NOT_FOUND', '订单不存在');
  return order;
}

export function accountGameDate(order: OrderRow, now: number): string {
  return gameDateAt(now, order.gameZoneId, order.dailyRefreshMinutes);
}

/** 归档守卫：未完成短期单或未到期托管期阻止归档。 */
export function assertArchivable(
  data: BackupDataSet,
  orderIds: Set<string>,
  now: number,
  kind: 'owner' | 'account',
): void {
  const label = kind === 'owner' ? '老板' : '游戏账号';
  for (const order of data.orders) {
    if (!orderIds.has(order.id) || order.cancelledAt !== null) continue;
    const today = accountGameDate(order, now);
    if (order.type === 'SHORT_TASK') {
      if (order.completedAt === null) {
        throw new AppError('ARCHIVE_GUARD', `${label}还有未完成的短期单，先完成或作废后再归档`);
      }
      continue;
    }
    const periods = data.hosting_periods.filter((period) => period.orderId === order.id);
    const latest = periods.reduce<null | (typeof periods)[number]>(
      (current, period) => (!current || period.endDate > current.endDate ? period : current),
      null,
    );
    if (latest && today <= latest.endDate) {
      throw new AppError('ARCHIVE_GUARD', `${label}还有未到期的托管服务，暂不能归档`);
    }
  }
}

export function orderIdsOfAccount(data: BackupDataSet, accountId: string): Set<string> {
  return new Set(data.orders.filter((order) => order.accountId === accountId).map((order) => order.id));
}

export function orderIdsOfOwner(data: BackupDataSet, ownerId: string): Set<string> {
  const accounts = new Set(
    data.game_accounts.filter((account) => account.ownerId === ownerId).map((account) => account.id),
  );
  return new Set(
    data.orders.filter((order) => accounts.has(order.accountId)).map((order) => order.id),
  );
}

export function assertWritableAccount(
  data: BackupDataSet,
  ownerId: string,
  accountId: string,
): void {
  const owner = mustFindOwner(data, ownerId);
  const account = mustFindAccount(data, accountId);
  if (account.ownerId !== ownerId) {
    throw new AppError('INVALID_INPUT', '账号不属于所选老板');
  }
  if (owner.archivedAt !== null) {
    throw new AppError('ARCHIVED_OWNER', '老板已归档，不能写入工作记录');
  }
  if (account.archivedAt !== null) {
    throw new AppError('ARCHIVED_ACCOUNT', '游戏账号已归档，不能写入工作记录');
  }
}

export function assertOrderWritable(data: BackupDataSet, orderId: string): OrderRow {
  const order = mustFindOrder(data, orderId);
  if (order.cancelledAt !== null) {
    throw new AppError('ORDER_CANCELLED', '订单已作废，不能继续写入工作记录');
  }
  // 归档订单（安卓可写入）与归档老板/账号同样只读：否则从安卓恢复的数据会被
  // 网页端重新写入，与另一端"归档即只读"的判定分叉（契约 D-18）。
  if (order.archivedAt !== null) {
    throw new AppError('ARCHIVED_ORDER', '订单已归档，不能继续写入工作记录');
  }
  const account = mustFindAccount(data, order.accountId);
  const owner = mustFindOwner(data, account.ownerId);
  if (owner.archivedAt !== null) {
    throw new AppError('ARCHIVED_OWNER', '老板已归档，不能写入工作记录');
  }
  if (account.archivedAt !== null) {
    throw new AppError('ARCHIVED_ACCOUNT', '游戏账号已归档，不能写入工作记录');
  }
  return order;
}
