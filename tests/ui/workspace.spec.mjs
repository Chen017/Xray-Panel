import { readFile } from 'node:fs/promises';
import { choose, expect, expectNoOverflow, login, navigate, nodeName, openEditor, secondNodeName, test } from './fixtures.mjs';

test('login, navigation and theme changes follow the system and survive reload', async ({ page, panel, press, isMobile, colorScheme }) => {
  const root = page.locator('html');
  const theme = page.getByRole('button', { name: /^界面主题：/ });
  const opposite = colorScheme === 'light' ? 'dark' : 'light';
  await page.goto(panel.url);
  await expect(root).toHaveAttribute('data-mantine-color-scheme', colorScheme);
  await page.getByPlaceholder('输入管理员密码').fill('incorrect-password');
  await press(page.getByRole('button', { name: '登录控制台' }));
  await expect(page.getByText('密码错误', { exact: true })).toBeVisible();
  await login(page, panel, press);
  const originalBackground = await page.locator('body').evaluate(body => getComputedStyle(body).backgroundColor);
  await press(theme);
  await press(page.getByRole('menuitem', { name: opposite === 'dark' ? '深色' : '浅色', exact: true }));
  await expect(root).toHaveAttribute('data-mantine-color-scheme', opposite);
  await expect(page.locator('body')).not.toHaveCSS('background-color', originalBackground);
  await page.reload();
  await expect(page.getByRole('heading', { name: '节点管理' })).toBeVisible();
  await expect(root).toHaveAttribute('data-mantine-color-scheme', opposite);
  await press(theme);
  await press(page.getByRole('menuitem', { name: '跟随系统', exact: true }));
  await expect(root).toHaveAttribute('data-mantine-color-scheme', colorScheme);
  await page.emulateMedia({ colorScheme: opposite });
  await expect(root).toHaveAttribute('data-mantine-color-scheme', opposite);

  for (const section of ['部署与任务', '设备与订阅', '安全与设置', '部署指南', '节点管理']) {
    await navigate(page, isMobile, press, section);
    await expectNoOverflow(root);
  }
  if (isMobile) await press(page.getByRole('button', { name: '打开导航菜单' }));
  await press(page.getByRole('button', { name: '退出登录' }));
  await expect(page.getByRole('button', { name: '登录控制台' })).toBeVisible();
});

test('node search, selection, ordering and Agent enrollment', async ({ page, panel, press, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 650 });
  await login(page, panel, press);
  const search = page.getByRole('textbox', { name: '搜索节点' });
  const manage = page.getByRole('button', { name: `管理 ${nodeName}`, exact: true });
  await search.fill('203.0.113.20');
  await expect(manage).toBeHidden();
  await expect(page.getByRole('button', { name: `管理 ${secondNodeName}`, exact: true })).toBeVisible();
  await search.clear();
  const selectAll = page.getByRole('checkbox', { name: '选择所有节点' });
  await press(selectAll);
  await expect(page.getByText('已选 2 台')).toBeVisible();
  await press(selectAll);
  await expect(page.getByText('已选 2 台')).toBeHidden();
  await press(page.getByRole('button', { name: '节点排序' }));
  const order = page.getByRole('dialog', { name: '所有节点排序' });
  await press(order.getByRole('button', { name: `上移：${secondNodeName}` }));
  await press(order.getByRole('button', { name: '保存顺序' }));
  await expect(order).toBeHidden();
  expect((await panel.system.call('/node-order')).body.order).toEqual([panel.secondary.id, panel.node.id]);

  await press(page.getByRole('button', { name: '添加节点', exact: true }));
  const create = page.getByRole('dialog', { name: '添加 Xray 节点' });
  await create.getByLabel('节点名称').fill('回归测试新节点');
  await create.getByLabel('IPv4 / 域名').fill('node.example.org');
  await press(create.getByRole('button', { name: '创建节点并生成 Agent 凭据' }));
  const enrollment = page.getByRole('dialog', { name: '接入 VPS Agent' });
  await expect(enrollment.getByRole('tab', { name: '安装脚本' })).toHaveAttribute('aria-selected', 'true');
  await press(enrollment.getByRole('tab', { name: '高级：原始配置' }));
  await expect(enrollment.getByRole('tabpanel', { name: '高级：原始配置' }).locator('pre')).toContainText('nodeId');
  await expectNoOverflow(enrollment);
  await page.keyboard.press('Escape');
  await expect(enrollment).toBeHidden();
  await expect(page.getByRole('button', { name: '管理 回归测试新节点', exact: true })).toBeVisible();
  await expectNoOverflow(page.locator('html'));
});

