import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Field,
  Modal,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../../components/ui';
import { IconPlus, IconTrash } from '../../components/icons';
import { StringListInputs } from '../../components/StringListInputs';
import { useApp } from '../../app/ServiceProvider';
import { useQuery } from '../../app/useQuery';
import { toAppError } from '../../contracts/errors';
import { beginOperation } from '../../pwa/updateSafety';
import type { TemplateDraft, TemplateTaskDraft } from '../../application/contracts';
import { DEFAULT_SERVICE_WEEKDAYS } from '../../contracts/tables';
import { RECURRENCE_LABELS, emptyTaskDraft, minutesFromTime, timeInput } from '../orders/orderUtils';
import { TaskDraftRow } from '../orders/TaskDraftRow';

function emptyDraft(): TemplateDraft {
  return {
    gameName: '',
    templateVersion: '2026.10',
    gameVersionNotes: null,
    zoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 300,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    categories: [
      {
        name: '日常',
        hostingMode: 'DATE_RANGE',
        targetSessions: null,
        serviceWeekdays: null,
        tasks: [emptyTaskDraft()],
      },
    ],
    pricePresets: [],
    serverOptions: [],
    defaultOrderTitle: null,
  };
}

/** 分类托管方式的编辑取值（inherit = 沿用模板级默认，不写显式值）。 */
type CategoryModeValue = 'inherit' | 'dates' | 'weekdays' | 'count';

function categoryModeValue(category: TemplateDraft['categories'][number]): CategoryModeValue {
  if (category.hostingMode === null) return 'inherit';
  if (category.hostingMode === 'COUNT_BASED') return 'count';
  return category.serviceWeekdays ? 'weekdays' : 'dates';
}

function categoryModePatch(
  value: CategoryModeValue,
  previous: TemplateDraft['categories'][number],
): Partial<TemplateDraft['categories'][number]> {
  if (value === 'inherit') {
    return { hostingMode: null, targetSessions: null, serviceWeekdays: null };
  }
  if (value === 'count') {
    return {
      hostingMode: 'COUNT_BASED',
      targetSessions: previous.targetSessions ?? previous.serviceCount ?? 30,
      serviceWeekdays: null,
    };
  }
  if (value === 'weekdays') {
    return {
      hostingMode: 'DATE_RANGE',
      targetSessions: null,
      serviceWeekdays: previous.serviceWeekdays ?? DEFAULT_SERVICE_WEEKDAYS,
    };
  }
  return { hostingMode: 'DATE_RANGE', targetSessions: null, serviceWeekdays: null };
}

