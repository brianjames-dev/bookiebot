// Run after npm run build. Set BOOKIEBOT_PLAYWRIGHT_MODULE when Playwright is
// supplied by an external browser-test runtime rather than frontend dependencies.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../..')
const frontend = path.join(root, 'web/expense-report')
const req = createRequire(path.join(frontend, 'package.json'))
const { chromium, webkit } = process.env.BOOKIEBOT_PLAYWRIGHT_MODULE
  ? require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE) : req('playwright')
const css = fs.readFileSync(path.join(root, 'src/bookiebot/reports/assets/expense-report-app.css'), 'utf8')
const bundle = req('esbuild').buildSync({ stdin: { resolveDir: frontend, loader: 'tsx', contents: `
  import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
  import {KonstaProvider} from 'konsta/react'; import {AppNavigationBar} from './src/app-navigation-bar';
  function Fixture() {
    const [config,setConfig]=useState({active:'overview',compact:false,count:5});
    window.configure=changes=>setConfig(current=>({...current,...changes}));
    return <KonstaProvider theme="ios" dark={window.dark}><div className="bb-app-shell">
      <AppNavigationBar active={config.active} current={config.settings ? null : config.active} compact={config.compact} reconciliationVisible={config.count===5}
        onSelect={active=>{window.selections.push(active); if(!window.blockNavigation) setConfig(current=>({...current,active}));}}/>
    </div></KonstaProvider>;
  }
  window.selections=[]; createRoot(document.getElementById('root')).render(<Fixture/>);
` }, bundle: true, format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text

async function geometry(page, label, compact) {
  // Let the ResizeObserver run after a tab/count/viewport change.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const result = await page.locator('.bb-navigation-pane').evaluate(host => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const selected = host.querySelector('button[data-state="active"]')
    return {
      selected: selected.getAttribute('aria-label'), button: rect(selected),
      bubble: rect(host.querySelector('.bb-navigation-selection')),
      icon: rect(selected.querySelector('svg')), label: rect(selected.firstElementChild.lastElementChild),
      targets: [...host.querySelectorAll('button')].map(rect),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
  assert.equal(result.selected, label)
  const { button, bubble, icon } = result
  const close = (a, b, message) => assert.ok(Math.abs(a - b) <= 1, `${message}: ${a} vs ${b}`)
  close(bubble.x + bubble.width / 2, button.x + button.width / 2, 'Bubble must center on the actual selected button')
  close(bubble.y + bubble.height / 2, button.y + button.height / 2, 'Vertical centering')
  close(bubble.x + bubble.width / 2, icon.x + icon.width / 2, 'Icon must center in the bubble')
  const contents = compact ? [icon] : [icon, result.label]
  const contentWidth = Math.max(...contents.map(content => content.width))
  const contentHeight = Math.max(...contents.map(content => content.bottom)) - Math.min(...contents.map(content => content.y))
  assert.ok(bubble.width <= contentWidth + 13 && bubble.height <= contentHeight + 13, 'Bubble must fit the icon/label stack rather than filling a whole tab slot')
  for (const content of contents) {
    assert.ok(content.x >= bubble.x + 1 && content.right <= bubble.right - 1, `Bubble must enclose ${label} horizontally`)
    assert.ok(content.y >= bubble.y + 1 && content.bottom <= bubble.bottom - 1, `Bubble must enclose ${label} vertically`)
  }
  result.targets.forEach(target => assert.ok(target.width >= 44 && target.height >= 44, 'At least 44px touch targets'))
  assert.equal(result.overflow, false, 'Navigation must not widen the document')
}

async function fixture(browser, width, dark, reducedMotion = 'reduce') {
  const page = await browser.newPage({ viewport: { width, height: 700 }, hasTouch: true, reducedMotion })
  await page.route('**/*', route => route.abort())
  await page.setContent(`<!doctype html><html data-theme="${dark ? 'dark' : 'light'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>window.dark=${dark}</script></body></html>`)
  await page.addScriptTag({ content: bundle })
  await page.locator('.bb-navigation-pane').waitFor()
  return page
}

;(async () => {
  let cases = 0
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const width of [320, 390, 768]) for (const dark of [false, true]) {
        const page = await fixture(browser, width, dark)
        for (const count of [4, 5]) for (const compact of [false, true]) {
          await page.evaluate(config => window.configure(config), { count, compact })
          for (const label of ['Overview', 'Transactions', 'Shared', 'Savings', ...(count === 5 ? ['Reconcile'] : [])]) {
            await page.getByRole('button', { name: label, exact: true }).click()
            await geometry(page, label, compact)
          }
          cases++
        }
        // Native touch must select once, including near unequal button edges.
        await page.evaluate(() => window.configure({ count: 5, compact: false }))
        await geometry(page, 'Reconcile', false)
        const transaction = await page.getByRole('button', { name: 'Transactions', exact: true }).boundingBox()
        const before = await page.evaluate(() => window.selections.length)
        await page.touchscreen.tap(transaction.x + transaction.width - 2, transaction.y + transaction.height / 2)
        await geometry(page, 'Transactions', false)
        assert.equal(await page.evaluate(() => window.selections.length), before + 1, 'Touch must not double-select')
        // Keyboard activation and navigation rejected by the work guard stay aligned.
        await page.getByRole('button', { name: 'Savings', exact: true }).focus()
        await page.keyboard.press('Space')
        await geometry(page, 'Savings', false)
        await page.evaluate(() => { window.blockNavigation = true })
        await page.getByRole('button', { name: 'Shared', exact: true }).click()
        await geometry(page, 'Savings', false)
        await page.touchscreen.tap(transaction.x + 3, transaction.y + transaction.height / 2)
        await geometry(page, 'Savings', false)
        await page.evaluate(() => window.configure({ settings: true }))
        await geometry(page, 'Savings', false)
        assert.equal(await page.locator('button[aria-current="page"]').count(), 0, 'Settings retains the bubble without claiming a main tab is the current page')
        if (engine === chromium && width === 320 && dark) {
          await page.evaluate(() => { window.blockNavigation = false; window.configure({ settings: false }) })
          const cdp = await page.context().newCDPSession(page)
          const bounds = await page.locator('.bb-navigation-link').evaluateAll(buttons => buttons.map(button => { const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }))
          const previous = await page.evaluate(() => window.selections.length)
          const touch = async (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] })
          await touch('touchStart', bounds[0])
          await touch('touchMove', bounds[1])
          await geometry(page, 'Transactions', false)
          await touch('touchMove', bounds[4])
          await geometry(page, 'Reconcile', false)
          await touch('touchEnd')
          await geometry(page, 'Reconcile', false)
          assert.equal(await page.evaluate(() => window.selections.length), previous + 1, 'Dragging selects once on release')
          await touch('touchStart', bounds[0])
          await touch('touchMove', bounds[1])
          await touch('touchCancel')
          await geometry(page, 'Reconcile', false)
          assert.equal(await page.evaluate(() => window.selections.length), previous + 1, 'A cancelled gesture cannot navigate')
          await cdp.detach()
        }
        await page.close()
      }
      const moving = await fixture(browser, 390, true, 'no-preference')
      for (const compact of [true, false]) {
        await moving.evaluate(compact => window.configure({ active: 'transactions', compact }), compact)
        await moving.waitForTimeout(600)
        await geometry(moving, 'Transactions', compact)
      }
      await moving.setViewportSize({ width: 320, height: 700 })
      await moving.waitForTimeout(600)
      await geometry(moving, 'Transactions', false)
      if (process.env.BOOKIEBOT_NAV_SCREENSHOT) await moving.screenshot({ path: process.env.BOOKIEBOT_NAV_SCREENSHOT, clip: { x: 0, y: 610, width: 320, height: 90 } })
      await moving.close()
    } finally { await browser.close() }
  }
  console.log(`${cases} Chromium/WebKit layout combinations passed: all tab bounds, touch, keyboard, guarded selection, resize and compact transitions`)
})().catch(error => { console.error(error); process.exit(1) })
