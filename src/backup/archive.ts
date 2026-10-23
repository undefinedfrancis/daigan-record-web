import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { AppError } from '../contracts/errors';
import type { BackupAttachmentEntry, Snapshot } from '../contracts/backup';
import { GENERATOR } from '../contracts/backup';
import type { SchemaVersion } from '../contracts/tables';
import { BUSINESS_TABLES, LIMITS } from '../contracts/tables';
import { decodeData, encodeData, type ColumnPresence } from './dataCodec';
import { columnsFor, TABLE_SPECS } from './catalog';
import { CURRENT_SCHEMA } from '../contracts/tables';
import { decryptArchive, encryptArchive, isEncryptedEnvelope, sha256Hex } from './crypto';
import {
  assertArchiveSize,
  assertAttachmentCount,
  assertAttachmentSize,
  assertAttachmentTotal,
  assertCollectionRatio,
  assertDataJsonSize,
  assertEntryCount,
  assertRowCount,
} from './limits';

export const MANIFEST_FORMAT = 'daigan-backup';
export const MANIFEST_FORMAT_VERSION = 1;

export interface BackupManifest {
  format: string;
  formatVersion: number;
  schemaVersion: SchemaVersion;
  exportedAt: number;
  generator: string;
  tableCounts: Record<string, number>;
  dataSha256: string;
  attachments: BackupAttachmentEntry[];
  attachmentTotalBytes: number;
}

const ATTACHMENT_PREFIX = 'attachments/';

/** jsdom 的 Blob 没有 arrayBuffer()，统一走 FileReader 兜底。 */
export async function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsArrayBuffer(blob);
  });
}

function safeAttachmentName(name: string): string {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new AppError('BACKUP_FORMAT', `附件路径不合法：${name}`);
  }
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(text: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('BACKUP_FORMAT', 'manifest.json 不是有效 JSON');
  }
  if (!isRecord(parsed)) throw new AppError('BACKUP_FORMAT', 'manifest.json 顶层必须是对象');
  if (parsed.format !== MANIFEST_FORMAT) {
    throw new AppError('BACKUP_FORMAT', '这不是代肝记录备份文件');
  }
  if (parsed.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new AppError('BACKUP_FORMAT', `不支持的备份格式版本：${String(parsed.formatVersion)}`);
  }
  const schema = parsed.schemaVersion;
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 7 || schema > CURRENT_SCHEMA) {
    throw new AppError('BACKUP_FORMAT', `不支持的数据库版本：${String(schema)}`);
  }
  if (typeof parsed.dataSha256 !== 'string') {
    throw new AppError('BACKUP_FORMAT', '清单缺少数据校验和');
  }
  if (!isRecord(parsed.tableCounts)) {
    throw new AppError('BACKUP_FORMAT', '清单缺少表数量');
  }
  if (!Array.isArray(parsed.attachments)) {
    throw new AppError('BACKUP_FORMAT', '清单缺少附件列表');
  }
  const attachments: BackupAttachmentEntry[] = parsed.attachments.map((entry) => {
    if (!isRecord(entry)) throw new AppError('BACKUP_FORMAT', '附件清单项必须是对象');
    // 安卓清单用 relativePath；网页端早期导出用 name。
    const rawPath = typeof entry.relativePath === 'string' ? entry.relativePath : entry.name;
    const { id, mimeType, sizeBytes, sha256 } = entry;
    if (typeof id !== 'string' || typeof rawPath !== 'string' || typeof mimeType !== 'string') {
      throw new AppError('BACKUP_FORMAT', '附件清单字段不完整');
    }
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes)) {
      throw new AppError('BACKUP_FORMAT', '附件大小必须是整数');
    }
    if (typeof sha256 !== 'string') throw new AppError('BACKUP_FORMAT', '附件缺少校验和');
    return { id, name: safeAttachmentName(rawPath), mimeType, sizeBytes, sha256 };
  });
  return {
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    schemaVersion: schema as SchemaVersion,
    exportedAt: typeof parsed.exportedAt === 'number' ? parsed.exportedAt : 0,
    generator: typeof parsed.generator === 'string' ? parsed.generator : '',
    tableCounts: parsed.tableCounts as Record<string, number>,
    dataSha256: parsed.dataSha256,
    attachments,
    attachmentTotalBytes:
      typeof parsed.attachmentTotalBytes === 'number'
        ? parsed.attachmentTotalBytes
        : attachments.reduce((sum, item) => sum + item.sizeBytes, 0),
  };
}

