import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Modal,
  TextInput,
  useToast,
} from '../../components/ui';
import { IconDownload, IconRefresh, IconUpload } from '../../components/icons';
import { formatMoney } from '../../domain/money';
import { formatDateTime } from '../../domain/gameCalendar';
import { useApp } from '../../app/ServiceProvider';
import { useQuery } from '../../app/useQuery';
import { hasCrossTabLocks } from '../../storage/locks';
import { toAppError } from '../../contracts/errors';
import type { RestorePreview } from '../../backup/restoreService';
import {
  getMotionPreference,
  setMotionPreference,
  type MotionPreference,
} from '../../app/preferences';
import { beginOperation } from '../../pwa/updateSafety';
import { useUpdate } from '../../pwa/UpdateProvider';
import { describeCurrentVersion, isPwaRuntimeSupported } from '../../pwa/buildInfo';

interface BackupRecord {
  exportedAt: number;
  revision: number;
  encrypted: boolean;
}

/** Chrome/Edge 的安装提示事件（非标准 API，需自行声明）。 */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function recordKey(database: string): string {
  return `daigan-backup-record:${database}`;
}

export function SettingsPage() {
  const { services, token, refresh, replaceToken } = useApp();
  const toast = useToast();
  const update = useUpdate();
  const settings = useQuery(() => services.queries.settings(), []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [record, setRecord] = useState<BackupRecord | null>(null);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted: boolean | null }>({
    persisted: null,
  });
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [restoreModal, setRestoreModal] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  const [motion, setMotion] = useState<MotionPreference>(() => getMotionPreference());
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);

  // PWA：跟踪安装提示、独立窗口状态与 Service Worker 是否就绪。
  useEffect(() => {
    const media = window.matchMedia('(display-mode: standalone)');
    const syncDisplay = () =>
      setStandalone(
        media.matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true,
      );
    syncDisplay();
    media.addEventListener('change', syncDisplay);
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    if (navigator.serviceWorker) {
      void navigator.serviceWorker
        .getRegistration()
        .then((registration) => setOfflineReady(Boolean(registration)))
        .catch(() => setOfflineReady(false));
    }
    return () => {
      media.removeEventListener('change', syncDisplay);
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!settings.data) return;
    const stored = localStorage.getItem(recordKey(settings.data.datasetDatabase));
    if (stored) {
      try {
        setRecord(JSON.parse(stored) as BackupRecord);
      } catch {
        setRecord(null);
      }
    }
  }, [settings.data]);

  useEffect(() => {
    const nav = navigator as Navigator & { storage?: StorageManager };
    if (!nav.storage?.estimate) return;
    void nav.storage.estimate().then((estimate) => {
      setStorage({
        usage: estimate.usage,
        quota: estimate.quota,
        persisted: null,
      });
    });
    void nav.storage.persisted?.().then((persisted) => {
      setStorage((current) => ({ ...current, persisted }));
    });
  }, []);

  async function exportBackup() {
    if (password && password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    const endOperation = beginOperation('backup-op');
    setBusy(true);
    setError(null);
    try {
      const result = await services.exportBackup.exportCurrent(password || undefined);
      const name = `daigan-record-${new Date(result.exportedAt)
        .toISOString()
        .slice(0, 10)}${password ? '-encrypted' : ''}.dgbk`;
      download(result.blob, name);
      const next: BackupRecord = {
        exportedAt: result.exportedAt,
        revision: await services.runtime.revision(),
        encrypted: Boolean(password),
      };
      setRecord(next);
      if (settings.data) localStorage.setItem(recordKey(settings.data.datasetDatabase), JSON.stringify(next));
      setPassword('');
      setConfirmPassword('');
      toast('备份已生成并发起下载，请确认文件已保存', 'success');
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      setBusy(false);
      endOperation();
    }
  }

  async function requestPersist() {
    const nav = navigator as Navigator & { storage?: StorageManager };
    try {
      const granted = (await nav.storage?.persist?.()) ?? false;
      setStorage((current) => ({ ...current, persisted: granted }));
      toast(granted ? '已获得持久存储许可' : '浏览器未授予持久存储，清理站点数据会丢失资料', granted ? 'success' : 'error');
    } catch {
      toast('当前浏览器不支持持久存储请求', 'error');
    }
  }

  async function prepareRestore() {
    if (!restoreFile) return;
    const endOperation = beginOperation('backup-op');
    setBusy(true);
    setError(null);
    try {
      const result = await services.restore.prepareRestore(restoreFile, restorePassword || undefined);
      setPreview(result);
      setBackedUp(false);
      setRestoreModal(true);
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      setBusy(false);
      endOperation();
    }
  }

  async function confirmRestore() {
    if (!preview) return;
    const endOperation = beginOperation('backup-op');
    setBusy(true);
    setError(null);
    try {
      const next = await services.restore.commitRestore(preview.sessionId, token);
      replaceToken(next);
      refresh();
      setRestoreModal(false);
      setPreview(null);
      setRestoreFile(null);
      setRestorePassword('');
      toast('已切换到恢复的资料', 'success');
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      setBusy(false);
      endOperation();
    }
  }

  const modifiedSinceBackup =
    record && settings.data ? settings.data.revision > record.revision : false;

  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="page-title">资料与设置</h1>
        <p className="muted">资料只保存在当前浏览器，换域名或清理站点数据都会得到另一份本地资料。</p>
      </header>

      <ErrorText message={error ?? settings.error} />

      <Card>
        <div className="section-title">
          <h2>完整备份</h2>
          <IconDownload size={18} />
        </div>
        <p className="muted">
          导出包含老板、账号、账号分类、模板、订单、打卡、累计进度、收款与截图的 .dgbk 文件
          （便携 schema 15、模板格式 4）。填写密码会加密整个文件。
        </p>
        <p className="muted mt-2">
          备份是<strong>整份替换</strong>：不做自动同步，也不会与另一台设备的资料合并。只有声明同一便携
          schema（15）的安卓版本才能读取这类新文件；v1.8.4 及更早的安卓版本不认识账号分类与累计进度，
          <strong>升级安卓端之前不要把新备份恢复到旧版本</strong>。旧版安卓导出的文件仍可在网页恢复并升级。
          跨端真实文件往返尚未在实机上完成验收。
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="密码（可选）" hint="空密码导出普通 ZIP，文件含账号密码请自行保管">
            <TextInput
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="确认密码">
            <TextInput
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              disabled={!password}
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={exportBackup} disabled={busy}>
            导出完整备份
          </Button>
          {record ? (
            <Badge tone={modifiedSinceBackup ? 'warn' : 'default'}>
              上次导出 {formatDateTime(record.exportedAt, 'Asia/Shanghai')}
              {modifiedSinceBackup ? ' · 之后有修改' : ''}
              {record.encrypted ? ' · 已加密' : ''}
            </Badge>
          ) : (
            <Badge tone="warn">尚未导出过备份</Badge>
          )}
        </div>
        <p className="muted mt-2">
          浏览器只能发起下载，无法确认文件是否真正落盘；显示“已生成并发起下载”不代表已安全保存。
        </p>
      </Card>

      <Card>
        <div className="section-title">
          <h2>从备份恢复</h2>
          <IconUpload size={18} />
        </div>
        <p className="muted">
          恢复是整份替换，不合并两台设备分别编辑的资料。准备阶段不会改动当前资料；校验、迁移或写候选库
          任一步失败都会保留原资料。旧版网页或旧版安卓的文件会被升级到当前 schema 后再预览。
        </p>
        <p className="muted mt-1">
          资料保存在当前浏览器的 IndexedDB 中：清理站点数据、换域名或换浏览器都会得到另一份空白资料，
          浏览器也可能在空间紧张时回收数据。定期导出完整备份是唯一的长期保留方式。
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="btn cursor-pointer">
            选择 .dgbk 文件
            <input
              type="file"
              accept=".dgbk,application/octet-stream,application/zip"
              className="sr-only"
              onChange={(event) => {
                setRestoreFile(event.target.files?.[0] ?? null);
                event.target.value = '';
              }}
            />
          </label>
          <Field label="备份密码">
            <TextInput
              type="password"
              value={restorePassword}
              onChange={(event) => setRestorePassword(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Button variant="primary" onClick={prepareRestore} disabled={busy || !restoreFile}>
            预览恢复内容
          </Button>
        </div>
        {restoreFile ? <p className="muted mt-2">已选择：{restoreFile.name}</p> : null}
      </Card>

      <Card>
        <div className="section-title">
          <h2>存储状态</h2>
          <IconRefresh size={18} />
        </div>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="muted">已用空间</dt>
            <dd>{storage.usage !== undefined ? `${(storage.usage / 1024 / 1024).toFixed(1)} MB` : '无法获取'}</dd>
          </div>
          <div>
            <dt className="muted">浏览器配额</dt>
            <dd>{storage.quota !== undefined ? `${(storage.quota / 1024 / 1024).toFixed(0)} MB` : '无法获取'}</dd>
          </div>
          <div>
            <dt className="muted">持久存储</dt>
            <dd>
              {storage.persisted === null ? '未知' : storage.persisted ? '已授予' : '未授予'}
            </dd>
          </div>
          <div>
            <dt className="muted">本机资料标识</dt>
            <dd className="break-all text-xs">{settings.data?.datasetDatabase ?? '—'}</dd>
          </div>
        </dl>
        <Button className="mt-3" onClick={requestPersist}>
          申请持久存储
        </Button>
        <p className="muted mt-2">
          浏览器仍可能在空间紧张时清除数据。备份是唯一的跨设备与长期保留方式。
        </p>
        {!hasCrossTabLocks() ? (
          <p className="mt-2 rounded-lg border border-warn/40 bg-[#fdf3e2] px-3 py-2 text-sm text-warn">
            当前浏览器不支持跨标签页锁（Web Locks）。请使用较新的 Chrome、Edge、Safari 或
            Firefox，避免同时在多个标签页修改资料。
          </p>
        ) : null}
      </Card>

      <Card>
        <div className="section-title">
          <h2>页面切换与动效</h2>
        </div>
        <p className="muted">觉得动画或渐变发晕时可改为直接切换；偏好保存在当前浏览器。</p>
        <div className="mt-2 flex flex-col gap-1.5">
          {(
            [
              { value: 'full', label: '保留动效', hint: '按钮、展开与弹层带轻微过渡' },
              { value: 'reduced', label: '直接切换', hint: '关闭过渡与动画，页面立即切换' },
            ] as const
          ).map((option) => (
            <label
              key={option.value}
              className="flex min-h-[38px] cursor-pointer items-center gap-2 rounded-lg border border-line bg-white/60 px-3 py-1.5"
            >
              <input
                type="radio"
                name="motion"
                checked={motion === option.value}
                onChange={() => {
                  setMotion(option.value);
                  setMotionPreference(option.value);
                }}
              />
              <span className="text-sm">{option.label}</span>
              <span className="meta ml-auto">{option.hint}</span>
            </label>
          ))}
        </div>
      </Card>

      <Card>
        <div className="section-title">
          <h2>安装到桌面</h2>
          <Badge tone={standalone || offlineReady ? 'default' : 'warn'}>
            {standalone
              ? '已安装'
              : offlineReady
                ? '离线就绪'
                : import.meta.env.DEV
                  ? '开发模式未启用'
                  : '未启用离线缓存'}
          </Badge>
        </div>
        <p className="muted">
          安装后以独立窗口全屏使用，断网也能打开已缓存的页面；资料仍只保存在本机浏览器，不会上传。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={!installPrompt}
            onClick={() => {
              const event = installPrompt;
              if (!event) return;
              setInstallPrompt(null);
              void event.prompt();
            }}
          >
            <IconDownload size={16} /> 安装到桌面
          </Button>
          <span className="muted">
            {installPrompt
              ? '浏览器已允许安装，点击即可添加到桌面。'
              : import.meta.env.DEV
                ? '开发预览不注册离线缓存（避免缓存开发资源），安装功能仅生产构建可用。'
                : 'iOS Safari 可用「分享 → 添加到主屏幕」；Chrome / Edge 可从地址栏右侧的安装图标添加。'}
          </span>
        </div>
      </Card>

      <Card>
        <div className="section-title">
          <h2>版本与更新</h2>
          <Badge tone={update?.state.waiting ? 'warn' : 'default'}>
            {update?.state.waiting
              ? '有新版本'
              : !isPwaRuntimeSupported()
                ? import.meta.env.DEV
                  ? '开发模式未启用'
                  : '未启用离线缓存'
                : '当前版本'}
          </Badge>
        </div>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="muted">当前版本</dt>
            <dd className="break-all text-xs">{describeCurrentVersion()}</dd>
          </div>
          <div>
            <dt className="muted">更新状态</dt>
            <dd>
              {update?.state.waiting
                ? update.state.waitingLabel
                  ? `新版本（${update.state.waitingLabel}）已准备好`
                  : '新版本已准备好，等待确认'
                : '暂无待安装的更新'}
            </dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            data-testid="check-update"
            onClick={() => void update?.checkNow()}
            disabled={!update || update.state.checking || update.state.activating}
          >
            <IconRefresh size={16} /> {update?.state.checking ? '检查中…' : '检查更新'}
          </Button>
          {update?.state.waiting ? (
            <Button
              variant="primary"
              data-testid="settings-update-accept"
              onClick={() => void update.accept()}
              disabled={update.state.activating}
            >
              {update.state.activating ? '更新中…' : '立即更新'}
            </Button>
          ) : null}
        </div>
        {update?.resultText ? (
          <p
            data-testid="update-check-result"
            className={`mt-2 text-sm ${
              update.state.checkResult === 'error' ||
              update.state.checkResult === 'download-failed' ||
              update.state.checkResult === 'timeout'
                ? 'text-danger'
                : 'muted'
            }`}
          >
            {update.resultText}
          </p>
        ) : null}
        <p className="muted mt-2">
          更新只替换页面资源，不会改动本机资料。选择「稍后」可继续使用当前版本，之后仍可在本页「立即更新」。
        </p>
      </Card>

      <Card>
        <div className="section-title">
          <h2>资料概况</h2>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="muted">老板</dt>
            <dd className="font-semibold">{settings.data?.ownerCount ?? 0}</dd>
          </div>
          <div>
            <dt className="muted">账号</dt>
            <dd className="font-semibold">{settings.data?.accountCount ?? 0}</dd>
          </div>
          <div>
            <dt className="muted">订单</dt>
            <dd className="font-semibold">{settings.data?.orderCount ?? 0}</dd>
          </div>
          <div>
            <dt className="muted">截图</dt>
            <dd className="font-semibold">
              {settings.data?.attachmentCount ?? 0}
              <span className="muted ml-1">
                ({((settings.data?.attachmentBytes ?? 0) / 1024 / 1024).toFixed(1)} MB)
              </span>
            </dd>
          </div>
        </dl>
        <p className="muted mt-3">
          网页本地数据库不加密；备份密码只保护导出的文件。不要在公共电脑上保存账号密码。
        </p>
      </Card>

      <Modal
        open={restoreModal && Boolean(preview)}
        title="确认替换本机资料"
        onClose={() => {
          if (!preview) return;
          void services.restore.cancelRestore(preview.sessionId);
          setRestoreModal(false);
          setPreview(null);
        }}
        footer={
          <>
            <Button
              onClick={() => {
                if (!preview) return;
                void services.restore.cancelRestore(preview.sessionId);
                setRestoreModal(false);
                setPreview(null);
              }}
              disabled={busy}
            >
              取消
            </Button>
            <Button variant="danger" onClick={confirmRestore} disabled={busy || !backedUp}>
              替换本机资料
            </Button>
          </>
        }
      >
        {preview ? (
          <div className="flex flex-col gap-3 text-sm">
            <p className="rounded-xl border border-warn/40 bg-[#fbeed6] px-3 py-2 text-warn">
              这会整份替换当前资料，不合并两台设备的编辑。
            </p>
            <dl className="grid grid-cols-2 gap-2">
              <div>
                <dt className="muted">来源</dt>
                <dd>{preview.generator || '未知生成器'}</dd>
              </div>
              <div>
                <dt className="muted">导出时间</dt>
                <dd>{preview.exportedAt ? formatDateTime(preview.exportedAt, 'Asia/Shanghai') : '未知'}</dd>
              </div>
              <div>
                <dt className="muted">数据库版本</dt>
                <dd>schema {preview.schemaVersion}</dd>
              </div>
              <div>
                <dt className="muted">老板 / 账号</dt>
                <dd>
                  {preview.counts.owners} / {preview.counts.accounts}
                </dd>
              </div>
              <div>
                <dt className="muted">订单 / 收款</dt>
                <dd>
                  {preview.counts.orders} / {preview.counts.receipts}
                </dd>
              </div>
              <div>
                <dt className="muted">附件</dt>
                <dd>
                  {preview.counts.attachments}（{(preview.attachmentBytes / 1024 / 1024).toFixed(1)} MB）
                </dd>
              </div>
              <div>
                <dt className="muted">有效实收</dt>
                <dd>¥{formatMoney(preview.receivedCents)}</dd>
              </div>
              <div>
                <dt className="muted">待收</dt>
                <dd>¥{formatMoney(preview.outstandingCents)}</dd>
              </div>
            </dl>
            <label className="flex items-start gap-2 rounded-xl border border-line bg-white/70 px-3 py-2">
              <input
                type="checkbox"
                checked={backedUp}
                onChange={(event) => setBackedUp(event.target.checked)}
                className="mt-1"
              />
              <span>
                我已另行保存当前资料（推荐先导出完整备份），确认继续替换。
              </span>
            </label>
            <ErrorText message={error} />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
