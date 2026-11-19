const assert = require('node:assert/strict');
const {fixture, engines, tap, report} = require('./duo_layout_browser_test.cjs');
const {base} = require('./savings_workspace_browser_test.cjs');

async function checkVisibility(page, step, expectRetained = false) {
  // An inactive ancestor can be visibility:hidden while a nested pane still
  // paints with its own visibility:visible. AX visibility alone misses this.
  await page.waitForFunction(() => !document.querySelector('.sw-root .bi-step-viewport[data-moving=true]'));
  const result = await page.locator('.sw-root').evaluate(root => {
    const retained = [...root.querySelectorAll('.bi-step-pane[data-visible=false] .bi-step-pane')];
    const leaks = retained.filter(pane => {
      const style = getComputedStyle(pane);
      if (style.visibility !== 'visible' || !pane.offsetWidth || !pane.offsetHeight) return false;
      for (let node = pane; node && node !== root; node = node.parentElement) {
        if (getComputedStyle(node).opacity === '0') return false;
      }
      return true;
    });
    return {retained: retained.length, leaks: leaks.map(pane => pane.querySelector('h2')?.textContent ?? pane.dataset.scene)};
  });
  if (expectRetained) assert(result.retained > 0, step + ' exercises nested retained panes');
  assert.deepEqual(result.leaks, [], step + ' paints only the active editor');
}

async function verify(browser, width, height, dark) {
  const month = new Date().toLocaleDateString('en-CA', {timeZone: 'America/Los_Angeles'}).slice(0, 7);
  const shown = {...report, year: Number(month.slice(0, 4)), month: Number(month.slice(5))};
  const state = base();
  const {page, errors, unexpected} = await fixture(browser, width, height, dark, false, false, width === 951 ? 84 : 0, {
    report: () => shown,
    request: async route => {
      if (new URL(route.request().url()).pathname !== '/app/savings' || route.request().method() !== 'GET') return false;
      await route.fulfill({json: state});
      return true;
    },
  });
  try {
    await tap(page, page.locator('[data-nav-screen=savings]'));
    const app = page.locator('.sw-root');
    const button = name => app.getByRole('button', {name, exact: typeof name === 'string'});
    await page.emulateMedia({reducedMotion: 'no-preference'});
    await button('View Emergency fund').click();
    await button('Edit goal').click();
    await app.getByRole('textbox', {name: 'Goal name'}).fill('First draft');
    await button('View Japan trip').click();
    await app.getByRole('heading', {name: 'Japan trip', exact: true}).waitFor();
    await checkVisibility(page, 'Switching from Edit goal to another goal');

    await button('End goal').click();
    await button('Review').click();
    await app.getByRole('heading', {name: 'Review end goal', exact: true}).waitFor();
    await checkVisibility(page, 'Reviewing an end-goal action');
    await button('Back').click();
    await app.getByRole('heading', {name: 'End goal', exact: true}).waitFor();
    await checkVisibility(page, 'Returning from the end-goal review');
    await button('Cancel').click();
    await checkVisibility(page, 'Canceling the end-goal editor');

    if (width >= 800) await button('Close savings details').click();
    await button(/Ally Savings.*10,000/).click();
    await button('Edit account').click();
    await app.locator('.si-institution-field').filter({visible: true}).click();
    await app.getByRole('searchbox', {name: 'Bank or institution'}).fill('Chase');
    await checkVisibility(page, 'Opening the institution picker', true);
    await button('Back').click();
    await app.getByRole('heading', {name: 'Edit account', exact: true}).waitFor();
    await checkVisibility(page, 'Returning from institutions to Edit account');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  } catch (error) {
    await page.screenshot({path: '/private/tmp/bookiebot-savings-editor-visibility-failure.png'});
    throw error;
  } finally {
    await page.close();
  }
}

(async () => {
  for (const engine of engines.filter(e => !process.env.ONLY_ENGINE || e.name() === process.env.ONLY_ENGINE)) {
    const browser = await engine.launch({headless: true});
    try {
      for (const [width, height, dark] of [[382, 678, true], [951, 669, false]]) {
        await verify(browser, width, height, dark);
        console.log('PASS Savings editor visibility', engine.name(), width, height);
      }
    } finally {
      await browser.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
