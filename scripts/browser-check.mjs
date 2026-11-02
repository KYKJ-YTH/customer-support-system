import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { origin, username, password } from './maxkb-client.mjs';

await mkdir('.local', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  await page.goto(`${origin}/admin/login`);
  await page.getByPlaceholder('用户名').fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(url => !url.pathname.includes('/login'));
  await page.waitForLoadState('networkidle');
  const dialog = page.getByRole('dialog', { name: '修改密码' });
  if (await dialog.isVisible()) {
    const newPassword = `Support!${randomBytes(5).toString('hex')}1`;
    for (const input of await dialog.locator('input').all()) await input.fill(newPassword);
    const responsePromise = page.waitForResponse(response => response.url().includes('password') && response.request().method() !== 'GET');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    const result = await (await responsePromise).json();
    if (result.code !== 200) throw new Error(`Password initialization failed: ${result.message}`);
    await writeFile('.local/login.json', JSON.stringify({ url: `${origin}/admin/login`, username, password: newPassword }, null, 2));
    await dialog.waitFor({ state: 'hidden' });
    console.log('Initialized administrator password; credentials saved in .local/login.json');
  }
  if (process.argv[2]) await page.goto(`${origin}${process.argv[2]}`);
  await page.waitForLoadState('networkidle');
  console.log(JSON.stringify({ url: page.url(), text: await page.locator('body').innerText() }));
  await page.screenshot({ path: '.local/maxkb-desktop.png', fullPage: true });
} finally {
  await browser.close();
}
