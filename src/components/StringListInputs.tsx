import { useState } from 'react';
import { Button, TextInput } from './ui';
import { IconPlus, IconTrash } from './icons';

/**
 * 独立文本框列表编辑器：每项一个独立文本框，可逐个增删（与 MonthDayInputs 同一交互）。
 * 空行保留在输入框里但不提交；提交值为去空去重的字符串数组。
 */
export function StringListInputs({
  value,
  onChange,
  placeholder,
  itemLabel,
  addLabel = '添加一项',
  max = 50,
}: {
  value: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  itemLabel: string;
  addLabel?: string;
  max?: number;
}) {
  const [inputs, setInputs] = useState<string[]>(() => (value.length > 0 ? [...value] : ['']));

  function commit(next: string[]): void {
    setInputs(next);
    const seen = new Set<string>();
    const items: string[] = [];
    for (const raw of next) {
      const item = raw.trim();
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item.slice(0, 60));
      if (items.length >= max) break;
    }
    onChange(items);
  }

  return (
    <div className="flex flex-col gap-2">
      {inputs.map((item, index) => (
        <span key={index} className="flex items-center gap-1">
          <TextInput
            value={item}
            placeholder={placeholder}
            aria-label={`${itemLabel} ${index + 1}`}
            className="w-40"
            maxLength={60}
            onChange={(event) => {
              const next = [...inputs];
              next[index] = event.target.value;
              commit(next);
            }}
          />
          <Button
            variant="ghost"
            aria-label={`删除${itemLabel} ${index + 1}`}
            style={{ minHeight: 26, minWidth: 26, padding: '0 4px' }}
            onClick={() => commit(inputs.filter((_, position) => position !== index))}
          >
            <IconTrash size={14} />
          </Button>
        </span>
      ))}
      <div>
        <Button variant="ghost" onClick={() => commit([...inputs, ''])}>
          <IconPlus size={14} /> {addLabel}
        </Button>
      </div>
    </div>
  );
}
