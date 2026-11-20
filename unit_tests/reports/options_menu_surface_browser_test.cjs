const assert = require('node:assert/strict')
const { fixture, engines } = require('./duo_layout_browser_test.cjs')
const { base } = require('./savings_workspace_browser_test.cjs')

async function verify(browser, width, height, dark) {
  const { page, errors, unexpected } = await fixture(browser, width, height, dark, false, false, 0, {
    async request(route) {
      if (new URL(route.request().url()).pathname !== '/app/savings') return false
      assert.equal(route.request().method(), 'GET')
      await route.fulfill({ json: base() })
      return true
    },
  })
  try {
    const tab = (screen) => page.locator(`[data-nav-screen="${screen}"]`).click()
    const noGlow = async (locator, name) => {
      await locator.waitFor()
      const style = await locator.evaluate(node => {
        const css = getComputedStyle(node)
        return { shadow: css.boxShadow, filter: css.filter, surface: css.backgroundColor }
      })
      assert.equal(style.shadow, 'none', name)
      assert(!style.filter.includes('drop-shadow'), name)
      assert(!['transparent', 'rgba(0, 0, 0, 0)'].includes(style.surface), name)
    }

    await tab('transactions')
    await page.locator('#bb-main-page-title .bb-month-trigger').click()
    await noGlow(page.locator('.bb-month-popover[aria-hidden="false"] > .k-glass'), 'Transactions month picker')
    await page.keyboard.press('Escape')
    await tab('shared')
    await page.getByRole('button', { name: 'Reimbursement options', exact: true }).click()
    await noGlow(page.getByRole('dialog', { name: 'Options', exact: true }), 'Reimbursements options')
    await page.keyboard.press('Escape')
    await tab('savings')
    await page.getByRole('button', { name: 'Savings options', exact: true }).click()
    await noGlow(page.getByRole('dialog', { name: 'Savings options', exact: true }), 'Savings options')
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
  } finally {
    await page.close()
  }
}

;(async () => {
  for (const engine of engines) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const [width, height, dark] of [[382, 678, true], [951, 669, false], [951, 669, true]]) {
        await verify(browser, width, height, dark)
        console.log('PASS options surfaces', engine.name(), width, height, dark ? 'dark' : 'light')
      }
    } finally { await browser.close() }
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
