# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: stage5-final.spec.ts >> 流程F：网页→安卓→网页（链路1收尾）：浏览器看到安卓续写后的 25 与自己的改动
- Location: tests/e2e/stage5-final.spec.ts:70:1

# Error details

```
Error: expect(received).toContain(expected) // indexOf

Expected value: "安卓改名分类"
Received array: ["小号", "网页续用分类", "主号"]
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - complementary [ref=e4]:
      - generic [ref=e11]:
        - paragraph [ref=e12]: 代肝单据管理系统
        - paragraph [ref=e13]: 本地优先 · 无需注册
      - navigation "主导航" [ref=e14]:
        - button "今日事项" [ref=e15]
        - button "老板与账号" [ref=e19]
        - button "订单" [active] [ref=e24]
        - button "收款与统计" [ref=e30]
      - navigation "次导航" [ref=e35]:
        - button "模板库" [ref=e36]
        - button "资料与设置" [ref=e40]
      - paragraph [ref=e44]: 资料保存在当前浏览器。请定期在「资料与设置」导出完整备份。
    - main [ref=e46]:
      - generic [ref=e47]:
        - generic [ref=e48]:
          - generic [ref=e49]:
            - heading "订单" [level=1] [ref=e50]
            - paragraph [ref=e51]: 4 张
          - generic [ref=e52]:
            - combobox "按类型筛选" [ref=e53]:
              - option "全部类型" [selected]
              - option "托管"
              - option "短期单"
            - combobox "按老板筛选" [ref=e54]:
              - option "全部老板" [selected]
              - option "#1 老板甲"
              - option "#2 老板乙"
            - combobox "按颜色筛选" [ref=e55]:
              - option "全部颜色" [selected]
              - option "红"
              - option "橙"
              - option "绿"
              - option "蓝"
              - option "紫"
              - option "灰"
            - button "刷新" [ref=e56] [cursor=pointer]
            - button "新建订单" [ref=e62] [cursor=pointer]
        - generic [ref=e65]:
          - checkbox "显示已作废订单" [ref=e66]
          - text: 显示已作废订单
        - list [ref=e68]:
          - listitem [ref=e69]:
            - button "网页续用订单 颜色标记" [ref=e71]
            - 'button "网页续用订单 托管 #1 老板甲 · 游戏X · 官服 · 按次数 2 次 待收 ¥66.00" [ref=e73]':
              - generic [ref=e74]:
                - generic [ref=e75]:
                  - generic [ref=e76]: 网页续用订单
                  - generic [ref=e77]: 托管
                - generic [ref=e78]: "#1 老板甲 · 游戏X · 官服 · 按次数 2 次"
              - generic [ref=e79]: 待收 ¥66.00
          - listitem [ref=e82]:
            - button "打卡托管 颜色标记" [ref=e84]
            - 'button "打卡托管 托管 已完成 #1 老板甲 · 游戏X · 官服 · 按次数 1 次 待收 ¥25.00" [ref=e86]':
              - generic [ref=e87]:
                - generic [ref=e88]:
                  - generic [ref=e89]: 打卡托管
                  - generic [ref=e90]: 托管
                  - generic [ref=e91]: 已完成
                - generic [ref=e92]: "#1 老板甲 · 游戏X · 官服 · 按次数 1 次"
              - generic [ref=e93]: 待收 ¥25.00
          - listitem [ref=e96]:
            - button "短期累计 颜色标记" [ref=e98]
            - 'button "短期累计 短期 #1 老板甲 · 游戏X · 官服 待收 ¥5.00" [ref=e100]':
              - generic [ref=e101]:
                - generic [ref=e102]:
                  - generic [ref=e103]: 短期累计
                  - generic [ref=e104]: 短期
                - generic [ref=e105]: "#1 老板甲 · 游戏X · 官服"
              - generic [ref=e106]: 待收 ¥5.00
          - listitem [ref=e109]:
            - button "月度刷新托管 颜色标记" [ref=e111]
            - 'button "月度刷新托管 托管 #2 老板乙 · 游戏X · 官服 · 至 2026-03-30 待收 ¥88.00" [ref=e113]':
              - generic [ref=e114]:
                - generic [ref=e115]:
                  - generic [ref=e116]: 月度刷新托管
                  - generic [ref=e117]: 托管
                - generic [ref=e118]: "#2 老板乙 · 游戏X · 官服 · 至 2026-03-30"
              - generic [ref=e119]: 待收 ¥88.00
  - status [ref=e122]: 已切换到恢复的资料
```

