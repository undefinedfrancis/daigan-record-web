import type { Snapshot } from '../contracts/backup';
import type { DatasetRuntime, DatasetToken } from '../storage/datasetRuntime';
import { writeArchive } from './archive';

export interface ExportResult {
  blob: Blob;
  token: DatasetToken;
  exportedAt: number;
  attachmentCount: number;
  attachmentBytes: number;
}

export interface ExportDeps {
  runtime: DatasetRuntime;
  now: () => number;
}

/** 在锁内取一致快照，释放锁后再压缩与加密。 */
export function createExportService({ runtime, now }: ExportDeps) {
  async function snapshotCurrent(): Promise<{ snapshot: Snapshot; token: DatasetToken }> {
    const { data, token } = await runtime.read((ctx) => ({ data: ctx.data, token: ctx.token }));
    const blobs = await runtime.readBlobs(data.attachments.map((row) => row.id));
    return { snapshot: { data, attachments: blobs }, token };
  }

  async function exportCurrent(password?: string): Promise<ExportResult> {
    const { snapshot, token } = await snapshotCurrent();
    const blob = await writeArchive(snapshot, password);
    return {
      blob,
      token,
      exportedAt: now(),
      attachmentCount: snapshot.attachments.size,
      attachmentBytes: snapshot.data.attachments.reduce((sum, row) => sum + row.sizeBytes, 0),
    };
  }

  return { exportCurrent, snapshotCurrent };
}
