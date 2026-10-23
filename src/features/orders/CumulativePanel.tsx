import { useState } from 'react';
import { Badge, Button, Card, ErrorText, TextInput, useToast } from '../../components/ui';
import { useApp } from '../../app/ServiceProvider';
import { toAppError } from '../../contracts/errors';
import type { ProgressScope } from '../../domain/progressEvents';
import type { OrderDetailView, ProgressHistoryEntry } from '../../application/contracts';
import { submissionGameDate } from './cumulativeSubmission';
import {
  clearPendingOperation,
  cumulativeOperationPayload,
  operationIdFor,
} from './pendingOperations';

/**
 * UF-038 累计进度面板。
 *
 * - 输入框里是**当前累计总值**，不是本次增加量；
 * - 提交/更正/撤销都通过追加式事件完成，历史不可改写；
 * - 归属日按每个任务**自己的 scope 日历**在提交边界现算（R5）：这里不再用订单快照，
 *   否则订单与期次的刷新点不同时会提交一个命令层不承认的游戏日；
 * - 历史更正沿用原事件的归属日期与 scope，绝不把记录挪到别的轮次；
 * - 可更正性看事件的**链关系**（未被取代且不是撤销），不看它是否决定当前总值；
 * - 已移除任务不提供"按今天的新观测"，只能走历史轮次或事件更正；
 * - 重试身份按"同一载荷复用 operationId"持久化，失败保留、成功后清除。
 */
