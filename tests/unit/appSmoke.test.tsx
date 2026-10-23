import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import Dexie from 'dexie';
import { Root } from '../../src/app/Root';
import { resetControlDb } from '../../src/storage/controlDb';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(check: () => boolean, timeout = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待超时');
}

describe('应用启动', () => {
  let root: ReactRoot | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
    resetControlDb();
    await Dexie.delete('daigan-control');
    const names = await Dexie.getDatabaseNames();
    for (const name of names) {
      if (name.startsWith('daigan-data-')) await Dexie.delete(name);
    }
  });

  it('空账本启动后渲染今日事项与四个导航入口', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(<Root />);

    await waitFor(() => (container?.textContent ?? '').includes('今日事项'));
    const text = container.textContent ?? '';
    expect(text).toContain('今日事项');
    expect(text).toContain('老板与账号');
    expect(text).toContain('订单');
    expect(text).toContain('收款与统计');
    expect(text).not.toContain('更多');
    expect(text).not.toContain('无法打开本机资料');
  }, 20000);
});
