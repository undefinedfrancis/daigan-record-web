import { useEffect, useMemo, useState } from 'react';
import { Button, ErrorText, Field, Select, TextInput } from '../../components/ui';
import { IconEye, IconEyeOff, IconPlus, IconTrash } from '../../components/icons';
import { useApp } from '../../app/ServiceProvider';
import type {
  AccountCategorySummary,
  AccountDraft,
  TemplateSummary,
} from '../../application/contracts';
import type { LoginMethod } from '../../contracts/tables';

const LOGIN_LABELS: Record<LoginMethod, string> = {
  PASSWORD: '密码',
  VERIFICATION_CODE: '验证码',
  QR_CODE: '扫码登录',
};

const DEVICE_PRESETS = ['手机', '平板', '电脑'];

interface ResourceRow {
  key: string;
  name: string;
  qty: string;
}

function newResourceKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 兼容旧自由文本（每行一项，如「原石 ×1600」）解析为资源行。 */
function parseResourceRows(text: string): ResourceRow[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.*)[×xX*](.*)$/);
      const name = match?.[1]?.trim();
      if (match && name) {
        return { key: newResourceKey(), name, qty: (match[2] ?? '').trim() };
      }
      return { key: newResourceKey(), name: line, qty: '' };
    });
}

/** 资源行序列化为「名称 ×数量」每行一项，与安卓端字段格式保持一致。 */
function serializeResourceRows(rows: ResourceRow[]): string {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => {
      const name = row.name.trim();
      const qty = row.qty.trim();
      return qty ? `${name} ×${qty}` : name;
    })
    .join('\n');
}

/** UF-022：账号录入草稿，仅存本机 localStorage。 */
function draftKey(ownerId: string, accountId?: string): string {
  return `daigan-account-draft:${ownerId}:${accountId ?? 'new'}`;
}

