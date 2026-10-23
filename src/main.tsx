import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app/theme.css';
import { Root } from './app/Root';
import { updateManager } from './pwa/updateManager';

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

// PWA：生产构建注册 Service Worker 并驱动按构建的更新流程；开发模式不注册，避免缓存开发资源。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void updateManager.ensureStarted();
  });
}
