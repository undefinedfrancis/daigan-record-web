/**
 * 升级测试静态服务器：
 * - 在同一 origin 上按需切换发布 A / B 两份生产构建（模拟新部署）；
 * - 注入指定路径的失败响应（模拟新版本资源下载失败）；
 * - 缓存响应头与 vercel.json 保持一致（sw.js / version.json / 入口再验证，assets 不可变）。
 *
 * 控制端点（仅测试用）：
 *   GET  /__e2e/state                 → { name, broken }
 *   POST /__e2e/switch?name=a|b       → 切换当前发布目录
 *   POST /__e2e/break?prefix=/assets/ → 使匹配前缀的请求返回 500
 *   POST /__e2e/heal                  → 清除注入失败
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.E2E_UPGRADE_PORT ?? 4318);
const BUILDS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.builds');

let currentName = 'a';
let brokenPrefixes = [];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function cacheControlFor(pathname) {
  if (pathname === '/' || pathname.endsWith('/index.html')) return 'public, max-age=0, must-revalidate';
  if (pathname.endsWith('/sw.js') || pathname.endsWith('/version.json')) {
    return 'public, max-age=0, must-revalidate';
  }
  if (pathname.includes('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=0, must-revalidate';
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname.startsWith('/__e2e/')) {
    if (req.method === 'GET' && url.pathname === '/__e2e/state') {
      sendJson(res, 200, { name: currentName, broken: brokenPrefixes });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__e2e/switch') {
      const name = url.searchParams.get('name') ?? '';
      if (!/^[ab]$/.test(name)) {
        sendJson(res, 400, { error: 'name 必须是 a 或 b' });
        return;
      }
      currentName = name;
      sendJson(res, 200, { name: currentName });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__e2e/break') {
      const prefix = url.searchParams.get('prefix') ?? '';
      if (prefix) brokenPrefixes.push(prefix);
      sendJson(res, 200, { broken: brokenPrefixes });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__e2e/heal') {
      brokenPrefixes = [];
      sendJson(res, 200, { broken: [] });
      return;
    }
    sendJson(res, 404, { error: '未知控制端点' });
    return;
  }

  if (brokenPrefixes.some((prefix) => url.pathname.includes(prefix))) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('injected failure');
    return;
  }

  const root = path.join(BUILDS_DIR, currentName);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = path.join(root, rel);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': cacheControlFor(url.pathname),
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[upgrade-server] http://127.0.0.1:${PORT} 当前发布=${currentName}`);
});
