import { useCallback, useEffect, useState } from 'react';
import { App } from './App';
import { ServiceProvider } from './ServiceProvider';
import { ToastProvider, Button, Card } from '../components/ui';
import { UpdateProvider } from '../pwa/UpdateProvider';
import { createServices, type AppServices } from '../application';
import { DatasetRuntime, type DatasetToken } from '../storage/datasetRuntime';
import { subscribeDatasetChange } from '../storage/locks';
import { toAppError } from '../contracts/errors';
import { applyMotionPreference } from './preferences';

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface BootState {
  status: 'loading' | 'ready' | 'error';
  services: AppServices | null;
  token: DatasetToken | null;
  message?: string;
}

export function Root() {
  const [state, setState] = useState<BootState>({ status: 'loading', services: null, token: null });

  const boot = useCallback(async () => {
    setState({ status: 'loading', services: null, token: null });
    try {
      const runtime = new DatasetRuntime({ newId, now: () => Date.now() });
      const services = createServices(runtime, () => Date.now(), newId);
      const token = await services.restore.recover();
      await services.templates.ensureBuiltIns();
      setState({ status: 'ready', services, token });
    } catch (reason) {
      setState({
        status: 'error',
        services: null,
        token: null,
        message: toAppError(reason).message,
      });
    }
  }, []);

  useEffect(() => {
    applyMotionPreference();
    void boot();
  }, [boot]);

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="paper flex flex-col items-center gap-2 px-8 py-10 text-center">
          <p className="text-base font-bold">代肝单据管理系统</p>
          <p className="muted">正在打开本机资料…</p>
        </div>
      </div>
    );
  }

  if (state.status === 'error' || !state.services || !state.token) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="max-w-md">
          <h1 className="text-base font-bold">无法打开本机资料</h1>
          <p className="muted mt-2">{state.message ?? '未知错误'}</p>
          <p className="muted mt-2">
            网页不会自动清空现有状态。若资料确实损坏，可以先导出/保留现场，再从备份恢复。
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={() => void boot()}>
              重试
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const services = state.services;

  return (
    <ToastProvider>
      <UpdateProvider>
        <DatasetSubscription services={services}>
          <ServiceProvider services={services} initialToken={state.token}>
            <App />
          </ServiceProvider>
        </DatasetSubscription>
      </UpdateProvider>
    </ToastProvider>
  );
}

function DatasetSubscription({
  services,
  children,
}: {
  services: AppServices;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const unsubscribe = subscribeDatasetChange((event) => {
      void services.runtime.current().then((token) => {
        if (token.generation !== event.generation) {
          // 其他标签页切换了资料：刷新页面以重新打开活动资料，避免旧页面继续写入。
          window.location.reload();
        }
      });
    });
    return unsubscribe;
  }, [services]);

  return <>{children}</>;
}
