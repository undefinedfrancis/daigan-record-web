/**
 * 累计进度命令的**重试身份**（UF-038 / 契约 `commands.progress.executionOrder`）。
 *
 * - 同一载荷（任务 + scope 身份 + 归属日 + 总值 / 被更正事件）重试必须复用同一个
 *   operationId，这样服务端会返回首次结果，而不是重复追加事件；
 * - 载荷改变（例如把 10 改成 15、把日期从 day1 改到 day2、换了轮次）就换新的
 *   operationId —— 只按"值"绑定会让不同日期/轮次误用同一把钥匙；
 * - 失败/结果未知时**保留**原键；成功后清除；
 * - 用 sessionStorage 持久化，刷新页面后同一载荷仍可安全重试；切换数据集时
 *   写命令会被 `STALE_DATASET` 拒绝，旧键不会被用在新数据集上（键里带 scope 与
 *   载荷摘要，且成功后即清除）。
 */
import { scopeKey, type ProgressScope } from '../../domain/progressEvents';

/**
 * 累计命令的重试载荷：任务 + scope 身份 + 归属日 +（被更正事件）+ 取值。
 *
 * `scope === null` 表示"当前轮次（事务内 ensure）"，与具体的 `SESSION:<id>` 不同：
 * 前者用 `SESSION:auto` 表达，避免把"待建轮次"和某个已知轮次混为一谈。
 */
export function cumulativeOperationPayload(parts: {
  kind: 'SUBMIT' | 'CORRECT' | 'RETRACT';
  taskId: string;
  scope: ProgressScope | null;
  gameDate: string;
  value?: string | null;
  targetId?: string;
}): string {
  return [
    parts.kind,
    parts.taskId,
    parts.scope === null ? 'SESSION:auto' : scopeKey(parts.scope),
    parts.gameDate,
    parts.targetId ?? '',
    parts.value ?? '',
  ].join('|');
}

interface PendingRecord {
  payload: string;
  operationId: string;
}

function keyOf(scopeKey: string): string {
  return `daigan.pending-op:${scopeKey}`;
}

function read(scopeKey: string): PendingRecord | null {
  try {
    const raw = sessionStorage.getItem(keyOf(scopeKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingRecord;
    return typeof parsed?.operationId === 'string' && typeof parsed?.payload === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function operationIdFor(scopeKey: string, payload: string): string {
  const existing = read(scopeKey);
  if (existing && existing.payload === payload) return existing.operationId;
  const operationId = `${scopeKey}-${crypto.randomUUID()}`;
  try {
    sessionStorage.setItem(keyOf(scopeKey), JSON.stringify({ payload, operationId }));
  } catch {
    // 隐私模式无法持久化时退化为"本次会话内重试复用"，不阻断写入。
  }
  return operationId;
}

export function clearPendingOperation(scopeKey: string): void {
  try {
    sessionStorage.removeItem(keyOf(scopeKey));
  } catch {
    // 同上。
  }
}
