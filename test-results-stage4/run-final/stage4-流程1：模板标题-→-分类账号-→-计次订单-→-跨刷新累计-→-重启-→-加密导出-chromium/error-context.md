# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: stage4.spec.ts >> 流程1：模板标题 → 分类账号 → 计次订单 → 跨刷新累计 → 重启 → 加密导出
- Location: tests/e2e/stage4.spec.ts:81:1

# Error details

```
Error: locator.click: Error: strict mode violation: getByRole('button', { name: '订单' }) resolved to 2 elements:
    1) <button type="button" aria-current="page" class="flex min-h-[38px] items-center gap-2.5 rounded-lg px-2.5 text-sm bg-sage font-semibold text-[#1f3a2a]">…</button> aka getByRole('button', { name: '订单', exact: true })
    2) <button type="button" class="btn btn-ghost">…</button> aka getByRole('button', { name: '订单列表' })

Call log:
  - waiting for getByRole('button', { name: '订单' })

```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - complementary [ref=f1e4]:
    - generic [ref=f1e11]:
      - paragraph [ref=f1e12]: 代肝单据管理系统
      - paragraph [ref=f1e13]: 本地优先 · 无需注册
    - navigation "主导航" [ref=f1e14]:
      - button "今日事项" [ref=f1e15]
      - button "老板与账号" [ref=f1e19]
      - button "订单" [ref=f1e24]
      - button "收款与统计" [ref=f1e30]
    - navigation "次导航" [ref=f1e35]:
      - button "模板库" [ref=f1e36]
      - button "资料与设置" [ref=f1e40]
    - paragraph [ref=f1e44]: 资料保存在当前浏览器。请定期在「资料与设置」导出完整备份。
  - main [ref=f1e46]:
    - generic [ref=f1e47]:
      - generic [ref=f1e48]:
        - button "订单列表" [ref=f1e49] [cursor=pointer]
        - button "刷新" [ref=f1e53] [cursor=pointer]
      - generic [ref=f1e60]:
        - generic [ref=f1e61]:
          - generic [ref=f1e62]:
            - heading "自动带入标题" [level=1] [ref=f1e63]
            - button "自动带入标题 颜色标记" [ref=f1e65]
            - generic [ref=f1e67]: 托管
          - paragraph [ref=f1e68]: "#1 流程老板 · 原神 · 官服 · Asia/Shanghai"
          - paragraph [ref=f1e69]:
            - text: 实收 ¥0.00 · 待收
            - generic [ref=f1e70]: ¥100.00
        - generic [ref=f1e71]:
          - button "记录收款" [ref=f1e72] [cursor=pointer]
          - button "续期" [ref=f1e73] [cursor=pointer]
          - button "修改" [ref=f1e74] [cursor=pointer]
          - button "截图" [ref=f1e75] [cursor=pointer]
          - button "作废" [ref=f1e79] [cursor=pointer]
          - button "删除空单" [ref=f1e80] [cursor=pointer]
      - generic [ref=f1e81]:
        - generic [ref=f1e82]:
          - heading "期次" [level=2] [ref=f1e83]
          - generic [ref=f1e84]: 1 期
        - list [ref=f1e85]:
          - listitem [ref=f1e86]:
            - generic [ref=f1e87]:
              - generic [ref=f1e88]:
                - text: 第 1 期 · 按次数 1 次
                - generic [ref=f1e89]: 已打卡 0 次 · 剩余 1
              - generic [ref=f1e90]:
                - generic [ref=f1e91]: ¥100.00
                - generic [ref=f1e92]: 待收 ¥100.00
        - list [ref=f1e93]:
          - listitem [ref=f1e94]: 第 1 次打卡 · 归属 2026-03-10 · 未完成（0/1） · 含累计目标
      - generic [ref=f1e95]:
        - generic [ref=f1e96]:
          - heading "累计进度" [level=2] [ref=f1e97]
          - generic [ref=f1e98]: 输入当前累计总值
        - paragraph [ref=f1e99]:
          - text: 这里填的是
          - strong [ref=f1e100]: 当前累计总值
          - text: ：先记 10、再记 15，结果就是 15。跨日不重置， 达标前每天都可以更新；普通每日/每周任务仍按各自周期重置。
        - list [ref=f1e101]:
          - listitem [ref=f1e102]:
            - generic [ref=f1e103]:
              - generic [ref=f1e104]: 抽卡第 1 次打卡
              - generic [ref=f1e105]:
                - text: 20 / 100
                - generic [ref=f1e106]: 未达标
            - generic [ref=f1e107]:
              - generic [ref=f1e108]:
                - generic [ref=f1e109]: 当前累计总值
                - textbox "抽卡 当前累计总值" [ref=f1e110]: "20"
              - button "记录总值" [ref=f1e111] [cursor=pointer]
            - list [ref=f1e112]:
              - listitem [ref=f1e113]:
                - generic [ref=f1e114]: 2026-03-10 · 记录 · 10
              - listitem [ref=f1e115]:
                - generic [ref=f1e116]: 2026-03-11 · 记录 · 20
                - generic [ref=f1e117]: 当前有效
                - generic [ref=f1e118]:
                  - button "更正" [ref=f1e119] [cursor=pointer]
                  - button "撤销" [ref=f1e120] [cursor=pointer]
      - generic [ref=f1e121]:
        - generic [ref=f1e122]:
          - heading "任务" [level=2] [ref=f1e123]
          - generic [ref=f1e124]: 1 个
        - list [ref=f1e125]:
          - listitem [ref=f1e126]:
            - generic [ref=f1e127]:
              - button "抽卡 颜色标记" [ref=f1e129]
              - generic [ref=f1e131]:
                - generic [ref=f1e132]: 抽卡
                - generic [ref=f1e133]: 每日
            - generic [ref=f1e134]:
              - generic [ref=f1e135]: 累计
              - generic [ref=f1e136]: 20 / 100
              - button "抽卡 截图" [ref=f1e137] [cursor=pointer]
              - generic [ref=f1e141]: 未达标
      - generic [ref=f1e142]:
        - generic [ref=f1e143]:
          - heading "打卡日历" [level=2] [ref=f1e144]
          - generic [ref=f1e148]:
            - button "上个月" [ref=f1e149] [cursor=pointer]
            - generic [ref=f1e152]: 2026 年 3 月
            - button "下个月" [ref=f1e153] [cursor=pointer]
        - generic [ref=f1e157]:
          - generic [ref=f1e158]: 一
          - generic [ref=f1e159]: 二
          - generic [ref=f1e160]: 三
          - generic [ref=f1e161]: 四
          - generic [ref=f1e162]: 五
          - generic [ref=f1e163]: 六
          - generic [ref=f1e164]: 日
          - button "2026-03-01" [ref=f1e172] [cursor=pointer]: "1"
          - button "2026-03-02" [ref=f1e174] [cursor=pointer]: "2"
          - button "2026-03-03" [ref=f1e176] [cursor=pointer]: "3"
          - button "2026-03-04" [ref=f1e178] [cursor=pointer]: "4"
          - button "2026-03-05" [ref=f1e180] [cursor=pointer]: "5"
          - button "2026-03-06" [ref=f1e182] [cursor=pointer]: "6"
          - button "2026-03-07" [ref=f1e184] [cursor=pointer]: "7"
          - button "2026-03-08" [ref=f1e186] [cursor=pointer]: "8"
          - button "2026-03-09" [ref=f1e188] [cursor=pointer]: "9"
          - button "2026-03-10" [ref=f1e190] [cursor=pointer]: "10"
          - button "2026-03-11" [ref=f1e192] [cursor=pointer]: "11"
          - button "2026-03-12" [ref=f1e194] [cursor=pointer]: "12"
          - button "2026-03-13" [ref=f1e196] [cursor=pointer]: "13"
          - button "2026-03-14" [ref=f1e198] [cursor=pointer]: "14"
          - button "2026-03-15" [ref=f1e200] [cursor=pointer]: "15"
          - button "2026-03-16" [ref=f1e202] [cursor=pointer]: "16"
          - button "2026-03-17" [ref=f1e204] [cursor=pointer]: "17"
          - button "2026-03-18" [ref=f1e206] [cursor=pointer]: "18"
          - button "2026-03-19" [ref=f1e208] [cursor=pointer]: "19"
          - button "2026-03-20" [ref=f1e210] [cursor=pointer]: "20"
          - button "2026-03-21" [ref=f1e212] [cursor=pointer]: "21"
          - button "2026-03-22" [ref=f1e214] [cursor=pointer]: "22"
          - button "2026-03-23" [ref=f1e216] [cursor=pointer]: "23"
          - button "2026-03-24" [ref=f1e218] [cursor=pointer]: "24"
          - button "2026-03-25" [ref=f1e220] [cursor=pointer]: "25"
          - button "2026-03-26" [ref=f1e222] [cursor=pointer]: "26"
          - button "2026-03-27" [ref=f1e224] [cursor=pointer]: "27"
          - button "2026-03-28" [ref=f1e226] [cursor=pointer]: "28"
          - button "2026-03-29" [ref=f1e228] [cursor=pointer]: "29"
          - button "2026-03-30" [ref=f1e230] [cursor=pointer]: "30"
          - button "2026-03-31" [ref=f1e232] [cursor=pointer]: "31"
        - paragraph [ref=f1e234]: 该日没有安排任务。
        - generic [ref=f1e235]:
          - generic [ref=f1e236]: 全部完成
          - generic [ref=f1e238]: 部分完成
          - generic [ref=f1e240]: 待完成
          - generic [ref=f1e242]: 无任务
          - generic [ref=f1e244]: 今天
          - generic [ref=f1e246]: 点击日期可查看、打卡或补录
      - generic [ref=f1e247]:
        - generic [ref=f1e248]:
          - heading "收款记录" [level=2] [ref=f1e249]
          - generic [ref=f1e250]: 0 条
        - paragraph [ref=f1e252]: 还没有收款
