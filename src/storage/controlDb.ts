import Dexie, { type EntityTable } from 'dexie';

export interface ActiveDatasetState {
  databaseName: string;
  generation: number;
  revision: number;
  datasetId: string;
  /** 最近一次整体恢复的会话 ID，便于诊断。 */
  lastRestoreId: string | null;
  createdAt: number;
}

export interface ControlRow {
  key: string;
  value: unknown;
}

export type RestoreStatus = 'PREPARING' | 'READY';

export interface RestoreSessionRow {
  id: string;
  databaseName: string;
  status: RestoreStatus;
  createdAt: number;
  generator: string;
  exportedAt: number;
  schemaVersion: number;
  counts: {
    owners: number;
    accounts: number;
    orders: number;
    receipts: number;
    attachments: number;
    rows: number;
  };
  receivedCents: number;
  outstandingCents: number;
  attachmentBytes: number;
}

export const CONTROL_DB_NAME = 'daigan-control';
export const ACTIVE_KEY = 'activeDataset';

class ControlDatabase extends Dexie {
  state!: EntityTable<ControlRow, 'key'>;
  sessions!: EntityTable<RestoreSessionRow, 'id'>;

  constructor() {
    super(CONTROL_DB_NAME);
    this.version(1).stores({ state: 'key' });
    this.version(2).stores({ state: 'key', sessions: 'id, status' });
  }
}

let instance: ControlDatabase | null = null;

export function resetControlDb(): void {
  if (!instance) return;
  try {
    instance.close();
  } catch {
    // 忽略重复关闭。
  }
  instance = null;
}

export function controlDb(): ControlDatabase {
  if (!instance) {
    instance = new ControlDatabase();
    instance.on('versionchange', () => instance?.close());
  }
  return instance;
}

export async function readActiveState(): Promise<ActiveDatasetState | null> {
  const row = await controlDb().state.get(ACTIVE_KEY);
  if (!row) return null;
  return row.value as ActiveDatasetState;
}

export async function writeActiveState(state: ActiveDatasetState): Promise<void> {
  await controlDb().state.put({ key: ACTIVE_KEY, value: state });
}
