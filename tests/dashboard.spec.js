// Hormuz Watch dashboard smoke tests — runs in chromium, firefox, webkit.
// Smoke only: validates the headline metrics render and the verdict badge
// appears. Catches render bugs that may differ across browser engines.
const { test, expect } = require('@playwright/test');

test.describe('dashboard smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('brent price renders with $ and a number', async ({ page }) => {
    const el = page.locator('#brentPrice');
    await expect(el).toBeVisible({ timeout: 30_000 });
    // Wait until the element is hydrated past the "$&mdash;" placeholder
    await expect.poll(async () => (await el.textContent() || '').trim(), {
      timeout: 30_000,
      message: 'brentPrice never populated with a numeric value',
    }).toMatch(/^\$\s*[\d.,]+/);
  });

  test('vessel transit count is visible', async ({ page }) => {
    const el = page.locator('#mvTransit24h');
    await expect(el).toBeVisible({ timeout: 30_000 });
    // Any value (including 0) is acceptable — we just need it rendered
    await expect.poll(async () => (await el.textContent() || '').trim(), {
      timeout: 30_000,
      message: 'mvTransit24h never received a value',
    }).toMatch(/\d/);
  });

  test('verdict badge appears', async ({ page }, testInfo) => {
    // renderConclusions() runs at T+2.5s; give it generous slack across browsers
    const badge = page.locator('.cv-badge').first();
    await expect(badge).toBeVisible({ timeout: 30_000 });
    const text = (await badge.textContent() || '').trim();
    expect(text.length).toBeGreaterThan(0);
    // Fullpage screenshot for visual review per browser
    await page.screenshot({
      path: testInfo.outputPath(`dashboard-${testInfo.project.name}.png`),
      fullPage: true,
    });
    await testInfo.attach(`dashboard-${testInfo.project.name}.png`, {
      path: testInfo.outputPath(`dashboard-${testInfo.project.name}.png`),
      contentType: 'image/png',
    });
  });
});
