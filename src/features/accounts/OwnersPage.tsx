import { useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Modal, TextInput, useToast } from '../../components/ui';
import { IconChevronRight, IconPlus, IconRefresh } from '../../components/icons';
import { formatMoney } from '../../domain/money';
import { useApp } from '../../app/ServiceProvider';
import { useQuery } from '../../app/useQuery';
import { navigate } from '../../app/Router';
import { toAppError } from '../../contracts/errors';
import {
  getAccountViewMode,
  setAccountViewMode,
  type AccountViewMode,
} from '../../app/preferences';
import { AccountView } from './AccountView';

export function OwnersPage() {
  const { services, token, refresh } = useApp();
  const toast = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyword, setKeyword] = useState('');
  // UF-037：老板视图 / 账号视图；偏好只存本机。
  const [view, setView] = useState<AccountViewMode>(getAccountViewMode);

  function changeView(next: AccountViewMode) {
    setView(next);
    setAccountViewMode(next);
  }

  const owners = useQuery(() => services.queries.owners(true), []);
  const accountMatches = useQuery(
    () => services.queries.searchAccounts(keyword),
    [keyword],
  );

  const active = (owners.data ?? []).filter((owner) => !owner.archived);
  const archived = (owners.data ?? []).filter((owner) => owner.archived);
  const matches = (nicknameText: string, number: number) => {
    if (!keyword.trim()) return true;
    const text = keyword.trim().toLowerCase();
    return nicknameText.toLowerCase().includes(text) || String(number) === text;
  };
  const hasOwnerMatch =
    !keyword.trim() ||
    active.some((owner) => matches(owner.nickname, owner.number)) ||
    archived.some((owner) => matches(owner.nickname, owner.number));

  async function createOwner() {
    setBusy(true);
    setError(null);
    try {
      await services.accounts.saveOwner({ nickname }, token);
      setCreating(false);
      setNickname('');
      refresh();
      toast('老板已创建', 'success');
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">老板与账号</h1>
          <p className="muted">
            共 {active.length} 位老板 · 归档 {archived.length}
          </p>
          <div className="mt-1 flex gap-1" role="group" aria-label="账号页视图">
            <Button
              variant={view === 'owners' ? 'primary' : 'ghost'}
              aria-pressed={view === 'owners'}
              onClick={() => changeView('owners')}
              style={{ minHeight: 30 }}
            >
              按老板
            </Button>
            <Button
              variant={view === 'accounts' ? 'primary' : 'ghost'}
              aria-pressed={view === 'accounts'}
              onClick={() => changeView('accounts')}
              style={{ minHeight: 30 }}
            >
              按账号
            </Button>
          </div>
        </div>
        <div className="flex gap-2">
          <TextInput
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索老板 / 账号 / UID"
            aria-label="搜索老板或账号"
            className="w-44"
          />
          <Button variant="ghost" onClick={owners.reload} aria-label="刷新">
            <IconRefresh size={18} />
          </Button>
          {view === 'owners' ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <IconPlus size={18} /> 新建老板
            </Button>
          ) : null}
        </div>
      </header>

      <ErrorText message={owners.error} />

      {view === 'accounts' ? (
        <AccountView keyword={keyword} onChangeView={() => changeView('owners')} />
      ) : (
        <>

      {keyword.trim() && (accountMatches.data?.length ?? 0) > 0 ? (
        <Card>
          <div className="section-title">
            <h2>账号搜索结果（{accountMatches.data?.length}）</h2>
          </div>
          <ul className="divide-y divide-line">
            {(accountMatches.data ?? []).map((account) => (
              <li key={account.id}>
                <button
                  type="button"
                  className="flex min-h-[44px] w-full items-center gap-2 py-1.5 text-left text-sm"
                  onClick={() => navigate(`/owners/${account.ownerId}`)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {account.gameName} · {account.server}
                    <span className="ml-2 text-xs text-ink-soft">UID {account.uid}</span>
                    {account.archived ? <span className="ml-2 text-xs text-ink-soft">已归档</span> : null}
                  </span>
                  <span className="text-xs text-ink-soft">{account.ownerLabel}</span>
                  <IconChevronRight size={16} />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {active.length === 0 && !keyword.trim() ? (
        <EmptyState
          title="还没有老板"
          description="先建立老板，再为其添加游戏账号与订单。"
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              新建老板
            </Button>
          }
        />
      ) : keyword.trim() && !hasOwnerMatch && (accountMatches.data?.length ?? 0) === 0 ? (
        <EmptyState title="没有匹配的老板或账号" description="换个关键词试试，可搜索昵称、编号、游戏、区服或 UID。" />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {active
              .filter((owner) => matches(owner.nickname, owner.number))
              .map((owner) => (
                <li key={owner.id}>
                  <button
                    type="button"
                    className="flex min-h-[56px] w-full items-center gap-3 py-2 text-left"
                    onClick={() => navigate(`/owners/${owner.id}`)}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-sage-soft text-sm font-bold">
                      {owner.number}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{owner.nickname}</span>
                      <span className="block text-xs text-ink-soft">
                        {owner.accountCount} 个账号 · {owner.activeOrderCount} 张进行中订单
                      </span>
                    </span>
                    {owner.outstandingCents > 0 ? (
                      <Badge tone="warn">待收 ¥{formatMoney(owner.outstandingCents)}</Badge>
                    ) : null}
                    <IconChevronRight size={18} />
                  </button>
                </li>
              ))}
          </ul>
        </Card>
      )}

      {archived.length > 0 ? (
        <Card>
          <button
            type="button"
            className="flex min-h-[44px] w-full items-center justify-between text-sm font-semibold"
            onClick={() => setShowArchived((value) => !value)}
            aria-expanded={showArchived}
          >
            <span>已归档老板（{archived.length}）</span>
            <span className="muted">{showArchived ? '收起' : '展开'}</span>
          </button>
          {showArchived ? (
            <ul className="mt-2 divide-y divide-line">
              {archived
                .filter((owner) => matches(owner.nickname, owner.number))
                .map((owner) => (
                  <li key={owner.id}>
                    <button
                      type="button"
                      className="flex min-h-[44px] w-full items-center gap-3 py-2 text-left text-sm text-ink-soft"
                      onClick={() => navigate(`/owners/${owner.id}`)}
                    >
                      <span>#{owner.number}</span>
                      <span className="flex-1 truncate">{owner.nickname}</span>
                      <IconChevronRight size={16} />
                    </button>
                  </li>
                ))}
            </ul>
          ) : null}
        </Card>
      ) : null}
        </>
      )}

      <Modal
        open={creating}
        title="新建老板"
        onClose={() => setCreating(false)}
        guardUpdates
        footer={
          <>
            <Button onClick={() => setCreating(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={createOwner} disabled={busy || !nickname.trim()}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="昵称" hint="1–30 个字符，编号由系统自动分配且不回收">
            <TextInput
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={30}
              autoFocus
            />
          </Field>
          <ErrorText message={error} />
        </div>
      </Modal>
    </div>
  );
}
