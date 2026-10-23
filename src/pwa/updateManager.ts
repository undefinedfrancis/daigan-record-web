import { getCurrentBuildId, isPwaRuntimeSupported } from './buildInfo';
import { getUpdateBlockMessage } from './updateSafety';

/**
 * 更新流程编排：注册 Service Worker、检测新构建、等待用户确认、
 * 校验安全（无未保存编辑 / 无进行中操作 / 无其他应用标签页）后显式激活并刷新一次。
 */

export type CheckResult =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'offline'
  | 'error'
  | 'found'
  | 'download-failed'
  | 'timeout';

export interface UpdateState {
  supported: boolean;
  checking: boolean;
  /** 有已准备完成、等待用户确认的新版本。 */
  waiting: boolean;
  waitingBuildId: string | null;
  waitingLabel: string | null;
  dismissed: boolean;
  activating: boolean;
  checkResult: CheckResult;
}

export interface VersionPayload {
  buildId: string;
  version?: string;
  label?: string;
}

export type Notifier = (message: string, tone: 'info' | 'success' | 'error') => void;

export const OTHER_TABS_MESSAGE = '请先关闭其他打开的本应用页面，再更新。';
/** 无法确认其他标签页状态时的提示：宁可阻止更新，也不当作 0 个标签页放行。 */
export const UNKNOWN_TABS_MESSAGE = '暂时无法确认其他页面状态，请稍后重试。';
export const WAITING_CHANGED_MESSAGE = '更新状态已变化，请重新检查更新。';
export const NOT_READY_MESSAGE = '更新未就绪，请重新检查更新。';
export const ACTIVATION_FAILED_MESSAGE = '更新未完成，请重试。';

/** 校验 worker 回报的其他标签页数量：必须是 >= 0 的整数，否则视为无法确认。 */
export function parseOtherTabsResponse(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const count = (data as Record<string, unknown>).count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
  return count;
}

export function parseVersionPayload(data: unknown): VersionPayload | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (typeof record.buildId !== 'string' || record.buildId.length === 0) return null;
  return {
    buildId: record.buildId,
    version: typeof record.version === 'string' ? record.version : undefined,
    label: typeof record.label === 'string' ? record.label : undefined,
  };
}

export type ManualCheckOutcome = 'offline' | 'error' | 'up-to-date' | 'found';

/**
 * 手动检查结果判定：检查未成功（离线 / 请求失败 / 元数据无效）绝不回报「已是最新」。
 */
export function mapManualCheck(input: {
  fetchOk: boolean;
  onLine: boolean;
  payload: VersionPayload | null;
  currentBuildId: string | null;
}): ManualCheckOutcome {
  if (!input.fetchOk) return input.onLine ? 'error' : 'offline';
  if (!input.payload) return 'error';
  if (!input.currentBuildId) return 'error';
  return input.payload.buildId === input.currentBuildId ? 'up-to-date' : 'found';
}

export function describeCheckResult(
  result: CheckResult,
  waiting: boolean,
  dismissed: boolean,
): string {
  switch (result) {
    case 'checking':
      return '正在检查更新…';
    case 'up-to-date':
      return '当前已是最新版本。';
    case 'offline':
      return '当前离线，无法检查更新。';
    case 'error':
      return '检查更新失败，请稍后重试。';
    case 'found':
      if (waiting && dismissed) return '新版本已准备好（此前已选择「稍后」），可在下方「立即更新」。';
      if (waiting) return '新版本已准备好，更新后即可使用。';
      return '已发现新版本，正在下载准备…';
    case 'download-failed':
      return '新版本下载失败，请稍后重试；当前版本可继续使用。';
    case 'timeout':
      return '新版本准备超时，请稍后重试。';
    default:
      return '';
  }
}

function dismissedKey(buildId: string | null): string {
  return `daigan-update-dismissed:${buildId ?? 'unknown'}`;
}

function isDismissed(buildId: string | null): boolean {
  try {
    return sessionStorage.getItem(dismissedKey(buildId)) === '1';
  } catch {
    return false;
  }
}

function rememberDismissed(buildId: string | null): void {
  try {
    sessionStorage.setItem(dismissedKey(buildId), '1');
  } catch {
    // 隐私模式等场景忽略。
  }
}

