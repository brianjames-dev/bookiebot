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

async function verifyWorkspace(browser) {
  let release, releaseFirst
  const held = new Promise(resolve => { release = resolve })
  const heldFirst = new Promise(resolve => { releaseFirst = resolve })
  const items = Array.from({ length: 22 }, (_, i) => ({ ...row, id: i + 1, merchant: `Fixture charge ${i + 1}` }))
  const { page, errors, unexpected } = await fixture(browser, 867, 669, true, false, false, 0, {
    async request(route) {
      const path = new URL(route.request().url()).pathname
      if (path === '/app/reconciliation') {
        assert.equal(route.request().method(), 'GET', 'Opening an editor must not change a bank transaction')
        await route.fulfill({ json: { enabled: true, checkedAt: null, items } })
        return true
      }
      if (!path.startsWith('/app/reconciliation/')) return false
      const id = Number(path.split('/').at(-1))
      if (id === 1) await heldFirst
      if (id === 2) await held
      await route.fulfill({ json: { item: {
        ...items[id - 1],
        suggestions: id === 1 ? [match, { ...match, id: 'alternative', item: 'Backup jacket' }] : [],
        logging: { allowed: true, kind: 'expense', categories: ['shopping'], paymentMethods: ['Fixture card'], reason: '' },
      } } })
      return true
    },
  })
  const scrollStyle = selector => page.locator(selector).evaluate(el => {
    const style = getComputedStyle(el), box = el.getBoundingClientRect()
    return [box.right, style.paddingRight, style.scrollbarWidth, style.scrollbarColor, style.overflowY, style.overscrollBehaviorY]
  })
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByRole('button', { name: 'Transactions', exact: true }).click()
    await page.locator('.bb-page[data-duo-landscape=true][data-screen=transactions] .bb-recorded-results').waitFor()
    const transactionsStyle = await scrollStyle('.bb-recorded-results')
    await page.getByRole('button', { name: 'Reconcile', exact: true }).click()
    const queue = page.locator('.bb-reconcile-row-toggle')
    await queue.first().waitFor()
    const left = page.locator('.bb-reconcile-left')
    assert.deepEqual(await scrollStyle('.bb-reconcile-left'), transactionsStyle)
    const [scrollHeight, clientHeight] = await left.evaluate(el => [el.scrollHeight, el.clientHeight])
    assert(scrollHeight > clientHeight, `The list owns vertical scroll (${scrollHeight}px in a ${clientHeight}px viewport)`)
    const first = queue.filter({ has: page.getByText('Fixture charge 1', { exact: true }) })
    const second = queue.filter({ has: page.getByText('Fixture charge 2', { exact: true }) })
    await first.click()
    const pane = page.getByRole('complementary', { name: 'Transaction review' })
    await pane.getByText('Finding sheet entries…').waitFor({ state: 'attached' })
    const close = pane.getByRole('button', { name: 'Close review' })
    const loadingAnchor = await close.boundingBox()
    const paneBox = await pane.boundingBox()
    assert(loadingAnchor && Math.abs(loadingAnchor.y - paneBox.y - 3) < 1)
    releaseFirst()
    await pane.getByText('Rain jacket').waitFor()
    assert.deepEqual(await close.boundingBox(), loadingAnchor, 'Close stays at the same position while the review loads')
    await page.waitForFunction(() => document.querySelector('.bb-reconcile-pane').getAnimations({ subtree:true }).length === 0)
    const ignore = pane.getByRole('button', { name: 'Ignore transaction' })
    assert.equal(await ignore.evaluate(el => getComputedStyle(el).borderTopWidth), '0px')
    const options = pane.locator('summary[aria-label="Review options"]')
    await options.click()
    const menu = pane.locator('.bb-reconcile-menu-content')
    assert.deepEqual(await menu.locator('button').allTextContents(), ['Choose budget entry', 'Add expense'])
    assert.equal(await menu.getByText('Backup jacket').count(), 0)
    await menu.getByRole('button', { name: 'Choose budget entry' }).click()
    await pane.getByRole('heading', { name: 'Choose budget entry', exact: true }).waitFor()
    await pane.getByRole('button', { name: /Backup jacket/ }).click()
    await pane.getByRole('heading', { name: 'Review match' }).waitFor()
    await options.click()
    await menu.getByRole('button', { name: 'Add expense', exact: true }).click()
    await pane.getByRole('heading', { name: 'Add expense', exact: true }).waitFor()
    assert.equal(await pane.getByRole('heading', { name: /Add / }).count(), 1)
    const form = pane.locator('form.bb-reconcile-log')
    assert.equal(await form.evaluate(el => getComputedStyle(el).borderTopWidth), '0px')
    const [overflowX, overflowY, delta] = await pane.evaluate(el => [
      getComputedStyle(el).overflowX, getComputedStyle(el).overflowY, el.scrollWidth - el.clientWidth,
    ])
    assert.equal(overflowX, 'hidden')
    assert.equal(overflowY, 'auto')
    assert(delta <= 1, 'No scroll track below the pane')
    await form.getByRole('button', { name: 'Cancel new entry' }).click()
    await pane.getByRole('heading', { name: 'Review match' }).waitFor()
    await second.click()
    assert.equal(await pane.getAttribute('aria-busy'), 'true')
    assert(await pane.getByText('Backup jacket').filter({ visible: true }).first().isVisible(), 'Keep the first editor visible while the second loads')
    release()
    await page.waitForFunction(() => {
      const old = document.querySelector('[data-review-layer=old]')
      const current = document.querySelector('[data-review-layer=current]')
      return old?.inert && current?.textContent.includes('Fixture charge 2') &&
        [...current.getAnimations()].some(animation => animation.playState === 'running')
    })
    await pane.getByText('No matching entry').waitFor()
    await pane.getByRole('button', { name: 'Close review' }).click()
    await pane.getByText('Choose a transaction to review.').waitFor()
    await page.setViewportSize({ width: 382, height: 852 })
    await first.click()
    const opening = page.locator('.bb-reconcile-row[data-open=true] .bi-expansion')
    await opening.locator('h2').waitFor()
    await page.waitForFunction(() => document.querySelector('.bb-reconcile-row[data-open=true] .bi-expansion')?.getBoundingClientRect().height > 80)
    await second.click()
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.bb-reconcile-row')]
      const [closing, opening] = rows.slice(0, 2).map(row => row.querySelector('.bi-expansion'))
      return closing?.dataset.open === 'false' && closing.getBoundingClientRect().height > 0 &&
        opening?.dataset.open === 'true' && opening.getAnimations().length > 0
    })
    assert.equal(await page.locator('.bb-reconcile-right').count(), 0)
    await page.setViewportSize({ width: 320, height: 678 })
    const strip = page.locator('.bb-reconcile-filters')
    const heading = page.getByRole('heading', { name: 'Reconcile', exact: true })
    const stripBox = await strip.boundingBox(), headingBox = await heading.boundingBox()
    assert(stripBox.x >= headingBox.x + headingBox.width)
    assert(Math.abs(stripBox.y + stripBox.height / 2 - headingBox.y - headingBox.height / 2) < 2)
    assert(await strip.evaluate(el => el.scrollWidth > el.clientWidth), 'More statuses extend past the clipped edge')
    await page.mouse.move(stripBox.x + stripBox.width - 10, stripBox.y + stripBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(stripBox.x + 10, stripBox.y + stripBox.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector('.bb-reconcile-filters').scrollLeft > 15)
    const checked = strip.getByRole('button', { name: /Checked/ })
    await checked.click()
    assert.equal(await checked.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
  } finally {
    release()
    releaseFirst()
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
      await verifyWorkspace(browser)
      console.log('PASS Reconcile scrollbar, selection transition and inline expansion', engine.name())
    } finally { await browser.close() }
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
