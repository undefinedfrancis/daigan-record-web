import { Button, Select, TextInput } from '../../components/ui';
import { IconArrowDown, IconArrowUp, IconGrip, IconTrash } from '../../components/icons';
import type { SortableItemControl } from '../../components/SortableList';
import { MonthDayInputs } from '../../components/MonthDayInputs';
import type { TemplateTaskDraft } from '../../application/contracts';
import type { ProgressType, Recurrence } from '../../contracts/tables';
import { RECURRENCE_LABELS } from './orderUtils';

export interface TaskDraftItem extends TemplateTaskDraft {
  key: string;
}

export function newDraftKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 单条任务草稿编辑行（建单与编辑订单共用）。 */
export function TaskDraftRow({
  task,
  onChange,
  onRemove,
  allowOneTime = true,
  sortControl,
}: {
  task: TaskDraftItem;
  onChange: (patch: Partial<TaskDraftItem>) => void;
  onRemove: () => void;
  /** 托管单不允许"一次性"任务（备份契约禁止）；存量脏数据仍保留可见并提示修改。 */
  allowOneTime?: boolean;
  /** 排序控件（拖动 + 上/下移）；提交顺序即 sortOrder，保存后今日事项同步。 */
  sortControl?: SortableItemControl;
}) {
  return (
    <li
      {...(sortControl?.itemProps ?? {})}
      className={`rounded-2xl border bg-white/75 p-3 shadow-[0_1px_0_rgba(48,79,61,0.05)] ${
        sortControl?.dragging ? 'border-sage-deep/50 bg-sage-soft/40' : 'border-line/80'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        {sortControl ? (
          <button
            type="button"
            {...sortControl.handleProps}
            className="flex h-8 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-ink-soft"
            style={{ touchAction: 'none' }}
          >
            <IconGrip size={16} />
          </button>
        ) : null}
        {sortControl ? (
          <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-ink-soft">
            {sortControl.index + 1}
          </span>
        ) : null}
        <TextInput
          value={task.title}
          onChange={(event) => onChange({ title: event.target.value })}
          placeholder="任务标题"
          aria-label="任务标题"
          className="min-w-40 flex-1"
        />
        <Select
          value={task.progressType}
          aria-label="进度类型"
          className="w-28"
          onChange={(event) => {
            const progressType = event.target.value as ProgressType;
            onChange({
              progressType,
              startValue: progressType === 'CHECKBOX' ? '0' : task.startValue,
              targetValue: progressType === 'CHECKBOX' ? '1' : task.targetValue,
            });
          }}
        >
          <option value="CHECKBOX">勾选</option>
          <option value="NUMERIC">数值</option>
        </Select>
        {task.progressType === 'NUMERIC' ? (
          <Select
            value={task.numericMode ?? 'PER_OCCURRENCE'}
            aria-label="数值口径"
            className="w-36"
            onChange={(event) =>
              onChange({
                numericMode: event.target.value === 'CUMULATIVE' ? 'CUMULATIVE' : null,
              })
            }
          >
            <option value="PER_OCCURRENCE">逐次数值</option>
            <option value="CUMULATIVE">累计总值</option>
          </Select>
        ) : null}
        <Select
          value={task.recurrence}
          aria-label="重复周期"
          className="w-32"
          onChange={(event) => {
            const recurrence = event.target.value as Recurrence;
            onChange({
              recurrence,
              weekdays: recurrence === 'SELECTED_WEEKDAYS' ? (task.weekdays ?? '1,3,5') : null,
              everyNDays: recurrence === 'EVERY_N_DAYS' ? (task.everyNDays ?? 2) : null,
              monthDay: recurrence === 'MONTHLY' ? (task.monthDay ?? 1) : null,
            });
          }}
        >
          {Object.entries(RECURRENCE_LABELS)
            .filter(([value]) => allowOneTime || value !== 'ONE_TIME')
            .map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          {!allowOneTime && task.recurrence === 'ONE_TIME' ? (
            <option value="ONE_TIME" disabled>
              一次性（托管单不支持，请改）
            </option>
          ) : null}
        </Select>
        {sortControl ? (
          <>
            <Button
              variant="ghost"
              aria-label="上移任务"
              disabled={!sortControl.canMoveUp}
              onClick={sortControl.moveUp}
            >
              <IconArrowUp size={16} />
            </Button>
            <Button
              variant="ghost"
              aria-label="下移任务"
              disabled={!sortControl.canMoveDown}
              onClick={sortControl.moveDown}
            >
              <IconArrowDown size={16} />
            </Button>
          </>
        ) : null}
        <Button variant="ghost" aria-label="删除任务" onClick={onRemove}>
          <IconTrash size={16} />
        </Button>
      </div>

      <div className="mt-2.5 flex flex-wrap items-end gap-2.5">
        <label className="field w-36">
          <span className="label">任务开始日期（可选）</span>
          <TextInput
            type="date"
            value={task.activeFrom ?? ''}
            onChange={(event) => onChange({ activeFrom: event.target.value || null })}
          />
        </label>
        <label className="field w-36">
          <span className="label">任务结束日期（可选）</span>
          <TextInput
            type="date"
            value={task.activeUntil ?? ''}
            onChange={(event) => onChange({ activeUntil: event.target.value || null })}
          />
        </label>
        {task.progressType === 'NUMERIC' ? (
          <>
            {task.numericMode === 'CUMULATIVE' ? (
              <p className="w-full text-xs text-ink-soft">
                累计目标：每天填写的是<strong>当前累计总值</strong>，不是本次增加量（先填 10、再填 15 结果就是
                15）。达标前每天都能更新，跨日不重置；达标后再更正为更低值会重新打开。
              </p>
            ) : null}
            <label className="field w-24">
              <span className="label">起始</span>
              <TextInput
                value={task.startValue}
                onChange={(event) => onChange({ startValue: event.target.value })}
              />
            </label>
            <label className="field w-24">
              <span className="label">目标</span>
              <TextInput
                value={task.targetValue}
                onChange={(event) => onChange({ targetValue: event.target.value })}
              />
            </label>
            <label className="field w-24">
              <span className="label">单位</span>
              <TextInput
                value={task.unit ?? ''}
                onChange={(event) => onChange({ unit: event.target.value || null })}
              />
            </label>
          </>
        ) : null}
        {task.recurrence === 'SELECTED_WEEKDAYS' ? (
          <div className="field">
            <span className="label">每周执行日</span>
            <div className="flex flex-wrap gap-1">
              {['一', '二', '三', '四', '五', '六', '日'].map((label, index) => {
                const day = index + 1;
                const selected = (task.weekdays ?? '')
                  .split(',')
                  .map((value) => Number(value.trim()))
                  .filter(Boolean);
                const active = selected.includes(day);
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={active}
                    className={`min-w-9 rounded-full border px-2 py-1 text-xs ${
                      active
                        ? 'border-sage-deep bg-sage text-[#1f3a2a]'
                        : 'border-line bg-white text-ink-soft'
                    }`}
                    onClick={() => {
                      const next = active
                        ? selected.filter((value) => value !== day)
                        : [...selected, day].sort((a, b) => a - b);
                      onChange({ weekdays: next.length > 0 ? next.join(',') : null });
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {task.recurrence === 'EVERY_N_DAYS' ? (
          <label className="field w-24">
            <span className="label">每隔天数</span>
            <TextInput
              value={task.everyNDays ?? 2}
              inputMode="numeric"
              onChange={(event) => onChange({ everyNDays: Number(event.target.value) })}
            />
          </label>
        ) : null}
        {task.recurrence === 'MONTHLY' ? (
          <div className="field">
            <span className="label">每月日号（可多个）</span>
            <MonthDayInputs
              value={task.monthDays ?? (task.monthDay != null ? String(task.monthDay) : '1')}
              onChange={(monthDays, monthDay) => onChange({ monthDays, monthDay })}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}
