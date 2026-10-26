import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/ServiceProvider';
import { useNavigate } from '../../app/Router';
import { Button, Modal } from '../../components/ui';
import type { DueReminderView } from '../../application/contracts';

const POLL_MS = 60 * 1000;

function stampText(epochMs: number): string {
  return new Date(epochMs).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 全局站内提醒弹窗（UF-053）。
 *
 * 打开网站、切回标签页、每分钟检查一次到期未读提醒；点「知道了」或关闭弹窗写已读，
 * 同一条提醒不会重复弹出。已归档/作废订单与已移除任务的提醒在查询层就已跳过。
 */
export function DueRemindersDialog() {
  const { services, token, refresh } = useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState<DueReminderView[]>([]);

  const check = useCallback(async () => {
    try {
      setItems(await services.reminders.due());
    } catch {
      // 资料正在切换/恢复时读失败属正常，不打扰用户，下次再查。
    }
  }, [services]);

  useEffect(() => {
    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check]);

  async function acknowledge(ids: string[]) {
    if (ids.length === 0) return;
    setItems((current) => current.filter((item) => !ids.includes(item.id)));
    try {
      await services.reminders.acknowledge(ids, token);
      // 已读写在本机表：主动刷新一次，订单里的提醒列表才会显示「已提醒」。
      refresh();
    } catch {
      // 失败时下次轮询会再次出现，不谎报成功。
    }
  }

  const open = items.length > 0;

  return (
    <Modal
      open={open}
      title="站内提醒"
      onClose={() => void acknowledge(items.map((item) => item.id))}
      footer={
        <Button variant="primary" onClick={() => void acknowledge(items.map((item) => item.id))}>
          全部知道了
        </Button>
      }
    >
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="rounded-xl border border-line bg-white/70 px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">
                {item.taskTitle ? `任务：${item.taskTitle}` : item.orderTitle}
              </span>
              <span className="text-xs tabular-nums text-ink-soft">{stampText(item.remindAt)}</span>
            </div>
            <p className="mt-1 text-xs text-ink-soft">
              {item.taskTitle ? `${item.orderTitle} · ` : ''}
              {item.ownerNickname}
            </p>
            {item.note ? (
              <p className="mt-1 rounded-lg bg-cream-deep/60 px-2 py-1 text-sm">{item.note}</p>
            ) : null}
            <div className="mt-2 flex justify-end">
              <Button
                style={{ minHeight: 30, padding: '0 10px' }}
                onClick={() => {
                  void acknowledge([item.id]);
                  navigate(`/orders/${item.orderId}`);
                }}
              >
                查看订单
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
