import { sha256Hex } from '../backup/crypto';

/** 稳定序列化：对象键排序，数组保持顺序。 */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function fingerprintOf(payload: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(stableJson(payload)));
}