test('editor selectors, nested dialogs and operation jobs work end to end', async ({ page, panel, press, isMobile }) => {
  await login(page, panel, press);
  const editor = await openEditor(page, press);
  await choose(page, press, editor.getByLabel('IPv4 来源'), '自动检测公网 IP');
  await expect(editor.getByLabel('IPv4 手动覆盖')).toBeHidden();
  await choose(page, press, editor.getByLabel('IPv4 来源'), '手动 IP / 域名（NAT / DDNS）');
  await expect(editor.getByLabel('IPv4 手动覆盖')).toBeVisible();
  await press(editor.getByRole('button', { name: '订阅名称', exact: true }));
  const names = page.getByRole('dialog', { name: `统一订阅名称 · ${nodeName}` });
  await names.getByLabel('订阅基础名称').fill('统一测试名');
  await press(names.getByRole('button', { name: '保存所有设备的名称' }));
  await expect(names).toBeHidden();
  await expect(editor.getByText('订阅名称：统一测试名', { exact: false })).toBeVisible();

  await choose(page, press, editor.getByLabel('监听端口'), '8443');
  await choose(page, press, editor.getByLabel('双栈分离方向'), 'IPv6 上行 / IPv4 下行');
  await expect(editor.getByLabel('监听端口')).toHaveValue('8443');
  await press(editor.getByRole('tab', { name: '线路 / 落地' }));
  await choose(page, press, editor.getByLabel('互联角色'), '落地机 / NAT / LXC');
  const nat = editor.getByRole('switch', { name: '允许客户端通过 NAT IPv4 接入' });
  await press(nat);
  await expect(nat).toBeChecked();
  const keygen = page.getByRole('dialog', { name: '任务结果 · relay-entry-keygen' });
  await expect(keygen).toBeVisible();
  await panel.completeJob('relay-entry-keygen', JSON.stringify({ encryption: 'fixture-encryption', decryption: 'fixture-decryption' }));
  await expect(keygen).toBeHidden({ timeout: 10_000 });
  await expect(editor.getByText('独立加密参数已就绪')).toBeVisible();
  await choose(page, press, editor.getByLabel('互联角色'), '独立节点（移除互联）');
  await expect(nat).toBeHidden();

  await press(editor.getByRole('tab', { name: '高级', exact: true }));
  await press(editor.getByRole('button', { name: 'UUID、REALITY 密钥、Short IDs 与日志' }));
  const logLevel = editor.getByLabel('日志等级');
  await logLevel.scrollIntoViewIfNeeded();
  await choose(page, press, logLevel, 'error');
  await expect(editor.getByLabel('日志等级')).toHaveValue('error');
  await press(editor.getByRole('tab', { name: '运维' }));
  const operations = editor.getByRole('tabpanel', { name: '运维' });
  await choose(page, press, operations.getByLabel('操作', { exact: true }), '关闭 TCP / UDP');
  await operations.getByLabel('端口', { exact: true }).fill('8080');
  await press(operations.getByRole('button', { name: '添加到草稿' }));
  await expect(operations.getByLabel('手动附加放行 / 关闭策略 JSON')).toHaveValue(/8080/);
  await press(operations.getByRole('button', { name: '校验当前配置' }));
  const result = page.getByRole('dialog', { name: '任务结果 · validate' });
  await expect(result.getByText('等待 Agent 领取', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(result).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await navigate(page, isMobile, press, '部署与任务');
  const task = page.getByRole('row').filter({ hasText: 'validate' });
  await press(task.getByRole('button', { name: '取消', exact: true }));
  await expect(task.getByText('已取消')).toBeVisible();
  await press(task.getByRole('button', { name: '查看结果' }));
  await expect(result.getByText('已取消')).toBeVisible();
});

test('device authorization choices, key generation and H2 settings persist', async ({ page, panel, press, isMobile }) => {
  await login(page, panel, press);
  await navigate(page, isMobile, press, '设备与订阅');
  await press(page.getByRole('button', { name: '授权设备', exact: true }).first());
  const create = page.getByRole('dialog', { name: '授权新设备' });
  await create.getByLabel('设备名称').fill('测试手机');
  await press(create.getByRole('button', { name: '在此浏览器生成设备密钥' }));
  await expect(create.getByLabel('设备 age 公钥')).toHaveValue(/^age1/);
  await press(create.getByRole('checkbox', { name: nodeName }));
  await choose(page, press, create.getByText('XHTTP 双栈分离', { exact: true }), 'Vision IPv4');
  await press(create.getByRole('button', { name: '保存授权' }));
  const secret = page.getByRole('dialog', { name: '设备订阅配置 · 仅显示一次' });
  await expect(secret.locator('pre').first()).toContainText('proxy-providers:');
  await page.keyboard.press('Escape');
  await expect(secret).toBeHidden();
  const { id, grants } = (await panel.system.call('/devices')).body[0];
  expect(grants[0].modes).toEqual(['split', 'vision4']);
  await press(page.getByRole('button', { name: '下行 H2 窗口' }));
  const window = page.getByRole('dialog', { name: '测试手机 · 下行 H2 窗口' });
  const windowSwitch = window.getByRole('switch', { name: /启用.*的下行窗口/ });
  await press(window.locator(`label[for="${await windowSwitch.getAttribute('id')}"]`));
  await expect(windowSwitch).toBeChecked();
  await window.getByLabel('接收窗口（M）').fill('12M');
  await press(window.getByRole('button', { name: '保存窗口设置' }));
  await expect(window).toBeHidden();
  expect(Object.values((await panel.system.call(`/devices/${id}/download-windows`)).body.windows)).toEqual([12 * 1024 * 1024]);
  await expectNoOverflow(page.locator('html'));
});

test('security forms, encrypted backup download and documentation tabs', async ({ page, panel, press, isMobile }) => {
  await login(page, panel, press);
  await navigate(page, isMobile, press, '安全与设置');
  await page.getByLabel('每轮间隔（秒）').fill('420');
  await press(page.getByRole('button', { name: '保存告警设置' }));
  await expect(page.getByText('告警设置已保存', { exact: true })).toBeVisible();
  expect((await panel.system.call('/monitoring')).body.settings.interval).toBe(420);
  await expect(page.getByRole('button', { name: '恢复备份', exact: true })).toBeDisabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'), press(page.getByRole('button', { name: '导出加密备份' })),
  ]);
  const backup = await readFile(await download.path(), 'utf8');
  expect(JSON.parse(backup).records.length).toBeGreaterThan(0);
  expect(backup).not.toContain(nodeName);
  await expectNoOverflow(page.locator('html'));
  await navigate(page, isMobile, press, '部署指南');
  for (const title of ['项目说明', '节点接入与部署', 'Cloudflare Zero Trust', 'Mihomo / Clash Verge Rev', 'Telegram 告警']) {
    await press(page.getByRole('tab', { name: title, exact: true }));
    await expect(page.getByRole('tabpanel', { name: title }).getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoOverflow(page.locator('html'));
  }
});