function hostingLabel(hostingMode: string | null, targetSessions: number | null, weekdays: string | null): string {
  if (hostingMode === 'COUNT_BASED') return `按次数 ${targetSessions ?? '—'} 次`;
  if (hostingMode === null) return '沿用模板（分类未指定）';
  return weekdays ? '仅工作日累计天数' : '按日期期限';
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TemplatesPage() {
  const { services, token, refresh } = useApp();
  const toast = useToast();
  const list = useQuery(() => services.queries.templates(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importMode, setImportMode] = useState<'copy' | 'replace'>('copy');
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setDraft(null);
      return;
    }
    void services.queries.templateDetail(selectedId).then(setDraft);
  }, [selectedId, services, list.data]);

  async function run(action: () => Promise<unknown>, message: string) {
    // 模板保存/导入等写操作期间登记更新阻塞，避免刷新打断。
    const endOperation = beginOperation('templates-op');
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
      toast(message, 'success');
      return true;
    } catch (reason) {
      setError(toAppError(reason).message);
      return false;
    } finally {
      setBusy(false);
      endOperation();
    }
  }

  function updateTask(categoryIndex: number, taskIndex: number, patch: Partial<TemplateTaskDraft>) {
    setDraft((current) => {
      if (!current) return current;
      const categories = current.categories.map((category, index) => {
        if (index !== categoryIndex) return category;
        return {
          ...category,
          tasks: category.tasks.map((task, taskIdx) =>
            taskIdx === taskIndex ? { ...task, ...patch } : task,
          ),
        };
      });
      return { ...current, categories };
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">模板库</h1>
          <p className="muted">模板只作为新建订单的默认值，修改模板不会影响已有订单</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => {
              setDraft(emptyDraft());
              setSelectedId(null);
              setEditing(true);
            }}
          >
            <IconPlus size={18} /> 新建模板
          </Button>
        </div>
      </header>

      <ErrorText message={error ?? list.error} />

      <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
        <Card>
          <div className="section-title">
            <h2>全部模板</h2>
            <span className="muted">{list.data?.length ?? 0}</span>
          </div>
          {(list.data ?? []).length === 0 ? (
            <EmptyState title="还没有模板" />
          ) : (
            <ul className="flex flex-col gap-1">
              {(list.data ?? []).map((template) => (
                <li key={template.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(template.id);
                      setEditing(false);
                    }}
                    className={`flex min-h-[44px] w-full items-center justify-between gap-2 rounded-xl px-2 text-left text-sm ${
                      selectedId === template.id ? 'bg-sage-soft font-semibold' : 'hover:bg-sage-soft/60'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{template.gameName}</span>
                      <span className="block text-xs text-ink-soft">
                        {template.templateVersion} · {template.taskCount} 个任务
                      </span>
                    </span>
                    {template.origin === 'BUILT_IN' ? <Badge>内置</Badge> : null}
                    {template.origin === 'IMPORTED' ? <Badge>导入</Badge> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-3">
          <Card>
            <div className="section-title">
              <h2>导入 / 导出</h2>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="同名模板处理">
                <Select
                  value={importMode}
                  onChange={(event) => setImportMode(event.target.value as 'copy' | 'replace')}
                >
                  <option value="copy">另存为新模板</option>
                  <option value="replace">替换同名模板</option>
                </Select>
              </Field>
              <label className="btn cursor-pointer">
                选择模板文件
                <input
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    void run(
                      () => services.templates.importFile(file, importMode, token),
                      '模板已导入',
                    );
                  }}
                />
              </label>
              {selectedId ? (
                <Button
                  onClick={() => {
                    const endOperation = beginOperation('templates-op');
                    void services.templates
                      .exportFile(selectedId)
                      .then((blob) => {
                        const name = (list.data ?? []).find((item) => item.id === selectedId)?.gameName ?? 'template';
                        downloadBlob(blob, `daigan-template-${name}.json`);
                      })
                      .finally(endOperation);
                  }}
                >
                  导出当前模板
                </Button>
              ) : null}
            </div>
            <p className="muted mt-2">
              模板文件只包含模板内容，不包含老板、账号、密码、订单或截图。
            </p>
          </Card>

          {draft && !editing ? (
            <Card>
              <div className="section-title">
                <h2>{draft.gameName}</h2>
                <div className="flex gap-2">
                  <Button onClick={() => setEditing(true)}>编辑</Button>
                  <Button variant="danger" onClick={() => setDeleting(selectedId)}>
                    删除
                  </Button>
                </div>
              </div>
              <p className="muted">
                版本 {draft.templateVersion} · {draft.zoneId} · 每日刷新 {timeInput(draft.dailyRefreshMinutes)}
                {' · '}
                {hostingLabel(draft.hostingMode ?? null, draft.targetSessions ?? null, draft.serviceWeekdays ?? null)}
              </p>
              <p className="muted mt-1 text-sm">
                默认订单标题：
                {draft.defaultOrderTitle ? draft.defaultOrderTitle : '未设置（建单时自行填写）'}
              </p>
              {draft.gameVersionNotes ? <p className="mt-1 text-sm">{draft.gameVersionNotes}</p> : null}
              {(draft.pricePresets?.length ?? 0) > 0 ? (
                <div className="mt-3 rounded-xl border border-line bg-white/60 p-2">
                  <p className="text-sm font-semibold">价格预设</p>
                  <p className="mt-1 text-xs text-ink-soft">
                    {(draft.pricePresets ?? [])
                      .map((preset) => `${preset.label ? `${preset.label} ` : ''}${(preset.amountCents / 100).toFixed(2)} 元`)
                      .join(' · ')}
                  </p>
                </div>
              ) : null}
              <div className="mt-3 flex flex-col gap-3">
                {draft.categories.map((category, index) => (
                  <div key={`${category.name}-${index}`} className="rounded-xl border border-line bg-white/60 p-2">
                    <p className="text-sm font-semibold">{category.name}</p>
                    <ul className="mt-1 divide-y divide-line">
                      {category.tasks.map((task, taskIndex) => (
                        <li key={`${task.title}-${taskIndex}`} className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
                          <span>{task.title}</span>
                          <span className="text-xs text-ink-soft">
                            {RECURRENCE_LABELS[task.recurrence]}
                            {task.progressType === 'NUMERIC' ? ` · ${task.targetValue}${task.unit ?? ''}` : ''}
                            {task.recurrence === 'SELECTED_WEEKDAYS' && task.weekdays
                              ? ` · 周${(task.weekdays ?? '')
                                  .split(',')
                                  .filter(Boolean)
                                  .map((value) => ['一', '二', '三', '四', '五', '六', '日'][Number(value) - 1] ?? '')
                                  .join('')}`
                              : ''}
                            {task.recurrence === 'EVERY_N_DAYS' ? ` · 每 ${task.everyNDays} 天` : ''}
                            {task.recurrence === 'MONTHLY'
                              ? ` · 每月 ${(task.monthDays ?? String(task.monthDay ?? '')).split(',').filter(Boolean).join('、')} 日`
                              : ''}
                            {task.activeFrom || task.activeUntil
                              ? ` · 限 ${task.activeFrom ?? '…'} ~ ${task.activeUntil ?? '…'}`
                              : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      <Modal open={editing && Boolean(draft)} title={draft?.id ? '编辑模板' : '新建模板'} onClose={() => setEditing(false)} wide guardUpdates>
        {draft ? (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="游戏名称">
                <TextInput
                  value={draft.gameName}
                  onChange={(event) => setDraft({ ...draft, gameName: event.target.value })}
                  maxLength={40}
                />
              </Field>
              <Field label="模板版本">
                <TextInput
                  value={draft.templateVersion}
                  onChange={(event) => setDraft({ ...draft, templateVersion: event.target.value })}
                  maxLength={30}
                />
              </Field>
              <Field label="时区">
                <TextInput
                  value={draft.zoneId}
                  onChange={(event) => setDraft({ ...draft, zoneId: event.target.value })}
                />
              </Field>
              <Field label="每日刷新时间">
                <TextInput
                  type="time"
                  value={timeInput(draft.dailyRefreshMinutes)}
                  onChange={(event) =>
                    setDraft({ ...draft, dailyRefreshMinutes: minutesFromTime(event.target.value) })
                  }
                />
              </Field>
              <Field label="每周刷新星期">
                <Select
                  value={draft.weeklyRefreshDay}
                  onChange={(event) => setDraft({ ...draft, weeklyRefreshDay: Number(event.target.value) })}
                >
                  {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label, index) => (
                    <option key={label} value={index + 1}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="每周刷新时间">
                <TextInput
                  type="time"
                  value={timeInput(draft.weeklyRefreshMinutes)}
                  onChange={(event) =>
                    setDraft({ ...draft, weeklyRefreshMinutes: minutesFromTime(event.target.value) })
                  }
                />
              </Field>
            </div>

            <Field label="版本说明">
              <TextArea
                value={draft.gameVersionNotes ?? ''}
                onChange={(event) => setDraft({ ...draft, gameVersionNotes: event.target.value || null })}
                maxLength={300}
              />
            </Field>

            <Field
              label="默认订单标题（UF-036）"
              hint="建单选择该模板时自动带入；手动改过或清空后不会被模板再次覆盖，改模板也不会改名已有订单"
            >
              <TextInput
                value={draft.defaultOrderTitle ?? ''}
                maxLength={60}
                placeholder="例如 原神每日托管"
                onChange={(event) =>
                  setDraft({ ...draft, defaultOrderTitle: event.target.value || null })
                }
              />
            </Field>

            <Field label="区服选项" hint="按游戏保存，接单填账号区服时可直接点选；逐项独立输入，可留空">
              <StringListInputs
                key={draft.id ?? 'new-template'}
                value={draft.serverOptions ?? []}
                onChange={(items) => setDraft({ ...draft, serverOptions: items })}
                placeholder="例如 官服"
                itemLabel="区服"
                addLabel="添加区服"
              />
            </Field>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="label">价格预设（接单时下拉选用）</p>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      pricePresets: [
                        ...(draft.pricePresets ?? []),
                        { amountCents: 0, label: null },
                      ],
                    })
                  }
                >
                  <IconPlus size={16} /> 添加预设
                </Button>
              </div>
              {(draft.pricePresets ?? []).length === 0 ? (
                <p className="muted">没有价格预设时，接单仍可手动输入价格。</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {(draft.pricePresets ?? []).map((preset, index) => (
                    <li key={index} className="flex flex-wrap items-center gap-2">
                      <TextInput
                        aria-label="预设金额（元）"
                        className="w-28"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={preset.amountCents > 0 ? (preset.amountCents / 100).toFixed(2) : ''}
                        onChange={(event) => {
                          const cents = Math.round(Number(event.target.value) * 100);
                          const next = [...(draft.pricePresets ?? [])];
                          next[index] = {
                            ...preset,
                            amountCents: Number.isFinite(cents) && cents > 0 ? cents : 0,
                          };
                          setDraft({ ...draft, pricePresets: next });
                        }}
                      />
                      <TextInput
                        aria-label="预设标签"
                        className="w-32"
                        placeholder="例如 月卡"
                        maxLength={30}
                        value={preset.label ?? ''}
                        onChange={(event) => {
                          const next = [...(draft.pricePresets ?? [])];
                          next[index] = { ...preset, label: event.target.value || null };
                          setDraft({ ...draft, pricePresets: next });
                        }}
                      />
                      <Button
                        variant="ghost"
                        aria-label="删除价格预设"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            pricePresets: (draft.pricePresets ?? []).filter((_, i) => i !== index),
                          })
                        }
                      >
                        <IconTrash size={16} />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between">
              <p className="label">分类与任务</p>
              <Button
                variant="ghost"
                onClick={() =>
                  setDraft({
                    ...draft,
                    categories: [
                      ...draft.categories,
                      {
                        name: `分类 ${draft.categories.length + 1}`,
                        hostingMode: null,
                        targetSessions: null,
                        serviceWeekdays: null,
                        tasks: [emptyTaskDraft()],
                      },
                    ],
                  })
                }
              >
                <IconPlus size={16} /> 添加分类
              </Button>
            </div>

            {draft.categories.map((category, categoryIndex) => (
              <div key={categoryIndex} className="rounded-xl border border-line bg-white/70 p-2">
                <div className="flex items-center gap-2">
                  <TextInput
                    value={category.name}
                    aria-label="分类名称"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        categories: draft.categories.map((item, index) =>
                          index === categoryIndex ? { ...item, name: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    aria-label="删除分类"
                    disabled={draft.categories.length === 1}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        categories: draft.categories.filter((_, index) => index !== categoryIndex),
                      })
                    }
                  >
                    <IconTrash size={16} />
                  </Button>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <Field
                    label="建单默认托管方式"
                    hint="该分类的默认值；建单表单中仍可再改。选「沿用模板」表示不写显式值"
                  >
                    <Select
                      value={categoryModeValue(category)}
                      onChange={(event) => {
                        const patch = categoryModePatch(
                          event.target.value as CategoryModeValue,
                          category,
                        );
                        setDraft({
                          ...draft,
                          categories: draft.categories.map((item, index) =>
                            index === categoryIndex ? { ...item, ...patch } : item,
                          ),
                        });
                      }}
                    >
                      <option value="inherit">沿用模板级默认</option>
                      <option value="dates">按日期期限</option>
                      <option value="weekdays">仅工作日累计天数（周一至周五）</option>
                      <option value="count">按次数（整轮打卡累计）</option>
                    </Select>
                  </Field>
                  {categoryModeValue(category) === 'count' ? (
                    <Field
                      label="服务次数"
                      hint="一个游戏日整轮打卡全部任务算 1 次，攒满次数本期结束"
                    >
                      <TextInput
                        value={String(category.targetSessions ?? '')}
                        inputMode="numeric"
                        onChange={(event) => {
                          const count = Number(event.target.value);
                          setDraft({
                            ...draft,
                            categories: draft.categories.map((item, index) =>
                              index === categoryIndex
                                ? {
                                    ...item,
                                    targetSessions: count > 0 ? count : null,
                                  }
                                : item,
                            ),
                          });
                        }}
                      />
                    </Field>
                  ) : null}
                  {categoryModeValue(category) === 'weekdays' ? (
                    <Field label="服务星期" hint="逗号分隔 ISO 1–7，默认周一至周五">
                      <TextInput
                        value={category.serviceWeekdays ?? DEFAULT_SERVICE_WEEKDAYS}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            categories: draft.categories.map((item, index) =>
                              index === categoryIndex
                                ? {
                                    ...item,
                                    serviceWeekdays: event.target.value || null,
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                    </Field>
                  ) : null}
                </div>
                <ul className="mt-2 flex flex-col gap-2">
                  {category.tasks.map((task, taskIndex) => (
                    <TaskDraftRow
                      key={taskIndex}
                      task={{ ...task, key: `${categoryIndex}-${taskIndex}` }}
                      onChange={(patch) => {
                        const { key: _key, ...rest } = patch;
                        void _key;
                        updateTask(categoryIndex, taskIndex, rest);
                      }}
                      onRemove={() =>
                        setDraft({
                          ...draft,
                          categories: draft.categories.map((item, index) =>
                            index === categoryIndex
                              ? { ...item, tasks: item.tasks.filter((_, idx) => idx !== taskIndex) }
                              : item,
                          ),
                        })
                      }
                    />
                  ))}
                </ul>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      categories: draft.categories.map((item, index) =>
                        index === categoryIndex
                          ? { ...item, tasks: [...item.tasks, emptyTaskDraft()] }
                          : item,
                      ),
                    })
                  }
                >
                  <IconPlus size={16} /> 添加任务
                </Button>
              </div>
            ))}

            <div className="flex justify-end gap-2">
              <Button onClick={() => setEditing(false)} disabled={busy}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await services.templates.save(draft, token);
                    setEditing(false);
                  }, '模板已保存')
                }
              >
                {busy ? '保存中…' : '保存模板'}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(deleting)}
        title="删除模板"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!deleting) return;
                void run(async () => {
                  await services.templates.remove(deleting, token);
                  setSelectedId(null);
                  setDeleting(null);
                }, '模板已删除');
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm">删除模板只会移除模板内容，已有订单的任务、价格与打卡不受影响。</p>
      </Modal>
    </div>
  );
}
