import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { name: 'today' }
  | { name: 'owners' }
  | { name: 'owner'; id: string }
  | { name: 'orders' }
  | { name: 'order'; id: string }
  | { name: 'ledger' }
  | { name: 'templates' }
  | { name: 'settings' };

export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').split('?')[0];
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'today' };
  switch (parts[0]) {
    case 'owners':
      return parts[1] ? { name: 'owner', id: decodeURIComponent(parts[1]) } : { name: 'owners' };
    case 'orders':
      return parts[1] ? { name: 'order', id: decodeURIComponent(parts[1]) } : { name: 'orders' };
    case 'ledger':
      return { name: 'ledger' };
    case 'templates':
      return { name: 'templates' };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'today' };
  }
}

export function navigate(path: string): void {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (window.location.hash === target) return;
  window.location.hash = target;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const handler = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  return route;
}

export function useNavigate() {
  return useCallback((path: string) => navigate(path), []);
}