function readDraft(ownerId: string, accountId?: string): AccountDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(ownerId, accountId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AccountDraft;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearAccountDraft(ownerId: string, accountId?: string): void {
  localStorage.removeItem(draftKey(ownerId, accountId));
}

export function hasAccountDraft(ownerId: string, accountId?: string): boolean {
  return localStorage.getItem(draftKey(ownerId, accountId)) !== null;
}

export function AccountForm({
  ownerId,
  templates,
  categories,
  initial,
  onSubmit,
  onCancel,
  onCategoriesChanged,
}: {
  ownerId: string;
  templates: TemplateSummary[];
  /** UF-037：全局账号分类，可在表单内直接选择或新建。 */
  categories: AccountCategorySummary[];
  initial?: AccountDraft;
  onSubmit: (draft: AccountDraft) => Promise<void>;
  onCancel: () => void;
  onCategoriesChanged?: () => void;
}) {
  const { services, token } = useApp();
  const [categoryOptions, setCategoryOptions] = useState<AccountCategorySummary[]>(categories);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  useEffect(() => {
    setCategoryOptions(categories);
  }, [categories]);
  const [draft, setDraft] = useState<AccountDraft>(() => {
    const stored = readDraft(ownerId, initial?.id);
    return (
      stored ?? (
        initial ?? {
          ownerId,
          gameName: '',
          server: '',
          uid: '',
          loginAccount: '',
          loginMethod: 'PASSWORD',
          password: '',
          defaultTemplateId: null,
          loginDevice: '',
          resourceNotes: '',
        }
      )
    );
  });
  const [restoredDraft, setRestoredDraft] = useState(() => readDraft(ownerId, initial?.id) !== null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverOptions, setServerOptions] = useState<{ id: string; name: string }[]>([]);
  const [customDevice, setCustomDevice] = useState(
    initial?.loginDevice && !DEVICE_PRESETS.includes(initial.loginDevice),
  );
  const [resourceRows, setResourceRows] = useState<ResourceRow[]>(() =>
    parseResourceRows(draft.resourceNotes ?? ''),
  );

  useEffect(() => {
    if (!draft.gameName.trim()) {
      setServerOptions([]);
      return;
    }
    void services.serverOptions.list(draft.gameName.trim()).then((options) => {
      setServerOptions(options.map((option) => ({ id: option.id, name: option.name })));
    });
  }, [draft.gameName, services]);

  const deviceOptions = useMemo(() => {
    const values = [...DEVICE_PRESETS];
    const current = (draft.loginDevice ?? '').trim();
    if (current && !values.includes(current)) values.push(current);
    return values;
  }, [draft.loginDevice]);

  function update<K extends keyof AccountDraft>(key: K, value: AccountDraft[K]) {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      // UF-022：每次修改同步存本机草稿，退出/刷新后可继续填写。
      try {
        localStorage.setItem(draftKey(ownerId, initial?.id), JSON.stringify(next));
      } catch {
        // 存储不可用时静默降级，不阻塞录入。
      }
      return next;
    });
  }

  function applyResourceRows(next: ResourceRow[]) {
    setResourceRows(next);
    update('resourceNotes', serializeResourceRows(next));
  }

  function updateResourceRow(key: string, patch: Partial<ResourceRow>) {
    applyResourceRows(
      resourceRows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // 始终以行式编辑器为准重算资源记录，避免 draft 与行状态不同步导致丢数据。
      await onSubmit({ ...draft, ownerId, resourceNotes: serializeResourceRows(resourceRows) });
      clearAccountDraft(ownerId, initial?.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  /** UF-037：在账号表单内直接新建分类并立即应用于该账号。 */
  async function createCategoryInline() {
    setCategoryError(null);
    try {
      const name = newCategoryName.trim();
      if (!name) throw new Error('请填写分类名称');
      const result = await services.accounts.createCategory({ name }, token);
      setCategoryOptions((current) => [
        ...current,
        {
          id: result.categoryId,
          name,
          sortOrder: current.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1,
          accountCount: 0,
        },
      ]);
      update('categoryId', result.categoryId);
      setNewCategoryName('');
      setCreatingCategory(false);
      onCategoriesChanged?.();
    } catch (reason) {
      setCategoryError(reason instanceof Error ? reason.message : '分类新建失败');
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="游戏名称">
          <TextInput
            value={draft.gameName}
            onChange={(event) => update('gameName', event.target.value)}
            placeholder="例如 原神"
            required
            maxLength={40}
          />
        </Field>
        <Field
          label="区服"
          hint={serverOptions.length > 0 ? '点击选项快速填写，也可手动输入' : undefined}
        >
          <TextInput
            value={draft.server}
            onChange={(event) => update('server', event.target.value)}
            placeholder="例如 官服"
            required
            maxLength={40}
            list="account-server-options"
          />
          <datalist id="account-server-options">
            {serverOptions.map((option) => (
              <option key={option.id} value={option.name} />
            ))}
          </datalist>
          {serverOptions.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {serverOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    draft.server === option.name
                      ? 'border-sage-deep bg-sage text-[#1f3a2a]'
                      : 'border-line bg-white text-ink-soft'
                  }`}
                  onClick={() => update('server', option.name)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          ) : null}
        </Field>
        <Field label="UID">
          <TextInput
            value={draft.uid}
            onChange={(event) => update('uid', event.target.value)}
            inputMode="numeric"
            required
          />
        </Field>
        <Field label="登录账号">
          <TextInput
            value={draft.loginAccount}
            onChange={(event) => update('loginAccount', event.target.value)}
            required
            autoComplete="off"
          />
        </Field>
        <Field label="登录方式">
          <Select
            value={draft.loginMethod}
            onChange={(event) => update('loginMethod', event.target.value as LoginMethod)}
          >
            {(Object.keys(LOGIN_LABELS) as LoginMethod[]).map((method) => (
              <option key={method} value={method}>
                {LOGIN_LABELS[method]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="密码"
          hint={
            draft.loginMethod === 'PASSWORD'
              ? '仅保存在本机'
              : `${LOGIN_LABELS[draft.loginMethod]}不保存密码`
          }
        >
          <div className="flex gap-2">
            <TextInput
              type={showPassword ? 'text' : 'password'}
              value={draft.password ?? ''}
              onChange={(event) => update('password', event.target.value)}
              disabled={draft.loginMethod !== 'PASSWORD'}
              autoComplete="new-password"
            />
            <Button
              variant="ghost"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
              style={{ minWidth: 44, padding: '0 8px' }}
            >
              {showPassword ? <IconEyeOff size={18} /> : <IconEye size={18} />}
            </Button>
          </div>
        </Field>
        <Field label="登录设备" hint="手机 / 平板 / 电脑 / 自定义，可不填">
          <Select
            value={customDevice ? '__custom__' : (draft.loginDevice ?? '')}
            onChange={(event) => {
              if (event.target.value === '__custom__') {
                setCustomDevice(true);
                update('loginDevice', '');
              } else {
                setCustomDevice(false);
                update('loginDevice', event.target.value);
              }
            }}
          >
            <option value="">未填写</option>
            {deviceOptions.map((device) => (
              <option key={device} value={device}>
                {device}
              </option>
            ))}
            <option value="__custom__">自定义…</option>
          </Select>
          {customDevice ? (
            <TextInput
              className="mt-1"
              value={draft.loginDevice ?? ''}
              onChange={(event) => update('loginDevice', event.target.value)}
              placeholder="输入设备名称"
              maxLength={60}
            />
          ) : null}
        </Field>
        <Field label="默认模板" hint="新建订单时预选，不改变已有订单">
          <Select
            value={draft.defaultTemplateId ?? ''}
            onChange={(event) => update('defaultTemplateId', event.target.value || null)}
          >
            <option value="">不使用</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.gameName} · {template.templateVersion}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="账号分类" hint="一个账号最多一个分类；不选即未分类">
          <div className="flex gap-2">
            <Select
              value={draft.categoryId ?? ''}
              onChange={(event) => update('categoryId', event.target.value || null)}
            >
              <option value="">未分类</option>
              {categoryOptions.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              onClick={() => setCreatingCategory((value) => !value)}
              aria-label="新建账号分类"
            >
              <IconPlus size={16} /> 新建
            </Button>
          </div>
          {creatingCategory ? (
            <div className="mt-1 flex gap-2">
              <TextInput
                value={newCategoryName}
                maxLength={30}
                placeholder="分类名称，例如 长期客户"
                aria-label="新分类名称"
                onChange={(event) => setNewCategoryName(event.target.value)}
              />
              <Button onClick={() => void createCategoryInline()} disabled={!newCategoryName.trim()}>
                创建并选用
              </Button>
            </div>
          ) : null}
          <ErrorText message={categoryError} />
        </Field>
      </div>

      {/* 资源组内含按钮，不能用 <label> 包裹，否则按钮的可访问名会被标签文字覆盖。 */}
      <div className="field">
        <span className="label">游戏资源记录</span>
        <div className="flex flex-col gap-2">
          {resourceRows.length === 0 ? (
            <p className="muted">还没有资源记录，点击下方添加。</p>
          ) : (
            resourceRows.map((row) => (
              <div key={row.key} className="flex items-center gap-2">
                <TextInput
                  value={row.name}
                  placeholder="资源名称，例如 原石"
                  aria-label="资源名称"
                  className="min-w-40 flex-1"
                  maxLength={40}
                  onChange={(event) => updateResourceRow(row.key, { name: event.target.value })}
                />
                <TextInput
                  value={row.qty}
                  placeholder="数量"
                  aria-label="资源数量"
                  className="w-28"
                  maxLength={20}
                  onChange={(event) => updateResourceRow(row.key, { qty: event.target.value })}
                />
                <Button
                  variant="ghost"
                  aria-label={`删除资源 ${row.name || '（未命名）'}`}
                  onClick={() => applyResourceRows(resourceRows.filter((item) => item.key !== row.key))}
                >
                  <IconTrash size={16} />
                </Button>
              </div>
            ))
          )}
          <div>
            <Button
              variant="ghost"
              onClick={() =>
                applyResourceRows([...resourceRows, { key: newResourceKey(), name: '', qty: '' }])
              }
            >
              <IconPlus size={16} /> 添加资源
            </Button>
          </div>
        </div>
        <span className="muted">逐项填写资源名称与数量，可自由增删；仅本账号可见</span>
      </div>

      <ErrorText message={error} />

      {restoredDraft ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sage-deep/30 bg-[#eaf3e6] px-3 py-2 text-sm">
          <span>已恢复上次未保存的草稿，可继续填写或丢弃。</span>
          <Button
            variant="ghost"
            onClick={() => {
              clearAccountDraft(ownerId, initial?.id);
              setRestoredDraft(false);
              setDraft(
                initial ?? {
                  ownerId,
                  gameName: '',
                  server: '',
                  uid: '',
                  loginAccount: '',
                  loginMethod: 'PASSWORD',
                  password: '',
                  defaultTemplateId: null,
                  loginDevice: '',
                  resourceNotes: '',
                },
              );
              setResourceRows(parseResourceRows(initial?.resourceNotes ?? ''));
            }}
          >
            丢弃草稿
          </Button>
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? '保存中…' : '保存账号'}
        </Button>
      </div>
    </form>
  );
}
