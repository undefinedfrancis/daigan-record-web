import { useState } from 'react';
import { Button, TextInput } from './ui';
import { IconPlus, IconTrash } from './icons';

/**
 * 每月日号编辑器：每个日号一个独立文本框，可逐个增删。
 * 提交值为升序去重的日号串（如 "1,15"）；空值与非法值不提交，仅保留在输入框里。
 */
export function MonthDayInputs({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (monthDays: string | null, monthDay: number | null) => void;
}) {
  const [inputs, setInputs] = useState<string[]>(() =>
    value && value.trim()
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '')
      : [''],
  );

  function commit(next: string[]): void {
    setInputs(next);
    const days = next
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item >= 1 && item <= 31);
    const unique = [...new Set(days)].sort((left, right) => left - right);
    onChange(unique.length > 0 ? unique.join(',') : null, unique.length > 0 ? unique[0] : null);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {inputs.map((item, index) => (
        <span key={index} className="flex items-center gap-1">
          <TextInput
            value={item}
            inputMode="numeric"
            placeholder="日号"
            aria-label={`每月日号 ${index + 1}`}
            className="w-16"
            maxLength={2}
            onChange={(event) => {
              const next = [...inputs];
              next[index] = event.target.value;
              commit(next);
            }}
          />
          <Button
            variant="ghost"
            aria-label={`删除每月日号 ${index + 1}`}
            style={{ minHeight: 26, minWidth: 26, padding: '0 4px' }}
            onClick={() => commit(inputs.filter((_, position) => position !== index))}
          >
            <IconTrash size={14} />
          </Button>
        </span>
      ))}
      <Button variant="ghost" onClick={() => commit([...inputs, ''])}>
        <IconPlus size={14} /> 添加日号
      </Button>
    </div>
  );
}
