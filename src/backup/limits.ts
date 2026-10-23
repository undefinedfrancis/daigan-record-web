import { AppError } from '../contracts/errors';
import { BUSINESS_TABLES, LIMITS } from '../contracts/tables';

export function assertArchiveSize(bytes: number): void {
  if (bytes > LIMITS.maxArchiveBytes) {
    throw new AppError('BACKUP_LIMIT', '备份文件超过 512 MiB 上限');
  }
}

export function assertEntryCount(count: number): void {
  if (count > LIMITS.maxEntries) {
    throw new AppError('BACKUP_LIMIT', `归档条目超过 ${LIMITS.maxEntries} 个`);
  }
}

export function assertAttachmentCount(count: number): void {
  if (count > LIMITS.maxAttachments) {
    throw new AppError('BACKUP_LIMIT', `附件数量超过 ${LIMITS.maxAttachments} 个`);
  }
}

export function assertAttachmentSize(bytes: number): void {
  if (bytes > LIMITS.maxAttachmentBytes) {
    throw new AppError('BACKUP_LIMIT', '单张截图超过 32 MiB 上限');
  }
}

export function assertAttachmentTotal(bytes: number): void {
  if (bytes > LIMITS.maxAttachmentTotalBytes) {
    throw new AppError('BACKUP_LIMIT', '附件总量超过 384 MiB 上限');
  }
}

export function assertDataJsonSize(bytes: number): void {
  if (bytes > LIMITS.maxDataJsonBytes) {
    throw new AppError('BACKUP_LIMIT', '数据 JSON 超过 64 MiB 上限');
  }
}

export function assertCollectionRatio(uncompressed: number, compressed: number): void {
  if (uncompressed <= LIMITS.maxCollectionRatioAfterBytes) return;
  const ratio = compressed > 0 ? uncompressed / compressed : Number.POSITIVE_INFINITY;
  if (ratio > LIMITS.maxCollectionRatio) {
    throw new AppError('BACKUP_LIMIT', '解压比例异常，已拒绝该归档');
  }
}

export function assertRowCount(data: Record<string, unknown[]>): void {
  for (const table of BUSINESS_TABLES) {
    const rows = data[table];
    if (!Array.isArray(rows)) {
      throw new AppError('BACKUP_FORMAT', `缺少业务表数据：${table}`);
    }
    if (rows.length > LIMITS.maxReceipts) {
      throw new AppError('BACKUP_LIMIT', `表 ${table} 行数超过上限`);
    }
  }
}
