// Delay a fixture match to inspect the actual button and spinner geometry.
const assert = require('node:assert/strict')
const { fixture, engines } = require('./duo_layout_browser_test.cjs')
const { base: savingsFixture } = require('./savings_workspace_browser_test.cjs')

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
      if (path === '/app/reconciliation/1') await route.fulfill({ json: { item: { ...row, suggestions: [match],
        logging: { allowed: true, kind: 'expense', categories: ['shopping'], paymentMethods: ['Fixture card'], reason: '' },
      } } })
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
    const add = page.getByRole('button', { name: 'Add expense', exact: true })
    await confirm.waitFor()
    const [confirmBox, addBox] = await Promise.all([confirm.boundingBox(), add.boundingBox()])
    assert(Math.abs(confirmBox.y - addBox.y) < 1 && confirmBox.x > addBox.x, 'Add and Confirm use the same footer row')
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
  let release, releaseFirst, releaseThird, requestedThird
  const held = new Promise(resolve => { release = resolve })
  const heldFirst = new Promise(resolve => { releaseFirst = resolve })
  const heldThird = new Promise(resolve => { releaseThird = resolve })
  const thirdStarted = new Promise(resolve => { requestedThird = resolve })
  const items = Array.from({ length: 22 }, (_, i) => ({ ...row, id: i + 1, stateVersion: `fixture-state-${i + 1}`, merchant: `Fixture charge ${i + 1}` }))
  const { page, errors, unexpected } = await fixture(browser, 867, 669, true, false, false, 0, {
    async request(route) {
      const path = new URL(route.request().url()).pathname
      if (path === '/app/reconciliation') {
        assert.equal(route.request().method(), 'GET', 'Opening an editor must not change a bank transaction')
        await route.fulfill({ json: { enabled: true, checkedAt: '2026-10-20T20:00:00Z', items } })
        return true
      }
      if (!path.startsWith('/app/reconciliation/')) return false
      const id = Number(path.split('/').at(-1))
      if (id === 1) await heldFirst
      if (id === 2) await held
      if (id === 3) { requestedThird(); await heldThird }
      await route.fulfill({ json: { item: {
        ...items[id - 1],
        suggestions: id === 1 ? [match, { ...match, id: 'alternative', item: 'Backup jacket', amountCents: 17000, amountMismatch: true }] : [],
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
    assert.equal(await page.locator('.bb-pull-refresh-space').count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('bb-pull-refresh-enabled')), false)
    assert.match(await page.locator('.bb-brand-status .bb-app-status time').innerText(), /^Updated /)
    assert.deepEqual(await scrollStyle('.bb-reconcile-left'), transactionsStyle)
    const [scrollHeight, clientHeight] = await left.evaluate(el => [el.scrollHeight, el.clientHeight])
    assert(scrollHeight > clientHeight, `The list owns vertical scroll (${scrollHeight}px in a ${clientHeight}px viewport)`)
    const first = queue.filter({ has: page.getByText('Fixture charge 1', { exact: true }) })
    const second = queue.filter({ has: page.getByText('Fixture charge 2', { exact: true }) })
    const third = queue.filter({ has: page.getByText('Fixture charge 3', { exact: true }) })
    await first.click()
    const pane = page.getByRole('complementary', { name: 'Transaction review' })
    await pane.getByText('Finding sheet entries…').waitFor({ state: 'attached' })
    const close = pane.getByRole('button', { name: 'Close review' })
    const loadingAnchor = await close.boundingBox()
    const paneBox = await pane.boundingBox()
    assert(loadingAnchor && Math.abs(loadingAnchor.y - paneBox.y - 3) < 1)
    const loader = await pane.locator('.bb-report-loading-spinner').boundingBox()
    assert(loader && loader.y > paneBox.y + 60, 'The spinner is centered in the review area below the heading')
    assert(Math.abs(loader.x + loader.width / 2 - paneBox.x - paneBox.width / 2) <= 6)
    releaseFirst()
    await pane.getByText('Rain jacket').waitFor()
    assert.deepEqual(await close.boundingBox(), loadingAnchor, 'Close stays at the same position while the review loads')
    await page.waitForFunction(() => document.querySelector('.bb-reconcile-pane').getAnimations({ subtree:true }).length === 0)
    const ignore = pane.getByRole('button', { name: 'Ignore transaction' })
    assert.equal(await ignore.evaluate(el => getComputedStyle(el).borderTopWidth), '0px')
    const direct = pane.locator('.bb-reconcile-entry-actions')
    const comparison = await pane.locator('.bb-reconcile-comparison').boundingBox()
    const result = await pane.locator('.bb-reconcile-match-result').boundingBox()
    assert(result.y + result.height <= comparison.y, 'The exact match appears above the comparison')
    assert((await direct.boundingBox()).y > comparison.y + comparison.height)
    assert.equal(await pane.locator('summary[aria-label="Review options"]').count(), 0)
    await pane.locator('button[data-budget]').click()
    await pane.getByRole('heading', { name: 'Choose budget entry', exact: true }).waitFor()
    const marked = pane.locator('.bb-reconcile-choice[aria-pressed=true] svg.lucide-circle-check')
    assert.equal(await marked.count(), 1)
    await pane.getByRole('button', { name: /Backup jacket/ }).click()
    await pane.getByRole('heading', { name: 'Review match' }).waitFor()
    assert.equal(await pane.locator('.bb-reconcile-match-result svg.lucide-triangle-alert').count(), 1)
    assert.equal(await pane.locator('.bb-reconcile-comparison-status:has(.bb-reconcile-match-result) + .bb-reconcile-comparison').count(), 1)
    const add = direct.getByRole('button', { name: 'Add expense', exact: true })
    assert.equal(await add.locator('.bb-saving-label').evaluate(el => getComputedStyle(el).columnGap), '8px')
    await add.click()
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
    assert.equal(await pane.getAttribute('data-loading'), 'true')
    await pane.getByRole('status').filter({ hasText: 'Finding sheet entries…' }).waitFor()
    assert(await pane.getByText('Backup jacket').filter({ visible: true }).first().isVisible(), 'Keep the first editor visible while the second loads')
    await third.click()
    await thirdStarted
    assert.equal(await third.getAttribute('aria-expanded'), 'true')
    assert.equal(await pane.getAttribute('data-loading'), 'true')
    assert.equal(await pane.getByRole('status').filter({ hasText: 'Finding sheet entries…' }).count(), 1)
    await first.click()
    await pane.getByText('Backup jacket').waitFor()
    assert.equal(await pane.getAttribute('data-loading'), null)
    releaseThird()
    await second.click()
    await page.evaluate(() => {
      const animate = Element.prototype.animate
      window.fixtureReviewTransitions = []
      Element.prototype.animate = function (frames, timing) {
        if (this.hasAttribute('data-review-layer')) {
          window.fixtureReviewTransitions.push({
            layer: this.dataset.reviewLayer, inert: this.inert, text: this.textContent,
          })
        }
        return animate.call(this, frames, timing)
      }
    })
    release()
    await pane.getByText('No matching entry').waitFor()
    const transitions = await page.evaluate(() => window.fixtureReviewTransitions)
    assert(transitions.some(layer => layer.layer === 'old' && layer.inert && layer.text.includes('Fixture charge 1')))
    assert(transitions.some(layer => layer.layer === 'current' && layer.text.includes('Fixture charge 2')))
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

async function verifyShortQueueRefresh(browser) {
  let writes = 0, reads = 0
  const { page, errors, unexpected } = await fixture(browser, 382, 852, true, false, false, 0, {
    async request(route) {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path === '/app/savings') {
        assert.equal(request.method(), 'GET')
        await route.fulfill({ json: savingsFixture() })
        return true
      }
      if (path !== '/app/reconciliation') return false
      if (request.method() === 'POST') {
        writes++
        assert.equal(request.postDataJSON().operation, 'check')
        await route.fulfill({ status: 503, json: { error: 'Temporary bank response' } })
      } else {
        reads++
        await route.fulfill({ json: { enabled: true, checkedAt: '2026-10-20T20:00:00Z', items: [row] } })
      }
      return true
    },
  })
  const touch = (type, y) => page.evaluate(([type, y]) => {
    const target = document.querySelector('.bb-reconcile-row-toggle')
    const point = { identifier: 91, target, clientX: 125, clientY: y }
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [point] }, changedTouches: { value: [point] } })
    target.dispatchEvent(event)
  }, [type, y])
  const brand = page.locator('.bb-report-brand')
  const phase = expected => page.waitForFunction(expected => document.querySelector('.bb-pull-refresh-space')?.dataset.phase === expected, expected)
  try {
    await page.getByRole('button', { name: 'Reconcile', exact: true }).click()
    await page.locator('.bb-reconcile-row-toggle').waitFor()
    const heading = () => page.locator('.bb-report-header').boundingBox()
    const reconcileTitle = await heading()
    const reviewGroup = await page.locator('.bb-reconcile-group').boundingBox()
    assert(reviewGroup.y - reconcileTitle.y - reconcileTitle.height < 10, 'Reconcile content starts directly below the shared title header')
    await page.waitForFunction(() => document.querySelector('.bb-pull-refresh-button')?.disabled === false)
    const initial = await brand.boundingBox()
    await touch('touchstart', 130)
    await touch('touchmove', 300)
    await phase('pulling')
    assert((await brand.boundingBox()).y - initial.y > 30)
    await touch('touchmove', 430)
    await phase('armed')
    const disc = await page.locator('.bb-pull-disc').boundingBox()
    assert(disc.y + disc.height <= (await brand.boundingBox()).y, 'Pull arrow never overlaps the wordmark in a short queue')
    await touch('touchend', 430)
    await phase('error')
    assert.match(await brand.locator('.bb-app-status').innerText(), /^Check saved status/)
    assert.equal(await page.locator('.bb-shell-reconcile').getByRole('button', { name: /try again|check status/i }).count(), 0)

    const before = reads
    await touch('touchstart', 170)
    await touch('touchmove', 470)
    await phase('armed')
    await touch('touchend', 470)
    await phase('done')
    assert.equal(reads, before + 1)
    assert.equal(writes, 1, 'The recovery pull only reads saved status')
    await phase('idle')
    assert.equal((await brand.boundingBox()).y, initial.y)
    assert.match(await brand.locator('.bb-app-status time').innerText(), /^Updated /)

    await page.setViewportSize({ width: 867, height: 669 })
    const refresh = page.getByRole('button', { name: 'Check bank transactions', exact: true })
    await refresh.waitFor()
    await touch('touchstart', 130)
    await touch('touchmove', 430)
    await touch('touchend', 430)
    assert.equal(await page.locator('.bb-pull-refresh-space').count(), 0)
    await refresh.click()
    await page.getByRole('button', { name: 'Check status', exact: true }).waitFor()
    assert.equal(writes, 2, 'Only the open layout arrow starts the next check')
    for (const [tab, label] of [
      ['Overview', 'Refresh Overview'],
      ['Transactions', 'Refresh Transactions'],
      ['Shared', 'Refresh reimbursements'],
      ['Savings', 'Refresh savings'],
    ]) {
      await page.getByRole('button', { name: tab, exact: true }).click()
      await page.getByRole('button', { name: label, exact: true }).waitFor()
      assert.equal(await page.locator('.bb-pull-refresh-space').count(), 0, `${tab} only uses a refresh button in open DUO`)
    }
    await page.setViewportSize({ width: 382, height: 852 })
    const compact = page.locator('.bb-pull-refresh-space')
    await compact.waitFor({ state: 'attached' })
    assert.equal(await page.locator('.bb-settings-masthead-title > .bb-page-refresh-button').count(), 0)
    await page.getByRole('button', { name: 'Savings', exact: true }).click()
    const summary = page.locator('.sa-summary .sg-eyebrow')
    await summary.waitFor()
    const savingsTitle = await heading(), savingsBody = await summary.boundingBox()
    assert(savingsBody.y - savingsTitle.y - savingsTitle.height < 10, 'Savings summary starts directly below the shared title header')
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
  } finally { await page.close() }
}

async function verifyMatchPriority(browser, width, height) {
  const split = { ...match, item: 'Fixture utility', amountCents: 13000, amountMismatch: true,
    confirmable: false, confidence: .6, split: 'equal' }
  const { page, errors, unexpected } = await fixture(browser, width, height, true, false, false, 0, {
    async request(route) {
      const path = new URL(route.request().url()).pathname
      if (path === '/app/reconciliation') await route.fulfill({ json: snapshot(row) })
      else if (path === '/app/reconciliation/1') await route.fulfill({ json: { item: { ...row, suggestions: [split],
        logging: { allowed: true, kind: 'expense', categories: ['shopping'], paymentMethods: ['Fixture card'], reason: '' },
      } } })
      else return false
      assert.equal(route.request().method(), 'GET')
      return true
    },
  })
  try {
    await page.getByRole('button', { name: 'Reconcile', exact: true }).click()
    await page.getByRole('button', { name: /^Fixture store/ }).click()
    await page.getByText('Potential matches (1)', { exact: true }).waitFor()
    assert.equal(await page.getByText('Choose an entry', { exact: true }).count(), 0)
    const choose = page.getByRole('button', { name: 'Choose budget entry', exact: true })
    const add = page.getByRole('button', { name: 'Add expense', exact: true })
    assert.notEqual(await choose.getAttribute('data-budget'), null)
    assert.equal(await choose.locator('svg.lucide-chevron-right').count(), 1)
    assert.match(await add.getAttribute('class'), /bb-reconcile-outline/)
    await choose.click()
    await page.getByRole('button', { name: /Fixture utility.*50\/50 split/ }).click()
    await page.getByRole('button', { name: 'Review amount change', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Ignore transaction', exact: true }).click()
    const ignore = page.getByRole('button', { name: 'Ignore transaction', exact: true })
    const back = page.getByRole('button', { name: 'Back', exact: true })
    await back.waitFor()
    const ignoreScene = page.locator('[data-editor-scene=ignore]')
    assert.equal(await ignoreScene.locator('.bb-reconcile-comparison').count(), 0)
    assert.equal(await ignoreScene.locator('.bb-reconcile-choice-source .bb-transaction-icon').count(), 1)
    assert.match(await ignoreScene.locator('.bb-reconcile-choice-source').innerText(), /Fixture store.*\$166\.31/s)
    for (const control of [ignore, back]) {
      assert.equal(await control.evaluate(el => getComputedStyle(el).borderTopWidth), '1px')
      assert((await control.boundingBox()).height >= 44)
    }
    await back.click()
    await page.getByText('Amounts match', { exact: true }).waitFor({ state: 'hidden' })
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
  } finally { await page.close() }
}

async function verifyDesktopAndReceiptRefresh(browser) {
  let checks = 0, receiptReads = 0, readingReceipt = false
  const desktop = { newPage: options => browser.newPage({ ...options, hasTouch: false, isMobile: false }) }
  const checked = { ...row, status: 'checked', matchLabel: 'Matches logged entry', matchedEntry: match, receipt: {
    allocationId: 'fixture-shared-bill', partner: 'Hannah', bankAmountCents: row.amountCents, outstandingCents: 8000,
  } }
  const other = { ...checked, id: 2, merchant: 'Another checked charge', receipt: undefined }
  const allocation = { id: 'fixture-shared-bill', payerOwner: 'brian', partnerOwner: 'hannah', payerPerson: 'Brian',
    item: 'Fixture store', location: '', category: 'shopping', expenseDate: '2026-10-20', grossCents: row.amountCents, payerShareCents: 8631,
    partnerShareCents: 8000, settledCents: 0, outstandingCents: 8000, accounting: 'cash_v1', method: 'equal',
    version: 1, projectedVersion: 1, status: 'outstanding' }
  const { page, errors, unexpected } = await fixture(desktop, 720, 850, true, false, false, 0, {
    async request(route) {
      const request = route.request(), path = new URL(request.url()).pathname
      if (path === '/app/reconciliation') {
        if (request.method() === 'POST') {
          assert.equal(request.postDataJSON().operation, 'check')
          checks++
        }
        await route.fulfill({ json: { ...snapshot(checked), items: [checked, other] } })
      } else if (path === '/app/reconciliation/1') await route.fulfill({ json: { item: checked } })
      else if (path === '/app/reconciliation/2') await route.fulfill({ json: { item: other } })
      else if (path === '/app/reimbursements') {
        assert.equal(request.method(), 'GET')
        if (readingReceipt && ++receiptReads === 1) await route.fulfill({ status: 503, json: { error: 'Receipt temporarily unavailable' } })
        else await route.fulfill({ json: { enabled: true, ownerKey: 'brian', currency: 'USD', allocations: [allocation], events: [], resets: [], resetState: 'fixture' } })
      } else return false
      return true
    },
  })
  try {
    await page.getByRole('button', { name: 'Reconcile', exact: true }).click()
    const desktopRefresh = page.getByRole('button', { name: 'Refresh Reconcile', exact: true })
    await desktopRefresh.click()
    assert.equal(checks, 1, 'Mouse users retain a clickable bank check')
    await page.setViewportSize({ width: 867, height: 669 })
    const toolbar = page.locator('.bb-reconcile-title-actions')
    await toolbar.getByRole('button', { name: /Checked/ }).click()
    const checkedRow = page.getByRole('button', { name: /^Fixture store/ })
    await checkedRow.click()
    const openReceipt = page.getByRole('button', { name: 'View Hannah’s share' })
    await openReceipt.waitFor()
    const comparisonStatus = page.locator('.bb-reconcile-comparison-status:visible')
    await comparisonStatus.getByText('Matches logged entry').waitFor()
    await comparisonStatus.locator('.rp-status').getByText('Awaiting repayment').waitFor()
    const matchStatus = await comparisonStatus.getByText('Matches logged entry').boundingBox()
    const awaiting = await comparisonStatus.locator('.rp-status').boundingBox()
    assert(awaiting.y >= matchStatus.y + matchStatus.height && Math.abs(awaiting.x - matchStatus.x) < 1)
    assert.equal(await page.locator('.bb-reconcile-comparison-status:visible + .bb-reconcile-comparison').count(), 1)
    const matchedBudget = page.locator('.bb-reconcile-comparison:visible [data-budget]')
    assert.match(await matchedBudget.innerText(), /Rain jacket/)
    assert.equal(await matchedBudget.getByText('$166.31', { exact: true }).count(), 1)
    assert.match(await openReceipt.getAttribute('class'), /bi-primary/)
    assert.equal(await page.getByRole('button', { name: 'Mark as received' }).count(), 0)
    readingReceipt = true
    await openReceipt.click()
    const receipt = page.getByRole('region', { name: 'Receive shared payment' })
    await receipt.getByText('Receipt temporarily unavailable').waitFor()
    assert.equal(await page.locator('.bb-reconcile-right [data-editor-scene=receipt] .bb-reconcile-receipt').count(), 1)
    assert.equal(await page.locator('.bb-reconcile-left .bb-reconcile-receipt').count(), 0)
    assert.equal(await receipt.getByText(/Pull down/).count(), 0)
    const refresh = toolbar.getByRole('button', { name: 'Refresh payment', exact: true })
    await refresh.click()
    await receipt.getByRole('heading', { name: 'Hannah’s share · Fixture store' }).waitFor()
    const receiptActions = receipt.locator('footer')
    async function checkReceiptButtons(actions) {
      const back = actions.getByRole('button', { name: 'Back', exact: true })
      const mark = actions.getByRole('button', { name: 'Mark as received', exact: true })
      await mark.waitFor()
      const [left, right] = await Promise.all([back.boundingBox(), mark.boundingBox()])
      assert(left.x < right.x && Math.abs(left.y - right.y) < 1, 'Back and Mark as received share one row')
      const [arrow, check] = await Promise.all([back.locator('svg').boundingBox(), mark.locator('.lucide-check').boundingBox()])
      assert.equal(check.width, arrow.width, 'The receipt checkmark matches the Back arrow size')
      assert.equal(check.height, arrow.height)
    }
    await checkReceiptButtons(receiptActions)
    assert.equal(await receipt.getByRole('button', { name: 'Confirm received record' }).count(), 0)
    assert.equal(await receipt.getByText(/The bank match is saved separately/).count(), 0)
    assert.equal(await receipt.getByRole('img', { name: /Brian.*Hannah/ }).count(), 1)
    assert.equal(await receipt.getByText('Cash received').count(), 1)
    assert.equal(receiptReads, 2)
    await page.getByRole('button', { name: /^Another checked charge/ }).click()
    await page.locator('.bb-reconcile-comparison').getByText('Another checked charge').waitFor()
    await checkedRow.click()
    await openReceipt.click()
    await page.getByRole('button', { name: 'Close review' }).click()
    await page.getByText('Choose a transaction to review.').waitFor()
    await checkedRow.click()
    await openReceipt.click()
    await page.setViewportSize({ width: 382, height: 852 })
    const inline = page.locator('.bb-reconcile-row[data-open=true] [data-editor-scene=receipt] .bb-reconcile-receipt')
    await inline.waitFor()
    await inline.getByRole('heading', { name: 'Hannah’s share · Fixture store' }).waitFor()
    await checkReceiptButtons(inline.locator('footer'))
    const back = inline.getByRole('button', { name: 'Back' })
    assert.match(await back.getAttribute('class'), /bi-cancel/)
    assert.equal(await back.evaluate(el => getComputedStyle(el).borderTopWidth), '0px')
    const markReceived = inline.locator('footer').getByRole('button', { name: 'Mark as received' })
    await markReceived.click()
    await inline.getByRole('button', { name: 'Confirm received record' }).waitFor()
    await inline.getByRole('button', { name: 'Cancel', exact: true }).click()
    await markReceived.waitFor()
    await back.click()
    await page.getByRole('heading', { name: 'Checked transaction', exact: true }).waitFor()
    assert.equal(await page.locator('.bb-reconcile-row[data-open=true]').count(), 1)
    await openReceipt.click()
    await inline.waitFor()
    await checkedRow.click()
    assert.equal(await checkedRow.getAttribute('aria-expanded'), 'false')
    assert.equal(checks, 1, 'Receipt refresh only reads the receipt')
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
  } finally { await page.close() }
}

async function verifyReceiptFeedback(browser, width, height) {
  const id = 'shared-reconcile-purchase'
  const checked = { ...row, status: 'checked', matchLabel: 'Matches logged entry',
    receipt: { allocationId: id, partner: 'Hannah', bankAmountCents: row.amountCents, outstandingCents: 8000 } }
  const allocation = { id, payerOwner: 'brian', partnerOwner: 'hannah', payerPerson: 'Brian',
    item: 'Shared fixture purchase', location: '', category: 'shopping', expenseDate: '2026-10-20',
    grossCents: 16631, payerShareCents: 8631, partnerShareCents: 8000, settledCents: 0, outstandingCents: 8000,
    accounting: 'cash_v1', method: 'equal', version: 1, projectedVersion: 1, status: 'outstanding' }
  const initial = { enabled: true, ownerKey: 'brian', currency: 'USD', allocations: [allocation], events: [], resetState: 'before-receipt' }
  const event = { id: 'recorded-cash', operationId: 'reconcile-receipt', allocationId: id, kind: 'receive', actorOwner: 'brian',
    payeeOwner: 'brian', debtorOwner: 'hannah', amountCents: 5000, date: allocation.expenseDate, status: 'confirmed' }
  const saved = { ...initial, allocations: [{ ...allocation, version: 2, settledCents: 5000, outstandingCents: 3000 }],
    events: [event], operationId: event.operationId, resetState: 'receipt-pending', undoState: 'receipt-guard', projectionPending: true }
  const undoJob = { id: 'fixture-undo', actorOwner: 'brian', operation: 'reverse_operation',
    status: 'completed', error: '', createdAt: '', updatedAt: '' }
  const restored = { ...initial, allocations: [{ ...allocation, version: 3, projectedVersion: 3 }],
    events: [{ ...event, status: 'reversed' }], resetState: 'receipt-undone', undoJob, undoJobs: [undoJob] }
  let state = initial, releaseProjection, releaseUndo, undoStarted
  const projection = new Promise(resolve => { releaseProjection = resolve })
  const undoResponse = new Promise(resolve => { releaseUndo = resolve })
  const undoRequested = new Promise(resolve => { undoStarted = resolve })
  const writes = []
  const staleRow = { id, actionId: id, version: 'v1', month: '2026-10', date: allocation.expenseDate, title: allocation.item,
    location: '', person: 'Brian', kind: 'expense', category: 'shopping', categoryLabel: 'Shopping',
    amountCents: 16631, canonicalAllocationId: id, canonicalAllocationVersion: 1,
    split: 'equal', fields: {}, editableFields: [], capabilities: {}, reasons: {} }
  const { page, errors, unexpected } = await fixture(browser, width, height, true, false, false, 0, {
    async request(route) {
      const request = route.request(), url = new URL(request.url())
      if (url.pathname === '/app/reconciliation') await route.fulfill({ json: snapshot(checked) })
      else if (url.pathname === '/app/reconciliation/1') await route.fulfill({ json: { item: checked } })
      else if (url.pathname === '/app/transactions') await route.fulfill({ json: {
        items: [staleRow], total: 1, nextOffset: null, categories: ['shopping'], persons: ['Brian'], month: '2026-10',
      } })
      else if (url.pathname === '/app/reimbursements') {
        if (request.method() === 'POST') {
          const body = request.postDataJSON()
          writes.push(body.operation)
          assert(body.requestId)
          if (body.operation === 'receive') {
            assert.equal(url.searchParams.get('deferredReceipt'), '1')
            assert.equal(body.amountCents, 5000)
            state = saved
          } else {
            assert.equal(body.operation, 'queue_undo')
            assert.equal(body.operationId, event.operationId)
            assert.equal(body.expectedUndoState, saved.undoState)
            undoStarted()
            await undoResponse
            state = restored
          }
        } else if (state === saved && !url.search) {
          // No Sheets recovery response can contribute to the immediate UI.
          await projection
        }
        await route.fulfill({ json: state })
      } else return false
      return true
    },
  })
  const nav = name => page.getByRole('button', { name, exact: true })
  const toast = page.locator('.sr-native-toast .bi-undo-popup')
  const purchases = page.locator('.bb-shell-transactions .bb-daily-transactions')
  const reimbursement = page.locator('.sr-row-main').filter({ hasText: allocation.item })
  try {
    await nav('Transactions').click()
    await purchases.getByText('$166.31', { exact: true }).waitFor()
    await nav('Shared').click()
    await reimbursement.getByText('$80.00', { exact: true }).waitFor()
    await nav('Reconcile').click()
    await page.getByRole('button', { name: /Checked/ }).click()
    await page.getByRole('button', { name: /^Fixture store/ }).click()
    await page.getByRole('button', { name: 'View Hannah’s share' }).click()
    await page.getByRole('button', { name: 'Mark as received' }).click()
    await page.getByLabel('Amount ($)').fill('50.00')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await nav('Confirm received record').click()
    await toast.getByText('$50.00 received', { exact: true }).waitFor()
    assert(await toast.evaluate(el => {
      const shell = el.closest('.bb-app-shell'), box = el.getBoundingClientRect()
      const gutter = parseFloat(getComputedStyle(shell).getPropertyValue('--bb-duo-overlay')) || 0
      return Math.abs(box.left + box.width / 2 - (window.innerWidth - gutter) / 2) < 1
    }), 'The shared Undo toast is centered in the app viewport')
    assert.equal(await toast.locator('.bi-undo-time').count(), 1)
    const deadline = await toast.getAttribute('data-expires-at')

    await nav('Transactions').click()
    await purchases.getByText('$116.31', { exact: true }).waitFor()
    await nav('Shared').click()
    await reimbursement.getByText('$30.00', { exact: true }).waitFor()
    assert.equal(await toast.getAttribute('data-expires-at'), deadline)
    await toast.getByRole('button', { name: 'Undo', exact: true }).click()
    await undoRequested
    await reimbursement.getByText('$80.00', { exact: true }).waitFor()
    await nav('Transactions').click()
    await purchases.getByText('$166.31', { exact: true }).waitFor()
    releaseUndo()
    releaseProjection()
    await toast.getByText('Undone', { exact: true }).waitFor()
    assert.deepEqual(writes, ['receive', 'queue_undo'])
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
  } finally {
    releaseUndo()
    releaseProjection()
    await page.close()
  }
}

;(async () => {
  for (const engine of engines) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const [width, height, dark] of [[382, 852, false], [867, 669, true]]) {
        await verify(browser, width, height, dark)
        await verifyMatchPriority(browser, width, height)
        console.log('PASS in-button Reconcile spinner', engine.name(), width, height)
        await verifyReceiptFeedback(browser, width, height)
        console.log('PASS Reconcile receipt and Undo across tabs', engine.name(), width, height)
      }
      await verifyWorkspace(browser)
      console.log('PASS Reconcile scrollbar, selection transition and inline expansion', engine.name())
      await verifyShortQueueRefresh(browser)
      console.log('PASS Reconcile short-queue pull, header status and open refresh', engine.name())
      await verifyDesktopAndReceiptRefresh(browser)
      console.log('PASS desktop bank check and open receipt refresh', engine.name())
    } finally { await browser.close() }
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
