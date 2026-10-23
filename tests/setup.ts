import 'fake-indexeddb/auto';

if (typeof globalThis.crypto === 'undefined') {
  // Node 18 以下兜底；Node 20+ 自带 webcrypto。
  throw new Error('测试环境缺少 Web Crypto');
}
