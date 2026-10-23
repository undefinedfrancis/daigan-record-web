import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Field,
  Modal,
  Select,
  TextInput,
  useToast,
} from '../../components/ui';
import { IconChevronRight, IconPlus, IconRefresh } from '../../components/icons';
import { useApp } from '../../app/ServiceProvider';
import { useQuery } from '../../app/useQuery';
import { navigate } from '../../app/Router';
import { toAppError } from '../../contracts/errors';
import { getAccountCategoryFilter, setAccountCategoryFilter } from '../../app/preferences';

/**
 * UF-037：以游戏账号为单位的跨老板视图。
 *
 * 身份始终是 `accountId`；分类是同名不同实体的稳定 id，不按显示名推断。视图与筛选
 * 偏好只存本机，分类归属随完整备份往返。
 */
export function AccountView({
  keyword,
  onChangeView,
}: {
  keyword: string;
  onChangeView: () => void;
}) {
  const { services, token, refresh } = useApp();
  const toast = useToast();
  const [categoryFilter, setCategoryFilter] = useState<string>(getAccountCategoryFilter);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [managing, setManaging] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categories = useQuery(() => services.accounts.categories(), []);
  const rows = useQuery(
    () =>
      services.accounts.accountView({
        ...(categoryFilter === 'all'
          ? {}
          : categoryFilter === 'none'
            ? { categoryId: null }
            : { categoryId: categoryFilter }),
        includeArchived,
        keyword,
      }),
    [categoryFilter, includeArchived, keyword],
  );

  function chooseFilter(value: string) {
    setCategoryFilter(value);
    setAccountCategoryFilter(value);
  }

  async function run(action: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
      categories.reload();
      rows.reload();
      if (message) toast(message, 'success');
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  async function createCategory() {
    if (!newCategory.trim()) return;
    await run(async () => {
      await services.accounts.createCategory({ name: newCategory }, token);
      setNewCategory('');
    }, '分类已创建');
  }

  async function renameCategory(categoryId: string, name: string) {
    await run(() => services.accounts.renameCategory({ categoryId, name }, token), '分类已重命名');
  }

  async function deleteCategory(categoryId: string) {
    await run(
      () => services.accounts.deleteCategory({ categoryId }, token),
      '分类已删除，账号保持未分类',
    );
    if (categoryFilter === categoryId) chooseFilter('all');
  }

  const list = rows.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="muted">共 {list.length} 个账号（跨老板）</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="account-category-filter">
            按分类筛选
          </label>
          <Select
            id="account-category-filter"
            value={categoryFilter}
            className="w-40"
            onChange={(event) => chooseFilter(event.target.value)}
          >
            <option value="all">全部分类</option>
            <option value="none">未分类</option>
            {(categories.data ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}（{category.accountCount}）
              </option>
            ))}
          </Select>
          <label className="flex min-h-[38px] cursor-pointer items-center gap-1.5 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            含已归档
          </label>
          <Button variant="ghost" onClick={rows.reload} aria-label="刷新账号">
            <IconRefresh size={18} />
          </Button>
          <Button onClick={() => setManaging(true)}>管理分类</Button>
          <Button variant="ghost" onClick={onChangeView}>
            按老板查看
          </Button>
        </div>
      </div>

      <ErrorText message={error ?? rows.error} />

      {list.length === 0 ? (
        <EmptyState
          title="没有符合条件的账号"
          description="可以在账号创建/编辑时选择或新建分类；已有账号默认未分类。"
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {list.map((row) => (
              <li key={row.accountId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => navigate(`/owners/${row.ownerId}`)}
                  aria-label={`打开账号 ${row.gameName} ${row.server}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {row.gameName} · {row.server}
                      {row.archived ? <span className="ml-2 text-xs text-ink-soft">已归档</span> : null}
                    </span>
                    <span className="block truncate text-xs text-ink-soft">
                      UID {row.uid} · {row.ownerLabel} · {row.orderCount} 张订单
                      {row.activeOrderCount > 0 ? `（进行中 ${row.activeOrderCount}）` : ''}
                    </span>
                  </span>
                  <IconChevronRight size={16} />
                </button>
                <Badge>{row.categoryName ?? '未分类'}</Badge>
                <label className="flex items-center gap-1 text-xs text-ink-soft">
                  <span className="sr-only">{`调整 ${row.gameName} 分类`}</span>
                  <Select
                    aria-label={`调整 ${row.gameName} ${row.server} 分类`}
                    className="w-36"
                    value={row.categoryId ?? ''}
                    disabled={busy}
                    onChange={(event) =>
                      void run(
                        () =>
                          services.accounts.setAccountCategory(
                            { accountId: row.accountId, categoryId: event.target.value || null },
                            token,
                          ),
                        '分类已更新',
                      )
                    }
                  >
                    <option value="">未分类</option>
                    {(categories.data ?? []).map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </Select>
                </label>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal open={managing} title="管理账号分类" onClose={() => setManaging(false)} wide>
        <div className="flex flex-col gap-3">
          <p className="muted">
            删除分类只会把账号置为未分类，不会删除账号、订单、任务或历史记录。
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="新建分类">
              <TextInput
                value={newCategory}
                maxLength={30}
                placeholder="例如 长期客户"
                onChange={(event) => setNewCategory(event.target.value)}
              />
            </Field>
            <Button variant="primary" disabled={busy || !newCategory.trim()} onClick={() => void createCategory()}>
              <IconPlus size={16} /> 创建
            </Button>
          </div>
          {(categories.data ?? []).length === 0 ? (
            <p className="muted">还没有分类。</p>
          ) : (
            <ul className="divide-y divide-line">
              {(categories.data ?? []).map((category) => (
                <CategoryRow
                  key={category.id}
                  name={category.name}
                  accountCount={category.accountCount}
                  busy={busy}
                  onRename={(name) => void renameCategory(category.id, name)}
                  onDelete={() => void deleteCategory(category.id)}
                />
              ))}
            </ul>
          )}
          <ErrorText message={error} />
        </div>
      </Modal>
    </div>
  );
}

function CategoryRow({
  name,
  accountCount,
  busy,
  onRename,
  onDelete,
}: {
  name: string;
  accountCount: number;
  busy: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(name);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <TextInput
        aria-label={`分类 ${name} 名称`}
        value={value}
        maxLength={30}
        className="min-w-40 flex-1"
        onChange={(event) => setValue(event.target.value)}
      />
      <span className="text-xs text-ink-soft">{accountCount} 个账号</span>
      <Button
        variant="ghost"
        disabled={busy || !value.trim() || value.trim() === name}
        onClick={() => onRename(value.trim())}
      >
        重命名
      </Button>
      {confirming ? (
        <>
          <Button variant="danger" disabled={busy} onClick={onDelete}>
            确认删除
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            取消
          </Button>
        </>
      ) : (
        <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
          <span className="text-danger">删除</span>
        </Button>
      )}
    </li>
  );
}
