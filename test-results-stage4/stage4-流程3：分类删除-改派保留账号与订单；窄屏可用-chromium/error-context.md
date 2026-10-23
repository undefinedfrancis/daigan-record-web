# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: stage4.spec.ts >> 流程3：分类删除/改派保留账号与订单；窄屏可用
- Location: tests/e2e/stage4.spec.ts:193:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('li').filter({ hasText: 'UID 9202' }).getByText('长期客户').first()
Expected: visible
Received: hidden
Timeout:  12000ms

Call log:
  - Expect "toBeVisible" locator('li').filter({ hasText: 'UID 9202' }).getByText('长期客户').first() with timeout 12000ms
  - waiting for locator('li').filter({ hasText: 'UID 9202' }).getByText('长期客户').first()
    27 × locator resolved to <option value="d636510e-546a-4903-85e9-5aa3febc9ecb">长期客户</option>
       - unexpected value "hidden"

```

```yaml
- complementary:
  - paragraph: 代肝单据管理系统
  - paragraph: 本地优先 · 无需注册
  - navigation "主导航":
    - button "今日事项"
    - button "老板与账号"
    - button "订单"
    - button "收款与统计"
  - navigation "次导航":
    - button "模板库"
    - button "资料与设置"
  - paragraph: 资料保存在当前浏览器。请定期在「资料与设置」导出完整备份。
- main:
  - heading "老板与账号" [level=1]
  - paragraph: 共 2 位老板 · 归档 0
  - group "账号页视图":
    - button "按老板"
    - button "按账号" [pressed]
  - textbox "搜索老板或账号":
    - /placeholder: 搜索老板 / 账号 / UID
  - button "刷新"
  - paragraph: 共 2 个账号（跨老板）
  - text: 按分类筛选
  - combobox "按分类筛选":
    - option "全部分类" [selected]
    - option "未分类"
    - option "长期客户（1）"
  - checkbox "含已归档"
  - text: 含已归档
  - button "刷新账号"
  - button "管理分类"
  - button "按老板查看"
  - list:
    - listitem:
      - button "打开账号 原神 官服": "原神 · 官服 UID 9202 · #2 分类乙 · 0 张订单"
      - text: 未分类 调整 原神 分类
      - combobox "调整 原神 官服 分类":
        - option "未分类" [selected]
        - option "长期客户"
    - listitem:
      - button "打开账号 原神 官服": "原神 · 官服 UID 9201 · #1 分类甲 · 1 张订单（进行中 1）"
      - text: 长期客户 调整 原神 分类
      - combobox "调整 原神 官服 分类":
        - option "未分类"
        - option "长期客户" [selected]
