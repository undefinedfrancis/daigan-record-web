import type { Table, Transaction } from 'dexie';
import Dexie from 'dexie';
import { AppError } from '../contracts/errors';
import type { BackupDataSet, TableName, TableRows } from '../contracts/tables';
import { BUSINESS_TABLES } from '../contracts/tables';
import {
  BusinessDatabase,
  type DatasetMetaRow,
  loadDataSet,
  openBusinessDb,
} from './businessDb';
import { type ActiveDatasetState, readActiveState, writeActiveState } from './controlDb';
import { broadcastDatasetChange, withDatasetLock } from './locks';

export interface DatasetToken {
  databaseName: string;
  generation: number;
}

export interface ReadContext {
  token: DatasetToken;
  data: BackupDataSet;
  /** 只读访问本机扩展表（附件字节、颜色标记）用。 */
  db: BusinessDatabase;
}

export interface WriteContext extends ReadContext {
  tx: Transaction;
  table<K extends TableName>(name: K): Table<TableRows[K], string | number>;
}

export interface ExclusiveContext {
  token: DatasetToken;
  state: ActiveDatasetState;
  switchTo(databaseName: string, restoreId: string | null): Promise<DatasetToken>;
}

export interface RuntimeOptions {
  newId: () => string;
  now: () => number;
}

export const DATASET_META_ID = 'dataset';

export class DatasetRuntime {
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(options: RuntimeOptions) {
    this.newId = options.newId;
    this.now = options.now;
  }

  async init(): Promise<DatasetToken> {
    return withDatasetLock(async () => {
      const state = await readActiveState();
      if (!state) {
        const created = await this.createEmptyDataset();
        return { databaseName: created.databaseName, generation: created.generation };
      }
      await this.assertHealthy(state.databaseName);
      return { databaseName: state.databaseName, generation: state.generation };
    });
  }

  async current(): Promise<DatasetToken> {
    const state = await readActiveState();
    if (!state) throw new AppError('STORAGE_UNAVAILABLE', '尚未创建本机资料');
    return { databaseName: state.databaseName, generation: state.generation };
  }

  async revision(): Promise<number> {
    const state = await readActiveState();
    return state?.revision ?? 0;
  }

  async read<T>(fn: (ctx: ReadContext) => Promise<T> | T): Promise<T> {
    return withDatasetLock(async () => {
      const state = await this.requireState();
      const db = openBusinessDb(state.databaseName);
      try {
        const data = await loadDataSet(db);
        return await fn({
          token: { databaseName: state.databaseName, generation: state.generation },
          data,
          db,
        });
      } finally {
        db.close();
      }
    });
  }

  async readBlob(id: string): Promise<Blob | null> {
    return withDatasetLock(async () => {
      const state = await this.requireState();
      const db = openBusinessDb(state.databaseName);
      try {
        const row = await db.attachmentBlobs.get(id);
        return row?.blob ?? null;
      } finally {
        db.close();
      }
    });
  }

  async readBlobs(ids: string[]): Promise<Map<string, Blob>> {
    return withDatasetLock(async () => {
      const state = await this.requireState();
      const db = openBusinessDb(state.databaseName);
      try {
        const rows = await db.attachmentBlobs.bulkGet(ids);
        const result = new Map<string, Blob>();
        rows.forEach((row, index) => {
          if (row) result.set(ids[index], row.blob);
        });
        return result;
      } finally {
        db.close();
      }
    });
  }

  async write<T>(expected: DatasetToken, fn: (ctx: WriteContext) => Promise<T>): Promise<T> {
    return withDatasetLock(async () => {
      const state = await this.requireState();
      this.assertToken(expected, state);
      const db = openBusinessDb(state.databaseName);
      let result: T;
      try {
        result = await db.transaction('rw', db.tables, async (tx) => {
          const data = await loadDataSet(db);
          const ctx: WriteContext = {
            token: { databaseName: state.databaseName, generation: state.generation },
            data,
            db,
            tx,
            table: <K extends TableName>(name: K) =>
              tx.table(name) as unknown as Table<TableRows[K], string | number>,
          };
          return fn(ctx);
        });
      } finally {
        db.close();
      }
      await this.bumpRevision(state);
      return result;
    });
  }

  async exclusive<T>(fn: (ctx: ExclusiveContext) => Promise<T>): Promise<T> {
    return withDatasetLock(async () => {
      const state = await this.requireState();
      const ctx: ExclusiveContext = {
        token: { databaseName: state.databaseName, generation: state.generation },
        state,
        switchTo: async (databaseName: string, restoreId: string | null) => {
          const next: ActiveDatasetState = {
            databaseName,
            generation: state.generation + 1,
            revision: state.revision + 1,
            datasetId: databaseName,
            lastRestoreId: restoreId,
            createdAt: state.createdAt,
          };
          await writeActiveState(next);
          const token = { databaseName: next.databaseName, generation: next.generation };
          broadcastDatasetChange({
            type: 'dataset-changed',
            generation: token.generation,
            databaseName: token.databaseName,
          });
          return token;
        },
      };
      return fn(ctx);
    });
  }

  async assertHealthy(databaseName: string): Promise<void> {
    const exists = await Dexie.exists(databaseName);
    if (!exists) {
      throw new AppError(
        'STORAGE_UNAVAILABLE',
        '本机活动资料数据库不存在。请从备份恢复，或明确新建空账本；网页不会自动清空现有状态。',
      );
    }
    const db = openBusinessDb(databaseName);
    try {
      const meta = await db.dataset_meta.get(DATASET_META_ID);
      if (!meta) {
        throw new AppError('STORAGE_UNAVAILABLE', '本机资料不完整，已保留现场并停止写入');
      }
    } finally {
      db.close();
    }
  }

  async createEmptyDataset(): Promise<ActiveDatasetState> {
    const databaseName = `daigan-data-${this.newId()}`;
    const db = openBusinessDb(databaseName);
    try {
      const meta: DatasetMetaRow = {
        id: DATASET_META_ID,
        datasetId: databaseName,
        createdAt: this.now(),
      };
      await db.dataset_meta.put(meta);
    } finally {
      db.close();
    }
    const previous = await readActiveState();
    const state: ActiveDatasetState = {
      databaseName,
      generation: (previous?.generation ?? 0) + 1,
      revision: 1,
      datasetId: databaseName,
      lastRestoreId: null,
      createdAt: this.now(),
    };
    await writeActiveState(state);
    broadcastDatasetChange({
      type: 'dataset-changed',
      generation: state.generation,
      databaseName,
    });
    return state;
  }

  /** 恢复后清理旧数据库；失败不回滚指针。 */
  async dropDatabase(databaseName: string): Promise<void> {
    try {
      await Dexie.delete(databaseName);
    } catch {
      // 清理失败可稍后重试，活动指针已提交。
    }
  }

  private async requireState(): Promise<ActiveDatasetState> {
    const state = await readActiveState();
    if (!state) throw new AppError('STORAGE_UNAVAILABLE', '尚未创建本机资料');
    return state;
  }

  private assertToken(expected: DatasetToken, actual: ActiveDatasetState): void {
    if (
      expected.databaseName !== actual.databaseName ||
      expected.generation !== actual.generation
    ) {
      throw new AppError('STALE_DATASET', '本机资料已切换，请刷新页面后重试');
    }
  }

  private async bumpRevision(state: ActiveDatasetState): Promise<void> {
    const next: ActiveDatasetState = { ...state, revision: state.revision + 1 };
    await writeActiveState(next);
  }
}

export function businessTableNames(): readonly TableName[] {
  return BUSINESS_TABLES;
}
