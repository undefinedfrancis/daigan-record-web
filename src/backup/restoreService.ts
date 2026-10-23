import Dexie from 'dexie';
import { AppError } from '../contracts/errors';
import { receivablesOf } from '../domain/ledger';
import { reconstructDerivedState, type ReconstructionReport } from '../domain/derivedState';
import type { DatasetRuntime, DatasetToken } from '../storage/datasetRuntime';
import { DATASET_META_ID } from '../storage/datasetRuntime';
import { loadDataSet, openBusinessDb, writeDataSet } from '../storage/businessDb';
import {
  type RestoreSessionRow,
  controlDb,
} from '../storage/controlDb';
import { readArchive } from './archive';
import { normalizeDecodedDataset, type NormalizeResult } from './normalize';
import { ValidatedSnapshot } from './validateSnapshot';

export interface RestorePreview {
  sessionId: string;
  databaseName: string;
  baseToken: DatasetToken;
  generator: string;
  exportedAt: number;
  /** 源文件声明的便携 schema。 */
  schemaVersion: number;
  /** 规范化后的目标便携 schema。 */
  targetSchemaVersion: number;
  /** 实际执行的迁移 id 与计数（旧文件才会非空）。 */
  migrations: string[];
  migrationCounts: Record<string, number>;
  migrationNotes: string[];
  /** 恢复期派生态重建的结果（缓存/轮次/订单完成都是从权威记录重算的）。 */
  reconstruction: ReconstructionReport;
  counts: RestoreSessionRow['counts'];
  receivedCents: number;
  outstandingCents: number;
  attachmentBytes: number;
}

const STALE_SESSION_MS = 10 * 60 * 1000;

export interface RestoreDeps {
  runtime: DatasetRuntime;
  newId: () => string;
  now: () => number;
}

