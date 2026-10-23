import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

export interface BuildEntry {
  /** 相对 outDir 的 POSIX 风格路径。 */
  file: string;
  /** 文件内容的 sha256 十六进制摘要。 */
  hash: string;
}

/**
 * 由构建产物内容推导确定性构建身份：
 * 相同产物（含相同版本号、可选标签与相同 worker 源码）必得相同 buildId，便于复现与比对。
 * workerSource 传入替换占位符前的 Service Worker 模板原文：
 * 只改 worker 代码也必须换 buildId，否则 waiting 安装复用已激活的缓存名。
 */
export function computeBuildId(
  entries: BuildEntry[],
  salt: string,
  workerSource = '',
): string {
  const lines = [...entries]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((item) => `${item.file}:${item.hash}`);
  return createHash('sha256')
    .update(lines.join('\n'))
    .update('\n')
    .update(salt)
    .update('\n')
    .update(createHash('sha256').update(workerSource).digest('hex'))
    .digest('hex')
    .slice(0, 16);
}

/** 生成期注入 index.html 的 meta 标签不参与构建身份计算，避免自引用。 */
export function stripBuildMeta(html: string): string {
  return html.replace(/\s*<meta name="daigan-(?:build|version|build-label)"[^>]*>/g, '');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

const SKIP_FILES = new Set(['sw.js', 'version.json']);

/**
 * 生产构建收尾阶段：
 * 1. 扫描真实构建产物，生成预缓存清单（含懒加载分块，不含 sw.js 与版本元数据）；
 * 2. 计算确定性 buildId（产物 + 版本 + 标签 + worker 模板原文）；
 * 3. 生成 dist/sw.js 与 dist/version.json；
 * 4. 把构建身份注入 dist/index.html，供页面展示与更新比对。
 */
export function pwaBuildPlugin(): Plugin {
  let config: ResolvedConfig;

  return {
    name: 'daigan-pwa-build',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      if (config.command !== 'build') return;

      const outDir = path.resolve(config.root, config.build.outDir);
      const rawFiles = await walk(outDir);
      const files = rawFiles
        .map((file) => file.split(path.sep).join('/'))
        .filter((file) => !SKIP_FILES.has(file) && !file.endsWith('.map'))
        .sort();

      const entries: BuildEntry[] = [];
      for (const rel of files) {
        const buf = await fs.readFile(path.join(outDir, rel));
        const source = rel === 'index.html' ? stripBuildMeta(buf.toString('utf8')) : buf;
        entries.push({ file: rel, hash: createHash('sha256').update(source).digest('hex') });
      }

      const pkg = JSON.parse(
        await fs.readFile(path.resolve(config.root, 'package.json'), 'utf8'),
      ) as { version?: string };
      const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
      const label = process.env.DAIGAN_BUILD_LABEL ?? '';
      // worker 模板（占位符替换前）参与身份计算：仅改 worker 代码也得到新的 buildId 与缓存命名空间。
      const template = await fs.readFile(path.resolve(config.root, 'src/pwa/sw.js'), 'utf8');
      const buildId = computeBuildId(entries, `${version}\n${label}`, template);

      const sw = template
        .split('__BUILD_ID__')
        .join(buildId)
        .split('__APP_VERSION__')
        .join(version)
        .split('__BUILD_LABEL__')
        .join(label)
        .split('__PRECACHE_MANIFEST__')
        .join(JSON.stringify(files));
      await fs.writeFile(path.join(outDir, 'sw.js'), sw, 'utf8');

      await fs.writeFile(
        path.join(outDir, 'version.json'),
        `${JSON.stringify({ buildId, version, label })}\n`,
        'utf8',
      );

      const indexPath = path.join(outDir, 'index.html');
      const html = stripBuildMeta(await fs.readFile(indexPath, 'utf8'));
      const meta = [
        `<meta name="daigan-build" content="${buildId}" />`,
        `<meta name="daigan-version" content="${escapeAttr(version)}" />`,
        `<meta name="daigan-build-label" content="${escapeAttr(label)}" />`,
      ].join('\n    ');
      await fs.writeFile(indexPath, html.replace('</head>', `    ${meta}\n  </head>`), 'utf8');

      config.logger.info(
        `[daigan-pwa] buildId=${buildId} 预缓存 ${files.length} 项${label ? ` 标签=${label}` : ''}`,
      );
    },
  };
}
