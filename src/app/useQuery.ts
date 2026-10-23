import { useCallback, useEffect, useState } from 'react';
import { toAppError } from '../contracts/errors';
import { useApp } from './ServiceProvider';

export function useQuery<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const { revision } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [localTick, setLocalTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loader()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(toAppError(reason).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, localTick, ...deps]);

  const reload = useCallback(() => setLocalTick((value) => value + 1), []);

  return { data, loading, error, reload };
}
