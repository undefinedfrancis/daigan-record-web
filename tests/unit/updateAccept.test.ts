import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OTHER_TABS_MESSAGE,
  UNKNOWN_TABS_MESSAGE,
  UpdateManager,
  WAITING_CHANGED_MESSAGE,
  parseOtherTabsResponse,
} from '../../src/pwa/updateManager';
import { clearUpdateBlocker, setUpdateBlocker } from '../../src/pwa/updateSafety';

/**
 * 「接受更新」的安全门禁：其他标签页查询失败 / 响应非法 / 查询期间出现阻塞项
 * 都必须阻止激活并复位状态；重复点击不得发起第二次激活请求。
 */

type Responder = (message: Record<string, unknown>, ports: MessagePort[]) => void;

class FakeWorker {
  received: Array<Record<string, unknown>> = [];
  responder: Responder | null = null;

  postMessage = (message: Record<string, unknown>, ports?: MessagePort[]): void => {
    this.received.push(message);
    this.responder?.(message, ports ?? []);
  };

  addEventListener(): void {
    // 本测试不驱动 statechange / updatefound。
  }

  removeEventListener(): void {
    // 同上。
  }

  countOf(type: string): number {
    return this.received.filter((message) => message.type === type).length;
  }
}

interface Harness {
  manager: UpdateManager;
  active: FakeWorker;
  waiting: FakeWorker;
  registration: { waiting: FakeWorker; active: FakeWorker };
  notes: Array<{ message: string; tone: string }>;
  /** 默认不自动回复的 list-clients 端口，由用例决定何时/如何回复。 */
  tabQueries: MessagePort[];
}

function createHarness(tabQueryTimeoutMs = 300): Harness {
  const active = new FakeWorker();
  const waiting = new FakeWorker();
  waiting.responder = (message, ports) => {
    if (message.type === 'daigan:version') {
      ports[0]?.postMessage({ buildId: 'build-next', label: 'B' });
    }
  };

  const registration = {
    waiting,
    active,
    installing: null,
    update: async () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  // 默认挂起（不回复），用于制造超时与「查询进行中」的窗口。
  const tabQueries: MessagePort[] = [];
  active.responder = (message, ports) => {
    if (message.type === 'daigan:list-clients') tabQueries.push(ports[0] as MessagePort);
  };

  const container = {
    controller: active,
    register: async () => registration,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  });

  const manager = new UpdateManager({ tabQueryTimeoutMs, supported: true });
  const notes: Array<{ message: string; tone: string }> = [];
  manager.setNotifier((message, tone) => notes.push({ message, tone }));
  return { manager, active, waiting, registration, notes, tabQueries };
}

/** 让 worker 立即回报指定数量（或非法载荷）。 */
function replyCount(harness: Harness, payload: Record<string, unknown>): void {
  harness.active.responder = (message, ports) => {
    if (message.type === 'daigan:list-clients') ports[0]?.postMessage(payload);
  };
}

async function start(harness: Harness): Promise<void> {
  const pending = harness.manager.ensureStarted();
  if (document.readyState !== 'complete') window.dispatchEvent(new Event('load'));
  await pending;
  await vi.waitFor(() => expect(harness.manager.getState().waiting).toBe(true));
}