export async function extractArchive(file: Blob, password?: string): Promise<{
  manifest: BackupManifest;
  dataText: string;
  files: Map<string, Uint8Array>;
}> {
  assertArchiveSize(file.size);
  let bytes: Uint8Array = await bytesOf(file);
  if (isEncryptedEnvelope(bytes)) {
    if (!password) throw new AppError('BACKUP_PASSWORD', '该备份已加密，请输入密码');
    bytes = await decryptArchive(bytes, password);
    assertArchiveSize(bytes.length);
  } else if (password) {
    // 普通归档不需要密码；用户填了密码也允许，但不能当作已解密。
    password = undefined;
  }

  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  try {
    const entries = await reader.getEntries();
    assertEntryCount(entries.length);
    const files = new Map<string, Uint8Array>();
    const seen = new Set<string>();
    let attachmentTotal = 0;
    let attachmentCount = 0;

    for (const entry of entries) {
      const name = entry.filename;
      if (entry.directory) throw new AppError('BACKUP_FORMAT', `归档不允许目录条目：${name}`);
      if (seen.has(name)) throw new AppError('BACKUP_FORMAT', `归档包含重复条目：${name}`);
      seen.add(name);

      const isManifest = name === 'manifest.json';
      const isData = name === 'data.json';
      const isAttachment = name.startsWith(ATTACHMENT_PREFIX);
      if (!isManifest && !isData && !isAttachment) {
        throw new AppError('BACKUP_FORMAT', `归档包含未知条目：${name}`);
      }

      const size = entry.uncompressedSize ?? 0;
      assertCollectionRatio(size, entry.compressedSize ?? 0);

      if (isManifest && size > LIMITS.maxManifestBytes) {
        throw new AppError('BACKUP_LIMIT', '清单文件超过 1 MiB 上限');
      }
      if (isData) assertDataJsonSize(size);
      if (isAttachment) {
        assertAttachmentSize(size);
        attachmentCount += 1;
        assertAttachmentCount(attachmentCount);
        attachmentTotal += size;
        assertAttachmentTotal(attachmentTotal);
        const fileName = name.slice(ATTACHMENT_PREFIX.length);
        safeAttachmentName(fileName);
      }

      const data = await entry.getData(new Uint8ArrayWriter(), { checkSignature: true });
      files.set(name, data);
    }

    const manifestBytes = files.get('manifest.json');
    if (!manifestBytes) throw new AppError('BACKUP_FORMAT', '归档缺少 manifest.json');
    const dataBytes = files.get('data.json');
    if (!dataBytes) throw new AppError('BACKUP_FORMAT', '归档缺少 data.json');

    const manifest = parseManifest(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    const dataHash = await sha256Hex(dataBytes);
    if (dataHash !== manifest.dataSha256.toLowerCase()) {
      throw new AppError('BACKUP_CHECKSUM', '数据校验和不匹配，文件可能已损坏');
    }
    const dataText = new TextDecoder('utf-8', { fatal: true }).decode(dataBytes);
    files.delete('manifest.json');
    files.delete('data.json');
    return { manifest, dataText, files };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('BACKUP_FORMAT', '无法读取归档内容');
  } finally {
    await reader.close().catch(() => undefined);
  }
}

export async function readArchive(
  file: Blob,
  password?: string,
): Promise<{ snapshot: Snapshot; columnsByTable: ColumnPresence }> {
  const { manifest, dataText, files } = await extractArchive(file, password);
  const decoded = decodeData(dataText, manifest.schemaVersion);
  const data = decoded.data;
  assertRowCount(data as unknown as Record<string, unknown[]>);

  for (const table of BUSINESS_TABLES) {
    const expected = manifest.tableCounts[table];
    if (typeof expected === 'number' && expected !== data[table].length) {
      throw new AppError('BACKUP_FORMAT', `表 ${table} 行数与清单不一致`);
    }
    if (data[table].length > 0 && columnsFor(table).length === 0) {
      throw new AppError('BACKUP_FORMAT', `表 ${table} 列目录缺失`);
    }
  }

  const attachments = new Map<string, Blob>();
  const declared = new Map(manifest.attachments.map((item) => [item.name, item]));
  if (manifest.attachments.length !== files.size) {
    throw new AppError('BACKUP_FORMAT', '附件数量与清单不一致');
  }
  for (const row of data.attachments) {
    const entry = declared.get(row.relativePath);
    if (!entry) {
      throw new AppError('BACKUP_FORMAT', `附件 ${row.relativePath} 未登记在清单中`);
    }
    if (entry.id !== row.id) {
      throw new AppError('BACKUP_FORMAT', `附件 ${row.relativePath} 编号与清单不一致`);
    }
    if (entry.mimeType !== row.mimeType || entry.sizeBytes !== row.sizeBytes) {
      throw new AppError('BACKUP_FORMAT', `附件 ${row.relativePath} 元数据与清单不一致`);
    }
    const bytes = files.get(`${ATTACHMENT_PREFIX}${row.relativePath}`);
    if (!bytes) throw new AppError('BACKUP_FORMAT', `归档缺少附件：${row.relativePath}`);
    if (bytes.length !== row.sizeBytes) {
      throw new AppError('BACKUP_CHECKSUM', `附件字节数与记录不一致：${row.relativePath}`);
    }
    const hash = await sha256Hex(bytes);
    if (hash !== entry.sha256.toLowerCase()) {
      throw new AppError('BACKUP_CHECKSUM', `附件校验和不匹配：${row.relativePath}`);
    }
    attachments.set(row.id, new Blob([bytes as unknown as BlobPart], { type: row.mimeType }));
  }

  return {
    snapshot: {
      data,
      attachments,
      meta: {
        generator: manifest.generator,
        exportedAt: manifest.exportedAt,
        schemaVersion: manifest.schemaVersion,
        tableCounts: manifest.tableCounts,
      },
    },
    columnsByTable: decoded.columnsByTable,
  };
}

export async function writeArchive(snapshot: Snapshot, password?: string): Promise<Blob> {
  const dataText = encodeData(snapshot.data);
  const dataBytes = new TextEncoder().encode(dataText);
  assertDataJsonSize(dataBytes.length);

  const attachmentRows = snapshot.data.attachments;
  assertAttachmentCount(attachmentRows.length);

  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  const entries: BackupAttachmentEntry[] = [];
  const blobs: { name: string; bytes: Uint8Array }[] = [];
  let attachmentTotal = 0;

  for (const row of attachmentRows) {
    const blob = snapshot.attachments.get(row.id);
    if (!blob) {
      throw new AppError('BACKUP_VALIDATION', `缺少附件内容：${row.relativePath}`);
    }
    assertAttachmentSize(blob.size);
    attachmentTotal += blob.size;
    assertAttachmentTotal(attachmentTotal);
    const bytes = await bytesOf(blob);
    if (bytes.length !== row.sizeBytes) {
      throw new AppError('BACKUP_VALIDATION', `附件字节数与记录不一致：${row.relativePath}`);
    }
    const name = safeAttachmentName(row.relativePath);
    entries.push({
      id: row.id,
      name,
      mimeType: row.mimeType,
      sizeBytes: bytes.length,
      sha256: await sha256Hex(bytes),
    });
    blobs.push({ name, bytes });
  }

  const dataSha256 = await sha256Hex(dataBytes);
  const tableCounts = {} as Record<string, number>;
  for (const table of BUSINESS_TABLES) tableCounts[table] = snapshot.data[table].length;

  const manifest: BackupManifest = {
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA,
    exportedAt: Date.now(),
    generator: GENERATOR,
    tableCounts,
    dataSha256,
    attachments: entries,
    attachmentTotalBytes: attachmentTotal,
  };
  // 附件字段名与安卓 BackupManifestCodec 对齐（relativePath）。
  const manifestJson = {
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
    exportedAt: manifest.exportedAt,
    generator: manifest.generator,
    dataSha256: manifest.dataSha256,
    tableCounts: manifest.tableCounts,
    attachmentTotalBytes: manifest.attachmentTotalBytes,
    attachments: manifest.attachments.map((entry) => ({
      id: entry.id,
      relativePath: entry.name,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    })),
  };

  try {
    await writer.add(
      'manifest.json',
      new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(manifestJson))),
      { level: 6 },
    );
    await writer.add('data.json', new Uint8ArrayReader(dataBytes), {
      level: 6,
    });
    for (const entry of blobs) {
      // 必须 DEFLATE：zip.js 在流式写入时用 data descriptor（flag 0x0008），而 Java 的
      // `ZipInputStream`（安卓 `BackupArchiveReader` 的实现）对带 descriptor 的 **STORED**
      // 条目直接报 “only DEFLATED entries can have EXT descriptor”，安卓端就会把附件读短
      // 并按“大小与清单不一致”拒绝整份文件。这里对截图也用 level 6，牺牲一点体积换互通。
      await writer.add(`${ATTACHMENT_PREFIX}${entry.name}`, new Uint8ArrayReader(entry.bytes), {
        level: 6,
      });
    }
    let bytes: Uint8Array = await writer.close();
    assertArchiveSize(bytes.length);
    if (password) bytes = await encryptArchive(bytes, password);
    return new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
  } catch (error) {
    await writer.close().catch(() => undefined);
    if (error instanceof AppError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError('BACKUP_FORMAT', `生成备份文件失败：${detail}`);
  }
}

/** 当前写出的 portable 列目录（schema 15）。 */
export function tableColumnNames(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const table of BUSINESS_TABLES) result[table] = columnsFor(table);
  return result;
}

export function primaryKeyOf(table: keyof typeof TABLE_SPECS): string[] {
  return TABLE_SPECS[table].primaryKey;
}

