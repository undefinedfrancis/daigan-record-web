import { useState, type ReactNode } from 'react';
import { navigate, useRoute } from './Router';
import { useApp } from './ServiceProvider';
import {
  IconClipboard,
  IconList,
  IconSettings,
  IconTemplate,
  IconUsers,
  IconWallet,
} from '../components/icons';
import { Modal } from '../components/ui';
import { TodayPage } from '../features/today/TodayPage';
import { OwnersPage } from '../features/accounts/OwnersPage';
import { OwnerDetailPage } from '../features/accounts/OwnerDetailPage';
import { OrdersPage } from '../features/orders/OrdersPage';
import { OrderDetailPage } from '../features/orders/OrderDetailPage';
import { LedgerPage } from '../features/ledger/LedgerPage';
import { TemplatesPage } from '../features/templates/TemplatesPage';
import { SettingsPage } from '../features/settings/SettingsPage';

const PRIMARY_NAV = [
  { name: 'today', label: '今日事项', short: '今日', path: '/today', icon: IconClipboard },
  { name: 'owners', label: '老板与账号', short: '老板', path: '/owners', icon: IconUsers },
  { name: 'orders', label: '订单', short: '订单', path: '/orders', icon: IconList },
  { name: 'ledger', label: '收款与统计', short: '数据', path: '/ledger', icon: IconWallet },
] as const;

const SECONDARY_NAV = [
  { label: '模板库', path: '/templates', icon: IconTemplate },
  { label: '资料与设置', path: '/settings', icon: IconSettings },
];

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <svg width="30" height="30" viewBox="0 0 48 48" aria-hidden="true">
        <rect x="1" y="1" width="46" height="46" rx="12" fill="#E4EBDD" stroke="#304F3D" strokeWidth="1.5" />
        <rect x="9" y="8" width="30" height="32" rx="4" fill="#FFF8EA" stroke="#304F3D" strokeWidth="1.5" />
        <path d="M15 16h18M15 22h18M15 28h11" stroke="#55705F" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M30 32.5l3.2 3.2 6-7" fill="none" stroke="#86AA83" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold leading-tight">代肝单据管理系统</p>
        <p className="text-[11px] leading-tight text-ink-soft">本地优先 · 无需注册</p>
      </div>
    </div>
  );
}

function NavButton({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon: (props: { size?: number }) => ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[11px] leading-tight ${
        active ? 'bg-sage-soft font-semibold text-ink' : 'text-ink-soft'
      }`}
    >
      {icon({ size: 19 })}
      <span>{label}</span>
    </button>
  );
}

export function App() {
  const route = useRoute();
  const { revision } = useApp();
  const [moreOpen, setMoreOpen] = useState(false);
  const active =
    route.name === 'owner'
      ? 'owners'
      : route.name === 'order'
        ? 'orders'
        : route.name === 'templates' || route.name === 'settings'
          ? 'more'
          : route.name;

  let page: ReactNode;
  switch (route.name) {
    case 'today':
      page = <TodayPage />;
      break;
    case 'owners':
      page = <OwnersPage />;
      break;
    case 'owner':
      page = <OwnerDetailPage ownerId={route.id} />;
      break;
    case 'orders':
      page = <OrdersPage />;
      break;
    case 'order':
      page = <OrderDetailPage key={route.id} orderId={route.id} />;
      break;
    case 'ledger':
      page = <LedgerPage />;
      break;
    case 'templates':
      page = <TemplatesPage />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    default:
      page = <TodayPage />;
  }

  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-56 shrink-0 flex-col gap-5 border-r border-line bg-cream px-3.5 py-4 lg:flex">
        <Brand />
        <nav className="flex flex-col gap-0.5" aria-label="主导航">
          {PRIMARY_NAV.map((item) => (
            <button
              key={item.path}
              type="button"
              onClick={() => navigate(item.path)}
              aria-current={active === item.name ? 'page' : undefined}
              className={`flex min-h-[38px] items-center gap-2.5 rounded-lg px-2.5 text-sm ${
                active === item.name ? 'bg-sage font-semibold text-[#1f3a2a]' : 'hover:bg-sage-soft'
              }`}
            >
              {item.icon({ size: 18 })}
              {item.label}
            </button>
          ))}
        </nav>
        <div className="divider" />
        <nav className="flex flex-col gap-0.5" aria-label="次导航">
          {SECONDARY_NAV.map((item) => {
            const isActive = route.name === item.path.slice(1);
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => navigate(item.path)}
                className={`flex min-h-[38px] items-center gap-2.5 rounded-lg px-2.5 text-sm ${
                  isActive ? 'bg-sage-soft font-semibold' : 'hover:bg-sage-soft'
                }`}
              >
                {item.icon({ size: 17 })}
                {item.label}
              </button>
            );
          })}
        </nav>
        <p className="mt-auto text-[11px] leading-relaxed text-ink-soft">
          资料保存在当前浏览器。请定期在「资料与设置」导出完整备份。
        </p>
      </aside>

      <div className="flex min-h-screen flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-cream/80 px-4 py-2.5 backdrop-blur lg:hidden">
          <Brand />
          <span className="badge">离线可用</span>
        </header>
        <main
          key={`${route.name}-${revision > 0 ? 'r' : 'i'}`}
          className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-4 lg:px-7 lg:pb-10 lg:pt-6"
        >
          {page}
        </main>
        <nav
          className="fixed inset-x-0 bottom-0 z-30 flex gap-0.5 border-t border-line bg-cream px-1.5 pb-[env(safe-area-inset-bottom)] pt-1 lg:hidden"
          aria-label="底部导航"
        >
          {PRIMARY_NAV.map((item) => (
            <NavButton
              key={item.path}
              label={item.short}
              active={active === item.name}
              icon={item.icon}
              onClick={() => navigate(item.path)}
            />
          ))}
          <NavButton
            label="设置"
            active={active === 'more'}
            icon={IconSettings}
            onClick={() => setMoreOpen(true)}
          />
        </nav>
        <Modal open={moreOpen} title="设置与模板" onClose={() => setMoreOpen(false)}>
          <div className="flex flex-col gap-2 p-4">
            {SECONDARY_NAV.map((item) => (
              <button
                key={item.path}
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  navigate(item.path);
                }}
                className={`flex min-h-[48px] items-center gap-2.5 rounded-xl border border-line px-4 text-sm ${
                  route.name === item.path.slice(1)
                    ? 'bg-sage font-semibold'
                    : 'bg-white/60 hover:bg-sage-soft'
                }`}
              >
                {item.icon({ size: 18 })}
                {item.label}
              </button>
            ))}
          </div>
        </Modal>
      </div>
    </div>
  );
}
