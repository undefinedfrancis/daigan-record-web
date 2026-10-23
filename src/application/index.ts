import type { Snapshot } from '../contracts/backup';
import { createExportService } from '../backup/exportService';
import { createRestoreService } from '../backup/restoreService';
import { DatasetRuntime } from '../storage/datasetRuntime';
import { createAccountServices } from './accounts';
import { createAttachmentServices } from './attachments';
import type { Services } from './contracts';
import { createCumulativeServices } from './cumulative';
import { createOrderServices } from './orders';
import { createQueryServices } from './queries';
import { createReceiptServices } from './receipts';
import { createServerOptionServices } from './serverOptions';
import { createTaskServices } from './tasks';
import { createTemplateServices } from './templates';

export interface AppServices extends Services {
  runtime: DatasetRuntime;
  exportSnapshot(): Promise<Snapshot>;
  restore: ReturnType<typeof createRestoreService>;
  exportBackup: ReturnType<typeof createExportService>;
}

export function createServices(
  runtime: DatasetRuntime,
  clock: () => number,
  newId: () => string,
): AppServices {
  const deps = { runtime, now: clock, newId };
  const accounts = createAccountServices(deps);
  const serverOptions = createServerOptionServices(deps);
  const templates = createTemplateServices(deps);
  const orders = createOrderServices(deps);
  const receipts = createReceiptServices(deps);
  const tasks = createTaskServices(deps);
  const progress = createCumulativeServices(deps);
  const attachments = createAttachmentServices(deps);
  const queries = createQueryServices(deps);
  const exportService = createExportService({ runtime, now: clock });
  const restore = createRestoreService(deps);

  return {
    runtime,
    accounts,
    serverOptions,
    templates,
    orders,
    receipts,
    tasks,
    progress,
    attachments,
    queries,
    restore,
    exportBackup: exportService,
    async exportSnapshot(): Promise<Snapshot> {
      const snapshot = await exportService.snapshotCurrent();
      return snapshot.snapshot;
    },
  };
}
