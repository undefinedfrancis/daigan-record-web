import { AppError } from '../contracts/errors';
import { MONEY_MAX_CENTS } from '../contracts/tables';

/** 金额只以整数分存在；输入最多两位小数。 */
export function parseMoney(input: string): number {
  const text = input.trim().replace(/^¥|^￥/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new AppError('INVALID_INPUT', '金额最多两位小数，且必须为非负数');
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n) {
    throw new AppError('AMOUNT_OUT_OF_RANGE', '金额必须大于 0');
  }
  if (cents > BigInt(MONEY_MAX_CENTS)) {
    throw new AppError('AMOUNT_OUT_OF_RANGE', '金额超过上限 99,999,999.99 元');
  }
  return Number(cents);
}

export function parseMoneyOrZero(input: string): number {
  const text = input.trim();
  if (text === '' || text === '0' || text === '0.00') return 0;
  return parseMoney(text);
}

export function tryParseMoney(input: string): number | null {
  try {
    return parseMoney(input);
  } catch {
    return null;
  }
}

export function formatMoney(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  return `${negative ? '-' : ''}${whole.toLocaleString('zh-CN')}.${fraction.toString().padStart(2, '0')}`;
}

export function yuanInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2).replace(/\.00$/, '');
}

export function sumCents(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
