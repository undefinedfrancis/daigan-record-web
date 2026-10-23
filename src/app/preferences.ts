export type MotionPreference = 'full' | 'reduced';

const MOTION_KEY = 'daigan-ui-motion';

export function getMotionPreference(): MotionPreference {
  try {
    return localStorage.getItem(MOTION_KEY) === 'reduced' ? 'reduced' : 'full';
  } catch {
    return 'full';
  }
}

export function setMotionPreference(value: MotionPreference): void {
  try {
    localStorage.setItem(MOTION_KEY, value);
  } catch {
    // 隐私模式下写入失败时只影响本次会话。
  }
  applyMotionPreference(value);
}

export function applyMotionPreference(value = getMotionPreference()): void {
  document.documentElement.dataset.motion = value;
}

/**
 * UF-037：账号页视图与分类筛选是**本机偏好**，不进入备份、不跨设备同步。
 * 分类归属本身是业务记录，随完整备份往返（不在 localStorage）。
 */
export type AccountViewMode = 'owners' | 'accounts';

const ACCOUNT_VIEW_KEY = 'daigan.accounts.view';
const ACCOUNT_CATEGORY_KEY = 'daigan.accounts.categoryFilter';

export function getAccountViewMode(): AccountViewMode {
  try {
    return localStorage.getItem(ACCOUNT_VIEW_KEY) === 'accounts' ? 'accounts' : 'owners';
  } catch {
    return 'owners';
  }
}

export function setAccountViewMode(mode: AccountViewMode): void {
  try {
    localStorage.setItem(ACCOUNT_VIEW_KEY, mode);
  } catch {
    // 隐私模式写入失败只影响本次记忆。
  }
}

/** 'all' = 全部分类；'none' = 只看未分类；其余为分类 id。 */
export function getAccountCategoryFilter(): string {
  try {
    return localStorage.getItem(ACCOUNT_CATEGORY_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

export function setAccountCategoryFilter(value: string): void {
  try {
    localStorage.setItem(ACCOUNT_CATEGORY_KEY, value);
  } catch {
    // 同上。
  }
}
