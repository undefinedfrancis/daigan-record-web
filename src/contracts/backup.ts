import type { BackupDataSet, SchemaVersion } from './tables';

export interface BackupAttachmentEntry {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface SnapshotMeta {
  generator: string;
  exportedAt: number;
  schemaVersion: SchemaVersion;
  tableCounts: Record<string, number>;
}

export interface Snapshot {
  data: BackupDataSet;
  /** 附件 ID → 原始字节。 */
  attachments: Map<string, Blob>;
  meta?: SnapshotMeta;
}

export const GENERATOR = 'daigan-record-web/0.1.0';
