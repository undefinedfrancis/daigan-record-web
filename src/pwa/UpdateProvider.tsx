import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Button, useToast } from '../components/ui';
import {
  describeCheckResult,
  updateManager,
  type CheckResult,
  type UpdateState,
} from './updateManager';

export interface UpdateController {
  state: UpdateState;
  checkNow: () => Promise<void>;
  accept: () => Promise<void>;
  dismiss: () => void;
  /** 设置页展示的检查结果文案（空串表示尚未检查或无内容）。 */
  resultText: string;
}

const UpdateContext = createContext<UpdateController | null>(null);

export function useUpdate(): UpdateController | null {
  return useContext(UpdateContext);
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const state = useSyncExternalStore(updateManager.subscribe, updateManager.getState, updateManager.getState);

  useEffect(() => {
    updateManager.setNotifier((message, tone) => toast(message, tone));
    void updateManager.ensureStarted();
    return () => updateManager.setNotifier(null);
  }, [toast]);

  const checkNow = useCallback(() => updateManager.checkForUpdate(true), []);
  const accept = useCallback(() => updateManager.accept(), []);
  const dismiss = useCallback(() => updateManager.dismiss(), []);

  const resultText = describeCheckResult(state.checkResult as CheckResult, state.waiting, state.dismissed);

  const value = useMemo<UpdateController>(
    () => ({ state, checkNow, accept, dismiss, resultText }),
    [state, checkNow, accept, dismiss, resultText],
  );

  return (
    <UpdateContext.Provider value={value}>
      {children}
      <UpdateBanner controller={value} />
    </UpdateContext.Provider>
  );
}

/** 非阻塞更新通知：仅在新版本已完整准备好且未被「稍后」时出现。 */
function UpdateBanner({ controller }: { controller: UpdateController }) {
  const { state, accept, dismiss } = controller;
  const visible = state.supported && state.waiting && !state.dismissed;
  if (!visible) return null;

  return (
    <div
      data-testid="update-banner"
      role="region"
      aria-label="更新通知"
      className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 sm:bottom-20"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-line bg-cream px-4 py-3 shadow-lg">
        <p className="text-sm font-bold">发现新版本</p>
        <p className="muted mt-1 text-sm">新版本已准备好，更新后即可使用。</p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            data-testid="update-accept"
            onClick={() => void accept()}
            disabled={state.activating}
          >
            {state.activating ? '更新中…' : '立即更新'}
          </Button>
          <Button data-testid="update-dismiss" onClick={dismiss} disabled={state.activating}>
            稍后
          </Button>
        </div>
      </div>
    </div>
  );
}
