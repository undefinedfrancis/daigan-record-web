import { useEffect, useRef, useState } from 'react';

/** UF-019 预设色板。 */
export const COLOR_SWATCHES: { value: string; label: string; hex: string }[] = [
  { value: 'red', label: '红', hex: '#d9645c' },
  { value: 'amber', label: '橙', hex: '#d9943c' },
  { value: 'green', label: '绿', hex: '#6aa84f' },
  { value: 'blue', label: '蓝', hex: '#4a90d9' },
  { value: 'purple', label: '紫', hex: '#9b6bc7' },
  { value: 'gray', label: '灰', hex: '#9a958c' },
];

export function colorHexOf(value: string | null): string | null {
  return COLOR_SWATCHES.find((swatch) => swatch.value === value)?.hex ?? null;
}

/** 单任务颜色标记选择器：点色块选色，再点一次或选「清除」取消。 */
export function ColorTagPicker({
  value,
  onChange,
  size = 12,
  label,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
  size?: number;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const hex = colorHexOf(value);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={`${label} 颜色标记`}
        title={value ? '点击修改颜色标记' : '点击添加颜色标记'}
        onClick={() => setOpen((current) => !current)}
        className="flex items-center justify-center rounded-full border border-line bg-white"
        style={{ width: size + 10, height: size + 10 }}
      >
        <span
          className="rounded-full"
          style={{
            width: size,
            height: size,
            backgroundColor: hex ?? 'transparent',
            border: hex ? 'none' : '1.5px dashed #c9c3b6',
          }}
        />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1 flex flex-wrap items-center gap-1 rounded-xl border border-line bg-white p-1.5 shadow-md">
          {COLOR_SWATCHES.map((swatch) => (
            <button
              key={swatch.value}
              type="button"
              aria-label={swatch.label}
              title={swatch.label}
              className="h-5 w-5 rounded-full border border-line/60"
              style={{ backgroundColor: swatch.hex }}
              onClick={() => {
                onChange(value === swatch.value ? null : swatch.value);
                setOpen(false);
              }}
            />
          ))}
          <button
            type="button"
            className="rounded-full border border-line px-1.5 py-0.5 text-xs text-ink-soft"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            清除
          </button>
        </div>
      ) : null}
    </div>
  );
}
