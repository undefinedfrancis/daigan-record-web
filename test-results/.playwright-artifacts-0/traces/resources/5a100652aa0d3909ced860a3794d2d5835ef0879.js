/* 代肝记录网页版 Service Worker 模板。
 * 由 vite-plugins/pwaBuildPlugin.ts 在生产构建时替换占位符并写入 dist/sw.js。
 * 生命周期：按构建原子预缓存 → 安装成功停在 waiting → 页面显式确认后才激活。
 */
const BUILD_ID = '50ca6ae84e6a6544';
const APP_VERSION = '0.1.0';
const BUILD_LABEL = 'B';
const PRECACHE = ["assets/index-BVpx8sme.css","assets/index-VF5zngjB.js","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","index.html","manifest.webmanifest"];

const CACHE_PREFIX = 'daigan-pwa';
/** 旧版固定缓存名（升级到按构建缓存前的实现），名字不含 scope，需另行核实归属后才能清理。 */
const LEGACY_CACHES = ['daigan-shell-v1'];
const ENTRY = 'index.html';
const SCOPE = self.registration.scope;

/** 按 scope 派生缓存前缀，避免同一源下不同子目录部署互相删除缓存。 */
function fnv1a(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** 当前部署 scope 的专属缓存命名空间前缀；缓存清理只在这个命名空间内进行。 */
const SCOPE_PREFIX = `${CACHE_PREFIX}-${fnv1a(SCOPE)}-`;
const CACHE_NAME = `${SCOPE_PREFIX}${BUILD_ID}`;
const PRECACHE_URLS = PRECACHE.map((rel) => new URL(rel, SCOPE).href);
const PRECACHE_SET = new Set(PRECACHE_URLS);
const ENTRY_URL = new URL(ENTRY, SCOPE).href;

function reply(event, message) {
  const port = event.ports && event.ports[0];
  if (port) {
    port.postMessage(message);
    return;
  }
  if (event.source && typeof event.source.postMessage === 'function') {
    event.source.postMessage(message);
  }
}

/**
 * 原子预缓存：任一必需资源失败即安装失败，并只清理本次安装的候选缓存
 * （CACHE_NAME 含本次 buildId，绝不会命中上一构建已激活的缓存）。
 */
async function precacheAll() {
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.allSettled(
    PRECACHE_URLS.map(async (url) => {
      // no-cache：绕过 HTTP 缓存，确保写入缓存的资源与本次构建一致。
      const response = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' });
      if (!response.ok) {
        throw new Error(`预缓存失败 ${response.status} ${url}`);
      }
      await cache.put(url, response);
    }),
  );
  const failed = results.filter((item) => item.status === 'rejected');
  if (failed.length > 0) {
    await caches.delete(CACHE_NAME);
    const reason = failed[0].reason;
    throw reason instanceof Error ? reason : new Error('预缓存失败');
  }
  // 入口文档同时挂在 scope 地址下，兼容导航到目录 URL 的情况。
  const entry = await cache.match(ENTRY_URL);
  if (entry) await cache.put(SCOPE, entry.clone());
}

/** 旧版缓存名不含 scope：只有全部条目都落在本 scope 内，才认定为本部署的残留。 */
async function legacyCacheBelongsToScope(key) {
  try {
    const cache = await caches.open(key);
    const requests = await cache.keys();
    if (requests.length === 0) return false;
    return requests.every((request) => new URL(request.url, SCOPE).href.startsWith(SCOPE));
  } catch {
    return false;
  }
}

/** 只清理本 scope 命名空间内的过期缓存；其他部署与其他应用的缓存保持不变。 */
async function deleteObsoleteCaches() {
  const keys = await caches.keys();
  const obsolete = keys.filter((key) => key !== CACHE_NAME && key.startsWith(SCOPE_PREFIX));
  await Promise.all(obsolete.map((key) => caches.delete(key)));
  for (const key of keys) {
    if (!LEGACY_CACHES.includes(key)) continue;
    if (await legacyCacheBelongsToScope(key)) await caches.delete(key);
  }
}

self.addEventListener('install', (event) => {
  // 故意不调用 skipWaiting：安装成功后停在 waiting，由页面确认安全后显式激活。
  event.waitUntil(precacheAll());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 只清理本部署 scope 命名空间内的过期缓存，不动其他 scope 与其他应用的缓存。
      await deleteObsoleteCaches();
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.postMessage({ type: 'daigan:activated', buildId: BUILD_ID });
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  const requestId = data.requestId ?? null;

  if (data.type === 'daigan:skip-waiting') {
    // 显式激活协议：页面只向 waiting worker 发此消息；skipWaiting 对已激活实例是空操作。
    self.skipWaiting();
    reply(event, { type: 'daigan:skip-waiting-ack', requestId, buildId: BUILD_ID, ok: true });
    return;
  }

  if (data.type === 'daigan:version') {
    reply(event, {
      type: 'daigan:version',
      requestId,
      buildId: BUILD_ID,
      appVersion: APP_VERSION,
      label: BUILD_LABEL,
    });
    return;
  }

  if (data.type === 'daigan:list-clients') {
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const others = clients.filter((client) => {
          if (event.source && client.id === event.source.id) return false;
          // 只统计本应用 scope 内的标签页，与本应用无关的同源页面不阻止更新。
          return client.url.startsWith(SCOPE);
        });
        reply(event, { type: 'daigan:clients', requestId, count: others.length });
      })(),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Service Worker 脚本与更新元数据始终走网络，保证能发现新版本。
  if (url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/version.json')) return;

  // 导航：返回本构建缓存的入口文档，保证页面与资源版本一致、断网可启动。
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = (await cache.match(ENTRY_URL)) || (await cache.match(SCOPE));
        if (cached) return cached;
        return fetch(request);
      })(),
    );
    return;
  }

  // 其余同源 GET：仅本构建清单内资源缓存优先，不缓存任意响应。
  if (!PRECACHE_SET.has(url.href)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url.href);
      if (cached) return cached;
      return fetch(request);
    })(),
  );
});