function askWorker<T>(worker: ServiceWorker, message: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      window.clearTimeout(timer);
      channel.port1.close();
      resolve((event.data ?? null) as T | null);
    };
    try {
      worker.postMessage({ ...message, requestId: Date.now() }, [channel.port2]);
    } catch {
      window.clearTimeout(timer);
      channel.port1.close();
      resolve(null);
    }
  });
}

export interface UpdateManagerOptions {
  /** 查询其他标签页的超时（毫秒）；超时视为「无法确认」，不当作 0。 */
  tabQueryTimeoutMs?: number;
  /** 覆盖运行时能力判断（测试用于固定 supported 结果）。 */
  supported?: boolean;
}

/** 接受更新被安全检查拦下：携带面向用户的中文提示，状态已复位可重试。 */
class AcceptanceBlocked extends Error {}

export class UpdateManager {
  private readonly tabQueryTimeoutMs: number;

  constructor(options: UpdateManagerOptions = {}) {
    this.tabQueryTimeoutMs = options.tabQueryTimeoutMs ?? 2000;
    if (options.supported !== undefined) {
      this.state = { ...this.state, supported: options.supported };
    }
  }

  private state: UpdateState = {
    supported: isPwaRuntimeSupported(),
    checking: false,
    waiting: false,
    waitingBuildId: null,
    waitingLabel: null,
    dismissed: false,
    activating: false,
    checkResult: 'idle',
  };