# Test source

```ts
  15  |  * - `android-chain1-continued.dgbk` — Android restored the browser's continuation, wrote
  16  |  *   one more absolute total (25) and exported. The browser must see 25 and its own edits.
  17  |  * - `android-chain2-noedit-echo.dgbk` — Android restored the browser-native dataset and
  18  |  *   re-exported without edits. The browser must see exactly its own dataset.
  19  |  */
  20  | 
  21  | const GAME_START = new Date('2026-03-11T04:00:00Z'); // Shanghai 12:00 → game day 2026-03-11
  22  | const OUTPUT_DIR = path.resolve(process.cwd(), '../output/interop-uf036-038/stage5');
  23  | const ANDROID_FIXTURES = path.resolve(
  24  |   process.cwd(),
  25  |   '../../代肝记录软件/output/interop-fixtures/stage5',
  26  | );
  27  | 
  28  | async function boot(page: Page) {
  29  |   await page.clock.install({ time: GAME_START });
  30  |   await page.goto('/');
  31  |   await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  32  | }
  33  | 
  34  | async function gotoSection(page: Page, name: '今日事项' | '订单' | '资料与设置') {
  35  |   const nav = name === '资料与设置' ? '次导航' : '主导航';
  36  |   await page
  37  |     .getByRole('navigation', { name: nav })
  38  |     .getByRole('button', { name, exact: true })
  39  |     .click();
  40  | }
  41  | 
  42  | async function restoreBackup(page: Page, filePath: string, password?: string) {
  43  |   await gotoSection(page, '资料与设置');
  44  |   await page.locator('input[type=file][accept*="dgbk"]').setInputFiles(filePath);
  45  |   await expect(page.getByText(/已选择：/)).toBeVisible();
  46  |   if (password) await page.getByLabel('备份密码').fill(password);
  47  |   await page.getByRole('button', { name: '预览恢复内容' }).click();
  48  |   const modal = page.getByRole('dialog', { name: '确认替换本机资料' });
  49  |   await expect(modal).toBeVisible({ timeout: 30_000 });
  50  |   await modal.getByRole('checkbox').check();
  51  |   await modal.getByRole('button', { name: '替换本机资料' }).click();
  52  |   await expect(page.getByText('已切换到恢复的资料')).toBeVisible({ timeout: 30_000 });
  53  | }
  54  | 
  55  | async function exportBackup(page: Page, fileName: string) {
  56  |   await gotoSection(page, '资料与设置');
  57  |   const [download] = await Promise.all([
  58  |     page.waitForEvent('download'),
  59  |     page.getByRole('button', { name: '导出完整备份' }).click(),
  60  |   ]);
  61  |   const target = path.join(OUTPUT_DIR, fileName);
  62  |   await download.saveAs(target);
  63  |   const bytes = readFileSync(target);
  64  |   expect(bytes.length).toBeGreaterThan(500);
  65  |   console.log(
  66  |     `browser export ${fileName}: ${bytes.length} bytes sha256=${createHash('sha256').update(bytes).digest('hex')}`,
  67  |   );
  68  | }
  69  | 
  70  | test('流程F：网页→安卓→网页（链路1收尾）：浏览器看到安卓续写后的 25 与自己的改动', async ({
  71  |   page,
  72  | }) => {
  73  |   mkdirSync(OUTPUT_DIR, { recursive: true });
  74  |   await boot(page);
  75  |   await restoreBackup(page, path.join(ANDROID_FIXTURES, 'android-chain1-continued.dgbk'));
  76  | 
  77  |   // The browser's own continuation edits survived the Android round trip.
  78  |   await gotoSection(page, '订单');
  79  |   await expect(page.getByText('网页续用订单').first()).toBeVisible();
  80  |   await page.getByText('网页续用订单').first().click();
  81  |   await expect(page.getByRole('heading', { name: '网页续用订单' })).toBeVisible();
  82  |   // Android wrote one more absolute total (25) on the next game day: it must win.
  83  |   await expect(page.getByText(/25 \/ 100/).first()).toBeVisible();
  84  |   // The historical correction chain is intact (both platforms' corrections).
  85  |   await expect(page.getByText(/2026-03-10 · 第 1 次打卡 · 更正 · 8/)).toBeVisible();
  86  | 
  87  |   // Category rename performed on Android is visible in the browser.
  88  |   await gotoSection(page, '订单');
  89  |   const data = await page.evaluate(async () => {
  90  |     const databases = await indexedDB.databases();
  91  |     const name = databases
  92  |       .map((database) => database.name ?? '')
  93  |       .find((value) => value.startsWith('daigan-data-'))!;
  94  |     const db = await new Promise<IDBDatabase>((resolve, reject) => {
  95  |       const request = indexedDB.open(name);
  96  |       request.onsuccess = () => resolve(request.result);
  97  |       request.onerror = () => reject(request.error);
  98  |     });
  99  |     const read = (store: string) =>
  100 |       new Promise<Record<string, unknown>[]>((resolve, reject) => {
  101 |         const tx = db.transaction(store, 'readonly');
  102 |         const request = tx.objectStore(store).getAll();
  103 |         request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
  104 |         request.onerror = () => reject(request.error);
  105 |       });
  106 |     const rows = {
  107 |       categories: await read('account_categories'),
  108 |       receipts: await read('receipts'),
  109 |       events: await read('task_progress_events'),
  110 |     };
  111 |     db.close();
  112 |     return rows;
  113 |   });
  114 |   const categoryNames = data.categories.map((row) => row.name);
> 115 |   expect(categoryNames).toContain('安卓改名分类');
      |                         ^ Error: expect(received).toContain(expected) // indexOf
  116 |   expect(categoryNames).not.toContain('主号');
  117 |   // The Android receipt amendment became a new effective receipt row (audit kept).
  118 |   expect(data.receipts.length).toBeGreaterThanOrEqual(3);
  119 |   // Android's 25 plus the browser's own events are all present.
  120 |   expect(data.events.some((event) => event.totalValue === '25')).toBe(true);
  121 | 
  122 |   await exportBackup(page, 'web-chain1-final.dgbk');
  123 | });
  124 | 
  125 | test('流程G：网页→安卓→网页（链路2收尾）：安卓回传的无编辑数据集在浏览器中一致可用', async ({
  126 |   page,
  127 | }) => {
  128 |   mkdirSync(OUTPUT_DIR, { recursive: true });
  129 |   await boot(page);
  130 |   await restoreBackup(page, path.join(ANDROID_FIXTURES, 'android-chain2-noedit-echo.dgbk'));
  131 | 
  132 |   await gotoSection(page, '订单');
  133 |   await expect(page.getByText('网页打卡单').first()).toBeVisible();
  134 |   await expect(page.getByText('网页日期单').first()).toBeVisible();
  135 |   await expect(page.getByText('网页短期单').first()).toBeVisible();
  136 | 
  137 |   // Absolute totals survived the Android round trip unchanged.
  138 |   await page.getByText('网页打卡单').first().click();
  139 |   await expect(page.getByRole('heading', { name: '网页打卡单' })).toBeVisible();
  140 |   await expect(page.getByText(/15 \/ 100/).first()).toBeVisible();
  141 | 
  142 |   // The real JPEG still renders (bytes, not a marker).
  143 |   await gotoSection(page, '订单');
  144 |   await page.getByText('网页短期单').first().click();
  145 |   await page.getByRole('button', { name: '截图', exact: true }).click();
  146 |   const photos = page.getByRole('dialog', { name: '截图', exact: true });
  147 |   await expect(photos.locator('figure')).toHaveCount(1);
  148 |   const width = await photos.locator('img').first().evaluate((image) => {
  149 |     const element = image as HTMLImageElement;
  150 |     return element.naturalWidth;
  151 |   });
  152 |   expect(width).toBeGreaterThan(0);
  153 |   await page.keyboard.press('Escape');
  154 | 
  155 |   await exportBackup(page, 'web-chain2-final.dgbk');
  156 | });
  157 | 
```