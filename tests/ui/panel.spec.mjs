import { choose, expect, expectNoOverflow, login, openEditor, test } from './fixtures.mjs';

async function tapVisible(page, target, rightInset) {
  await expect(target).toBeInViewport({ ratio: 1 });
  const box = await target.boundingBox();
  // Touch the screen position without Playwright scrolling the drawer.
  await page.touchscreen.tap(box.x + (rightInset ? box.width - rightInset : box.width / 2), box.y + box.height / 2);
}

async function chooseWithoutScroll(page, editor, field, name) {
  const position = () => editor.evaluate(element => ({
    drawer: Math.round(element.scrollTop),
    page: Math.round(window.scrollY),
  }));
  const before = await position();
  expect(before.drawer).toBeGreaterThan(100);
  await tapVisible(page, field, 16);
  const option = page.getByRole('option', { name, exact: true });
  await expect(option).toBeInViewport({ ratio: 1 });
  expect(await position()).toEqual(before);
  await tapVisible(page, option);
  await expect(option).toBeHidden();
  await expect(field).toBeInViewport({ ratio: 1 });
  const after = await position();
  expect(after.page).toBe(before.page);
  // A draft change can insert a notice above the field and move the scroll anchor down.
  expect(after.drawer).toBeGreaterThanOrEqual(before.drawer - 2);
}

test('mobile dropdowns open at the bottom of a populated editor without jumping', async ({ page, panel, press, isMobile }) => {
  test.skip(!isMobile, 'Reproduces a tap in a scrolled phone viewport');
  await page.setViewportSize({ width: 393, height: 700 });
  const { system, node } = panel;
  const current = (await system.call('/nodes')).body.find(item => item.id === node.id);
  const seeded = await system.call(`/nodes/${node.id}/draft`, 'PUT', {
    revision: current.revision,
    customRules: ['google', 'apple', 'microsoft'].map(name => ({
      type: 'field', domain: [`geosite:${name}`], outboundTag: 'direct',
    })),
  });
  expect(seeded.status).toBe(200);
  await login(page, panel, press);
  const editor = await openEditor(page, press);
  await press(editor.getByRole('tab', { name: '分流规则' }));
  const rules = editor.getByRole('tabpanel', { name: '分流规则' });
  await expect(rules.getByText('GEOSITE · microsoft')).toBeVisible();
  const type = rules.getByRole('button', { name: '规则类型', exact: true });
  const action = rules.getByRole('button', { name: '动作', exact: true });
  await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.setViewportSize({ width: 393, height: 650 });
  await chooseWithoutScroll(page, editor, type, 'GEOSITE');
  await expect(type).toHaveText('GEOSITE');
  await chooseWithoutScroll(page, editor, action, '阻止 block');
  await expect(action).toHaveText('阻止 block');

  await press(editor.getByRole('tab', { name: '基础参数' }));
  const strategy = editor.getByLabel('出站 IP 策略');
  await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await chooseWithoutScroll(page, editor, strategy, '仅解析 IPv6');
  await expect(strategy).toHaveValue('仅解析 IPv6');
});

test('routing rule choices, editing, ordering and persisted preview', async ({ page, panel, press, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 650 });
  await login(page, panel, press);
  const editor = await openEditor(page, press);
  await press(editor.getByRole('tab', { name: '分流规则' }));
  const rules = editor.getByRole('tabpanel', { name: '分流规则' });
  const type = rules.getByRole('button', { name: '规则类型', exact: true });
  const value = rules.getByLabel('匹配值');
  const action = rules.getByRole('button', { name: '动作', exact: true });

  await choose(page, press, type, 'DOMAIN-SUFFIX');
  await expect(type).toHaveText('DOMAIN-SUFFIX');
  await press(type);
  const cidrOption = page.getByRole('option', { name: 'IP-CIDR', exact: true });
  await expect(cidrOption).toBeVisible();
  await type.press('Escape');
  await expect(cidrOption).toBeHidden();
  await expect(editor).toBeVisible();
  const longDomain = `${'a'.repeat(63)}.example.net`;
  await value.fill(longDomain);
  await choose(page, press, action, 'IPv6 解析');
  await expect(action).toHaveText('IPv6 解析');
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
