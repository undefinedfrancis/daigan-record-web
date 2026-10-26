import { useEffect, useState } from 'react';
import { Button, ErrorText, Field, Modal, Select, TextInput } from '../../components/ui';
import { toAppError } from '../../contracts/errors';
import { fromDateTimeInput, toDateTimeInput } from '../orders/orderUtils';

export interface ReminderTaskOption {
  id: string;
  title: string;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * 设置一条站内提醒（UF-053）。
 *
 * 提醒只存在本机：不进备份、不同步安卓；到点后下次打开网站弹窗提示。
 */
export function ReminderDialog({
  open,
  tasks,
  initialTaskId,
  onClose,
  onSave,
}: {
  open: boolean;
  tasks: ReminderTaskOption[];
  /** 从任务行进入时预选该任务；null 表示整笔订单。 */
  initialTaskId: string | null;
  onClose: () => void;
  onSave: (input: { taskId: string | null; remindAt: number; note: string | null }) => Promise<void>;
}) {
  const [taskId, setTaskId] = useState(initialTaskId ?? '');
  const [remindAt, setRemindAt] = useState(() => toDateTimeInput(Date.now() + HOUR_MS));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTaskId(initialTaskId ?? '');
    setRemindAt(toDateTimeInput(Date.now() + HOUR_MS));
    setNote('');
    setError(null);
  }, [open, initialTaskId]);

  async function submit() {
    if (!remindAt) {
      setError('请选择提醒时间');
      return;
    }
    const stamp = fromDateTimeInput(remindAt);
    setBusy(true);
    setError(null);
    try {
      await onSave({ taskId: taskId || null, remindAt: stamp, note: note.trim() || null });
      onClose();
    } catch (reason) {
      setError(toAppError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="设置提醒"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="提醒对象">
          <Select
            aria-label="提醒对象"
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
          >
            <option value="">整笔订单</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                任务：{task.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="提醒时间" hint="到点后打开网站会弹窗提醒；只在本机生效">
          <TextInput
            aria-label="提醒时间"
            type="datetime-local"
            value={remindAt}
            onChange={(event) => setRemindAt(event.target.value)}
          />
        </Field>
        <Field label="备注（可选）" hint="例如：收尾款、确认续期">
          <TextInput
            aria-label="提醒备注"
            value={note}
            maxLength={200}
            placeholder="到点弹窗里显示的内容"
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <ErrorText message={error} />
      </div>
    </Modal>
  );
}
