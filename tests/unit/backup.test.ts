import { describe, expect, it } from 'vitest';
import { emptyDataSet, LEGACY_OPTIONAL_COLUMNS } from '../../src/backup/catalog';
import { decodeData, encodeData } from '../../src/backup/dataCodec';
import { bytesOf, readArchive, writeArchive } from '../../src/backup/archive';
import { validateSnapshot } from '../../src/backup/validateSnapshot';
import type { BackupDataSet } from '../../src/contracts/tables';
import { CURRENT_SCHEMA } from '../../src/contracts/tables';

function seedData(): { data: BackupDataSet; attachments: Map<string, Blob> } {
  const data = emptyDataSet();
  data.owners.push({
    id: 'ow1',
    number: 1,
    nickname: '测试老板',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null,
    archiveBatchId: null,
  });
  data.owner_number_sequence.push({ id: 0, nextNumber: 2 });
  data.game_accounts.push({
    id: 'ac1',
    ownerId: 'ow1',
    gameName: '测试游戏',
    server: '官服',
    uid: '10086',
    loginAccount: 'demo@example.com',
    loginMethod: 'PASSWORD',
    password: 'p@ss🔐',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    archivedAt: null,
    archiveBatchId: null,
    defaultTemplateId: null,
    loginDevice: null,
    resourceNotes: null,
    categoryId: null,
  });
  data.orders.push({
    id: 'or1',
    accountId: 'ac1',
    type: 'HOSTING',
    title: '托管到月底',
    priceCents: null,
    paymentMode: 'INSTALLMENTS',
    deadlineDate: null,
    notes: '备注 <script>alert(1)</script>',
    gameZoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 300,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    completedAt: null,
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    cancelledAt: null,
    archivedAt: null,
    hostingMode: null,
    targetSessions: null,
    orderColor: null,
    monthlyRefreshDays: null,
  });
  data.hosting_periods.push({
    id: 'pe1',
    orderId: 'or1',
    periodIndex: 0,
    startDate: '2026-02-01',
    endDate: '2026-02-28',
    priceCents: 50000,
    gameZoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 300,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    createdAt: 1700000000000,
    renewalOperationId: null,
    serviceDays: null,
    serviceWeekdays: null,
    monthlyRefreshDays: null,
    serviceCount: null,
  });
  data.task_definitions.push({
    id: 'td1',
    orderId: 'or1',
    periodId: 'pe1',
    title: '每日签到',
    progressType: 'CHECKBOX',
    startValue: '0',
    targetValue: '1',
    currentValue: '0',
    unit: null,
    recurrence: 'DAILY',
    weekdays: null,
    everyNDays: null,
    sortOrder: 0,
    completedAt: null,
    completionBatchId: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    monthDay: null,
    monthDays: null,
    retiredAt: null,
    activeFrom: null,
    activeUntil: null,
    numericMode: null,
    colorArgb: null,
  });
  data.task_occurrences.push({
    id: 'oc1',
    taskDefinitionId: 'td1',
    occurrenceKey: 'D:2026-02-02',
    gameDate: '2026-02-02',
    windowStart: null,
    windowEnd: null,
    completedAt: 1700000001000,
    recordedAt: 1700000001000,
    backfilled: 0,
    completionBatchId: null,
    value: '1',
    createdAt: 1700000001000,
  });
  data.attachments.push({
    id: 'at1',
    taskDefinitionId: null,
    occurrenceId: 'oc1',
    relativePath: 'at1.png',
    mimeType: 'image/png',
    sizeBytes: 8,
    createdAt: 1700000002000,
  });
  data.receipts.push({
    id: 'rc1',
    operationId: 'op-rc1',
    orderId: 'or1',
    periodId: 'pe1',
    amountCents: 20000,
    receivedAt: 1700000003000,
    channel: 'WECHAT',
    note: null,
    status: 'ACTIVE',
    replacedByReceiptId: null,
    createdAt: 1700000003000,
  });
  data.reminder_settings.push({
    id: 0,
    shortDeadlineEnabled: 1,
    shortDeadlineMinutes: 540,
    hostingExpiryEnabled: 1,
    hostingExpiryMinutes: 600,
    unfinishedTasksEnabled: 0,
    unfinishedTasksMinutes: 0,
    updatedAt: 1700000000000,
  });
  const attachments = new Map<string, Blob>([
    ['at1', new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/png' })],
  ]);
  return { data, attachments };
}

describe('数据编解码（schema 15）', () => {
  it('编码后可无损还原', () => {
    const { data } = seedData();
    const text = encodeData(data);
    const decoded = decodeData(text, CURRENT_SCHEMA);
    expect(decoded.data).toEqual(data);
  });

  it('新导出总是写出完整列集，且不含已退役的 serviceMode/serviceCount', () => {
    const { data } = seedData();
    const doc = JSON.parse(encodeData(data)) as {
      schemaVersion: number;
      tables: { name: string; columns: string[] }[];
    };
    expect(doc.schemaVersion).toBe(15);
    const columnsOf = (name: string) => doc.tables.find((table) => table.name === name)!.columns;
    expect(columnsOf('hosting_periods')).toContain('serviceCount');
    expect(columnsOf('hosting_periods')).toContain('monthlyRefreshDays');
    expect(columnsOf('task_definitions')).toContain('activeUntil');
    expect(columnsOf('task_definitions')).toContain('colorArgb');
    expect(columnsOf('template_tasks')).toContain('activeFrom');
    expect(columnsOf('task_progress_events')).toContain('sequence');
    expect(columnsOf('hosting_sessions')).toContain('periodId');
    expect(columnsOf('game_templates')).not.toContain('serviceMode');
    expect(columnsOf('template_categories')).not.toContain('serviceMode');
    expect(columnsOf('orders')).not.toContain('serviceCount');
  });

  it('列关系与安卓对齐：archivedAt 紧跟 cancelledAt', () => {
    const { data } = seedData();
    const doc = JSON.parse(encodeData(data)) as {
      tables: { name: string; columns: string[] }[];
    };
    const orders = doc.tables.find((table) => table.name === 'orders')!;
    expect(orders.columns.indexOf('archivedAt')).toBe(orders.columns.indexOf('cancelledAt') + 1);
  });

  it('schema 7 的旧文件缺列只允许出现在读取兼容白名单里', () => {
    const { data } = seedData();
    const parsed = JSON.parse(encodeData(data)) as {
      schemaVersion: number;
      tables: { name: string; columns: string[]; rows: unknown[][] }[];
    };
    parsed.schemaVersion = 7;
    for (const table of parsed.tables) {
      const allow = LEGACY_OPTIONAL_COLUMNS[table.name] ?? new Set<string>();
      const kept = table.columns
        .map((column, index) => ({ column, index }))
        .filter(({ column }) => !allow.has(column));
      table.columns = kept.map(({ column }) => column);
      table.rows = table.rows.map((row) => kept.map(({ index }) => row[index]));
    }
    // 旧代次的文件还可能整张表缺失：hosting_sessions 属于可省略的历史表。
    parsed.tables = parsed.tables.filter((table) => table.name !== 'hosting_sessions');
    const decoded = decodeData(JSON.stringify(parsed), 7);
    expect(decoded.data.orders[0].cancelledAt).toBeNull();
    expect(decoded.data.orders[0].notes).toBe('备注 <script>alert(1)</script>');
    expect(decoded.data.task_definitions[0].monthDay).toBeNull();
    expect(decoded.data.hosting_periods[0].serviceCount).toBeNull();
    expect(decoded.columnsByTable.hosting_sessions).toBeNull();
  });

  it('schema 15 文件缺列一律拒绝（读取兼容白名单只对旧版本生效）', () => {
    const { data } = seedData();
    const parsed = JSON.parse(encodeData(data)) as {
      tables: { name: string; columns: string[]; rows: unknown[][] }[];
    };
    const tasks = parsed.tables.find((table) => table.name === 'task_definitions')!;
    const index = tasks.columns.indexOf('colorArgb');
    tasks.columns.splice(index, 1);
    tasks.rows = tasks.rows.map((row) => row.filter((_, position) => position !== index));
    expect(() => decodeData(JSON.stringify(parsed), CURRENT_SCHEMA)).toThrow(/缺少列/);
  });

  it('schema 15 文件携带已退役列时拒绝', () => {
    const { data } = seedData();
    const parsed = JSON.parse(encodeData(data)) as {
      tables: { name: string; columns: string[]; rows: unknown[][] }[];
    };
    const templates = parsed.tables.find((table) => table.name === 'game_templates')!;
    templates.columns.push('serviceMode');
    templates.rows = templates.rows.map((row) => [...row, null]);
    expect(() => decodeData(JSON.stringify(parsed), CURRENT_SCHEMA)).toThrow(/退役/);
  });

  it('拒绝超出安全整数的字面量', () => {
    const { data } = seedData();
    const text = encodeData(data).replace('1700000000000', '17000000000001234');
    expect(() => decodeData(text, CURRENT_SCHEMA)).toThrow(/整数超出安全范围/);
  });

  it('拒绝列顺序不符与缺失表', () => {
    const { data } = seedData();
    const parsed = JSON.parse(encodeData(data)) as {
      tables: { name: string; columns: string[] }[];
    };
    parsed.tables[0].columns.reverse();
    expect(() => decodeData(JSON.stringify(parsed), CURRENT_SCHEMA)).toThrow(/列/);
    parsed.tables.shift();
    expect(() => decodeData(JSON.stringify(parsed), CURRENT_SCHEMA)).toThrow(/缺少业务表/);
  });

  it('拒绝未知表与未知列', () => {
    const { data } = seedData();
    const withTable = JSON.parse(encodeData(data)) as {
      tables: { name: string; columns: string[]; rows: unknown[][] }[];
    };
    withTable.tables.push({ name: 'evil', columns: ['id'], rows: [] });
    expect(() => decodeData(JSON.stringify(withTable), CURRENT_SCHEMA)).toThrow(/未知业务表/);

    const withColumn = JSON.parse(encodeData(data)) as {
      tables: { name: string; columns: string[]; rows: unknown[][] }[];
    };
    const owners = withColumn.tables.find((table) => table.name === 'owners')!;
    owners.columns.push('ghost');
    owners.rows = owners.rows.map((row) => [...row, null]);
    expect(() => decodeData(JSON.stringify(withColumn), CURRENT_SCHEMA)).toThrow(/未知列/);
  });
});

describe('归档往返', () => {
  it('普通归档保持业务列与附件字节', async () => {
    const { data, attachments } = seedData();
    const blob = await writeArchive({ data, attachments });
    const restored = await readArchive(blob);
    expect(restored.snapshot.data).toEqual(data);
    const restoredBlob = restored.snapshot.attachments.get('at1');
    expect(restoredBlob).toBeDefined();
    const bytes = await bytesOf(restoredBlob!);
    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(restored.snapshot.meta?.schemaVersion).toBe(15);
    expect(restored.columnsByTable.orders).toContain('hostingMode');
  });

  it('加密归档可用 Unicode 密码读回', async () => {
    const { data, attachments } = seedData();
    const blob = await writeArchive({ data, attachments }, '代肝🔐é');
    expect(() => readArchive(blob)).rejects.toThrow(/密码/);
    const restored = await readArchive(blob, '代肝🔐é');
    expect(restored.snapshot.data.owners[0].nickname).toBe('测试老板');
  });

  it('错误密码与篡改都被拒绝', async () => {
    const { data, attachments } = seedData();
    const blob = await writeArchive({ data, attachments }, 'secret');
    await expect(readArchive(blob, 'wrong')).rejects.toThrow(/密码/);

    const bytes = await bytesOf(blob);
    bytes[bytes.length - 20] ^= 0xff;
    await expect(readArchive(new Blob([bytes as unknown as BlobPart]), 'secret')).rejects.toThrow();
  });

  it('附件缺失与哈希不符被拒绝', async () => {
    const { data } = seedData();
    await expect(writeArchive({ data, attachments: new Map() })).rejects.toThrow(/附件/);

    const { data: goodData, attachments } = seedData();
    const blob = await writeArchive({ data: goodData, attachments });
    const tampered = goodData.attachments.map((row) => ({ ...row, sizeBytes: 9 }));
    await expect(
      writeArchive({ data: { ...goodData, attachments: tampered }, attachments }),
    ).rejects.toThrow();
    expect(blob.size).toBeGreaterThan(0);
  });
});

describe('业务校验', () => {
  it('通过完整资料校验', () => {
    const { data, attachments } = seedData();
    expect(() => validateSnapshot({ data, attachments })).not.toThrow();
  });

  it('拒绝截图同时归属任务与发生记录', () => {
    const { data, attachments } = seedData();
    data.attachments[0].taskDefinitionId = 'td1';
    expect(() => validateSnapshot({ data, attachments })).toThrow(/截图/);
  });

  it('拒绝短期单收款带期次', () => {
    const { data, attachments } = seedData();
    data.receipts[0].periodId = null;
    expect(() => validateSnapshot({ data, attachments })).toThrow(/必须指定期次/);
  });

  it('拒绝孤儿外键', () => {
    const { data, attachments } = seedData();
    data.orders[0].accountId = 'missing';
    expect(() => validateSnapshot({ data, attachments })).toThrow(/账号/);
  });

  it('按次数与任务生效日期非法时拒绝', () => {
    const { data, attachments } = seedData();
    data.hosting_periods[0].serviceCount = 0;
    expect(() => validateSnapshot({ data, attachments })).toThrow(/按次数/);
    const bad = seedData();
    bad.data.hosting_periods[0].serviceCount = 5;
    bad.data.hosting_periods[0].serviceDays = 10;
    bad.data.hosting_periods[0].serviceWeekdays = '1,2,3,4,5';
    expect(() => validateSnapshot({ data: bad.data, attachments: bad.attachments })).toThrow(
      /不能同时/,
    );
    const ranged = seedData();
    ranged.data.task_definitions[0].activeFrom = '2026-02-05';
    ranged.data.task_definitions[0].activeUntil = '2026-02-01';
    expect(() => validateSnapshot({ data: ranged.data, attachments: ranged.attachments })).toThrow(
      /截止日/,
    );
  });

  it('财务 NOT NULL：期次价格为空即拒绝，绝不臆造', () => {
    const { data, attachments } = seedData();
    (data.hosting_periods[0] as unknown as Record<string, unknown>).priceCents = null;
    expect(() => validateSnapshot({ data, attachments })).toThrow(/期次价格/);
  });
});

describe('schema-15 模板/分类字段往返', () => {
  it('托管默认值随编码往返并保持分层语义', () => {
    const { data, attachments } = seedData();
    data.hosting_periods[0].monthlyRefreshDays = '5,20';
    data.task_definitions[0].activeUntil = '2026-02-20';
    data.task_definitions[0].numericMode = null;
    data.game_templates.push({
      id: 'gt1',
      gameName: '测试游戏',
      templateVersion: '1.0',
      gameVersionNotes: null,
      zoneId: 'Asia/Shanghai',
      dailyRefreshMinutes: 300,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      origin: 'USER',
      builtInKey: null,
      sortOrder: 0,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      hostingMode: 'COUNT_BASED',
      targetSessions: 12,
      serviceWeekdays: null,
      defaultOrderTitle: '托管 12 次',
    });
    data.template_categories.push({
      id: 'tc1',
      templateId: 'gt1',
      name: '日常',
      sortOrder: 0,
      hostingMode: 'COUNT_BASED',
      targetSessions: 8,
      serviceWeekdays: null,
    });
    const text = encodeData(data);
    const decoded = decodeData(text, CURRENT_SCHEMA).data;
    expect(decoded.hosting_periods[0].monthlyRefreshDays).toBe('5,20');
    expect(decoded.task_definitions[0].activeUntil).toBe('2026-02-20');
    expect(decoded.game_templates[0].hostingMode).toBe('COUNT_BASED');
    expect(decoded.game_templates[0].targetSessions).toBe(12);
    expect(decoded.game_templates[0].defaultOrderTitle).toBe('托管 12 次');
    expect(decoded.template_categories[0].hostingMode).toBe('COUNT_BASED');
    expect(decoded.template_categories[0].targetSessions).toBe(8);
    expect(() => validateSnapshot({ data: decoded, attachments })).not.toThrow();
  });

  it('模板/分类的托管目标越界或形状矛盾时拒绝', () => {
    const { data, attachments } = seedData();
    data.game_templates.push({
      id: 'gt1',
      gameName: '测试游戏',
      templateVersion: '1.0',
      gameVersionNotes: null,
      zoneId: 'Asia/Shanghai',
      dailyRefreshMinutes: 300,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      origin: 'USER',
      builtInKey: null,
      sortOrder: 0,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      hostingMode: 'DATE_RANGE',
      targetSessions: 12,
      serviceWeekdays: null,
      defaultOrderTitle: null,
    });
    expect(() => validateSnapshot({ data, attachments })).toThrow(/不得保留目标次数/);
  });
});
