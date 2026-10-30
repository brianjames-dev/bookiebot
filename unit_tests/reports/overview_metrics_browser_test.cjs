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
  Object.assign(view.metrics, {monthlyIncome: i ? 6500.25 : 5000.75, totalExpenses: i ? 1450.75 : 1200.50, amountSaved: i ? 700.25 : 500.75, savingsMinimum: 800.49, savingsIdeal: 1600.51, incomeAfterExpenses: i ? 4599.50 : 3299.50})
  view.categoryBudgets = {needs: 2500, wants: 1500, savings: 1000}
  view.categoryBalances = {raw: {needs: -200, wants: 1100, savings: 1000}, remaining: {needs: i ? 1250.25 : 1150, wants: i ? 900 : 500.25, savings: i ? 350.50 : 100}, deficits: {needs: 0, wants: 0, savings: 0}, transfers: [], totalOverspend: 0}
  report.metricExplanations[mode].left.components = ['needs', 'wants', 'savings'].map(key => ({label: `${key[0].toUpperCase()}${key.slice(1)} remaining`, amount: view.categoryBalances.remaining[key]}))
}
const css = fs.readFileSync(path.join(root, 'src/bookiebot/reports/assets/expense-report-app.css'), 'utf8')
const js = fs.readFileSync(path.join(root, 'src/bookiebot/reports/assets/expense-report-app.js'), 'utf8')
const html = dark => `<!doctype html><html data-theme="${dark ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName: 'Brian', reportUrl: '/app/expenses/data', logoutUrl: '/app/logout'})}</script><script>localStorage.setItem('bookiebot-expense-report-theme','${dark ? 'dark' : 'light'}')</script><script type="module">${js}</script></body></html>`
const money = value => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(value)
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
async function checkComparisonCapsule(page) {
  const layout = await page.locator('.bb-comparison-toggle').evaluate(button => {
    const box = button.parentElement.getBoundingClientRect(), metrics = document.querySelector('.bb-metrics-grid').getBoundingClientRect(), charts = document.querySelector('.bb-chart-carousel-nav').getBoundingClientRect(), style = getComputedStyle(button.parentElement)
    const copy = button.querySelector('.bb-comparison-copy').getBoundingClientRect(), icon = button.querySelector('.bb-comparison-icon').getBoundingClientRect(), chevron = button.querySelector('.bb-comparison-chevron').getBoundingClientRect()
    return {width: box.width, height: box.height, center: (box.left + box.right - metrics.left - metrics.right) / 2, metricWidth: metrics.width,
      topGap: box.top - metrics.bottom, bottomGap: charts.top - box.bottom, padding: getComputedStyle(button.querySelector(".bb-comparison-toggle-group")).left, radius: style.borderRadius, shadow: style.boxShadow,
      captionGap: getComputedStyle(button.querySelector('.bb-comparison-copy')).rowGap, iconGap: copy.left - icon.right, chevronGap: chevron.left - copy.right,
      textFits: [...button.querySelectorAll('.bb-comparison-title, .bb-comparison-caption')].every(node => node.scrollWidth <= node.clientWidth), border: getComputedStyle(button.closest(".bb-report-comparison")).borderBottomWidth}
  })
  assert.ok(layout.width < layout.metricWidth - 40, `Comparison hugs its content: ${JSON.stringify(layout)}`)
  assert.ok(Math.abs(layout.center) < 1)
  assert.equal(layout.height, 48); assert.equal(layout.radius, '16px'); assert.equal(layout.padding, '16px'); assert.equal(layout.captionGap, '2px')
  assert.equal(layout.topGap, 14); assert.equal(layout.bottomGap, 14); assert.equal(layout.shadow, 'none'); assert.equal(layout.border, '0px')
  assert.equal(layout.iconGap, 12); assert.ok(Math.abs(layout.chevronGap - 12) <= 1); assert.equal(layout.textFits, true)
  assert.equal(await page.locator('.bb-comparison-caption').innerText(), 'A month-to-month view')
}
async function checkQuietHeader(page, width, reduced) {
  const panels = ['Category Mix', 'Burn Rate', 'Calendar', 'Bills & Utilities']
  const nav = page.locator('.bb-chart-carousel-nav'), stage = page.locator('.bb-chart-carousel-band')
  const height = (await stage.boundingBox()).height
  for (const [index, name] of panels.entries()) {
    await page.getByRole('button', {name: `Show ${name}`, exact: true}).click()
    await page.waitForTimeout(300)
    assert.equal(await nav.getByRole('heading').innerText(), name)
    const layout = await nav.evaluate(el => {
      const title = el.querySelector('.bb-chart-carousel-title'), value = title.querySelector('.bb-fitted-amount-text'), dots = el.querySelector('.bb-chart-carousel-indicators')
      const box = node => {const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
      return {title:box(title),value:box(value),dots:box(dots),font:parseFloat(getComputedStyle(value).fontSize),padding:[getComputedStyle(el).paddingTop,getComputedStyle(el).paddingBottom],
        buttons:[...dots.children].map(button => ({box:box(button),marker:box(button.firstElementChild),text:button.textContent,pressed:button.getAttribute('aria-pressed'),duration:parseFloat(getComputedStyle(button.firstElementChild).transitionDuration)})),
        touchAction:getComputedStyle(document.querySelector('.bb-chart-carousel')).touchAction}
    })
    assert.deepEqual(layout.padding,['12px','0px'])
    assert.equal(layout.buttons.length,4)
    assert.ok(layout.buttons.every((button,i) => button.box.width===44&&button.box.height===44&&button.marker.height===6&&button.marker.width===(i===index?24:6)&&button.text===''))
    assert.ok(layout.value.right<=layout.title.right+1&&layout.font<=28,'Long headings fit without overlapping the position markers')
    if (width<=362) assert.ok(layout.title.bottom<=layout.dots.top+1,'Narrow phones retain full title text above right-aligned markers')
    else assert.ok(layout.title.right+8<=layout.dots.left+1)
    if (name==='Category Mix') assert.equal(layout.font,28,'Approved title size is retained where it fits')
    if (reduced) assert.ok(layout.buttons.every(button=>button.duration<=.001))
    assert.equal(layout.touchAction,'pan-y','Chart gestures leave vertical panning native')
    assert.equal((await stage.boundingBox()).height,height,'Every graph uses the unchanged shared stage height')
    assert.equal(await page.locator('.bb-chart-carousel-slide:not([inert])').count(),1,'Only the visible chart exposes its controls')
  }
  assert.equal(await page.getByRole('button',{name:'Previous chart',exact:true}).count(),0)
  assert.equal(await page.getByRole('button',{name:'Next chart',exact:true}).count(),0)
  const category = page.getByRole('button',{name:'Show Category Mix',exact:true})
  await category.focus();await page.keyboard.press('Enter');await page.keyboard.press('ArrowRight')
  assert.equal(await nav.getByRole('heading').innerText(),'Burn Rate','Keyboard arrows change the graph')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await nav.getByRole('heading').innerText(),'Category Mix')
  // Use complete native event shapes; observers must leave vertical panning uncanceled.
  const touch = async (type,x,y,selector='.bb-chart-carousel') => page.locator(selector).evaluate((target,{type,x,y})=>{
    const event=new Event(type,{bubbles:true,cancelable:true}),point={clientX:x,clientY:y}
    Object.defineProperties(event,{touches:{value:type==='touchend'?[]:[point]},changedTouches:{value:[point]},targetTouches:{value:type==='touchend'?[]:[point]}})
    target.dispatchEvent(event)
    return event.defaultPrevented
  },{type,x,y})
  for (const [type,x,y] of [['touchstart',240,120],['touchmove',235,280],['touchend',235,280]]) assert.equal(await touch(type,x,y),false)
  assert.equal(await nav.getByRole('heading').innerText(),'Category Mix','Vertical movement does not select another chart')
  for (const [type,x,y] of [['touchstart',240,120],['touchmove',35,124],['touchend',35,124]]) assert.equal(await touch(type,x,y),false)
  assert.equal(await nav.getByRole('heading').innerText(),'Burn Rate','Horizontal swipe selects the next graph')
  for (const [type,x,y] of [['touchstart',35,124],['touchmove',240,120],['touchend',240,120]]) assert.equal(await touch(type,x,y),false)
  assert.equal(await nav.getByRole('heading').innerText(),'Category Mix')
  for (const [type,x,y] of [['touchstart',240,120],['touchmove',35,124],['touchend',35,124]]) await touch(type,x,y,'.bb-category-mix-filter select')
  assert.equal(await nav.getByRole('heading').innerText(),'Category Mix','Using the native filter cannot swipe the graph')
}
;(async () => {
  let cases = 0
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({headless: true})
    try {
      for (const width of [320, 390, 736, 1280]) for (const dark of [false, true]) {
        const page = await browser.newPage({viewport: {width, height: 900}, hasTouch: true, isMobile: width < 768, reducedMotion: dark ? 'reduce' : 'no-preference'})
        const errors = [], unexpected = [], comparisonReads = []; let firstReport = true, releaseReport, releaseComparison
        page.on('pageerror', error => errors.push(error.message))
        await page.addInitScript(() => {delete window.PushManager})
        await page.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url()), name = url.pathname
          if (url.origin !== 'https://bookie.test' || request.method() !== 'GET') {unexpected.push(`${request.method()} ${url}`); await route.abort(); return}
          if (/^\/app\/assets\/category-mix-layout-[A-Za-z0-9_-]+\.js$/.test(name)) {await route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,'src/bookiebot/reports/assets',path.basename(name)),'utf8')}); return}
          let value
          if (name === '/app/expenses') {await route.fulfill({contentType: 'text/html', body: html(dark)}); return}
          if (name === '/app/expenses/data') {
            if (firstReport) {firstReport = false; await new Promise(resolve => {releaseReport = resolve})}
            const month = url.searchParams.get('month') || '2026-10', [year, number] = month.split('-').map(Number)
            value = {...report, year, month: number, monthLabel: new Intl.DateTimeFormat('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'}).format(new Date(Date.UTC(year, number - 1, 1)))}
          } else if (name === '/app/expenses/comparison') {
            comparisonReads.push(request.url())
            if (comparisonReads.length === 1) await new Promise(resolve => {releaseComparison = resolve})
            const mode = url.searchParams.get('mode'), amount = report.modeViews[mode].metrics.totalExpenses
            const period = spending => ({spending, complete:false})
            value = {selectedMonth: url.searchParams.get('month'), baselineMonth: url.searchParams.get('compare_month'), baselineKind: 'selected-month', mode,
              throughDay:29, shortMonthAdjusted:false, selected: period(amount), baseline: period(amount + 25), changeAmount: -25, changePercent: Math.round(-25 / (amount + 25) * 1000) / 10, status: 'partial', coverageNote: 'Canonical Spent over matching days, including undated costs from isolated fixtures.'}
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
        const headerSpacing = await page.evaluate(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect()
          const time = rect('.bb-brand-status time'), title = rect('.bb-brand-copy .bb-wordmark'), toggle = rect('.bb-projection-control'), panel = rect('.bb-metrics-grid')
          return {timeGap: time.top - title.bottom, left: Math.abs(time.left - title.left), panelGap: panel.top - toggle.bottom, duplicate: document.querySelectorAll('.bb-report-header .bb-app-status').length}
        })
        assert.ok(headerSpacing.timeGap >= 0 && headerSpacing.timeGap <= 3 && headerSpacing.left < 1, 'Updated time sits directly beneath the brand text')
        assert.ok(headerSpacing.panelGap >= 10 && headerSpacing.panelGap <= 14, 'The metrics panel sits close to the month/view row')
        assert.equal(headerSpacing.duplicate, 0)
        await checkComparisonCapsule(page)
        await checkQuietHeader(page, width, dark)
        assert.equal(comparisonReads.length, 0, 'Collapsed capsule does not fetch comparisons')
        for (const [i, mode] of ['Current', 'Projected'].entries()) {
          await page.getByRole('button', {name: mode, exact: true}).click()
          await page.waitForTimeout(300)
          const view = report.modeViews[mode.toLowerCase()]
          const totals = await page.locator('.bb-metrics-grid > .bb-metric-card > .bb-metric-value .bb-fitted-amount-text').allTextContents()
          assert.deepEqual(totals, [money(view.metrics.monthlyIncome), money(view.metrics.totalExpenses), money(view.metrics.incomeAfterExpenses), money(view.metrics.amountSaved)])
          assert.deepEqual(await page.locator('.bb-left-category-amount').allTextContents(), (i ? ['$1,250', '$900', '$351'] : ['$1,150', '$500', '$100']))
          assert.deepEqual(await page.locator('.bb-savings-metric-card .bb-savings-progress-labels b').allTextContents(), ['$800', '$1,601'])
          const geometry = await page.evaluate(() => {
            const grid = document.querySelector('.bb-metrics-grid'), rows = document.querySelector('.bb-left-category-rows')
            const rect = node => node.getBoundingClientRect()
            const target = grid.querySelector('.bb-savings-progress-labels span:last-child b'), text = document.createRange()
            text.selectNodeContents(target)
            return {radius: getComputedStyle(grid).borderRadius, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, gap: getComputedStyle(rows).rowGap,
              tracks: [...document.querySelectorAll('.bb-left-category-track')].map(node => rect(node).height),
              padding: [...grid.children].map(node => getComputedStyle(node).paddingTop),
              icons: [...grid.querySelectorAll('.bb-metric-explain')].map(node => {const range = document.createRange(); range.selectNodeContents(node.firstChild); const icon = rect(node.lastElementChild), value = rect(node.closest('.bb-metric-card').querySelector('.bb-metric-value')); return {right: Math.abs(icon.right - value.right), gap: icon.left - range.getBoundingClientRect().right}}),
              numberBottomGaps: [...grid.children].slice(0, 2).map(node => rect(node).bottom - rect(node.querySelector('.bb-metric-value')).bottom),
              barTextAlignment: rect(grid.querySelector('.bb-left-category-row:last-child .bb-left-category-track')).bottom - text.getBoundingClientRect().bottom,
              fits: [...grid.querySelectorAll('.bb-fitted-amount-text, .bb-left-category-amount, .bb-savings-progress-labels b')].every(node => rect(node).right <= rect(node.closest('.bb-metric-card')).right - 10),
              overflow: document.documentElement.scrollWidth > innerWidth}
          })
          assert.equal(geometry.radius, '20px'); assert.equal(geometry.columns, width <= 640 ? 2 : 4)
          assert.equal(geometry.gap, '2px'); assert.deepEqual(geometry.tracks, [6, 6, 6]); assert.ok(geometry.padding.every(value => value === '16px'))
          assert.ok(geometry.icons.every(icon => icon.right < 1 && icon.gap >= 12), 'All info icons align with their frame content’s right edge')
          if (width <= 640) {
            assert.ok(geometry.numberBottomGaps.every(gap => gap >= 29 && gap <= 31), 'Income and Spent split the previous bottom spacing at 30px')
          }
          assert.ok(Math.abs(geometry.barTextAlignment) <= 5, `The Savings bar aligns with the final Saved target text: ${geometry.barTextAlignment}`)
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
        const compare = page.locator('.bb-comparison-toggle')
        await page.evaluate(() => {
          window.__comparisonCard = document.querySelector('.bb-comparison-card')
          window.__comparisonPicker = document.querySelector('.bb-comparison-month-head .bb-month-trigger')
          window.__comparisonFrames = []
          const start = performance.now()
          const sample = () => {
            const rect = window.__comparisonCard.getBoundingClientRect()
            window.__comparisonFrames.push({width: rect.width, height: rect.height})
            if (performance.now() - start < 450) requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        })
        await compare.focus(); await page.keyboard.press('Enter')
        while (!releaseComparison) await page.waitForTimeout(10)
        await page.getByText('Comparing matching days…').waitFor()
        assert.equal(await compare.getAttribute('aria-label'), 'Collapse comparison')
        releaseComparison()
        await page.locator('.bb-comparison-values').waitFor()
        await page.waitForTimeout(500)
        const expanded = await page.evaluate(() => {
          const card = document.querySelector('.bb-comparison-card'), body = document.querySelector('.bb-comparison-content'), button = document.querySelector('.bb-comparison-toggle')
          const rect = node => {const r = node.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height}}
          const group = card.querySelector('.bb-comparison-toggle-group'), content = card.querySelector('.bb-comparison-viewport')
          return {sameCard: card === window.__comparisonCard, samePicker: window.__comparisonPicker === card.querySelector('.bb-month-trigger'),
            card:rect(card), body:rect(body), slot:rect(card.parentElement), button:rect(button), radius:getComputedStyle(card).borderRadius,
            groupHidden:getComputedStyle(group).visibility === 'hidden' && group.getAttribute('aria-hidden') === 'true',
            accessible:content.getAttribute('aria-hidden') === 'false' && !content.inert, duration:getComputedStyle(card).getPropertyValue('--bb-comparison-duration').trim(),
            overflow:document.documentElement.scrollWidth > innerWidth,
            amounts:[...card.querySelectorAll('.bb-comparison-difference .bb-fitted-amount-text, .bb-comparison-amount .bb-fitted-amount-text')].map(node => ({text:node.textContent, font:parseFloat(getComputedStyle(node).fontSize), box:rect(node)})),
            tracks:[...card.querySelectorAll('.bb-comparison-track')].map(rect),
            dividerPadding:[getComputedStyle(card.querySelector('.bb-comparison-hero')).paddingBottom, getComputedStyle(card.querySelector('.bb-comparison-months')).paddingTop],
            frames:window.__comparisonFrames}
        })
        assert.ok(expanded.sameCard && expanded.samePicker && expanded.groupHidden && expanded.accessible)
        assert.ok(Math.abs(expanded.card.width - expanded.slot.width) < 1); assert.equal(expanded.radius, '20px'); assert.equal(parseFloat(expanded.duration) * (expanded.duration.endsWith('ms') ? 1 : 1000), 360)
        assert.ok(Math.abs(expanded.card.height - expanded.body.height - 2) < 1, 'Container fits asynchronous result height')
        assert.equal(expanded.button.width, 44); assert.equal(expanded.button.height, 44)
        assert.equal(expanded.card.right - expanded.button.right, 9)
        assert.ok(expanded.amounts.every(amount => amount.box.left >= expanded.body.left && amount.box.right <= expanded.body.right - 15), 'Complete amounts fit the panel')
        assert.ok(expanded.amounts[0].box.right <= expanded.button.left, 'Difference clears the collapse control')
        assert.deepEqual(expanded.amounts.map(amount => amount.text), ['$25.00', '$1,450.75', '$1,475.75'])
        assert.equal(expanded.amounts[1].text, await page.locator('.bb-metrics-grid > .bb-metric-card').nth(1).locator('.bb-metric-value .bb-fitted-amount-text').innerText(), 'Selected comparison amount matches the overview Spent headline')
        assert.ok(expanded.amounts[0].font >= 37 && expanded.amounts.slice(1).every(amount => amount.font >= (width === 320 ? 15 : 17)), 'Normal amounts retain the selected readable font sizes')
        assert.ok(expanded.tracks.every(track => track.height === 8))
        assert.deepEqual(expanded.dividerPadding, ['12px', '12px'], 'The selected divider spacing applies to both sides')
        assert.equal(expanded.overflow, false)
        if (!dark) assert.ok(new Set(expanded.frames.map(frame => Math.round(frame.width))).size > 2, 'Normal-motion expansion has intermediate widths')
        if (width === 390) await page.screenshot({path:`/tmp/bookiebot-comparison-expanded-${engine.name()}-${dark ? 'dark' : 'light'}.png`})
        assert.equal(await page.locator('.bb-comparison-card').getByRole('button', {name:'Details', exact:true}).count(), 0, 'The comparison Details control is removed')
        assert.equal(await page.locator('.bb-comparison-card .bb-comparison-details, .bb-comparison-card table').count(), 0, 'No hidden details or exclusion table remain')
        assert.equal(await page.locator('.bb-comparison-period').innerText(), 'Projected Spent · days 1–29 · includes undated costs', 'The caption describes matching days, the active mode and included undated costs')
        assert.equal(await compare.getAttribute('aria-expanded'), 'true'); assert.equal(comparisonReads.length, 1)
        await page.getByRole('button', {name: 'Current', exact: true}).click()
        await page.waitForFunction(() => document.querySelector('.bb-comparison-amount .bb-fitted-amount-text')?.textContent === '$1,200.50')
        assert.equal(await page.locator('.bb-comparison-period').innerText(), 'Current Spent · days 1–29 · includes undated costs')
        assert.equal(comparisonReads.length, 2)
        await page.getByRole('button', {name: 'Projected', exact: true}).click()
        await page.waitForFunction(() => document.querySelector('.bb-comparison-amount .bb-fitted-amount-text')?.textContent === '$1,450.75')
        assert.equal(comparisonReads.length, 2, 'Each mode reuses its own cached monthly values')
        await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector('.bb-comparison-chevron')).transform).a < -.99)
        await page.getByRole('button', {name: 'Comparison month', exact: true}).click()
        const comparisonPicker = page.getByRole('dialog', {name: 'Comparison month', exact: true})
        await comparisonPicker.waitFor(); await comparisonPicker.getByRole('button', {name: 'Previous year', exact: true}).click()
        await comparisonPicker.getByRole('button', {name: 'October 2025', exact: true}).click()
        await page.waitForFunction(() => document.querySelector('.bb-comparison-values .bb-month-trigger')?.textContent === 'October 2025')
        assert.equal(comparisonReads.length, 3)
        await compare.focus(); await page.keyboard.press('Space'); await page.waitForTimeout(420)
        assert.equal(await compare.getAttribute('aria-expanded'), 'false')
        const hiddenComparison = page.locator('.bb-comparison-viewport')
        assert.equal(await hiddenComparison.getAttribute('aria-hidden'), 'true'); assert.equal(await hiddenComparison.evaluate(node => node.inert), true)
        assert.ok(await compare.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle !== 'none'), 'Capsule keeps visible keyboard focus')
        await checkComparisonCapsule(page)
        await compare.click(); await page.waitForTimeout(420); assert.equal(comparisonReads.length, 3, 'Reopening reuses the selected comparison')
        await compare.click(); await page.waitForTimeout(420)
        if (width === 390) {
          // Reverse unfinished transitions without replacing the frame or picker.
          await compare.evaluate(node => node.click()); await page.waitForTimeout(50)
          await compare.evaluate(node => node.click()); await page.waitForTimeout(50)
          await compare.evaluate(node => node.click()); await page.waitForTimeout(450)
          assert.ok(await page.locator('.bb-comparison-card').evaluate(card => card === window.__comparisonCard && card.dataset.open === 'true' && Math.abs(card.getBoundingClientRect().height - card.querySelector('.bb-comparison-content').offsetHeight - 2) < 1))
          await page.setViewportSize({width:520, height:900}); await page.waitForTimeout(450)
          assert.ok(await page.locator('.bb-comparison-card').evaluate(card => Math.abs(card.getBoundingClientRect().width - card.parentElement.clientWidth) < 1 && document.documentElement.scrollWidth <= innerWidth), 'Open comparison refits on rotation/resize')
          await page.setViewportSize({width, height:900}); await page.waitForTimeout(450)
          await compare.click(); await page.waitForTimeout(420)
          await checkComparisonCapsule(page)
          assert.equal(comparisonReads.length, 3, 'Motion and resizing cannot trigger report reads')
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
        await page.getByRole('button', {name: 'Show Calendar', exact: true}).click()
        await page.getByRole('button', {name: 'Projected', exact: true}).click(); await page.reload()
        await page.locator('.bb-metrics-grid').waitFor()
        assert.equal(await page.getByRole('button', {name: 'Projected', exact: true}).getAttribute('aria-pressed'), 'true', 'Restyling preserves the existing per-owner mode preference')
        assert.equal(await page.locator('.bb-chart-carousel-title').innerText(), 'Calendar', 'The selected chart survives a fresh report load')
        if (width === 390) {await page.getByRole('button', {name:'Show Category Mix',exact:true}).click(); await page.waitForTimeout(300); await page.screenshot({path: `/tmp/bookiebot-overview-${engine.name()}-${dark ? 'dark' : 'light'}.png`})}
        assert.deepEqual(errors, [], `${engine.name()} ${width}px ${dark ? 'dark' : 'light'} has no page errors`); assert.deepEqual(unexpected, [], 'No external or financial write requests')
        await page.close()
      }
    } finally {await browser.close()}
  }
  console.log(`${cases} Chromium/WebKit Overview mode cases passed, with capsule geometry/picker/keyboard/caching, startup, metric details, motion and preferences; no external traffic or financial writes`)
})().catch(error => {console.error(error); process.exitCode = 1})
