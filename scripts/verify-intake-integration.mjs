import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { origin, username, password } from './maxkb-client.mjs';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/admin/login`);
  await page.getByPlaceholder('用户名').fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/admin/home');
  const menu = page.getByText('客服知识录入', { exact: true });
  await menu.click();
  await page.waitForURL('**/admin/customer-knowledge-intake');
  const frame = page.frameLocator('[data-testid="knowledge-intake-frame"]');
  await frame.locator('#product option').nth(1).waitFor({ state: 'attached' });
  assert(await frame.locator('#product option').count() >= 3);
  await frame.locator('#question').fill('导航集成检查：尚未提交的内容');
  await frame.getByRole('button', { name: '模型设置', exact: true }).click();
  await frame.locator('#baseUrl').waitFor({ state: 'visible' });
  await frame.getByRole('button', { name: '录入知识', exact: true }).click();
  assert.equal(await frame.locator('#question').inputValue(), '导航集成检查：尚未提交的内容');
  await page.screenshot({ path: '.local/intake-integrated-1440.png', fullPage: true });
  await page.reload();
  await frame.locator('#product option').nth(1).waitFor({ state: 'attached' });
  await page.getByText('知识库', { exact: true }).first().click();
  await page.waitForURL('**/admin/knowledge');
  await menu.click();
  await page.waitForURL('**/admin/customer-knowledge-intake');
  await page.goBack();
  await page.waitForURL('**/admin/knowledge');
  await page.goForward();
  await page.waitForURL('**/admin/customer-knowledge-intake');
  await frame.locator('#product option').nth(1).waitFor({ state: 'attached' });
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `.local/intake-integrated-${width}.png`, fullPage: true });
    assert(await frame.locator('body').evaluate(el => el.scrollWidth <= innerWidth + 1));
  }
  const guest = await browser.newPage();
  await guest.goto(`${origin}/admin/customer-knowledge-intake`);
  await guest.waitForURL('**/admin/login');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: top navigation, embedded product API, settings, refresh, back/forward, existing knowledge page, responsive intake, login redirect.');
} finally { await browser.close(); }
