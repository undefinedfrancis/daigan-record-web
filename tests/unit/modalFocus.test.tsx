import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, Modal, TextInput } from '../../src/components/ui';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 回归：弹窗内受控输入每敲一个字都会让父组件重渲染。
 * onClose 若以内联箭头函数传入，旧实现（effect 依赖 onClose）会在每次重渲染时
 * 重新执行「保存/恢复焦点」，导致输入框失焦、只能输入第一个字符。
 */

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function Harness() {
  const [open, setOpen] = useState(false);
  const [nickname, setNickname] = useState('');
  return (
    <div>
      <Button onClick={() => setOpen(true)}>新建老板</Button>
      <Modal open={open} title="新建老板" onClose={() => setOpen(false)}>
        <TextInput
          aria-label="昵称"
          value={nickname}
          maxLength={30}
          autoFocus
          onChange={(event) => setNickname(event.target.value)}
        />
      </Modal>
    </div>
  );
}

describe('弹窗内输入框焦点稳定', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it('连续输入时焦点留在输入框，不被打断', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Harness />));

    const trigger = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === '新建老板',
    ) as HTMLButtonElement;
    act(() => trigger.click());

    const input = container.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    typeInto(input, '花');
    expect(input.value).toBe('花');
    expect(document.activeElement).toBe(input);

    typeInto(input, '花生');
    expect(input.value).toBe('花生');
    expect(document.activeElement).toBe(input);
  });

  it('Esc 仍然调用最新的 onClose', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Harness />));

    const trigger = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === '新建老板',
    ) as HTMLButtonElement;
    act(() => {
      trigger.focus();
      trigger.click();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
