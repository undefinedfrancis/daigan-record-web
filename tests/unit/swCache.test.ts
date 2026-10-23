import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * 隔离的 Service Worker 测试：把 src/pwa/sw.js 模板替换占位符后在 vm 沙箱里执行，
 * 只驱动 install / activate 事件，验证缓存清理的部署范围与安装失败的清理边界。
 */

const SOURCE = readFileSync(path.resolve(process.cwd(), 'src/pwa/sw.js'), 'utf8');
const SCOPE = 'https://daigan.test/app/';
const BUILD = 'testbuild';

type CacheEntries = Map<string, string>;

interface Harness {
  context: vm.Context;
  cacheName: string;
  scopePrefix: string;
  deleted: string[];
  store: Map<string, CacheEntries>;
  install: () => Promise<void>;
  activate: () => Promise<void>;
}

function render(manifest: string[] = ['index.html', 'assets/app.js']): string {
  return SOURCE.split('__BUILD_ID__')
    .join(BUILD)
    .split('__APP_VERSION__')
    .join('1.0.0')
    .split('__BUILD_LABEL__')
    .join('')
    .split('__PRECACHE_MANIFEST__')
    .join(JSON.stringify(manifest));
}

function createHarness(options: { seed?: Record<string, string[]>; breakUrl?: string } = {}): Harness {
  const store = new Map<string, CacheEntries>();
  for (const [name, urls] of Object.entries(options.seed ?? {})) {
    store.set(name, new Map(urls.map((url) => [url, `${name}:${url}`])));
  }

  const deleted: string[] = [];
  const caches = {
    async keys(): Promise<string[]> {
      return [...store.keys()];
    },
    async open(name: string) {
      if (!store.has(name)) store.set(name, new Map());
      const entries = store.get(name) as CacheEntries;
      return {
        async keys() {
          return [...entries.keys()].map((url) => ({ url }));
        },
        async match(url: string) {
          const body = entries.get(String(url));
          return body === undefined ? undefined : new Response(body);
        },
        async put(url: string, response: Response | string) {
          entries.set(String(url), typeof response === 'string' ? response : String(response));
        },
      };
    },
    async delete(name: string): Promise<boolean> {
      deleted.push(name);
      return store.delete(name);
    },
  };

  const fetchStub = async (input: string) => {
    if (options.breakUrl && String(input).includes(options.breakUrl)) {
      return new Response('missing', { status: 404 });
    }
    return new Response(`body:${input}`, { status: 200 });
  };

  const handlers = new Map<string, (event: unknown) => void>();
  const self = {
    registration: { scope: SCOPE },
    location: { origin: 'https://daigan.test' },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
    },
    skipWaiting: () => undefined,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers.set(type, handler);
    },
  };

  const context = vm.createContext({ self, caches, fetch: fetchStub, Response, URL });
  vm.runInContext(render(), context, { filename: 'sw.js' });

  const run = (type: string): Promise<void> => {
    const handler = handlers.get(type);
    if (!handler) throw new Error(`缺少 ${type} 事件处理器`);
    let pending: Promise<void> = Promise.resolve();
    const event = {
      waitUntil: (promise: Promise<void>) => {
        pending = promise;
      },
    };
    handler(event);
    return pending;
  };

  return {
    context,
    cacheName: vm.runInContext('CACHE_NAME', context) as string,
    scopePrefix: vm.runInContext('SCOPE_PREFIX', context) as string,
    deleted,
    store,
    install: () => run('install'),
    activate: () => run('activate'),
  };
}

describe('Service Worker 缓存清理范围', () => {
  it('当前构建缓存保留，同 scope 旧缓存删除，其他 scope 与无关缓存保留', async () => {
    const harness = createHarness({ seed: {} });
    const current = harness.cacheName;
    const older = `${harness.scopePrefix}olderbuild`;
    // 大写与下划线不属于 base36 hash，确保它确实属于另一个部署 scope。
    const otherScope = 'daigan-pwa-OTHER_SCOPE_abc-b1';
    const unrelated = 'unrelated-cache';

    // 先算好当前构建缓存名，再按真实初始状态重建沙箱。
    const seeded = createHarness({
      seed: {
        [current]: [`${SCOPE}index.html`],
        [older]: [`${SCOPE}index.html`],
        [otherScope]: ['https://daigan.test/other/index.html'],
        [unrelated]: ['https://daigan.test/x'],
      },
    });
    await seeded.activate();

    expect(seeded.cacheName).toBe(current);
    expect(seeded.store.has(current)).toBe(true);
    expect(seeded.store.has(older)).toBe(false);
    expect(seeded.store.has(otherScope)).toBe(true);
    expect(seeded.store.has(unrelated)).toBe(true);
    expect(seeded.deleted).toEqual([older]);
  });

  it('旧版固定缓存仅在条目归属本 scope 时清理，归属不明时保留', async () => {
    const current = createHarness().cacheName;
    const seeded = createHarness({
      seed: {
        [current]: [`${SCOPE}index.html`],
        'daigan-shell-v1': [`${SCOPE}index.html`],
        'daigan-shell-v1-other': [],
      },
    });
    await seeded.activate();
    // 归属本 scope 的旧缓存被清理。
    expect(seeded.store.has('daigan-shell-v1')).toBe(false);

    const foreignCurrent = createHarness().cacheName;
    const foreign = createHarness({
      seed: {
        [foreignCurrent]: [`${SCOPE}index.html`],
        'daigan-shell-v1': ['https://daigan.test/another-app/index.html'],
      },
    });
    await foreign.activate();
    // 名字相同但条目属于别的部署：无法确认归属，保留。
    expect(foreign.store.has('daigan-shell-v1')).toBe(true);
  });

  it('安装失败只删除本次候选缓存，上一构建缓存保留', async () => {
    const harness = createHarness({
      breakUrl: 'assets/app.js',
      seed: {
        [`${createHarness().scopePrefix}previousbuild`]: [`${SCOPE}index.html`],
        'unrelated-cache': ['https://daigan.test/x'],
      },
    });
    const previous = `${harness.scopePrefix}previousbuild`;

    await expect(harness.install()).rejects.toThrow();
    expect(harness.deleted).toEqual([harness.cacheName]);
    expect(harness.store.has(harness.cacheName)).toBe(false);
    expect(harness.store.has(previous)).toBe(true);
    expect(harness.store.has('unrelated-cache')).toBe(true);
  });
});
