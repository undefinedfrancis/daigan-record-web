import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AppServices } from '../application';
import type { DatasetToken } from '../storage/datasetRuntime';

interface AppContextValue {
  services: AppServices;
  token: DatasetToken;
  revision: number;
  refresh: () => void;
  replaceToken: (token: DatasetToken) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function ServiceProvider({
  services,
  initialToken,
  children,
}: {
  services: AppServices;
  initialToken: DatasetToken;
  children: ReactNode;
}) {
  const [token, setToken] = useState(initialToken);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const replaceToken = useCallback((next: DatasetToken) => {
    setToken(next);
    setRevision((value) => value + 1);
  }, []);

  const value = useMemo(
    () => ({ services, token, revision, refresh, replaceToken }),
    [services, token, revision, refresh, replaceToken],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('ServiceProvider 未挂载');
  return value;
}