export function createRestoreService({ runtime, newId, now }: RestoreDeps) {
  async function prepareRestore(file: Blob, password?: string): Promise<RestorePreview> {
    const baseToken = await runtime.current();
    const { snapshot: raw, columnsByTable } = await readArchive(file, password);
    // 顺序固定（S2-R3）：
    // 1. 解码 + 白名单内的 legacy 归一；
    // 2. 校验**权威**结构与引用（派生的陈旧缓存不能否决整份数据）；
    // 3. 从权威记录重建派生值（轮次完成度、累计缓存、订单完成）；
    // 4. 校验候选数据集（此时派生值也必须自洽）；
    // 5. 写候选库并读回校验；
    // 6. 只有全部成功才由 commitRestore 激活。
    const normalized: NormalizeResult = normalizeDecodedDataset({
      data: raw.data,
      columnsByTable,
      schemaVersion: raw.meta?.schemaVersion ?? 8,
    });
    ValidatedSnapshot.of(raw, { phase: 'authoritative' });
    const reconstruction = reconstructDerivedState(raw.data);
    const validated = ValidatedSnapshot.of(raw, { phase: 'candidate' });
    const snapshot = validated.snapshot;
    const sessionId = newId();
    const databaseName = `daigan-data-${newId()}`;

    const rows = Object.values(snapshot.data).reduce((sum, table) => sum + table.length, 0);
    const attachmentBytes = snapshot.data.attachments.reduce((sum, row) => sum + row.sizeBytes, 0);
    const receivables = receivablesOf(snapshot.data);

    const session: RestoreSessionRow = {
      id: sessionId,
      databaseName,
      status: 'PREPARING',
      createdAt: now(),
      generator: snapshot.meta?.generator ?? '',
      exportedAt: snapshot.meta?.exportedAt ?? 0,
      schemaVersion: snapshot.meta?.schemaVersion ?? 8,
      counts: {
        owners: snapshot.data.owners.length,
        accounts: snapshot.data.game_accounts.length,
        orders: snapshot.data.orders.length,
        receipts: snapshot.data.receipts.length,
        attachments: snapshot.data.attachments.length,
        rows,
      },
      receivedCents: snapshot.data.receipts
        .filter((receipt) => receipt.status === 'ACTIVE')
        .reduce((sum, receipt) => sum + receipt.amountCents, 0),
      outstandingCents: receivables.reduce((sum, item) => sum + item.outstandingCents, 0),
      attachmentBytes,
    };
    await controlDb().sessions.put(session);

    try {
      const db = openBusinessDb(databaseName);
      try {
        await db.dataset_meta.put({
          id: DATASET_META_ID,
          datasetId: databaseName,
          createdAt: now(),
        });
        await writeDataSet(db, snapshot.data, snapshot.attachments);
        // 读回候选库并再校验一次：写库阶段的转换（缺列补 null、索引重建）不能让
        // 一份"预览时合法"的数据变成"实际存进去不合法"的数据。
        const written = await loadDataSet(db);
        for (const [table, rows] of Object.entries(snapshot.data)) {
          const stored = (written as Record<string, unknown[]>)[table] ?? [];
          if (stored.length !== (rows as unknown[]).length) {
            throw new AppError('STORAGE_UNAVAILABLE', `候选资料写入不完整：${table}`);
          }
        }
        ValidatedSnapshot.of({ data: written, attachments: snapshot.attachments }, { phase: 'candidate' });
      } finally {
        db.close();
      }
      await runtime.assertHealthy(databaseName);
      await controlDb().sessions.put({ ...session, status: 'READY' });
    } catch (error) {
      await controlDb().sessions.delete(sessionId);
      await Dexie.delete(databaseName).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError('STORAGE_UNAVAILABLE', '写入候选资料失败，可能是存储空间不足');
    }

    const receivedCents = snapshot.data.receipts
      .filter((receipt) => receipt.status === 'ACTIVE')
      .reduce((sum, receipt) => sum + receipt.amountCents, 0);

    return {
      sessionId,
      databaseName,
      baseToken,
      generator: session.generator,
      exportedAt: session.exportedAt,
      schemaVersion: session.schemaVersion,
      targetSchemaVersion: 15,
      migrations: normalized.report.applied,
      migrationCounts: normalized.report.counts,
      migrationNotes: normalized.report.notes,
      reconstruction,
      counts: session.counts,
      receivedCents,
      outstandingCents: session.outstandingCents,
      attachmentBytes,
    };
  }

  async function commitRestore(sessionId: string, expected: DatasetToken): Promise<DatasetToken> {
    const session = await controlDb().sessions.get(sessionId);
    if (!session) throw new AppError('NOT_FOUND', '恢复会话不存在或已取消');
    if (session.status !== 'READY') {
      throw new AppError('CONFLICT', '恢复尚未准备完成');
    }
    return runtime.exclusive(async (ctx) => {
      if (
        ctx.token.databaseName !== expected.databaseName ||
        ctx.token.generation !== expected.generation
      ) {
        throw new AppError('STALE_DATASET', '本机资料已变更，请重新预览后再恢复');
      }
      await runtime.assertHealthy(session.databaseName);
      const previous = ctx.token.databaseName;
      const token = await ctx.switchTo(session.databaseName, sessionId);
      await controlDb().sessions.delete(sessionId);
      await runtime.dropDatabase(previous);
      return token;
    });
  }

  async function cancelRestore(sessionId: string): Promise<void> {
    const session = await controlDb().sessions.get(sessionId);
    if (!session) return;
    await controlDb().sessions.delete(sessionId);
    await Dexie.delete(session.databaseName).catch(() => undefined);
  }

  async function recover(): Promise<DatasetToken> {
    const token = await runtime.init();
    const sessions = await controlDb().sessions.toArray();
    for (const session of sessions) {
      if (session.status === 'PREPARING' && now() - session.createdAt > STALE_SESSION_MS) {
        await cancelRestore(session.id);
      }
    }
    return token;
  }

  return { prepareRestore, commitRestore, cancelRestore, recover };
}

export type RestoreService = ReturnType<typeof createRestoreService>;