describe('其他标签页数量校验', () => {
  it('只接受非负整数，其余视为无法确认', () => {
    expect(parseOtherTabsResponse({ count: 0 })).toBe(0);
    expect(parseOtherTabsResponse({ count: 3 })).toBe(3);
    expect(parseOtherTabsResponse({ count: -1 })).toBeNull();
    expect(parseOtherTabsResponse({ count: 1.5 })).toBeNull();
    expect(parseOtherTabsResponse({ count: '2' })).toBeNull();
    expect(parseOtherTabsResponse({ count: Number.NaN })).toBeNull();
    expect(parseOtherTabsResponse({ count: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseOtherTabsResponse({})).toBeNull();
    expect(parseOtherTabsResponse(null)).toBeNull();
  });
});

describe('接受更新的安全门禁', () => {
  let harness: Harness;

  afterEach(() => {
    clearUpdateBlocker('test-blocker');
    // @ts-expect-error 清理注入的假 serviceWorker
    delete navigator.serviceWorker;
  });

  it('标签页查询超时阻止激活并允许重试', async () => {
    harness = createHarness(40);
    await start(harness);
    expect(harness.manager.getState().supported).toBe(true);

    // 不回复：查询超时 => 无法确认，绝不按 0 个标签页放行。
    await harness.manager.accept();
    expect(harness.notes.at(-1)?.message).toBe(UNKNOWN_TABS_MESSAGE);
    expect(harness.waiting.countOf('daigan:skip-waiting')).toBe(0);
    expect(harness.manager.getState().activating).toBe(false);

    // 重试：重新发起查询，拿到明确结论后按结论处理。
    replyCount(harness, { count: 1 });
    await harness.manager.accept();
    expect(harness.active.countOf('daigan:list-clients')).toBe(2);
    expect(harness.notes.at(-1)?.message).toBe(OTHER_TABS_MESSAGE);
    expect(harness.waiting.countOf('daigan:skip-waiting')).toBe(0);
    expect(harness.manager.getState().activating).toBe(false);
  });

  it('通信错误阻止激活', async () => {
    harness = createHarness();
    await start(harness);
    harness.active.postMessage = () => {
      throw new Error('channel closed');
    };
    await harness.manager.accept();
    expect(harness.notes.at(-1)?.message).toBe(UNKNOWN_TABS_MESSAGE);
    expect(harness.waiting.countOf('daigan:skip-waiting')).toBe(0);
    expect(harness.manager.getState().activating).toBe(false);
  });

  it('非法数量响应阻止激活', async () => {
    harness = createHarness();
    await start(harness);
    replyCount(harness, { count: '0' });
    await harness.manager.accept();
    expect(harness.notes.at(-1)?.message).toBe(UNKNOWN_TABS_MESSAGE);
    expect(harness.waiting.countOf('daigan:skip-waiting')).toBe(0);
    expect(harness.manager.getState().activating).toBe(false);
  });

  it('确认有其他标签页时阻止激活并复位状态', async () => {
    harness = createHarness();
    await start(harness);
    replyCount(harness, { count: 2 });
    await harness.manager.accept();
    expect(harness.notes.at(-1)?.message).toBe(OTHER_TABS_MESSAGE);
    expect(harness.waiting.countOf('daigan:skip-waiting')).toBe(0);
    expect(harness.manager.getState().activating).toBe(false);

    // 重试会重新查询（关闭其他标签页后即可继续）。
    replyCount(harness, { count: 1 });
    await harness.manager.accept();
    expect(harness.active.countOf('daigan:list-clients')).toBe(2);
    expect(harness.notes.at(-1)?.message).toBe(OTHER_TABS_MESSAGE);
  });

  it('查询期间出现的未保存编辑阻止激活', async () => {
    harness = createHarness();
    await start(harness);
    harness.active.responder = (message, ports) => {
      if (message.type === 'daigan:list-clients') {
        window.setTimeout(() => ports[0]?.postMessage({ count: 0 }), 10);
      }
    };

    const pending = harness.manager.accept();
    // 异步查询尚未返回时出现未保存编辑。
    setUpdateBlocker('test-blocker', 'dirty');
    await pending;

    expect(harness.notes.at(-1)?.message).toContain('请先保存');
    expect(harness.waiting.countOf('daigan:skip-waiting')).toBe(0);
    expect(harness.manager.getState().activating).toBe(false);

    // 解除阻塞后可重试：本次查询报告有其他标签页，仍会被拦下并复位。
    clearUpdateBlocker('test-blocker');
    replyCount(harness, { count: 1 });
    await harness.manager.accept();
    expect(harness.notes.at(-1)?.message).toBe(OTHER_TABS_MESSAGE);
    expect(harness.manager.getState().activating).toBe(false);
  });

  it('waiting worker 在查询期间被替换时安全中止', async () => {
    harness = createHarness();
    await start(harness);
    harness.active.responder = (message, ports) => {
      if (message.type === 'daigan:list-clients') {
        window.setTimeout(() => ports[0]?.postMessage({ count: 0 }), 10);
      }
    };

    const pending = harness.manager.accept();
    const replacement = new FakeWorker();
    replacement.responder = (message, ports) => {
      if (message.type === 'daigan:version') ports[0]?.postMessage({ buildId: 'build-later' });
    };
    harness.registration.waiting = replacement;
    await pending;

    expect(harness.notes.at(-1)?.message).toBe(WAITING_CHANGED_MESSAGE);
    expect(harness.waiting.countOf('daigan:skip-waiting')).toBe(0);
    expect(replacement.countOf('daigan:skip-waiting')).toBe(0);
    expect(harness.manager.getState().activating).toBe(false);
  });

  it('重复点击不发起第二次激活请求', async () => {
    harness = createHarness();
    await start(harness);

    // 第一次点击后查询挂起，此时再点两次。
    const first = harness.manager.accept();
    const second = harness.manager.accept();
    const third = harness.manager.accept();
    expect(harness.manager.getState().activating).toBe(true);
    await vi.waitFor(() => expect(harness.tabQueries.length).toBe(1));

    harness.tabQueries[0].postMessage({ count: 1 });
    await Promise.all([first, second, third]);
    expect(harness.active.countOf('daigan:list-clients')).toBe(1);
    expect(harness.notes.filter((note) => note.message === OTHER_TABS_MESSAGE)).toHaveLength(1);
    expect(harness.waiting.countOf('daigan:skip-waiting')).toBe(0);
    expect(harness.manager.getState().activating).toBe(false);

    // 状态复位后允许显式重试。
    const retry = harness.manager.accept();
    await vi.waitFor(() => expect(harness.tabQueries.length).toBe(2));
    harness.tabQueries[1].postMessage({ count: 1 });
    await retry;
    expect(harness.active.countOf('daigan:list-clients')).toBe(2);
    expect(harness.notes.filter((note) => note.message === OTHER_TABS_MESSAGE)).toHaveLength(2);
  });
});
