import { AppError } from '../contracts/errors';
import { LIMITS } from '../contracts/tables';
import type { DatasetRuntime, DatasetToken } from '../storage/datasetRuntime';
import { assertOrderWritable } from './guards';

export interface AttachmentDeps {
  runtime: DatasetRuntime;
  newId: () => string;
  now: () => number;
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'jpg';
}

export function createAttachmentServices({ runtime, newId, now }: AttachmentDeps) {
  async function put(
    target: { taskId: string } | { occurrenceId: string },
    file: Blob,
    token: DatasetToken,
  ): Promise<string> {
    if (!file || file.size === 0) throw new AppError('INVALID_INPUT', '图片文件为空');
    if (file.size > LIMITS.maxAttachmentBytes) {
      throw new AppError('BACKUP_LIMIT', '单张截图不能超过 32 MiB');
    }
    if (!file.type.startsWith('image/')) {
      throw new AppError('INVALID_INPUT', '只支持图片文件');
    }
    return runtime.write(token, async (ctx) => {
      const id = newId();
      const relativePath = `${id}.${extensionFor(file.type)}`;

      let orderId: string | null = null;
      if ('taskId' in target) {
        const task = ctx.data.task_definitions.find((row) => row.id === target.taskId);
        if (!task) throw new AppError('NOT_FOUND', '任务不存在');
        orderId = task.orderId;
      } else {
        const occurrence = ctx.data.task_occurrences.find((row) => row.id === target.occurrenceId);
        if (!occurrence) throw new AppError('NOT_FOUND', '打卡记录不存在');
        const task = ctx.data.task_definitions.find(
          (row) => row.id === occurrence.taskDefinitionId,
        );
        if (!task) throw new AppError('NOT_FOUND', '任务不存在');
        orderId = task.orderId;
      }
      assertOrderWritable(ctx.data, orderId);

      await ctx.table('attachments').add({
        id,
        taskDefinitionId: 'taskId' in target ? target.taskId : null,
        occurrenceId: 'occurrenceId' in target ? target.occurrenceId : null,
        relativePath,
        mimeType: file.type,
        sizeBytes: file.size,
        createdAt: now(),
      });
      await ctx.db.attachmentBlobs.add({ id, blob: file });
      return id;
    });
  }

  return {
    put,
    async remove(id: string, token: DatasetToken): Promise<void> {
      await runtime.write(token, async (ctx) => {
        await ctx.table('attachments').delete(id);
        await ctx.db.attachmentBlobs.delete(id);
      });
    },
    async load(id: string): Promise<Blob | null> {
      return runtime.readBlob(id);
    },
    /** 某任务的全部截图：任务级一张 + 该任务各打卡日的截图。 */
    async listTask(taskId: string) {
      return runtime.read((ctx) => {
        const occurrenceIds = new Set(
          ctx.data.task_occurrences
            .filter((row) => row.taskDefinitionId === taskId)
            .map((row) => row.id),
        );
        return ctx.data.attachments
          .filter(
            (row) =>
              row.taskDefinitionId === taskId ||
              (row.occurrenceId !== null && occurrenceIds.has(row.occurrenceId)),
          )
          .map((row) => ({
            id: row.id,
            taskDefinitionId: row.taskDefinitionId,
            occurrenceId: row.occurrenceId,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
          }));
      });
    },
    async list(orderId: string) {
      return runtime.read((ctx) => {
        const taskIds = new Set(
          ctx.data.task_definitions
            .filter((task) => task.orderId === orderId)
            .map((task) => task.id),
        );
        const occurrenceIds = new Set(
          ctx.data.task_occurrences
            .filter((row) => taskIds.has(row.taskDefinitionId))
            .map((row) => row.id),
        );
        return ctx.data.attachments
          .filter(
            (row) =>
              (row.taskDefinitionId && taskIds.has(row.taskDefinitionId)) ||
              (row.occurrenceId && occurrenceIds.has(row.occurrenceId)),
          )
          .map((row) => ({
            id: row.id,
            taskDefinitionId: row.taskDefinitionId,
            occurrenceId: row.occurrenceId,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
          }));
      });
    },
  };
}
