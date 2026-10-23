/**
 * 构建两份可区分的生产产物（tests/e2e/.builds/a 与 .builds/b），
 * 供升级测试在同一 origin 上先后发布。DAIGAN_BUILD_LABEL 写入构建身份，
 * 使 A/B 的 buildId 与 version.json 可观察区分。
 *
 * 注意：目录清理用系统 rm（POSIX），且子进程清空 NODE_OPTIONS，
 * 避开部分环境注入的 fs 包装（并发删除时会超时）。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const builds = [
  { label: 'A', outDir: 'tests/e2e/.builds/a' },
  { label: 'B', outDir: 'tests/e2e/.builds/b' },
];

for (const build of builds) {
  console.log(`[upgrade-fixtures] 构建 ${build.label} → ${build.outDir}`);
  execFileSync('rm', ['-rf', path.join(webRoot, build.outDir)]);
  execFileSync('npx', ['vite', 'build', '--outDir', build.outDir, '--emptyOutDir'], {
    cwd: webRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '', DAIGAN_BUILD_LABEL: build.label },
  });
}

console.log('[upgrade-fixtures] 完成');
