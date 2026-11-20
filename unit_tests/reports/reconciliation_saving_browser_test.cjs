// Delay a fixture match to inspect the actual button and spinner geometry.
const assert = require('node:assert/strict')
const { fixture, engines } = require('./duo_layout_browser_test.cjs')

const row = { id: 1, version: 'fixture-v1', status: 'needs_review', date: '2026-10-20', merchant: 'Fixture store',
  amountCents: 16631, currency: 'USD', accountLabel: 'Fixture card', suggestions: [] }
const match = { id: 'fixture-expense', item: 'Rain jacket', date: '2026-10-18', amountCents: 16631, category: 'Shopping',
  amountMismatch: false, kind: 'recorded', confirmable: true }
const snapshot = (item) => ({ enabled: true, checkedAt: null, items: [item] })

async function verify(browser, width, height, dark) {
  let finish, posts = 0
  const waitForSave = new Promise(resolve => { finish = resolve })
  const { page, errors, unexpected } = await fixture(browser, width, height, dark, false, false, 0, {
    async request(route) {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path === '/app/reconciliation/1') await route.fulfill({ json: { item: { ...row, suggestions: [match] } } })
      else if (path !== '/app/reconciliation') return false
      else if (request.method() === 'POST') {
        posts++
        assert.equal(request.postDataJSON().operation, 'confirm')
        await waitForSave
        await route.fulfill({ json: snapshot({ ...row, status: 'checked' }) })
      } else await route.fulfill({ json: snapshot(row) })
      return true
    },
  })
  try {
    await page.getByRole('button', { name: 'Reconcile', exact: true }).click()
    await page.getByRole('button', { name: /^Fixture store/ }).click()
    const confirm = page.getByRole('button', { name: 'Confirm match', exact: true })
    await confirm.click()
    const spinner = confirm.locator('.bb-report-loading-spinner')
    await spinner.waitFor({ state: 'visible' })
    assert.equal(await confirm.isDisabled(), true)
    assert.equal(await confirm.getAttribute('aria-busy'), 'true')
    assert.equal(await page.locator('.bb-reconcile .bb-report-loading').count(), 1)
    const box = await confirm.boundingBox(), indicator = await spinner.boundingBox()
    for (const [axis, length] of [['x', 'width'], ['y', 'height']])
      assert(Math.abs(box[axis] + box[length] / 2 - indicator[axis] - indicator[length] / 2) < 1, 'Spinner stays centered inside the button')
    finish()
    await confirm.waitFor({ state: 'detached' })
    assert.equal(posts, 1)
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
  } finally {
    finish()
    await page.close()
  }
}

;(async () => {
  for (const engine of engines) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const [width, height, dark] of [[382, 852, false], [867, 669, true]]) {
        await verify(browser, width, height, dark)
        console.log('PASS in-button Reconcile spinner', engine.name(), width, height)
      }
    } finally { await browser.close() }
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
