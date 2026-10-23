import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * 更新安全机制：页面级「未保存编辑 / 进行中操作」登记表。
 * 更新被接受时先查询此表；存在阻塞项则提示用户先保存/等待，而不是强行刷新。
 */

export const DIRTY_MESSAGE = '请先保存或取消当前编辑，再更新。';
export const BUSY_MESSAGE = '正在处理资料，请完成后再更新。';

export type UpdateBlockKind = 'dirty' | 'busy';

export interface UpdateBlocker {
  id: string;
  kind: UpdateBlockKind;
  message: string;
}

const blockers = new Map<string, UpdateBlocker>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function setUpdateBlocker(
  id: string,
  kind: UpdateBlockKind,
  message?: string,
): void {
  blockers.set(id, {
    id,
    kind,
    message: message ?? (kind === 'busy' ? BUSY_MESSAGE : DIRTY_MESSAGE),
  });
  notify();
}

export function clearUpdateBlocker(id: string): void {
  if (blockers.delete(id)) notify();
}

/** 登记一个进行中的操作（截图上传、备份导出/恢复、批量写入等），返回结束函数。 */
export function beginOperation(id: string, message: string = BUSY_MESSAGE): () => void {
  setUpdateBlocker(id, 'busy', message);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    clearUpdateBlocker(id);
  };
}

export function getUpdateBlockers(): UpdateBlocker[] {
  return [...blockers.values()];
}

/** 有阻塞项时返回应展示的提示；busy 优先于 dirty。无阻塞返回 null。 */
export function getUpdateBlockMessage(): string | null {
  const list = getUpdateBlockers();
  const busy = list.find((item) => item.kind === 'busy');
  if (busy) return busy.message;
  const dirty = list.find((item) => item.kind === 'dirty');
  return dirty ? dirty.message : null;
}

export function subscribeUpdateBlockers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 挂载期间登记一个阻塞项；卸载或 active 变 false 时自动清理。 */
export function useUpdateBlocker(
  active: boolean,
  kind: UpdateBlockKind,
  message?: string,
): void {
  const [id] = useState(() => `blocker-${Math.random().toString(36).slice(2, 10)}`);
  useEffect(() => {
    if (!active) return;
    setUpdateBlocker(id, kind, message);
    return () => clearUpdateBlocker(id);
  }, [active, id, kind, message]);
}

/**
 * 创建/编辑表单守卫：表单存在期间视为未保存编辑，提交忙碌时叠加 busy 阻塞。
 * 表单关闭（组件卸载或 active 变 false）后自动解除。
 */
export function useFormUpdateGuard(active: boolean, busy: boolean): void {
  useUpdateBlocker(active, 'dirty');
  useUpdateBlocker(active && busy, 'busy');
}

export function useUpdateBlockerCount(): number {
  return useSyncExternalStore(
    subscribeUpdateBlockers,
    () => blockers.size,
    () => 0,
  );
}
