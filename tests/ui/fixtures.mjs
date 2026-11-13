import { test as base, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixtureBundle, testPassword, testSystem } from '../helpers.mjs';

export const nodeName = '东京测试线路';
export const secondNodeName = '香港测试节点';

export const test = base.extend({
  tls: [async ({}, use) => {
    // WebKit honors the production CSP by upgrading asset requests to HTTPS.
    const directory = mkdtempSync(path.join(tmpdir(), 'xray-panel-ui-'));
    const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
    const gitOpenSSL = 'C:/Program Files/Git/usr/bin/openssl.exe';
    const openssl = process.env.OPENSSL_BIN ?? (existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl');
    try {
      execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
        '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 15_000, stdio: 'pipe' });
      await use({ key: readFileSync(key), cert: readFileSync(cert) });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
  panel: async ({ tls }, use) => {
    const system = await testSystem({ secure: true });
    const server = createServer(tls, system.admin);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const url = `https://127.0.0.1:${server.address().port}`;
      system.config.adminOrigin = url;
      system.config.agentOrigin = 'https://agent.example.test';
      system.config.subscriptionOrigin = 'https://subscriptions.example.test';
      await system.login();
      const primary = await system.call('/nodes', 'POST', { name: nodeName, ipv4: '203.0.113.10', ipv6: '2001:db8::10' });
      const secondary = await system.call('/nodes', 'POST', { name: secondNodeName, ipv4: '203.0.113.20' });
      expect(primary.status).toBe(201);
      expect(secondary.status).toBe(201);
      const { node, agentToken } = primary.body;
      const agentHeaders = { 'Content-Type': 'application/json', 'X-Node-ID': node.id, Authorization: `Bearer ${agentToken}` };
      const bundle = fixtureBundle();
      let firewall;
      const poll = () => fetch(`${system.urls[2]}/v1/agent/poll`, {
        method: 'POST', headers: agentHeaders, body: JSON.stringify({ bundle, report: { installed: true, active: true, firewall } }),
      });
      expect((await poll()).status).toBe(200);
      async function completeJob(action, output) {
        const response = await poll();
        expect(response.status).toBe(200);
        const { job } = await response.json();
        expect(job.action).toBe(action);
        const result = await fetch(`${system.urls[2]}/v1/agent/jobs/${job.id}/result`, {
          method: 'POST', headers: agentHeaders,
          body: JSON.stringify({ ok: true, lease: job.lease, bundle: job.payload.bundle ?? bundle, output }),
        });
        expect(result.status).toBe(200);
      }
      async function publishFirewall(report) {
        firewall=report;
        expect((await poll()).status).toBe(200);
      }
      await use({ url, system, node, secondary: secondary.body.node, completeJob, publishFirewall });
    } finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await system.close();
    }
  },
  press: async ({ isMobile }, use) => {
    await use(locator => isMobile ? locator.tap() : locator.click());
  },
  consoleErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'uncaught browser errors').toEqual([]);
  }, { auto: true }],
});

export { expect };

export async function login(page, panel, press) {
  await page.goto(panel.url);
  await page.getByPlaceholder('输入管理员密码').fill(testPassword);
  await press(page.getByRole('button', { name: '登录控制台' }));
  await expect(page.getByRole('heading', { name: '节点管理', exact: true })).toBeVisible();
}

export async function openEditor(page, press) {
  await press(page.getByRole('button', { name: `管理 ${nodeName}`, exact: true }));
  const editor = page.getByRole('dialog', { name: nodeName, exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

export async function choose(page, press, field, option) {
  await press(field);
  await press(page.getByRole('option', { name: option, exact: true }));
}

export async function navigate(page, isMobile, press, name) {
  if (isMobile) await press(page.getByRole('button', { name: '打开导航菜单' }));
  await press(page.getByRole('button', { name: new RegExp(`^${name}(?: \\d+)?$`) }));
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '导航菜单' })).toBeHidden();
}

export async function expectNoOverflow(locator) {
  await expect.poll(() => locator.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}
