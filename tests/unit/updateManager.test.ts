import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeCheckResult,
  mapManualCheck,
  parseVersionPayload,
} from '../../src/pwa/updateManager';
import { computeBuildId, stripBuildMeta } from '../../vite-plugins/pwaBuildPlugin.ts';

describe('构建身份计算', () => {
  const entries = [
    { file: 'index.html', hash: 'aa' },
    { file: 'assets/app.js', hash: 'bb' },
  ];

  it('相同产物与盐得到相同 buildId（可复现）', () => {
    expect(computeBuildId(entries, '1.0.0\n')).toBe(computeBuildId(entries, '1.0.0\n'));
  });

  it('条目顺序不影响 buildId', () => {
    const reversed = [...entries].reverse();
    expect(computeBuildId(reversed, '1.0.0\n')).toBe(computeBuildId(entries, '1.0.0\n'));
  });

  it('产物内容或版本标签变化会改变 buildId', () => {
    const changed = [entries[0], { file: 'assets/app.js', hash: 'cc' }];
    expect(computeBuildId(changed, '1.0.0\n')).not.toBe(computeBuildId(entries, '1.0.0\n'));
    expect(computeBuildId(entries, '1.0.1\n')).not.toBe(computeBuildId(entries, '1.0.0\n'));
  });

  it('仅 Service Worker 代码变化也改变 buildId（换缓存命名空间）', () => {
    const workerA = `const BUILD_ID = '__BUILD_ID__';\nself.addEventListener('install', () => {});\n`;
    const workerB = `const BUILD_ID = '__BUILD_ID__';\nself.addEventListener('activate', () => {});\n`;
    const base = computeBuildId(entries, '1.0.0\n', workerA);
    expect(computeBuildId(entries, '1.0.0\n', workerA)).toBe(base);
    expect(computeBuildId(entries, '1.0.0\n', workerB)).not.toBe(base);
    // 不传 worker 源码与传入 worker 源码也不同，防止调用方漏传时静默复用旧身份。
    expect(computeBuildId(entries, '1.0.0\n')).not.toBe(base);
  });

  it('真实 worker 模板参与身份计算：只改一行 worker 也得到新 buildId', () => {
    const template = readFileSync(path.resolve(process.cwd(), 'src/pwa/sw.js'), 'utf8');
    const patched = template.replace("const LEGACY_CACHES = ['daigan-shell-v1'];", "const LEGACY_CACHES = [];");
    expect(patched).not.toBe(template);
    const base = computeBuildId(entries, '1.0.0\n', template);
    expect(base).toBe(computeBuildId(entries, '1.0.0\n', template));
    expect(computeBuildId(entries, '1.0.0\n', patched)).not.toBe(base);
    // worker 模板本身不进预缓存清单（清单只来自构建产物）。
    expect(entries.some((entry) => entry.file === 'sw.js')).toBe(false);
  });

  it('index.html 的构建身份 meta 不参与哈希（避免自引用）', () => {
    const withMeta = `<!doctype html><html><head><meta name="daigan-build" content="x" /></head><body></body></html>`;
    const withoutMeta = `<!doctype html><html><head></head><body></body></html>`;
    expect(stripBuildMeta(withMeta)).toBe(withoutMeta);
  });
});

describe('更新元数据解析', () => {
  it('解析合法 version.json', () => {
    expect(parseVersionPayload({ buildId: 'abc', version: '1.0.0', label: 'A' })).toEqual({
      buildId: 'abc',
      version: '1.0.0',
      label: 'A',
    });
  });

  it('拒绝缺失 buildId 或结构错误的数据', () => {
    expect(parseVersionPayload(null)).toBeNull();
    expect(parseVersionPayload({})).toBeNull();
    expect(parseVersionPayload({ buildId: 123 })).toBeNull();
    expect(parseVersionPayload('abc')).toBeNull();
  });
});

describe('手动检查结果判定', () => {
  const payload = { buildId: 'build-b' };

  it('请求失败时按在线状态区分离线与失败，绝不报已是最新', () => {
    expect(mapManualCheck({ fetchOk: false, onLine: false, payload: null, currentBuildId: 'a' })).toBe('offline');
    expect(mapManualCheck({ fetchOk: false, onLine: true, payload: null, currentBuildId: 'a' })).toBe('error');
  });

  it('元数据无效或无法确定当前构建时报失败', () => {
    expect(mapManualCheck({ fetchOk: true, onLine: true, payload: null, currentBuildId: 'a' })).toBe('error');
    expect(mapManualCheck({ fetchOk: true, onLine: true, payload, currentBuildId: null })).toBe('error');
  });

  it('比对构建身份区分已是最新与发现新版本', () => {
    expect(mapManualCheck({ fetchOk: true, onLine: true, payload, currentBuildId: 'build-b' })).toBe('up-to-date');
    expect(mapManualCheck({ fetchOk: true, onLine: true, payload, currentBuildId: 'build-a' })).toBe('found');
  });
});

describe('检查结果文案', () => {
  it('离线/失败/最新各有明确文案', () => {
    expect(describeCheckResult('offline', false, false)).toContain('离线');
    expect(describeCheckResult('error', false, false)).toContain('检查更新失败');
    expect(describeCheckResult('up-to-date', false, false)).toContain('已是最新');
    expect(describeCheckResult('download-failed', false, false)).toContain('下载失败');
    expect(describeCheckResult('timeout', false, false)).toContain('超时');
  });

  it('已就绪与已推迟分别描述', () => {
    expect(describeCheckResult('found', true, false)).toContain('已准备好');
    expect(describeCheckResult('found', true, true)).toContain('稍后');
    expect(describeCheckResult('found', false, false)).toContain('正在下载准备');
  });
});
