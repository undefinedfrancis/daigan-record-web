import { parseMoney, yuanInput } from '../../domain/money';
import { formatTime } from '../../backup/templateCodec';
import type { TemplateTaskDraft } from '../../application/contracts';
import type { Recurrence } from '../../contracts/tables';

export function toDateTimeInput(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function fromDateTimeInput(value: string): number {
  const stamp = new Date(value).getTime();
  return Number.isFinite(stamp) ? stamp : Date.now();
}

export function timeInput(minutes: number): string {
  return formatTime(minutes);
}

export function minutesFromTime(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 300;
  return Math.min(1439, Math.max(0, hour * 60 + minute));
}

export function moneyOrNull(value: string): number | null {
  if (!value.trim()) return null;
  return parseMoney(value);
}

export function moneyInput(cents: number | null | undefined): string {
  return yuanInput(cents);
}

export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  ONE_TIME: '一次性',
  DAILY: '每日',
  WEEKLY: '每周',
  SELECTED_WEEKDAYS: '指定星期',
  EVERY_N_DAYS: '每隔 N 天',
  MONTHLY: '每月',
};

export function emptyTaskDraft(): TemplateTaskDraft {
  return {
    title: '',
    progressType: 'CHECKBOX',
    startValue: '0',
    targetValue: '1',
    unit: null,
    recurrence: 'DAILY',
    weekdays: null,
    everyNDays: null,
    monthDay: null,
  };
}

export function weekdayText(value: string | null): string {
  if (!value) return '';
  return value
    .split(',')
    .filter(Boolean)
    .map((day) => ['一', '二', '三', '四', '五', '六', '日'][Number(day) - 1] ?? '')
    .join('');
}