```

# Test source

```ts
  28  |   await expect(page.getByRole('heading', { name: '模板库' })).toBeVisible();
  29  | }
  30  | 
  31  | async function createTemplateWithTitle(page: Page) {
  32  |   await openTemplates(page);
  33  |   await page.getByRole('button', { name: '新建模板' }).click();
  34  |   const dialog = page.getByRole('dialog', { name: '新建模板' });
  35  |   await dialog.getByLabel('游戏名称').fill('原神');
  36  |   await dialog.getByLabel(/默认订单标题/).fill('自动带入标题');
  37  |   await dialog.getByLabel('任务标题').first().fill('抽卡');
  38  |   await dialog.getByLabel('进度类型').first().selectOption('NUMERIC');
  39  |   await dialog.getByLabel('数值口径').first().selectOption('CUMULATIVE');
  40  |   await dialog.getByLabel('目标').first().fill('100');
  41  |   await dialog.getByRole('button', { name: '保存模板' }).click();
  42  |   await expect(dialog).toBeHidden();
  43  | }
  44  | 
  45  | async function createOwnerWithAccount(
  46  |   page: Page,
  47  |   ownerName: string,
  48  |   options: { category?: string; uid?: string } = {},
  49  | ) {
  50  |   await page.getByRole('button', { name: '老板与账号' }).click();
  51  |   await page.getByRole('button', { name: '新建老板' }).first().click();
  52  |   await page.getByLabel('昵称').fill(ownerName);
  53  |   await page.getByRole('button', { name: '保存', exact: true }).click();
  54  |   await expect(page.getByText(ownerName).first()).toBeVisible();
  55  |   await page.getByText(ownerName).first().click();
  56  |   await expect(page.getByRole('heading', { name: ownerName })).toBeVisible();
  57  | 
  58  |   await page.getByRole('button', { name: '添加账号' }).first().click();
  59  |   const dialog = page.getByRole('dialog', { name: '添加游戏账号' });
  60  |   await dialog.getByLabel('游戏名称').fill('原神');
  61  |   await dialog.getByLabel('区服').fill('官服');
  62  |   await dialog.getByLabel('UID').fill(options.uid ?? '9001');
  63  |   await dialog.getByLabel('登录账号').fill(`acc-${options.uid ?? '9001'}`);
  64  |   await dialog.locator('input[type="password"]').fill('secret');
  65  |   if (options.category) {
  66  |     await dialog.getByRole('button', { name: '新建账号分类' }).click();
  67  |     await dialog.getByLabel('新分类名称').fill(options.category);
  68  |     await dialog.getByRole('button', { name: '创建并选用' }).click();
  69  |   }
  70  |   await dialog.getByRole('button', { name: '保存账号' }).click();
  71  |   await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
  72  | }
  73  | 
  74  | async function openOrderEditor(page: Page) {
  75  |   await page.getByRole('button', { name: '下单' }).click();
  76  |   const dialog = page.getByRole('dialog', { name: '新建订单' });
  77  |   await expect(dialog).toBeVisible();
  78  |   return dialog;
  79  | }
  80  | 
  81  | test('流程1：模板标题 → 分类账号 → 计次订单 → 跨刷新累计 → 重启 → 加密导出', async ({
  82  |   page,
  83  | }) => {
  84  |   await boot(page);
  85  |   await createTemplateWithTitle(page);
  86  |   await createOwnerWithAccount(page, '流程老板', { category: '流程分类', uid: '9001' });
  87  | 
  88  |   const editor = await openOrderEditor(page);
  89  |   await editor.getByLabel('套用模板').selectOption({ label: '原神 · 2026.10' });
  90  |   // UF-036：模板默认标题自动带入（来源是显式状态，不是字符串比较）。
  91  |   await expect(editor.getByLabel('订单标题')).toHaveValue('自动带入标题');
  92  |   await editor.getByLabel('服务模式').selectOption('count');
  93  |   await editor.getByLabel('服务次数').fill('1');
  94  |   await editor.getByLabel('本期价格（元）').fill('100');
  95  |   await editor.getByRole('checkbox').uncheck();
  96  |   await editor.getByRole('button', { name: '创建订单' }).click();
  97  |   await expect(page.getByRole('heading', { name: '自动带入标题' })).toBeVisible();
  98  | 
  99  |   // UF-038：输入的是"当前累计总值"，10 之后在**次日**再记 20，结果 20（不是 30）。
  100 |   const input = page.getByLabel('抽卡 当前累计总值');
  101 |   await input.fill('10');
  102 |   await page.getByRole('button', { name: '记录总值' }).click();
  103 |   await expect(page.getByText(/10 \/ 100/).first()).toBeVisible();
  104 | 
  105 |   // 跨"游戏日刷新"：先推进到刷新前（仍是 03-10），再推进到刷新后（03-11）。
  106 |   await page.clock.setSystemTime(BEFORE_REFRESH);
  107 |   await page.getByRole('button', { name: '今日事项' }).click();
  108 |   await page.getByRole('button', { name: '刷新', exact: true }).click();
  109 |   await expect(page.getByText(/游戏日 2026-03-10/)).toBeVisible();
  110 |   await expect(page.getByLabel('抽卡 当前累计总值')).toHaveValue('10');
  111 | 
  112 |   await page.clock.setSystemTime(AFTER_REFRESH);
  113 |   await page.getByRole('button', { name: '刷新', exact: true }).click();
  114 |   await expect(page.getByText(/游戏日 2026-03-11/)).toBeVisible();
  115 |   // 刷新后值不重置。
  116 |   await expect(page.getByLabel('抽卡 当前累计总值')).toHaveValue('10');
  117 | 
  118 |   // 新的一天继续记录当前总值：10 → 20，仍是 20。
  119 |   await page.getByRole('button', { name: '自动带入标题' }).first().click();
  120 |   await expect(page.getByRole('heading', { name: '自动带入标题' })).toBeVisible();
  121 |   await page.getByLabel('抽卡 当前累计总值').fill('20');
  122 |   await page.getByRole('button', { name: '记录总值' }).click();
  123 |   await expect(page.getByText(/20 \/ 100/).first()).toBeVisible();
  124 |   await expect(page.getByText(/30 \/ 100/)).toHaveCount(0);
  125 | 
  126 |   // 浏览器重启（整页重载）后总值与两天的事件历史仍在。
  127 |   await page.reload();
> 128 |   await page.getByRole('button', { name: '订单' }).click();
      |                                                  ^ Error: locator.click: Error: strict mode violation: getByRole('button', { name: '订单' }) resolved to 2 elements:
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
  219 |   await page
  220 |     .locator('li')
  221 |     .filter({ hasText: 'UID 9202' })
  222 |     .getByLabel('调整 原神 官服 分类')
  223 |     .selectOption({ label: '长期客户' });
  224 |   await expect(
  225 |     page.locator('li').filter({ hasText: 'UID 9202' }).getByText('长期客户').first(),
  226 |   ).toBeVisible();
  227 |   await expect(
  228 |     page.locator('li').filter({ hasText: 'UID 9201' }).getByText('长期客户').first(),
```