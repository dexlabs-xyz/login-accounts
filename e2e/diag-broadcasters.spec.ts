/**
 * Diagnostic, not part of the normal suite: are there Railgun broadcasters on
 * Sepolia, and do they accept our test USDT? Run: DIAG=1 npx playwright test e2e/diag-broadcasters.spec.ts
 */
import { test } from '@playwright/test';

test.skip(!process.env.DIAG, 'Diagnostic only; set DIAG=1');
test.setTimeout(240_000);

test('Railgun broadcasters on Sepolia', async ({ page }) => {
  page.on('console', (m) => /error/i.test(m.type()) && console.log('[console]', m.text().slice(0, 300)));
  page.context().on('requestfailed', (r) => console.log('[failed]', new URL(r.url()).host, r.failure()?.errorText));
  await page.goto('/');
  // Runs in the browser, where Vite serves the source file at this path.
  const result = await page.evaluate(async (path) => {
    const mod = (await import(/* @vite-ignore */ path)) as { checkBroadcasters: (ms: number) => Promise<unknown> };
    return mod.checkBroadcasters(120_000);
  }, '/src/dev/broadcaster-check.ts');
  console.log('[broadcasters]', JSON.stringify(result, null, 2));
});
