import { AppError } from '../contracts/errors';

/**
 * 进度与模板数值使用最多 3 位小数的精确十进制，运算全程 BigInt。
 *
 * 边界（contract v4 `conventions.decimal`，R8）：共享**绝对值**上限 1e12，
 * 即 scale 3 下的 1e15 缩放单位。网页旧实现把上限当成缩放单位（等效 1e9），
 * 与安卓相差 1000 倍，会让已经合法的安卓模板值无法导出，因此在此扩容。
 */
const SCALE = 3;
const FACTOR = 1000n;
/** 1e15 缩放单位 = 绝对值 1e12。 */
const MAX_UNITS = 1_000_000_000_000_000n;

export interface Decimal {
  /** 缩放 1000 后的整数。 */
  units: bigint;
}

export const DECIMAL_SCALE = SCALE;
export const DECIMAL_MAX_UNITS = MAX_UNITS;
export const DECIMAL_MAX_ABSOLUTE_TEXT = '1000000000000';

export function parseDecimal(input: string): Decimal {
  const text = input.trim();
  if (!/^-?\d+(\.\d{1,3})?$/.test(text)) {
    throw new AppError('INVALID_INPUT', `数值格式不正确：${input}`);
  }
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = body.split('.');
  const units = BigInt(whole) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
  const signed = negative ? -units : units;
  if (signed > MAX_UNITS || signed < -MAX_UNITS) {
    throw new AppError('INVALID_INPUT', '数值超出允许范围（绝对值上限 1000000000000）');
  }
  return { units: signed };
}

export function tryParseDecimal(input: string): Decimal | null {
  try {
    return parseDecimal(input);
  } catch {
    return null;
  }
}

export function formatDecimal(value: Decimal): string {
  const negative = value.units < 0n;
  const abs = negative ? -value.units : value.units;
  const whole = abs / FACTOR;
  const fraction = abs % FACTOR;
  const fractionText = fraction === 0n ? '' : `.${fraction.toString().padStart(SCALE, '0').replace(/0+$/, '')}`;
  return `${negative ? '-' : ''}${whole.toString()}${fractionText}`;
}

export function normalizeDecimal(input: string): string {
  return formatDecimal(parseDecimal(input));
}

export function compareDecimal(left: Decimal, right: Decimal): number {
  if (left.units === right.units) return 0;
  return left.units < right.units ? -1 : 1;
}

export function isZero(value: Decimal): boolean {
  return value.units === 0n;
}

export function addDecimal(left: Decimal, right: Decimal): Decimal {
  const units = left.units + right.units;
  if (units > MAX_UNITS || units < -MAX_UNITS) {
    throw new AppError('INVALID_INPUT', '计算结果超出允许范围');
  }
  return { units };
}

export function subtractDecimal(left: Decimal, right: Decimal): Decimal {
  return addDecimal(left, { units: -right.units });
}

export function clampDecimal(value: Decimal, min: Decimal, max: Decimal): Decimal {
  if (value.units < min.units) return min;
  if (value.units > max.units) return max;
  return value;
}

/** 进度完成判定：CHECKBOX 用 1，NUMERIC 用目标值。 */
export function isProgressComplete(current: string, target: string): boolean {
  const currentValue = tryParseDecimal(current);
  const targetValue = tryParseDecimal(target);
  if (!currentValue || !targetValue) return false;
  return currentValue.units >= targetValue.units;
}

export function formatProgress(progressType: 'CHECKBOX' | 'NUMERIC', value: string, target: string, unit: string | null): string {
  if (progressType === 'CHECKBOX') return value === '1' ? '已完成' : '未完成';
  const suffix = unit ? unit : '';
  return `${normalizeDecimal(value)} / ${normalizeDecimal(target)}${suffix}`;
}
