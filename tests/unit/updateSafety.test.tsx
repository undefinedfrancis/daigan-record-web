import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  beginOperation,
  clearUpdateBlocker,
  getUpdateBlockMessage,
  getUpdateBlockers,
  setUpdateBlocker,
  subscribeUpdateBlockers,
  useUpdateBlocker,
  useFormUpdateGuard,
  BUSY_MESSAGE,
  DIRTY_MESSAGE,
} from '../../src/pwa/updateSafety';

describe('更新安全登记表', () => {
  it('无阻塞项时不阻止更新', () => {
    expect(getUpdateBlockMessage()).toBeNull();
    expect(getUpdateBlockers()).toEqual([]);
  });

  it('beginOperation 登记进行中操作，结束后解除', () => {
    const end = beginOperation('upload');
    expect(getUpdateBlockMessage()).toBe(BUSY_MESSAGE);
    end();
    expect(getUpdateBlockMessage()).toBeNull();
    // 结束函数幂等。
    end();
    expect(getUpdateBlockMessage()).toBeNull();
  });

  it('未保存编辑使用独立提示，busy 优先于 dirty', () => {
    setUpdateBlocker('form', 'dirty');
    expect(getUpdateBlockMessage()).toBe(DIRTY_MESSAGE);
    const end = beginOperation('db-write');
    expect(getUpdateBlockMessage()).toBe(BUSY_MESSAGE);
    end();
    expect(getUpdateBlockMessage()).toBe(DIRTY_MESSAGE);
    clearUpdateBlocker('form');
    expect(getUpdateBlockMessage()).toBeNull();
  });

  it('订阅者在登记变化时收到通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUpdateBlockers(listener);
    const end = beginOperation('op-1');
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    end();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('useUpdateBlocker 在卸载时自动清理', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    function Probe({ active }: { active: boolean }) {
      useUpdateBlocker(active, 'busy');
      return null;
    }
    act(() => {
      root.render(<Probe active />);
    });
    expect(getUpdateBlockMessage()).toBe(BUSY_MESSAGE);
    act(() => {
      root.unmount();
    });
    expect(getUpdateBlockMessage()).toBeNull();
  });

  it('useFormUpdateGuard 叠加 dirty 与 busy 并随关闭解除', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    function Form({ open, busy }: { open: boolean; busy: boolean }) {
      useFormUpdateGuard(open, busy);
      return null;
    }
    act(() => {
      root.render(<Form open busy />);
    });
    expect(getUpdateBlockMessage()).toBe(BUSY_MESSAGE);
    act(() => {
      root.render(<Form open busy={false} />);
    });
    expect(getUpdateBlockMessage()).toBe(DIRTY_MESSAGE);
    act(() => {
      root.render(<Form open={false} busy={false} />);
    });
    expect(getUpdateBlockMessage()).toBeNull();
    act(() => {
      root.unmount();
    });
  });
});
