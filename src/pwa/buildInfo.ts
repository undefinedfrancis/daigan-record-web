/** 构建身份：生产构建时由 pwaBuildPlugin 注入 index.html 的 meta 标签。 */

function meta(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  const value = el?.content?.trim();
  return value ? value : null;
}

export function getCurrentBuildId(): string | null {
  return meta('daigan-build');
}

export function getAppVersion(): string | null {
  return meta('daigan-version');
}

export function getCurrentBuildLabel(): string | null {
  return meta('daigan-build-label');
}

export function isPwaRuntimeSupported(): boolean {
  return import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export function describeCurrentVersion(): string {
  if (import.meta.env.DEV) return '开发模式（未注册离线缓存）';
  const parts = [
    getAppVersion() ? `v${getAppVersion()}` : null,
    getCurrentBuildId(),
    getCurrentBuildLabel() || null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : '未知版本（构建信息缺失）';
}