export function CumulativePanel({
  detail,
  onChanged,
}: {
  detail: OrderDetailView;
  onChanged: () => void;
}) {
  const { services, token } = useApp();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key);
    setError(null);
    try {
      await action();
      toast(message, 'success');
      onChanged();
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      setBusy(null);
    }
  }

  if (detail.cumulative.length === 0) return null;

  return (
    <Card>
      <div className="section-title">
        <h2>累计进度</h2>
        <span className="muted">输入当前累计总值</span>
      </div>
      <p className="muted mb-2 text-xs">
        这里填的是<strong>当前累计总值</strong>：先记 10、再记 15，结果就是 15。跨日不重置，
        达标前每天都可以更新；普通每日/每周任务仍按各自周期重置。
      </p>
      <ErrorText message={error} />
      <ul className="flex flex-col gap-3">
        {detail.cumulative.map((task) => {
          const key = task.taskId;
          const draft = drafts[key] ?? task.currentValue;
          return (
            <li key={key} className="rounded-xl border border-line bg-white/70 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {task.title}
                  <span className="ml-2 text-xs text-ink-soft">{task.scopeLabel}</span>
                  {task.retired ? <span className="ml-2"><Badge tone="warn">已移除</Badge></span> : null}
                </span>
                <span className="flex items-center gap-2 text-xs text-ink-soft">
                  {task.currentValue} / {task.targetValue}
                  {task.unit ?? ''}
                  {task.reachedTarget ? <Badge>已达标</Badge> : <Badge tone="warn">未达标</Badge>}
                </span>
              </div>
              {task.retired ? (
                <p className="muted mt-1 text-xs">
                  该任务已移除：不能再按当前轮次记录新的总值。请在下方“已移除任务（历史）”里
                  按原轮次补记，或在下面的历史记录里更正/撤销。
                </p>
              ) : (
                <div className="mt-1 flex flex-wrap items-end gap-2">
                  <label className="field w-32">
                    <span className="label">当前累计总值</span>
                    <TextInput
                      aria-label={`${task.title} 当前累计总值`}
                      value={draft}
                      inputMode="decimal"
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [key]: event.target.value }))
                      }
                    />
                  </label>
                  <Button
                    variant="primary"
                    disabled={busy === key || draft.trim() === ''}
                    onClick={() => {
                      // 归属日在提交边界现算：表单打开期间跨过刷新点也不会提交过期日期。
                      const gameDate = submissionGameDate(task.calendar);
                      const payload = cumulativeOperationPayload({
                        kind: 'SUBMIT',
                        taskId: task.taskId,
                        scope: task.scope,
                        gameDate,
                        value: draft.trim(),
                      });
                      const operationId = operationIdFor(`${task.taskId}:submit`, payload);
                      void run(
                        key,
                        async () => {
                          await services.progress.submit(
                            {
                              taskId: task.taskId,
                              totalValue: draft.trim(),
                              gameDate,
                              operationId,
                              scope: task.scope ?? { kind: 'SESSION' as const },
                            },
                            token,
                          );
                          clearPendingOperation(`${task.taskId}:submit`);
                          setDrafts((current) => {
                            const next = { ...current };
                            delete next[key];
                            return next;
                          });
                        },
                        '已记录当前累计总值',
                      );
                    }}
                  >
                    记录总值
                  </Button>
                </div>
              )}

              {task.history.length > 0 ? (
                <ul className="mt-2 divide-y divide-line text-xs">
                  {task.history.map((entry) => (
                    <HistoryRow
                      key={entry.id}
                      entry={entry}
                      busy={busy === key}
                      onCorrect={(value) => {
                        const payload = cumulativeOperationPayload({
                          kind: 'CORRECT',
                          taskId: task.taskId,
                          scope: entry.scope,
                          gameDate: entry.gameDate,
                          value,
                          targetId: entry.id,
                        });
                        const operationId = operationIdFor(`${task.taskId}:correct:${entry.id}`, payload);
                        void run(
                          key,
                          async () => {
                            await services.progress.correct(
                              {
                                operationId,
                                correctsEventId: entry.id,
                                kind: 'CORRECT',
                                totalValue: value,
                                gameDate: entry.gameDate,
                                scope: entry.scope,
                              },
                              token,
                            );
                            clearPendingOperation(`${task.taskId}:correct:${entry.id}`);
                          },
                          '已追加更正',
                        );
                      }}
                      onRetract={() => {
                        const payload = cumulativeOperationPayload({
                          kind: 'RETRACT',
                          taskId: task.taskId,
                          scope: entry.scope,
                          gameDate: entry.gameDate,
                          value: null,
                          targetId: entry.id,
                        });
                        const operationId = operationIdFor(`${task.taskId}:retract:${entry.id}`, payload);
                        void run(
                          key,
                          async () => {
                            await services.progress.correct(
                              {
                                operationId,
                                correctsEventId: entry.id,
                                kind: 'RETRACT',
                                totalValue: null,
                                gameDate: entry.gameDate,
                                scope: entry.scope,
                              },
                              token,
                            );
                            clearPendingOperation(`${task.taskId}:retract:${entry.id}`);
                          },
                          '已撤销该次记录',
                        );
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <p className="muted mt-1 text-xs">
                  还没有观测记录。记录一次后即可在历史里更正或撤销。
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function HistoryRow({
  entry,
  busy,
  onCorrect,
  onRetract,
}: {
  entry: ProgressHistoryEntry;
  busy: boolean;
  onCorrect: (value: string) => void;
  onRetract: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.totalValue ?? '');
  const labels: Record<ProgressHistoryEntry['kind'], string> = {
    SUBMIT: '记录',
    CORRECT: '更正',
    RETRACT: '撤销',
  };
  return (
    <li className="flex flex-wrap items-center gap-2 py-1" data-testid="cumulative-history-row">
      <span className="text-ink-soft">
        {entry.gameDate} · {entry.scopeLabel} · {labels[entry.kind]}
        {entry.totalValue !== null ? ` · ${entry.totalValue}` : ''}
      </span>
      {entry.supersededBy ? <Badge>已被更正</Badge> : null}
      {entry.effective ? <Badge>当前有效</Badge> : null}
      {entry.correctable ? (
        <span className="ml-auto flex items-center gap-1">
          {editing ? (
            <>
              <TextInput
                aria-label="更正为"
                className="w-20"
                value={value}
                inputMode="decimal"
                onChange={(event) => setValue(event.target.value)}
              />
              <Button
                disabled={busy || !value.trim()}
                onClick={() => {
                  onCorrect(value.trim());
                  setEditing(false);
                }}
              >
                保存更正
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                取消
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
                更正
              </Button>
              <Button variant="ghost" disabled={busy} onClick={onRetract}>
                撤销
              </Button>
            </>
          )}
        </span>
      ) : null}
    </li>
  );
}

/**
 * 已移除任务的历史入口（UF-038 / Android H1/H3 对齐）。
 *
 * 只对**已存在的轮次**补记或撤销，绝不为缺失的轮次建行：
 * - 打卡/普通数值任务：`setHistoricalRoundCompletion`（应做集与稳定归属日在服务层）；
 * - 累计任务：无观测的轮次给出**该轮归属日**的首次观测入口（精确 task + session + 日期，
 *   不使用"今天"或当前轮次）；已有观测的轮次指向上方累计进度的事件更正/撤销。
 */
export function RetiredHistoryPanel({
  detail,
  onChanged,
}: {
  detail: OrderDetailView;
  onChanged: () => void;
}) {
  const { services, token } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totals, setTotals] = useState<Record<string, string>>({});

  if (detail.historicalTasks.length === 0) return null;

  async function setCompleted(
    key: string,
    orderId: string,
    sessionIndex: number,
    taskId: string,
    completed: boolean,
  ) {
    setBusy(key);
    setError(null);
    try {
      await services.tasks.setHistoricalRoundCompletion(
        { orderId, sessionIndex, taskId, completed },
        token,
      );
      toast(completed ? '已补记该轮历史' : '已撤销该轮历史记录', 'success');
      onChanged();
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      setBusy(null);
    }
  }

  async function recordHistoricalTotal(
    key: string,
    taskId: string,
    sessionId: string,
    gameDate: string,
    value: string,
  ) {
    setBusy(key);
    setError(null);
    const scope: ProgressScope = { kind: 'SESSION', sessionId };
    try {
      const operationId = operationIdFor(
        `historical:${taskId}:${sessionId}`,
        cumulativeOperationPayload({ kind: 'SUBMIT', taskId, scope, gameDate, value }),
      );
      await services.progress.submit(
        { taskId, totalValue: value, gameDate, operationId, scope },
        token,
      );
      clearPendingOperation(`historical:${taskId}:${sessionId}`);
      toast(`已补记第 ${gameDate} 的累计总值`, 'success');
      onChanged();
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <div className="section-title">
        <h2>已移除任务（历史）</h2>
        <span className="muted">{detail.historicalTasks.length} 个</span>
      </div>
      <p className="muted mb-2 text-xs">
        这些任务已从当前打卡列表移除，但历史的轮次仍需如实补记。只对已存在的轮次生效，
        不会创建新的轮次，也不能在移除日之后归属。
      </p>
      <ErrorText message={error} />
      <ul className="flex flex-col gap-2">
        {detail.historicalTasks.map((task) => (
          <li
            key={task.taskId}
            data-testid="retired-task"
            className="rounded-xl border border-line bg-white/70 px-3 py-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium">
                {task.title}
                <span className="ml-2 text-xs text-ink-soft">已移除</span>
                {task.retiredDate ? (
                  <span className="ml-2 text-xs text-ink-soft">移除日 {task.retiredDate}</span>
                ) : null}
              </span>
              <span className="text-xs text-ink-soft">
                {task.startValue} → {task.targetValue}
                {task.unit ?? ''}
                {task.cumulative ? ' · 累计' : ''}
              </span>
            </div>
            <ul className="mt-1 divide-y divide-line text-xs">
              {task.rounds.map((round) => {
                const key = `${task.taskId}:${round.sessionIndex}`;
                const attributable =
                  round.attributedDate !== null &&
                  (task.retiredDate === null || round.attributedDate <= task.retiredDate);
                const draft = totals[key] ?? '';
                return (
                  <li
                    key={key}
                    data-testid={`retired-round-${round.sessionIndex}`}
                    className="flex flex-wrap items-center gap-2 py-1"
                  >
                    <span>
                      第 {round.sessionIndex} 次打卡 · {round.attributedDate ?? '未知归属日'} ·{' '}
                      {round.currentValue}/{task.targetValue}
                    </span>
                    {round.completed ? <Badge>已记录</Badge> : <Badge tone="warn">未记录</Badge>}
                    {round.hasObservation && !round.hasEffectiveObservation ? (
                      <span className="text-ink-soft">此前观测已撤回</span>
                    ) : round.hasObservation && !round.completed ? (
                      <span className="text-ink-soft">已有观测但未达标</span>
                    ) : null}
                    {task.cumulative ? (
                      round.hasEffectiveObservation ? (
                        <span className="ml-auto text-ink-soft">
                          已有观测：请在上方「累计进度」里按「第 {round.sessionIndex} 次打卡」更正或撤销
                        </span>
                      ) : attributable ? (
                        <span className="ml-auto flex items-end gap-1">
                          <label className="field w-28">
                            <span className="label">该轮累计总值</span>
                            <TextInput
                              aria-label={`${task.title} 第 ${round.sessionIndex} 次打卡累计总值`}
                              value={draft}
                              inputMode="decimal"
                              onChange={(event) =>
                                setTotals((current) => ({ ...current, [key]: event.target.value }))
                              }
                            />
                          </label>
                          <Button
                            variant="ghost"
                            disabled={busy === key || draft.trim() === ''}
                            onClick={() =>
                              void recordHistoricalTotal(
                                key,
                                task.taskId,
                                round.sessionId,
                                round.attributedDate as string,
                                draft.trim(),
                              )
                            }
                          >
                            补记
                          </Button>
                        </span>
                      ) : (
                        <span className="ml-auto text-ink-soft">
                          归属日已晚于移除日，不能补记
                        </span>
                      )
                    ) : (
                      <span className="ml-auto flex gap-1">
                        {round.completed ? (
                          <Button
                            variant="ghost"
                            disabled={busy === key}
                            onClick={() =>
                              void setCompleted(
                                key,
                                detail.order.id,
                                round.sessionIndex,
                                task.taskId,
                                false,
                              )
                            }
                          >
                            撤销
                          </Button>
                        ) : attributable ? (
                          <Button
                            variant="ghost"
                            disabled={busy === key}
                            onClick={() =>
                              void setCompleted(
                                key,
                                detail.order.id,
                                round.sessionIndex,
                                task.taskId,
                                true,
                              )
                            }
                          >
                            补记
                          </Button>
                        ) : (
                          <span className="text-ink-soft">归属日已晚于移除日</span>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </Card>
  );
}
