// Shared by the tests that drive a real browser.
//
// Playwright is not a dependency of this package: the browser tests need it,
// but a checkout without it should still run every other test. So instead of
// importing it at the top of a test file, where a missing package crashes the
// whole file at load, tests call tryLaunchChromium() and SKIP with the reason
// it returns. A skip is visible in the output and names the fix, which is the
// same rule the motion tests follow when MuJoCo is missing: a test that could
// not run must never look like a test that passed.
//
// To run the browser tests:
//   npm install --no-save playwright && npx playwright install chromium
// (--no-save keeps package.json unchanged.)

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const FIX = 'npm install --no-save playwright && npx playwright install chromium';

/**
 * Resolve Playwright and launch Chromium, or say plainly why that is not
 * possible. Never throws.
 *
 * @returns {Promise<{browser: object|null, skipReason: string|null}>}
 */
export async function tryLaunchChromium(launchOptions = {}) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    return {
      browser: null,
      skipReason: `Playwright is not installed (${e.code ?? e.message}), so browser tests are skipped. To run them: ${FIX}`,
    };
  }
  try {
    return { browser: await chromium.launch(launchOptions), skipReason: null };
  } catch (e) {
    const firstLine = String(e.message ?? e).split('\n')[0];
    return {
      browser: null,
      skipReason: `Chromium could not be launched (${firstLine}), so browser tests are skipped. To run them: ${FIX}`,
    };
  }
}
