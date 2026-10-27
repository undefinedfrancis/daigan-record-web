import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { moveKey } from '../domain/taskOrder';

/**
 * 轻量拖拽排序列表（零依赖，Pointer Events）。
 *
 * 为什么不用 HTML5 `draggable`：今日事项主要在手机上用，原生 drag 在触屏上不触发；
 * 也不引第三方库（项目至今没有 UI/动画依赖）。
 *
 * 交互：
 * - 手柄按住上下拖动（`touch-action: none`，不会带着页面滚）；
 * - 手柄聚焦时 ↑ / ↓ 键移动，页面里另有显式上移/下移按钮（键盘与误触兜底）；
 * - 松手才提交（一次 `onReorder`），拖动过程中只做本地预览。
 */

export interface SortableItemControl {
  key: string;
  /** 预览顺序里的位置（拖动时就已更新）。 */
  index: number;
  total: number;
  dragging: boolean;
  handleProps: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
    'data-sortable-handle': string;
    'aria-label': string;
    title: string;
  };
  /** 必须展开到该条目的 `<li>` 上：拖动时用它量取行高与中点。 */
  itemProps: { 'data-sortable-item': string };
  moveUp: () => void;
  moveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

interface DragState {
  from: number;
  keys: string[];
  /** 每个条目中线（视口坐标），拖动时按指针位置算落点。 */
  mids: number[];
  pointerId: number;
}

export function SortableList<T>({
  items,
  keyOf,
  labelOf,
  onReorder,
  renderItem,
  disabled = false,
  testId,
  listClassName = '',
}: {
  items: T[];
  keyOf: (item: T) => string;
  /** 无障碍播报用的名字（「体力」已移到第 2 位）。 */
  labelOf: (item: T) => string;
  onReorder: (orderedKeys: string[]) => void;
  renderItem: (item: T, control: SortableItemControl) => ReactNode;
  disabled?: boolean;
  testId?: string;
  /** 追加到 `<ul>` 的布局类（间距由调用方决定）。 */
  listClassName?: string;
}) {
  const keys = items.map(keyOf);
  const signature = keys.join('\u0000');
  const listRef = useRef<HTMLUListElement | null>(null);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const labelRef = useRef(labelOf);
  labelRef.current = labelOf;
  // 每次渲染重建映射：条目内容会随查询刷新变化（勾选、数值），键相同不代表对象相同，
  // 缓存映射会让排序行显示过期数据。
  const byKey = new Map(items.map((item) => [keyOf(item), item]));
  const [preview, setPreview] = useState<string[] | null>(null);
  const previewRef = useRef<string[] | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [announce, setAnnounce] = useState('');

  // 数据变了（刷新、筛选、删条目）就丢弃预览：绝不渲染已经不存在的键。
  useEffect(() => {
    previewRef.current = null;
    setPreview(null);
    dragRef.current = null;
    setDragKey(null);
  }, [signature]);

  const orderedKeys =
    preview && preview.length === keys.length && preview.every((key) => byKey.has(key))
      ? preview
      : keys;

  function applyPreview(next: string[] | null) {
    previewRef.current = next;
    setPreview(next);
  }

  function commit(nextKeys: string[], movedKey: string) {
    const moved = byKey.get(movedKey);
    const position = nextKeys.indexOf(movedKey) + 1;
    if (moved) setAnnounce(`「${labelRef.current(moved)}」已移到第 ${position} 位`);
    onReorderRef.current(nextKeys);
  }

  function moveBy(index: number, delta: number) {
    if (disabled || items.length < 2) return;
    const target = index + delta;
    if (target < 0 || target >= keys.length) return;
    commit(moveKey(keys, index, target), keys[index]);
  }

  function startDrag(event: React.PointerEvent<HTMLElement>, index: number) {
    if (disabled || items.length < 2) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const elements = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-sortable-item]') ?? [],
    );
    if (elements.length !== keysRef.current.length) return;
    dragRef.current = {
      from: index,
      keys: [...keysRef.current],
      mids: elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top + rect.height / 2;
      }),
      pointerId: event.pointerId,
    };
    setDragKey(keysRef.current[index] ?? null);
    applyPreview([...keysRef.current]);
  }

  useEffect(() => {
    if (dragKey === null) return;

    const handleMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      let target = drag.mids.length - 1;
      for (let index = 0; index < drag.mids.length; index += 1) {
        if (event.clientY < drag.mids[index]) {
          target = index;
          break;
        }
      }
      applyPreview(moveKey(drag.keys, drag.from, target));
    };

    const finish = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const moved = previewRef.current;
      dragRef.current = null;
      setDragKey(null);
      applyPreview(null);
      const before = drag.keys.join('\u0000');
      if (moved && moved.join('\u0000') !== before) {
        commit(moved, drag.keys[drag.from] ?? '');
      }
    };

    const cancel = () => {
      dragRef.current = null;
      setDragKey(null);
      applyPreview(null);
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', handleKey);
    };
    // commit/applyPreview 通过 ref 读取最新值，effect 只在拖拽开关时重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragKey]);

  return (
    <div>
      <ul ref={listRef} data-sortable-list={testId} className={`flex flex-col ${listClassName}`}>
        {orderedKeys.map((key, index) => {
          const item = byKey.get(key) as T;
          const control: SortableItemControl = {
            key,
            index,
            total: orderedKeys.length,
            dragging: dragKey === key,
            handleProps: {
              onPointerDown: (event) => startDrag(event, index),
              onKeyDown: (event) => {
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  moveBy(index, -1);
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  moveBy(index, 1);
                }
              },
              'data-sortable-handle': key,
              'aria-label': `拖动排序：${labelOf(item)}（当前第 ${index + 1} 位，共 ${orderedKeys.length} 位）`,
              title: '按住上下拖动排序',
            },
            itemProps: { 'data-sortable-item': key },
            moveUp: () => moveBy(index, -1),
            moveDown: () => moveBy(index, 1),
            canMoveUp: index > 0 && !disabled,
            canMoveDown: index < orderedKeys.length - 1 && !disabled,
          };
          return <Fragment key={key}>{renderItem(item, control)}</Fragment>;
        })}
      </ul>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
