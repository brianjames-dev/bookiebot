// Run after npm run build. Exercise the production shell with isolated, read-only fixtures.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process')
const {createRequire} = require('node:module')
const root = path.resolve(__dirname, '../..'), req = createRequire(path.join(root, 'web/expense-report/package.json'))
const {chromium, webkit} = process.env.BOOKIEBOT_PLAYWRIGHT_MODULE ? require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE) : req('playwright')
const report = JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON || 'python', ['-c', `
import json
from unit_tests.reports.test_income_projection import build, income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','5000'))))))
`], {cwd: root, env: {...process.env, PYTHONPATH: path.join(root, 'src')}}).toString())
Object.assign(report, {ownerName: 'Brian', year: 2026, month: 10, monthLabel: 'October 2026'})
for (const [i, mode] of ['current', 'projected'].entries()) {
  const view = report.modeViews[mode]
  Object.assign(view.metrics, {monthlyIncome: i ? 6500.25 : 5000.75, totalExpenses: 1200.50, amountSaved: i ? 700.25 : 500.75, savingsMinimum: 800.49, savingsIdeal: 1600.51, incomeAfterExpenses: i ? 4599.50 : 3299.50})
  view.categoryBudgets = {needs: 2500, wants: 1500, savings: 1000}
  view.categoryBalances = {raw: {needs: -200, wants: 1100, savings: 1000}, remaining: {needs: i ? 1250.25 : 1150, wants: i ? 900 : 500.25, savings: i ? 350.50 : 100}, deficits: {needs: 0, wants: 0, savings: 0}, transfers: [], totalOverspend: 0}
  report.metricExplanations[mode].left.components = ['needs', 'wants', 'savings'].map(key => ({label: `${key[0].toUpperCase()}${key.slice(1)} remaining`, amount: view.categoryBalances.remaining[key]}))
}
const css = fs.readFileSync(path.join(root, 'src/bookiebot/reports/assets/expense-report-app.css'), 'utf8')
const js = fs.readFileSync(path.join(root, 'src/bookiebot/reports/assets/expense-report-app.js'), 'utf8')
const html = dark => `<!doctype html><html data-theme="${dark ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName: 'Brian', reportUrl: '/app/expenses/data', logoutUrl: '/app/logout'})}</script><script>localStorage.setItem('bookiebot-expense-report-theme','${dark ? 'dark' : 'light'}')</script><script type="module">${js}</script></body></html>`
const money = value => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(value)
const wholeMoney = value => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0}).format(value)
async function checkHeader(page, width) {
  const layout = await page.evaluate(() => {
    const rect = node => {const r = node.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, width: r.width, height: r.height}}
    const month = document.querySelector('.bb-report-header .bb-month-trigger'), toggle = document.querySelector('.bb-projection-control')
    return {month: rect(month), text: rect(month.firstElementChild), toggle: rect(toggle), header: rect(document.querySelector('.bb-report-header')), font: getComputedStyle(month).fontSize, radius: getComputedStyle(toggle).borderRadius,
      labels: [...toggle.querySelectorAll('button')].map(node => ({box: rect(node), font: getComputedStyle(node).fontSize, fits: node.scrollWidth <= node.clientWidth})), overflow: document.documentElement.scrollWidth > innerWidth}
  })
  assert.ok(layout.text.right + 12 <= layout.toggle.left, `Month text and chevron fit before toggle: ${JSON.stringify(layout)}`)
  assert.ok(Math.abs(layout.toggle.right - layout.header.right) < 1)
  assert.ok(Math.abs(layout.month.top + layout.month.height / 2 - layout.toggle.top - layout.toggle.height / 2) < 1)
  assert.equal(layout.toggle.width, width <= 360 ? 136 : 154)
  assert.equal(layout.toggle.height, 46); assert.equal(layout.radius, '18px')
  if (width >= 390) assert.equal(layout.font, '34px')
  assert.ok(layout.labels.every(label => label.box.height >= 44 && label.font === '12px' && label.fits))
  assert.equal(layout.overflow, false)
}
;(async () => {
  let cases = 0
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({headless: true})
    try {
      for (const width of [320, 390, 736, 1280]) for (const dark of [false, true]) {
        const page = await browser.newPage({viewport: {width, height: 900}, hasTouch: true, isMobile: width < 768, reducedMotion: dark ? 'reduce' : 'no-preference'})
        const errors = [], unexpected = []; let firstReport = true, releaseReport
        page.on('pageerror', error => errors.push(error.message))
        await page.addInitScript(() => {delete window.PushManager})
        await page.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url()), name = url.pathname
          if (url.origin !== 'https://bookie.test' || request.method() !== 'GET') {unexpected.push(`${request.method()} ${url}`); await route.abort(); return}
          let value
          if (name === '/app/expenses') {await route.fulfill({contentType: 'text/html', body: html(dark)}); return}
          if (name === '/app/expenses/data') {
            if (firstReport) {firstReport = false; await new Promise(resolve => {releaseReport = resolve})}
            const month = url.searchParams.get('month') || '2026-10', [year, number] = month.split('-').map(Number)
            value = {...report, year, month: number, monthLabel: new Intl.DateTimeFormat('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'}).format(new Date(Date.UTC(year, number - 1, 1)))}
          } else if (name === '/app/expenses/months') value = {currentMonth: '2026-10', months: ['2025-10', '2026-09', '2026-10'].map(value => ({value, label: value === '2026-09' ? 'September 2026' : `October ${value.slice(0, 4)}`})), coverage: {status: 'complete', unavailableYears: []}}
          else if (name === '/app/reconciliation') value = {enabled: true, checkedAt: '2026-10-29T07:00:00Z', items: []}
          else if (name === '/app/reimbursements') value = {enabled: true, ownerKey: 'brian', currency: 'USD', allocations: [], events: [], resets: [], resetState: 'fixture'}
          else if (name === '/app/goals') value = {goals: []}
          else if (name === '/app/notifications') value = {enabled: false, publicKey: 'B' + 'A'.repeat(86), preferences: {weekly: true, upcoming: false, showAmounts: false, hour: 10}}
          else if (name === '/app/widgets/settings') value = {connections: [], scriptUrl: '/app/widgets/script', setupInstructionsUrl: '/app/widgets/help'}
          else if (name === '/app/version') value = {version: 'fixture-version'}
          else if (name.includes('avatar')) {await route.fulfill({contentType: 'image/png', body: fs.readFileSync(path.join(root, 'assets/avatars/avatar7.png'))}); return}
          else {unexpected.push(`${request.method()} ${url}`); await route.fulfill({status: 404, json: {error: 'Unknown fixture'}}); return}
          await route.fulfill({json: value})
        })
        await page.goto('https://bookie.test/app/expenses')
        await page.locator('.bb-report-loading-spinner').waitFor()
        await page.evaluate(() => {window.__header = document.querySelector('.bb-report-header'); window.__avatar = document.querySelector('.bb-app-avatar')})
        await checkHeader(page, width)
        while (!releaseReport) await page.waitForTimeout(10)
        releaseReport()
        await page.locator('.bb-metrics-grid').waitFor()
        await page.getByRole('button', {name: 'Report month', exact: true}).waitFor({state: 'visible'})
        assert.equal(await page.evaluate(() => window.__header === document.querySelector('.bb-report-header') && window.__avatar === document.querySelector('.bb-app-avatar')), true, 'Startup preserves real header and avatar')
        assert.match(await page.locator('.bb-wordmark').innerText(), /BookieBot.*Brian/s)
        const month = page.getByRole('button', {name: 'Report month', exact: true})
        assert.equal(await month.innerText(), 'October'); assert.equal(await month.getAttribute('aria-description'), 'October 2026')
        await checkHeader(page, width)
        for (const [i, mode] of ['Current', 'Projected'].entries()) {
          await page.getByRole('button', {name: mode, exact: true}).click()
          await page.waitForTimeout(300)
          const view = report.modeViews[mode.toLowerCase()]
          const totals = await page.locator('.bb-metrics-grid > .bb-metric-card > .bb-metric-value .bb-fitted-amount-text').allTextContents()
          assert.deepEqual(totals, [money(view.metrics.monthlyIncome), money(view.metrics.totalExpenses + view.metrics.amountSaved), wholeMoney(view.metrics.incomeAfterExpenses), money(view.metrics.amountSaved)])
          assert.deepEqual(await page.locator('.bb-left-category-amount').allTextContents(), (i ? ['$1,250', '$900', '$351'] : ['$1,150', '$500', '$100']))
          assert.deepEqual(await page.locator('.bb-savings-metric-card .bb-savings-progress-labels b').allTextContents(), ['$800', '$1,601'])
          const geometry = await page.evaluate(() => {
            const grid = document.querySelector('.bb-metrics-grid'), rows = document.querySelector('.bb-left-category-rows')
            const rect = node => node.getBoundingClientRect()
            return {radius: getComputedStyle(grid).borderRadius, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, gap: getComputedStyle(rows).rowGap,
              tracks: [...document.querySelectorAll('.bb-left-category-track')].map(node => rect(node).height),
              padding: [...grid.children].map(node => getComputedStyle(node).paddingTop),
              icons: [...grid.querySelectorAll('.bb-metric-explain')].map(node => {const range = document.createRange(); range.selectNodeContents(node.firstChild); const icon = rect(node.lastElementChild), value = rect(node.closest('.bb-metric-card').querySelector('.bb-metric-value')); return {right: Math.abs(icon.right - value.right), gap: icon.left - range.getBoundingClientRect().right}}),
              numberBottomGaps: [...grid.children].slice(0, 2).map(node => rect(node).bottom - rect(node.querySelector('.bb-metric-value')).bottom),
              lowerContentGaps: [...grid.children].slice(2).map(node => rect(node).bottom - rect(node.querySelector('.bb-left-category-row:last-child .bb-left-category-amount, .bb-savings-progress-labels span:last-child b')).bottom),
              fits: [...grid.querySelectorAll('.bb-fitted-amount-text, .bb-left-category-amount, .bb-savings-progress-labels b')].every(node => rect(node).right <= rect(node.closest('.bb-metric-card')).right - 10),
              overflow: document.documentElement.scrollWidth > innerWidth}
          })
          assert.equal(geometry.radius, '20px'); assert.equal(geometry.columns, width <= 640 ? 2 : 4)
          assert.equal(geometry.gap, '2px'); assert.deepEqual(geometry.tracks, [6, 6, 6]); assert.ok(geometry.padding.every(value => value === '16px'))
          assert.ok(geometry.icons.every(icon => icon.right < 1 && icon.gap >= 12), 'All info icons align with their frame content’s right edge')
          if (width <= 640) {
            assert.ok(geometry.numberBottomGaps.every(gap => gap >= 39 && gap <= 41), 'Income and Spent retain generous space below the numbers')
            assert.ok(geometry.lowerContentGaps.every(gap => Math.abs(gap - geometry.numberBottomGaps[0]) <= 12), 'Top frame bottom spacing is comparable to the lower frames')
          }
          assert.equal(geometry.fits, true); assert.equal(geometry.overflow, false)
          await page.getByRole('button', {name: /^Explain Left:/}).click()
          const dialog = page.getByRole('dialog', {name: 'Left explained', exact: true})
          await dialog.waitFor()
          for (const amount of Object.values(view.categoryBalances.remaining)) assert.ok((await dialog.innerText()).includes(money(amount)), 'Graphic and modal use identical canonical remaining values')
          await page.keyboard.press('Escape'); await page.waitForTimeout(300)
          const selected = await page.locator('.bb-projection-control').evaluate(node => {
            const indicator = node.querySelector('.bb-selection-indicator').getBoundingClientRect(), button = node.querySelector('[aria-pressed="true"]').getBoundingClientRect()
            return {center: Math.abs((indicator.left + indicator.right - button.left - button.right) / 2), height: indicator.height, transition: getComputedStyle(node.querySelector('.bb-selection-indicator')).transitionDuration}
          })
          assert.ok(selected.center < 1 && selected.height === 40)
          if (dark) assert.ok(parseFloat(selected.transition) <= .001)
          cases++
        }
        await month.click()
        const picker = page.getByRole('dialog', {name: 'Report month', exact: true})
        await picker.waitFor(); await page.getByRole('button', {name: 'Previous year', exact: true}).click()
        assert.equal(await picker.locator('.bb-month-year strong').innerText(), '2025')
        await page.getByRole('button', {name: 'Next year', exact: true}).click()
        await picker.getByRole('button', {name: 'September 2026', exact: true}).click()
        await page.waitForFunction(() => document.querySelector('.bb-report-header .bb-month-trigger > span')?.textContent === 'September')
        await page.waitForTimeout(300); await checkHeader(page, width)
        await month.click()
        await page.waitForFunction(() => document.activeElement?.hasAttribute('data-month'))
        await page.keyboard.press('Escape')
        const focus = await month.evaluate(node => ({active: node === document.activeElement, outline: getComputedStyle(node).outlineStyle, disabled: node.disabled, expanded: node.getAttribute('aria-expanded'), current: document.activeElement?.outerHTML.slice(0, 350)}))
        assert.ok(focus.active, `Month keyboard focus is restored: ${JSON.stringify(focus)}`)
        // Exercise keyboard use directly; touch WebKit's Tab traversal depends
        // on the host's Full Keyboard Access setting.
        await month.focus(); await page.keyboard.press('Enter')
        await page.waitForFunction(() => document.activeElement?.hasAttribute('data-month'))
        await page.keyboard.press('ArrowRight')
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-month')), '2026-10')
        await page.keyboard.press('Escape')
        assert.equal(await month.evaluate(node => node === document.activeElement), true)
        await page.getByRole('button', {name: 'Current', exact: true}).focus(); await page.keyboard.press('Enter')
        assert.equal(await page.getByRole('button', {name: 'Current', exact: true}).getAttribute('aria-pressed'), 'true')
        await page.getByRole('button', {name: 'Projected', exact: true}).click(); await page.reload()
        await page.locator('.bb-metrics-grid').waitFor()
        assert.equal(await page.getByRole('button', {name: 'Projected', exact: true}).getAttribute('aria-pressed'), 'true', 'Restyling preserves the existing per-owner mode preference')
        if (width === 390) {await page.waitForTimeout(300); await page.screenshot({path: `/tmp/bookiebot-overview-${engine.name()}-${dark ? 'dark' : 'light'}.png`})}
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, [], 'No external or financial write requests')
        await page.close()
      }
    } finally {await browser.close()}
  }
  console.log(`${cases} Chromium/WebKit Overview mode cases passed, with startup, picker, geometry, details, keyboard, motion and preference checks; no external traffic or financial writes`)
})().catch(error => {console.error(error); process.exitCode = 1})
