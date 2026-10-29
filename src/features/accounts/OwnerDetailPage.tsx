import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Field,
  Modal,
  TextInput,
  useToast,
} from '../../components/ui';
import { IconChevronLeft, IconEye, IconEyeOff, IconPlus } from '../../components/icons';
import { formatMoney } from '../../domain/money';
import { useApp } from '../../app/ServiceProvider';
import { useQuery } from '../../app/useQuery';
import { navigate } from '../../app/Router';
import { toAppError } from '../../contracts/errors';
import { beginOperation } from '../../pwa/updateSafety';
import type { AccountSummary } from '../../application/contracts';
import type { CascadeCounts } from '../../application/cascade';
import { AccountForm } from './AccountForm';
import { OrderEditor } from '../orders/OrderEditor';
import { expiryToneClass, orderExpiryBadge } from '../orders/orderExpiry';

/** 一个游戏账号一个独立模块：上半「游戏账号信息」，下半「该账号对应订单」。 */
function AccountModule({
  account,
  disabled,
  onEdit,
  onArchive,
  onDelete,
  onOrder,
}: {
  account: AccountSummary;
  disabled: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onOrder: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const orders = useMemo(
    () => [...account.orders].sort((a, b) => b.createdAt - a.createdAt),
    [account.orders],
  );
  const resources = (account.resourceNotes ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <Card>
      <div className="section-title">
        <h2>游戏账号信息</h2>
        <div className="flex flex-wrap gap-1">
          <Button variant="primary" onClick={onOrder} disabled={disabled} style={{ minHeight: 32 }}>
            下单
          </Button>
          <Button variant="ghost" onClick={onEdit}>
            编辑
          </Button>
          <Button variant="ghost" onClick={onArchive}>
            归档
          </Button>
          <Button variant="ghost" onClick={onDelete}>
            <span className="text-danger">删除</span>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p className="text-[15px] font-semibold">
          {account.gameName} · {account.server}
        </p>
        <p className="text-xs text-ink-soft">
          UID {account.uid} · {account.loginMethod === 'PASSWORD' ? '密码登录' : '验证码登录'}
        </p>
        <Badge>{account.categoryName ?? '未分类'}</Badge>
      </div>

      <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
        <div className="flex items-center gap-2">
          <dt className="text-ink-soft">登录账号</dt>
          <dd>{account.loginAccount}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-ink-soft">密码</dt>
          <dd className="flex items-center gap-1">
            <span className="font-mono">
              {account.loginMethod === 'VERIFICATION_CODE'
                ? '—'
                : !account.password
                  ? '未填写'
                  : revealed
                    ? account.password
                    : '••••••••'}
            </span>
            {account.password ? (
              <Button
                variant="ghost"
                onClick={() => setRevealed((value) => !value)}
                aria-label={revealed ? '隐藏密码' : '显示密码'}
                style={{ minHeight: 32, padding: '0 6px' }}
              >
                {revealed ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </Button>
            ) : null}
          </dd>
        </div>
        {account.loginDevice ? (
          <div className="flex items-center gap-2">
            <dt className="text-ink-soft">登录设备</dt>
            <dd>{account.loginDevice}</dd>
          </div>
        ) : null}
      </dl>

      {resources.length > 0 ? (
        <div className="mt-2">
          <p className="text-xs font-medium text-ink-soft">游戏资源记录</p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {resources.map((line, index) => (
              <li key={`${line}-${index}`}>
                <Badge>{line}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 border-t border-line pt-2">
        <div className="section-title">
          <h2>
            订单 <span className="text-xs font-normal text-ink-soft">{orders.length} 张</span>
          </h2>
          <Button onClick={onOrder} disabled={disabled} style={{ minHeight: 32 }}>
            <IconPlus size={16} /> 新增订单
          </Button>
        </div>
        {orders.length === 0 ? (
          <p className="muted">该账号还没有订单，点右上角「新增订单」即可下单。</p>
        ) : (
          <ul className="divide-y divide-line">
            {orders.map((order) => {
              const expiry = orderExpiryBadge(order);
              return (
                <li key={order.id}>
                  <button
                    type="button"
                    className="flex min-h-[52px] w-full items-center gap-2 py-2 text-left"
                    onClick={() => navigate(`/orders/${order.id}`)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{order.title}</span>
                      <span className="block text-xs text-ink-soft">
                        {order.currentServiceCount != null
                          ? `按次数 ${order.currentServiceCount} 次`
                          : order.currentPeriodEnd
                            ? `至 ${order.currentPeriodEnd}`
                            : ''}
                        {expiry ? (
                          <span className={expiryToneClass(expiry.tone)}> · {expiry.label}</span>
                        ) : null}
                        {order.deadlineDate ? ` · 截止 ${order.deadlineDate}` : ''}
                        {order.paidCents > 0 ? ` · 已收 ¥${formatMoney(order.paidCents)}` : ''}
                      </span>
                    </span>
                    {order.cancelled ? (
                      <Badge tone="danger">已作废</Badge>
                    ) : order.outstandingCents > 0 ? (
                      <Badge tone="warn">待收 ¥{formatMoney(order.outstandingCents)}</Badge>
                    ) : (
                      <Badge>已结清</Badge>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

export function OwnerDetailPage({ ownerId }: { ownerId: string }) {
  const { services, token, refresh } = useApp();
  const toast = useToast();
  const [editingAccount, setEditingAccount] = useState<AccountSummary | null>(null);
  const [creatingAccount, setCreatingAccount] = useState(false);
  // 直接在本页新建订单（可从账号卡片预选账号）。
  const [orderDraft, setOrderDraft] = useState<{ accountId: string | null; key: number } | null>(null);

  function openOrderEditor(accountId: string | null) {
    setOrderDraft({ accountId, key: Date.now() });
  }
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nickname, setNickname] = useState('');
  const [deleting, setDeleting] = useState<AccountSummary | null>(null);
  const [deletion, setDeletion] = useState<CascadeCounts | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deletingOwner, setDeletingOwner] = useState(false);
  const [ownerDeletion, setOwnerDeletion] = useState<CascadeCounts | null>(null);
  const [ownerDeleteBusy, setOwnerDeleteBusy] = useState(false);

  const detail = useQuery(() => services.queries.ownerDetail(ownerId), [ownerId]);
  const categories = useQuery(() => services.accounts.categories(), []);
  const data = detail.data;

  async function action(run: () => Promise<unknown>, message: string) {
    const endOperation = beginOperation('owner-detail-op');
    setError(null);
    try {
      await run();
      refresh();
      toast(message, 'success');
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      endOperation();
    }
  }

  if (detail.loading && !data) return <p className="muted">加载中…</p>;
  if (!data) {
    return (
      <EmptyState
        title="找不到该老板"
        description={detail.error ?? undefined}
        action={<Button onClick={() => navigate('/owners')}>返回列表</Button>}
      />
    );
  }

  const { owner } = data;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="ghost" onClick={() => navigate('/owners')}>
          <IconChevronLeft size={18} /> 老板列表
        </Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs text-ink-soft">编号 #{owner.number}</p>
            <h1 className="page-title">{owner.nickname}</h1>
            <p className="muted">
              {data.accounts.length} 个账号 · {data.orders.length} 张订单
              {owner.outstandingCents > 0 ? ` · 待收 ¥${formatMoney(owner.outstandingCents)}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {owner.archived ? (
              <>
                <Button
                  variant="primary"
                  onClick={() => action(() => services.accounts.restore('owner', owner.id, token), '老板已恢复')}
                >
                  恢复老板
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setOwnerDeletion(null);
                    setDeletingOwner(true);
                    void services.accounts
                      .previewOwnerDeletion(owner.id)
                      .then(setOwnerDeletion)
                      .catch(() => setOwnerDeletion(null));
                  }}
                >
                  删除老板
                </Button>
              </>
            ) : (
              <Button
                variant="danger"
                onClick={() =>
                  action(() => services.accounts.archive('owner', owner.id, token), '老板已归档')
                }
              >
                归档老板
              </Button>
            )}
            <Button
              onClick={() => {
                setNickname(owner.nickname);
                setRenaming(true);
              }}
            >
              改昵称
            </Button>
            <Button variant="ghost" onClick={() => navigate('/orders')}>
              全部订单
            </Button>
            <Button
              variant="primary"
              onClick={() => openOrderEditor(null)}
              disabled={owner.archived || data.accounts.length === 0}
            >
              <IconPlus size={18} /> 新增订单
            </Button>
            <Button variant="primary" onClick={() => setCreatingAccount(true)} disabled={owner.archived}>
              <IconPlus size={18} /> 添加账号
            </Button>
          </div>
        </div>
        <ErrorText message={error} />
      </Card>

      {data.accounts.length === 0 ? (
        <Card>
          <div className="section-title">
            <h2>游戏账号</h2>
            <span className="muted">0 个</span>
          </div>
          <EmptyState
            title="还没有账号"
            description="添加账号后才能创建订单。"
            action={
              <Button
                variant="primary"
                onClick={() => setCreatingAccount(true)}
                disabled={owner.archived}
              >
                <IconPlus size={18} /> 添加账号
              </Button>
            }
          />
        </Card>
      ) : (
        data.accounts.map((account) => (
          <AccountModule
            key={account.id}
            account={account}
            disabled={owner.archived}
            onEdit={() => setEditingAccount(account)}
            onOrder={() => openOrderEditor(account.id)}
            onArchive={() =>
              action(() => services.accounts.archive('account', account.id, token), '账号已归档')
            }
            onDelete={() => {
              setDeletion(null);
              setDeleting(account);
              void services.accounts
                .previewAccountDeletion(account.id)
                .then(setDeletion)
                .catch(() => setDeletion(null));
            }}
          />
        ))
      )}

      {data.archivedAccounts.length > 0 ? (
        <Card>
          <div className="section-title">
            <h2>已归档账号</h2>
            <Button
              variant="ghost"
              onClick={() => setShowArchived((value) => !value)}
              aria-expanded={showArchived}
            >
              {showArchived ? '收起' : '展开'}
            </Button>
          </div>
          {showArchived ? (
            <ul className="divide-y divide-line">
              {data.archivedAccounts.map((account) => (
                <li
                  key={account.id}
                  className="flex min-h-[44px] items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="text-ink-soft">
                    {account.gameName} · {account.server}
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      action(() => services.accounts.restore('account', account.id, token), '账号已恢复')
                    }
                  >
                    恢复
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">已归档 {data.archivedAccounts.length} 个账号，展开可恢复。</p>
          )}
        </Card>
      ) : null}

      <Modal
        open={creatingAccount}
        title="添加游戏账号"
        onClose={() => setCreatingAccount(false)}
        wide
        guardUpdates
      >
        <AccountForm
          ownerId={owner.id}
          templates={data.templates}
          categories={categories.data ?? []}
          onCategoriesChanged={categories.reload}
          onCancel={() => setCreatingAccount(false)}
          onSubmit={async (draft) => {
            await services.accounts.saveAccount(draft, token);
            setCreatingAccount(false);
            refresh();
            toast('账号已保存', 'success');
          }}
        />
      </Modal>

      <Modal
        open={Boolean(editingAccount)}
        title="编辑游戏账号"
        onClose={() => setEditingAccount(null)}
        wide
        guardUpdates
      >
        {editingAccount ? (
          <AccountForm
            ownerId={owner.id}
            templates={data.templates}
            categories={categories.data ?? []}
            onCategoriesChanged={categories.reload}
            initial={{
              id: editingAccount.id,
              ownerId: owner.id,
              gameName: editingAccount.gameName,
              server: editingAccount.server,
              uid: editingAccount.uid,
              loginAccount: editingAccount.loginAccount,
              loginMethod: editingAccount.loginMethod,
              categoryId: editingAccount.categoryId,
              password: editingAccount.password,
              defaultTemplateId: editingAccount.defaultTemplateId,
              loginDevice: editingAccount.loginDevice ?? '',
              resourceNotes: editingAccount.resourceNotes ?? '',
            }}
            onCancel={() => setEditingAccount(null)}
            onSubmit={async (draft) => {
              await services.accounts.saveAccount(draft, token);
              setEditingAccount(null);
              refresh();
              toast('账号已更新', 'success');
            }}
          />
        ) : null}
      </Modal>

      <Modal open={renaming} title="修改老板昵称" onClose={() => setRenaming(false)} guardUpdates>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action(
              () => services.accounts.saveOwner({ id: owner.id, nickname }, token),
              '昵称已更新',
            ).then(() => setRenaming(false));
          }}
        >
          <Field label="昵称" hint="编号不会改变">
            <TextInput
              value={nickname}
              maxLength={30}
              autoFocus
              onChange={(event) => setNickname(event.target.value)}
            />
          </Field>
          <ErrorText message={error} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRenaming(false)}>取消</Button>
            <Button type="submit" variant="primary" disabled={!nickname.trim()}>
              保存
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        title="删除游戏账号"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)} disabled={deleteBusy}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={deleteBusy}
              onClick={() => {
                if (!deleting) return;
                setDeleteBusy(true);
                setError(null);
                void services.accounts
                  .deleteAccount(deleting.id, token)
                  .then((counts) => {
                    setDeleting(null);
                    refresh();
                    toast(
                      `已删除账号，同时删除 ${counts.orders} 张订单、${counts.receipts} 笔收款、${counts.attachments} 张截图`,
                      'success',
                    );
                  })
                  .catch((reason: unknown) => setError(toAppError(reason).message))
                  .finally(() => setDeleteBusy(false));
              }}
            >
              确认删除账号
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm leading-relaxed">
          <p className="rounded-lg border border-danger/30 bg-[#fbe4dc] px-3 py-2 text-danger">
            删除不可撤销：该账号及其全部订单、打卡、截图、收款与更正记录都会一并删除。
          </p>
          {deleting ? (
            <p className="muted">
              {deleting.gameName} · {deleting.server} · UID {deleting.uid}
            </p>
          ) : null}
          {deletion ? (
            <dl className="grid grid-cols-2 gap-1">
              <div>
                <dt className="muted">订单</dt>
                <dd>{deletion.orders} 张</dd>
              </div>
              <div>
                <dt className="muted">打卡记录</dt>
                <dd>{deletion.occurrences} 条</dd>
              </div>
              <div>
                <dt className="muted">截图</dt>
                <dd>{deletion.attachments} 张</dd>
              </div>
              <div>
                <dt className="muted">收款</dt>
                <dd>{deletion.receipts} 笔</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">正在统计影响范围…</p>
          )}
          <ErrorText message={error} />
        </div>
      </Modal>

      <Modal
        open={deletingOwner}
        title="删除老板"
        onClose={() => setDeletingOwner(false)}
        footer={
          <>
            <Button onClick={() => setDeletingOwner(false)} disabled={ownerDeleteBusy}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={ownerDeleteBusy}
              onClick={() => {
                setOwnerDeleteBusy(true);
                setError(null);
                void services.accounts
                  .deleteOwner(owner.id, token)
                  .then((counts) => {
                    setDeletingOwner(false);
                    toast(
                      `已删除老板，同时删除 ${counts.orders} 张订单、${counts.receipts} 笔收款、${counts.attachments} 张截图`,
                      'success',
                    );
                    navigate('/owners');
                  })
                  .catch((reason: unknown) => setError(toAppError(reason).message))
                  .finally(() => setOwnerDeleteBusy(false));
              }}
            >
              确认删除老板
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm leading-relaxed">
          <p className="rounded-lg border border-danger/30 bg-[#fbe4dc] px-3 py-2 text-danger">
            删除不可撤销：该老板及其全部账号、订单、打卡、截图、收款与更正记录都会一并删除。
          </p>
          <p className="muted">
            {owner.nickname} · {data.accounts.length + data.archivedAccounts.length} 个账号 ·{' '}
            {data.orders.length} 张订单
          </p>
          {ownerDeletion ? (
            <dl className="grid grid-cols-2 gap-1">
              <div>
                <dt className="muted">订单</dt>
                <dd>{ownerDeletion.orders} 张</dd>
              </div>
              <div>
                <dt className="muted">打卡记录</dt>
                <dd>{ownerDeletion.occurrences} 条</dd>
              </div>
              <div>
                <dt className="muted">截图</dt>
                <dd>{ownerDeletion.attachments} 张</dd>
              </div>
              <div>
                <dt className="muted">收款</dt>
                <dd>{ownerDeletion.receipts} 笔</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">正在统计影响范围…</p>
          )}
          <ErrorText message={error} />
        </div>
      </Modal>

      <Modal
        open={orderDraft !== null}
        title="新建订单"
        onClose={() => setOrderDraft(null)}
        wide
      >
        {orderDraft ? (
          <OrderEditor
            key={orderDraft.key}
            open
            ownerIdInitial={owner.id}
            accountIdInitial={orderDraft.accountId ?? undefined}
            onClose={() => setOrderDraft(null)}
            onCreated={(orderId) => {
              setOrderDraft(null);
              toast('订单已创建', 'success');
              navigate(`/orders/${orderId}`);
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
}