```

# Test source

```ts
  122 |   await page.getByRole('button', { name: '记录总值' }).click();
  123 |   await expect(page.getByText(/20 \/ 100/).first()).toBeVisible();
  124 |   await expect(page.getByText(/30 \/ 100/)).toHaveCount(0);
  125 | 
  126 |   // 浏览器重启（整页重载）后总值与两天的事件历史仍在。
  127 |   await page.reload();
  128 |   await page.getByRole('button', { name: '订单' }).click();
  129 |   await page.getByText('自动带入标题').first().click();
  130 |   await expect(page.getByLabel('抽卡 当前累计总值')).toHaveValue('20');
  131 |   await expect(page.getByText(/2026-03-10 · 记录 · 10/)).toBeVisible();
  132 |   await expect(page.getByText(/2026-03-11 · 记录 · 20/)).toBeVisible();
  133 | 
  134 |   // 生产加密导出：真实下载文件 + 记录哈希（供证据索引）。
  135 |   mkdirSync(OUTPUT_DIR, { recursive: true });
  136 |   await page.getByRole('button', { name: '资料与设置' }).click();
  137 |   await page.getByLabel('密码（可选）').fill('stage4-browser-password');
  138 |   await page.getByLabel('确认密码').fill('stage4-browser-password');
  139 |   const [download] = await Promise.all([
  140 |     page.waitForEvent('download'),
  141 |     page.getByRole('button', { name: '导出完整备份' }).click(),
  142 |   ]);
  143 |   const target = path.join(OUTPUT_DIR, 'stage4-browser-encrypted.dgbk');
  144 |   await download.saveAs(target);
  145 |   const bytes = readFileSync(target);
  146 |   expect(bytes.length).toBeGreaterThan(500);
  147 |   const sha256 = createHash('sha256').update(bytes).digest('hex');
  148 |   console.log(`browser encrypted export: ${bytes.length} bytes sha256=${sha256}`);
  149 | });
  150 | 
  151 | test('流程2：累计历史更正/撤销 → 完成态与轮次重新打开', async ({ page }) => {
  152 |   await boot(page);
  153 |   await createOwnerWithAccount(page, '更正老板', { uid: '9100' });
  154 |   const editor = await openOrderEditor(page);
  155 |   await editor.getByLabel('服务模式').selectOption('count');
  156 |   await editor.getByLabel('服务次数').fill('1');
  157 |   await editor.getByLabel('本期价格（元）').fill('50');
  158 |   await editor.getByRole('checkbox').uncheck();
  159 |   await editor.getByRole('button', { name: '添加任务' }).click();
  160 |   await editor.getByLabel('任务标题').first().fill('抽卡');
  161 |   await editor.getByLabel('进度类型').first().selectOption('NUMERIC');
  162 |   await editor.getByLabel('数值口径').first().selectOption('CUMULATIVE');
  163 |   await editor.getByLabel('目标').first().fill('10');
  164 |   await editor.getByLabel('订单标题').fill('更正流程');
  165 |   await editor.getByRole('button', { name: '创建订单' }).click();
  166 |   await expect(page.getByRole('heading', { name: '更正流程' })).toBeVisible();
  167 | 
  168 |   const input = page.getByLabel('抽卡 当前累计总值');
  169 |   await input.fill('10');
  170 |   await page.getByRole('button', { name: '记录总值' }).click();
  171 |   await expect(page.getByText('已达标').first()).toBeVisible();
  172 |   await expect(page.getByText(/第 1 次打卡 · .* 已完成/).first()).toBeVisible();
  173 | 
  174 |   // 更正为更低值：重开完成态（历史追加，不覆盖）。
  175 |   await page.getByRole('button', { name: '更正', exact: true }).first().click();
  176 |   await page.getByLabel('更正为').fill('4');
  177 |   await page.getByRole('button', { name: '保存更正' }).click();
  178 |   await expect(page.getByText('未达标').first()).toBeVisible();
  179 |   await expect(page.getByText(/4 \/ 10/).first()).toBeVisible();
  180 |   await expect(page.getByText(/第 1 次打卡 · .* 未完成/).first()).toBeVisible();
  181 | 
  182 |   // 撤销"更正"这条观测：撤回**不复活**被取代的旧值（契约 D-30），回到起始值 0。
  183 |   await page.getByRole('button', { name: '撤销', exact: true }).first().click();
  184 |   await expect(page.getByText('未达标').first()).toBeVisible();
  185 |   await expect(page.getByText(/0 \/ 10/).first()).toBeVisible();
  186 | 
  187 |   // 轮次已按证据重开，可以重新记录当前总值 10 → 完成态再次成立。
  188 |   await page.getByLabel('抽卡 当前累计总值').fill('10');
  189 |   await page.getByRole('button', { name: '记录总值' }).click();
  190 |   await expect(page.getByText('已达标').first()).toBeVisible();
  191 | });
  192 | 
  193 | test('流程3：分类删除/改派保留账号与订单；窄屏可用', async ({ page }) => {
  194 |   await boot(page);
  195 |   await createOwnerWithAccount(page, '分类甲', { category: '长期客户', uid: '9201' });
  196 | 
  197 |   // 同一账号下一张订单，用于验证删分类不影响订单。
  198 |   const editor = await openOrderEditor(page);
  199 |   await editor.getByLabel('服务模式').selectOption('count');
  200 |   await editor.getByLabel('服务次数').fill('2');
  201 |   await editor.getByLabel('本期价格（元）').fill('80');
  202 |   await editor.getByRole('checkbox').uncheck();
  203 |   await editor.getByRole('button', { name: '添加任务' }).click();
  204 |   await editor.getByLabel('任务标题').first().fill('签到');
  205 |   await editor.getByLabel('订单标题').fill('分类流程订单');
  206 |   await editor.getByRole('button', { name: '创建订单' }).click();
  207 |   await expect(page.getByRole('heading', { name: '分类流程订单' })).toBeVisible();
  208 | 
  209 |   await createOwnerWithAccount(page, '分类乙', { uid: '9202' });
  210 |   await page.getByRole('button', { name: '老板与账号' }).click();
  211 |   await page.getByRole('button', { name: '按账号' }).click();
  212 |   await expect(page.getByText(/UID 9201/)).toBeVisible();
  213 |   await expect(page.getByText(/UID 9202/)).toBeVisible();
  214 |   await expect(
  215 |     page.locator('li').filter({ hasText: 'UID 9201' }).getByText('长期客户').first(),
  216 |   ).toBeVisible();
  217 | 
  218 |   // 改派：把 9202 也归入同一分类（行内 Badge 立即反映，身份仍是 accountId）。
  219 |   await page.getByLabel('调整 原神 官服 分类').last().selectOption({ label: '长期客户' });
  220 |   await expect(
  221 |     page.locator('li').filter({ hasText: 'UID 9202' }).getByText('长期客户').first(),
> 222 |   ).toBeVisible();
      |     ^ Error: expect(locator).toBeVisible() failed
  223 |   await expect(
  224 |     page.locator('li').filter({ hasText: 'UID 9201' }).getByText('长期客户').first(),
  225 |   ).toBeVisible();
  226 | 
  227 |   // 删除分类：两个账号都保留为未分类，订单仍在。
  228 |   await page.getByRole('button', { name: '管理分类' }).click();
  229 |   const managing = page.getByRole('dialog', { name: '管理账号分类' });
  230 |   await managing.getByRole('button', { name: '删除' }).first().click();
  231 |   await managing.getByRole('button', { name: '确认删除' }).click();
  232 |   await expect(managing.getByText('还没有分类。')).toBeVisible();
  233 |   await page.keyboard.press('Escape');
  234 |   await expect(page.getByText(/UID 9201/)).toBeVisible();
  235 |   await expect(page.getByText(/UID 9202/)).toBeVisible();
  236 |   // 分类删除后账号仍在，只是分类选择回到未分类（''）。
  237 |   await expect(page.getByLabel('调整 原神 官服 分类').first()).toHaveValue('');
  238 |   await expect(page.getByLabel('调整 原神 官服 分类').last()).toHaveValue('');
  239 | 
  240 |   await page.getByRole('button', { name: '按老板查看' }).click();
  241 |   await page.getByText('分类甲').first().click();
  242 |   await expect(page.getByText('分类流程订单').first()).toBeVisible();
  243 | 
  244 |   // 窄屏检查一次：账号视图与分类操作仍可达，且没有横向溢出。
  245 |   await page.setViewportSize({ width: 390, height: 844 });
  246 |   await page
  247 |     .getByRole('navigation', { name: '底部导航' })
  248 |     .getByRole('button', { name: '老板' })
  249 |     .click();
  250 |   await page.getByRole('button', { name: '按账号' }).click();
  251 |   await expect(page.getByText(/UID 9201/)).toBeVisible();
  252 |   await expect(page.getByRole('button', { name: '管理分类' })).toBeVisible();
  253 |   const overflow = await page.evaluate(
  254 |     () => document.documentElement.scrollWidth - window.innerWidth,
  255 |   );
  256 |   expect(overflow).toBeLessThanOrEqual(1);
  257 | });
  258 | 
```