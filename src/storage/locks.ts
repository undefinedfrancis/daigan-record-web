const LOCK_NAME = 'daigan-dataset';

let fallbackChain: Promise<unknown> = Promise.resolve();

export function hasCrossTabLocks(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}

/**
 * 同源跨标签页排他锁。
 * 浏览器不支持 Web Locks 时退回进程内串行队列，并在启动时以 `hasCrossTabLocks()`
 * 明确提示受支持范围，不把退化路径当成等价保护。
 */
export async function withDatasetLock<T>(fn: () => Promise<T>): Promise<T> {
  if (hasCrossTabLocks()) {
    return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, fn) as Promise<T>;
  }
  const run = fallbackChain.then(fn, fn);
  fallbackChain = run.catch(() => undefined);
  return run;
}

const CHANNEL_NAME = 'daigan-dataset-events';

export type DatasetEvent = { type: 'dataset-changed'; generation: number; databaseName: string };

export function broadcastDatasetChange(event: DatasetEvent): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage(event);
  channel.close();
}

export function subscribeDatasetChange(handler: (event: DatasetEvent) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (message: MessageEvent<DatasetEvent>) => handler(message.data);
  return () => channel.close();
}
