import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Modal,
  Select,
  useToast,
} from '../../components/ui';
import { IconChevronRight, IconPlus, IconRefresh } from '../../components/icons';
import { COLOR_SWATCHES, ColorTagPicker, colorHexOf } from '../../components/ColorTagPicker';
import { formatMoney } from '../../domain/money';
import { useApp } from '../../app/ServiceProvider';
import { useQuery } from '../../app/useQuery';
import { navigate } from '../../app/Router';
import { toAppError } from '../../contracts/errors';
import type { OrderSummary } from '../../application/contracts';
import type { OrderType } from '../../contracts/tables';
import { OrderEditor } from './OrderEditor';

export function OrdersPage() {
  const { services, token } = useApp();
  const toast = useToast();
  const [type, setType] = useState<OrderType | ''>('');
  const [ownerId, setOwnerId] = useState('');
  const [colorFilter, setColorFilter] = useState('');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [creating, setCreating] = useState(false);

  async function setOrderColor(order: OrderSummary, color: string | null) {
    try {
      await services.orders.setOrderColor(order.id, color, token);
      orders.reload();
    } catch (reason) {
      toast(toAppError(reason).message, 'error');
    }
  }

  const owners = useQuery(() => services.queries.owners(false), []);
  const orders = useQuery(
    () =>
      services.queries.orders({
        type: type || undefined,
        ownerId: ownerId || undefined,
        includeCancelled,
      }),
    [type, ownerId, includeCancelled],
  );

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">订单</h1>
          <p className="muted">{orders.data?.length ?? 0} 张</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select
            value={type}
            aria-label="按类型筛选"
            className="w-32"
            onChange={(event) => setType(event.target.value as OrderType | '')}
          >
            <option value="">全部类型</option>
            <option value="HOSTING">托管</option>
            <option value="SHORT_TASK">短期单</option>
          </Select>
          <Select
            value={ownerId}
            aria-label="按老板筛选"
            className="w-36"
            onChange={(event) => setOwnerId(event.target.value)}
          >
            <option value="">全部老板</option>
            {(owners.data ?? []).map((owner) => (
              <option key={owner.id} value={owner.id}>
                #{owner.number} {owner.nickname}
              </option>
            ))}
          </Select>
          <Select
            value={colorFilter}
            aria-label="按颜色筛选"
            className="w-28"
            onChange={(event) => setColorFilter(event.target.value)}
          >
            <option value="">全部颜色</option>
            {COLOR_SWATCHES.map((swatch) => (
              <option key={swatch.value} value={swatch.value}>
                {swatch.label}
              </option>
            ))}
          </Select>
          <Button variant="ghost" onClick={orders.reload} aria-label="刷新">
            <IconRefresh size={18} />
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus size={18} /> 新建订单
          </Button>
        </div>
      </header>

      <ErrorText message={orders.error} />

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeCancelled}
          onChange={(event) => setIncludeCancelled(event.target.checked)}
        />
        显示已作废订单
      </label>

      {orders.data && orders.data.length === 0 ? (
        <EmptyState
          title="还没有订单"
          description="新建订单时可以选择老板、账号、任务与首笔收款。"
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              新建订单
            </Button>
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {(orders.data ?? [])
              .filter((order) => !colorFilter || order.colorTag === colorFilter)
              .map((order) => {
                const stripe = colorHexOf(order.colorTag);
                return (
                  <li
                    key={order.id}
                    className="flex items-center gap-2"
                    style={stripe ? { borderLeft: `3px solid ${stripe}`, paddingLeft: 6 } : undefined}
                  >
                    <ColorTagPicker
                      value={order.colorTag}
                      label={order.title}
                      onChange={(color) => void setOrderColor(order, color)}
                    />
                    <button
                      type="button"
                      className="flex min-h-[60px] flex-1 items-center gap-3 py-2 text-left"
                      onClick={() => navigate(`/orders/${order.id}`)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{order.title}</span>
                          <Badge>{order.type === 'HOSTING' ? '托管' : '短期'}</Badge>
                          {order.cancelled ? <Badge tone="danger">已作废</Badge> : null}
                          {!order.cancelled && order.completed ? <Badge>已完成</Badge> : null}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-ink-soft">
                          {order.ownerName} · {order.accountName}
                          {order.currentServiceCount != null
                            ? ` · 按次数 ${order.currentServiceCount} 次`
                            : order.currentPeriodEnd
                              ? ` · 至 ${order.currentPeriodEnd}`
                              : ''}
                          {order.deadlineDate ? ` · 截止 ${order.deadlineDate}` : ''}
                        </span>
                      </span>
                      {order.outstandingCents > 0 ? (
                        <Badge tone="warn">待收 ¥{formatMoney(order.outstandingCents)}</Badge>
                      ) : (
                        <Badge>已结清</Badge>
                      )}
                      <IconChevronRight size={18} />
                    </button>
                  </li>
                );
              })}
          </ul>
          {colorFilter && (orders.data ?? []).every((order) => order.colorTag !== colorFilter) ? (
            <p className="muted py-2">没有符合颜色筛选的订单。</p>
          ) : null}
        </Card>
      )}

      <Modal open={creating} title="新建订单" onClose={() => setCreating(false)} wide guardUpdates>
        <OrderEditor
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(orderId) => {
            setCreating(false);
            toast('订单已创建', 'success');
            navigate(`/orders/${orderId}`);
          }}
        />
      </Modal>
    </div>
  );
}
