import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { origin } from './maxkb-client.mjs';

const config = JSON.parse(await readFile('.local/pilot.json', 'utf8'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const viewports = [{ width: 1440, height: 1000 }];
  if (process.argv.includes('--mobile')) viewports.push({ width: 390, height: 844 });
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport, locale: 'zh-CN' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/chat/${config.products[0].access.access_token}`);
    await page.locator('textarea').fill('请问这个商品是什么型号？');
    await page.locator('textarea').press('Enter');
    await page.getByText('DEMO-A', { exact: false }).first().waitFor();
    await page.screenshot({ path: `.local/chat-${viewport.width}.png`, fullPage: true });
    const text = await page.locator('body').innerText();
    assert(text.includes('DEMO-A'));
    assert(!text.includes('DEMO-B'));
    console.log(JSON.stringify({ viewport, url: page.url(), text, errors }));
    assert.equal(errors.length, 0);
    await page.close();
  }
} finally {
  await browser.close();
}
