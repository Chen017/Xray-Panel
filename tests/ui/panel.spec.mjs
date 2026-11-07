import { choose, expect, expectNoOverflow, login, openEditor, test } from './fixtures.mjs';

test('routing rule choices, editing, ordering and persisted preview', async ({ page, panel, press, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 650 });
  await login(page, panel, press);
  const editor = await openEditor(page, press);
  await press(editor.getByRole('tab', { name: '分流规则' }));
  const rules = editor.getByRole('tabpanel', { name: '分流规则' });
  const type = rules.getByLabel('规则类型');
  const value = rules.getByLabel('匹配值');
  const action = rules.getByLabel('动作', { exact: true });

  await choose(page, press, type, 'DOMAIN-SUFFIX');
  await expect(type).toHaveValue('DOMAIN-SUFFIX');
  await press(type);
  const cidrOption = page.getByRole('option', { name: 'IP-CIDR', exact: true });
  await expect(cidrOption).toBeVisible();
  await type.press('Escape');
  await expect(cidrOption).toBeHidden();
  await expect(editor).toBeVisible();
  const longDomain = `${'a'.repeat(63)}.example.net`;
  await value.fill(longDomain);
  await choose(page, press, action, 'IPv6 解析');
  await expect(action).toHaveValue('IPv6 解析');
  await press(rules.getByRole('button', { name: '添加到草稿' }));

  await choose(page, press, type, 'IP-CIDR');
  await value.fill('198.51.100.0/24');
  await choose(page, press, action, '阻止 block');
  await press(rules.getByRole('button', { name: '添加到草稿' }));
  await press(rules.getByRole('button', { name: '上移规则 2' }));
  await expect(rules.getByRole('button', { name: '上移规则 1' })).toBeDisabled();
  await press(rules.getByRole('button', { name: '编辑', exact: true }).first());
  await expect(value).toHaveValue('198.51.100.0/24');
  await value.fill('192.0.2.0/24');
  await press(rules.getByRole('button', { name: '更新此规则' }));
  await expect(rules.getByText('IP-CIDR · 192.0.2.0/24')).toBeVisible();

  await press(editor.getByRole('button', { name: '预览部署' }));
  const preview = page.getByRole('dialog', { name: '即将部署的配置（已注入设备独立 UUID）' });
  await expect(preview.getByText(/192\.0\.2\.0\/24/)).toBeVisible();
  const persisted = (await panel.system.call(`/nodes/${panel.node.id}/preview`)).body;
  expect(persisted.bundle.files['custom_rules.json']).toEqual([
    { type: 'field', ip: ['192.0.2.0/24'], outboundTag: 'block' },
    { type: 'field', domain: [`domain:${longDomain}`], outboundTag: 'direct-v6' },
  ]);
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await press(rules.getByRole('button', { name: '删除规则 2' }));
  await press(editor.getByRole('button', { name: '保存草稿' }));
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await openEditor(page, press);
  await press(editor.getByRole('tab', { name: '分流规则' }));
  await expect(rules.getByText('IP-CIDR · 192.0.2.0/24')).toBeVisible();
  await expect(rules.getByText(`DOMAIN-SUFFIX · ${longDomain}`)).toBeHidden();
  await expectNoOverflow(editor);
});