  private listeners = new Set<() => void>();
  private notifier: Notifier | null = null;
  private started = false;
  private registration: ServiceWorkerRegistration | null = null;
  private expectingReload = false;
  private reloaded = false;
  private activating = false;
  private hadController = false;
  private otherTabNotified = false;
  private lastAutoCheck = 0;
  private waitingSetup: Promise<void> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): UpdateState => this.state;

  setNotifier(notifier: Notifier | null): void {
    this.notifier = notifier;
  }

  private notify(message: string, tone: 'info' | 'success' | 'error'): void {
    this.notifier?.(message, tone);
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** 幂等启动：注册 SW 并接好生命周期监听；注册失败不阻塞应用。 */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.state.supported) return;

    this.hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', this.onControllerChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);

    if (document.readyState !== 'complete') {
      await new Promise<void>((resolve) => {
        window.addEventListener('load', () => resolve(), { once: true });
      });
    }

    try {
      const registration = await navigator.serviceWorker.register('./sw.js', {
        scope: './',
        updateViaCache: 'none',
      });
      this.registration = registration;
      registration.addEventListener('updatefound', this.onUpdateFound);
      await this.syncWaiting();
      void this.autoCheck();
    } catch {
      // 注册失败（如离线首访）不打扰使用；在线后 visibility/online 会重试。
    }
  }

  /** 手动「检查更新」：区分已是最新 / 离线 / 检查失败 / 发现新版本。 */
  async checkForUpdate(manual: boolean): Promise<void> {
    if (!this.state.supported || this.activating) return;
    if (manual) this.setState({ checking: true, checkResult: 'checking' });

    let fetchOk = false;
    let payload: VersionPayload | null = null;
    try {
      const response = await fetch('./version.json', { cache: 'no-store' });
      fetchOk = response.ok;
      if (response.ok) payload = parseVersionPayload(await response.json());
    } catch {
      fetchOk = false;
    }

    const outcome = mapManualCheck({
      fetchOk,
      onLine: typeof navigator !== 'undefined' ? navigator.onLine : true,
      payload,
      currentBuildId: getCurrentBuildId(),
    });

    if (outcome === 'found') {
      if (manual) this.setState({ checkResult: 'found' });
      try {
        const prepared = await this.prepareUpdate(60_000);
        await this.syncWaiting();
        if (manual) {
          this.setState({
            checking: false,
            checkResult: prepared ? 'found' : 'download-failed',
          });
        }
      } catch (reason) {
        await this.syncWaiting();
        const message = reason instanceof Error ? reason.message : '';
        if (manual) {
          this.setState({
            checking: false,
            checkResult: message === 'timeout' ? 'timeout' : message === 'offline' ? 'offline' : 'download-failed',
          });
        }
      }
      return;
    }

    if (manual) this.setState({ checking: false, checkResult: outcome });
    else if (outcome === 'offline' || outcome === 'error') {
      // 静默路径不打扰：下次回到前台再试。
    }
  }

  dismiss(): void {
    if (!this.state.waiting) return;
    rememberDismissed(this.state.waitingBuildId);
    this.setState({ dismissed: true });
  }

  /** 用户确认更新：先安全检查，再显式激活 waiting worker，由 controllerchange 触发一次刷新。 */
  async accept(): Promise<void> {
    if (!this.state.supported || this.activating) return;

    const block = getUpdateBlockMessage();
    if (block) {
      this.notify(block, 'error');
      return;
    }

    const registration = this.registration;
    if (!registration) {
      this.notify(NOT_READY_MESSAGE, 'error');
      return;
    }

    // 从异步流程起点即占用：重复点击不会并发发起第二次激活请求。
    this.activating = true;
    this.setState({ activating: true });

    try {
      const waiting = await this.resolveWaiting(registration);

      // 无法确认其他标签页时视为不安全，绝不按 0 个标签页放行。
      const others = await this.countOtherTabs();
      if (others === null) throw new AcceptanceBlocked(UNKNOWN_TABS_MESSAGE);
      if (others > 0) throw new AcceptanceBlocked(OTHER_TABS_MESSAGE);

      // 异步查询期间页面状态可能变化：激活前重新校验本地阻塞项与目标 worker。
      const changedBlock = getUpdateBlockMessage();
      if (changedBlock) throw new AcceptanceBlocked(changedBlock);
      if (registration.waiting !== waiting) throw new AcceptanceBlocked(WAITING_CHANGED_MESSAGE);

      this.expectingReload = true;
      // 成功路径：controllerchange 监听器负责刷新一次。
      await this.activateWaiting(waiting);
    } catch (reason) {
      this.expectingReload = false;
      this.activating = false;
      this.setState({ activating: false });
      await this.safeSyncWaiting();
      this.notify(
        reason instanceof AcceptanceBlocked ? reason.message : ACTIVATION_FAILED_MESSAGE,
        'error',
      );
    }
  }

  // ---- 内部实现 ----

  /** 取本次要激活的 waiting worker；没有则抛错（状态已复位，可稍后重试）。 */
  private async resolveWaiting(registration: ServiceWorkerRegistration): Promise<ServiceWorker> {
    let waiting = registration.waiting;
    if (!waiting) {
      await this.syncWaiting();
      waiting = registration.waiting;
    }
    if (!waiting) throw new AcceptanceBlocked(NOT_READY_MESSAGE);
    return waiting;
  }

  private async safeSyncWaiting(): Promise<void> {
    try {
      await this.syncWaiting();
    } catch {
      // 刷新 waiting 信息失败不影响已复位的中止状态。
    }
  }

  private async autoCheck(): Promise<void> {
    this.lastAutoCheck = Date.now();
    const registration = this.registration;
    if (!registration) return;
    try {
      await registration.update();
    } catch {
      // 静默：离线或网络失败不弹错。
    }
    await this.syncWaiting();
  }

  private maybeAutoCheck(): void {
    if (!this.state.supported || this.activating) return;
    if (Date.now() - this.lastAutoCheck < 5 * 60_000) return;
    void this.autoCheck();
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.maybeAutoCheck();
  };

  private onOnline = (): void => {
    this.maybeAutoCheck();
  };

  private onUpdateFound = (): void => {
    const registration = this.registration;
    const worker = registration?.installing;
    if (!registration || !worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') {
        // 有 controller 说明是更新（首次安装不提示）。
        if (navigator.serviceWorker.controller) void this.syncWaiting();
      } else if (worker.state === 'redundant' && !registration.waiting) {
        void this.syncWaiting();
      }
    });
  };

  private onControllerChange = (): void => {
    if (this.expectingReload) {
      if (this.reloaded) return;
      this.reloaded = true;
      window.location.reload();
      return;
    }
    if (!this.hadController) {
      // 首次安装 claim 接管：不是更新，不提示不刷新。
      this.hadController = true;
      return;
    }
    void this.syncWaiting();
    if (!this.otherTabNotified) {
      this.otherTabNotified = true;
      this.notify('应用已在其他页面完成更新；保存当前工作后可手动刷新。', 'info');
    }
  };

  /** 读取当前 waiting worker 的构建身份，并按构建决定是否仍抑制通知。 */
  private async syncWaiting(): Promise<void> {
    if (this.waitingSetup) return this.waitingSetup;
    this.waitingSetup = (async () => {
      const registration = this.registration;
      const waiting = registration?.waiting ?? null;
      if (!waiting || !navigator.serviceWorker.controller) {
        this.setState({
          waiting: false,
          waitingBuildId: null,
          waitingLabel: null,
          dismissed: false,
          activating: this.activating,
        });
        return;
      }
      const info = await askWorker<{ buildId?: string; label?: string }>(
        waiting,
        { type: 'daigan:version' },
        2000,
      );
      const buildId = info?.buildId ?? null;
      this.setState({
        waiting: true,
        waitingBuildId: buildId,
        waitingLabel: info?.label ?? null,
        dismissed: isDismissed(buildId),
        activating: this.activating,
      });
    })();
    try {
      await this.waitingSetup;
    } finally {
      this.waitingSetup = null;
    }
  }

  /** 等待新版本完成「下载 + 校验并停在 waiting」；失败/超时可重试。 */
  private async prepareUpdate(timeoutMs: number): Promise<boolean> {
    let registration = this.registration;
    if (!registration) {
      registration = await navigator.serviceWorker.register('./sw.js', {
        scope: './',
        updateViaCache: 'none',
      });
      this.registration = registration;
      registration.addEventListener('updatefound', this.onUpdateFound);
    }
    try {
      await registration.update();
    } catch {
      throw new Error(navigator.onLine ? 'download-failed' : 'offline');
    }
    return this.waitForWaiting(timeoutMs);
  }

  private waitForWaiting(timeoutMs: number): Promise<boolean> {
    const registration = this.registration;
    if (!registration) return Promise.resolve(false);
    if (registration.waiting && navigator.serviceWorker.controller) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        for (const cleanup of cleanups) cleanup();
        fn();
      };
      const timer = window.setTimeout(
        () => finish(() => reject(new Error('timeout'))),
        timeoutMs,
      );

      const inspectWorker = (worker: ServiceWorker) => {
        const onState = () => {
          if (worker.state === 'installed') {
            finish(() => resolve(true));
          } else if (worker.state === 'redundant') {
            if (registration.waiting) finish(() => resolve(true));
            else finish(() => resolve(false));
          }
        };
        worker.addEventListener('statechange', onState);
        cleanups.push(() => worker.removeEventListener('statechange', onState));
        if (worker.state === 'installed' || worker.state === 'redundant') onState();
      };

      const onUpdateFound = () => {
        const worker = registration.installing;
        if (worker) inspectWorker(worker);
      };
      registration.addEventListener('updatefound', onUpdateFound);
      cleanups.push(() => registration.removeEventListener('updatefound', onUpdateFound));
      if (registration.installing) inspectWorker(registration.installing);
    });
  }

  /**
   * 统计同 scope 的其他应用标签页。
   * 返回 null 表示「无法确认」（超时 / 无可用 worker / 通信错误 / 响应非法），
   * 调用方必须拒绝激活，而不是当作 0 个标签页。
   */
  private countOtherTabs(): Promise<number | null> {
    const target = this.registration?.active ?? navigator.serviceWorker.controller;
    if (!target || typeof MessageChannel === 'undefined') return Promise.resolve(null);
    const timeoutMs = this.tabQueryTimeoutMs;
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        channel.port1.close();
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(null), timeoutMs);
      channel.port1.onmessage = (event: MessageEvent) => finish(parseOtherTabsResponse(event.data));
      try {
        target.postMessage({ type: 'daigan:list-clients', requestId: Date.now() }, [channel.port2]);
      } catch {
        finish(null);
      }
    });
  }

  /** 向 waiting worker 发激活请求，等待 controller 交接；失败/超时抛错以便重试。 */
  private activateWaiting(worker: ServiceWorker): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        for (const cleanup of cleanups) cleanup();
        fn();
      };
      const timer = window.setTimeout(
        () => finish(() => reject(new Error('timeout'))),
        20_000,
      );

      const onControllerChange = () => finish(() => resolve());
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      cleanups.push(() =>
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange),
      );

      const onState = () => {
        if (worker.state === 'redundant') {
          // 被更新的构建取代或安装损坏：放弃本次激活，允许重试。
          finish(() => reject(new Error('redundant')));
        }
      };
      worker.addEventListener('statechange', onState);
      cleanups.push(() => worker.removeEventListener('statechange', onState));

      void askWorker<{ ok?: boolean }>(worker, { type: 'daigan:skip-waiting' }, 3000).then(
        (ack) => {
          if (settled) return;
          if (!ack || ack.ok === false) {
            finish(() => reject(new Error('no-ack')));
          }
        },
      );
    });
  }
}

export const updateManager = new UpdateManager();
