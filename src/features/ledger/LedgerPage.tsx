import { useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Select, TextInput } from '../../components/ui';
import { IconRefresh, IconWallet } from '../../components/icons';
import { formatMoney } from '../../domain/money';
import { useApp } from '../../app/ServiceProvider';
import { useQuery } from '../../app/useQuery';
import { navigate } from '../../app/Router';

const ZONES = ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'America/New_York', 'Europe/London'];

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

const CHANNEL_LABELS: Record<string, string> = {
  WECHAT: '微信',
  ALIPAY: '支付宝',
  BANK: '银行卡',
  CASH: '现金',
  OTHER: '其他',
};

export function LedgerPage() {
  const { services } = useApp();
  const [month, setMonth] = useState(currentMonth());
  const [zoneId, setZoneId] = useState('Asia/Shanghai');

  const ledger = useQuery(() => services.queries.ledger({ month, zoneId }), [month, zoneId]);
  const data = ledger.data;
  const maxTotal = Math.max(1, ...(data?.monthlyTotals.map((item) => item.receivedCents) ?? [1]));

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">收款与统计</h1>
          <p className="muted">实收按到账时间归属月份；欠款为全时段未收金额</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="月份">
            <TextInput type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </Field>
          <Field label="报表时区">
            <Select value={zoneId} onChange={(event) => setZoneId(event.target.value)}>
              {ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="ghost" onClick={ledger.reload} aria-label="刷新">
            <IconRefresh size={18} />
          </Button>
        </div>
      </header>

      <ErrorText message={ledger.error} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="muted">本月实收</p>
          <p className="num">¥{formatMoney(data?.receivedCents ?? 0)}</p>
        </Card>
        <Card>
          <p className="muted">全部待收</p>
          <p className="num text-warn">¥{formatMoney(data?.outstandingCents ?? 0)}</p>
        </Card>
        <Card>
          <p className="muted">本月新增订单</p>
          <p className="num">{data?.orderCount ?? 0}</p>
        </Card>
      </div>

      <Card>
        <div className="section-title">
          <h2>近六个月实收</h2>
        </div>
        <ul className="flex h-32 items-end gap-2">
          {(data?.monthlyTotals ?? []).map((item) => (
            <li key={item.month} className="flex flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[11px] text-ink-soft">
                {item.receivedCents > 0 ? `¥${Math.round(item.receivedCents / 100)}` : ''}
              </span>
              <div
                className="w-full rounded-t-md bg-sage"
                style={{
                  height: `${Math.max(4, Math.round((item.receivedCents / maxTotal) * 88))}px`,
                  opacity: item.month === month ? 1 : 0.55,
                }}
                aria-label={`${item.month} 实收 ${formatMoney(item.receivedCents)} 元`}
              />
              <span className="text-[11px]">{item.month.slice(5)}月</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <div className="section-title">
          <h2>待收款项</h2>
          <span className="muted">{data?.outstanding.length ?? 0} 项</span>
        </div>
        {data && data.outstanding.length === 0 ? (
          <EmptyState title="没有待收款项" />
        ) : (
          <ul className="divide-y divide-line">
            {(data?.outstanding ?? []).map((item) => (
              <li key={item.key} className="flex min-h-[52px] flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{item.orderTitle}</span>
                  <span className="block text-xs text-ink-soft">
                    {item.ownerName} · 应收 ¥{formatMoney(item.priceCents)} · 已收 ¥
                    {formatMoney(item.paidCents)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone="warn">待收 ¥{formatMoney(item.outstandingCents)}</Badge>
                  <Button variant="ghost" onClick={() => navigate(`/orders/${item.orderId}`)}>
                    去收款
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="section-title">
          <h2>{month} 实收流水</h2>
          <IconWallet size={18} />
        </div>
        {data && data.entries.length === 0 ? (
          <EmptyState title="本月还没有实收记录" description="只有 ACTIVE 状态的有效流水计入实收。" />
        ) : (
          <ul className="divide-y divide-line">
            {(data?.entries ?? []).map((entry) => (
              <li key={entry.receiptId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-medium">¥{formatMoney(entry.amountCents)}</span>
                  <span className="ml-2 text-xs text-ink-soft">
                    {CHANNEL_LABELS[entry.channel]} ·{' '}
                    {new Date(entry.receivedAt).toLocaleString('zh-CN')}
                  </span>
                </span>
                <button
                  type="button"
                  className="text-xs text-ink-soft underline"
                  onClick={() => navigate(`/orders/${entry.orderId}`)}
                >
                  {entry.orderTitle} · {entry.ownerName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
