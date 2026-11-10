// Use the actual phone HTML, CSS and production bundle. Generate the workspace
// fixture with test_transactions_workspace.py and point Playwright at it.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {createRequire} = require('node:module')
const {execFileSync} = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const req = createRequire(path.join(root, 'web/expense-report/package.json'))
const {chromium, webkit} = require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE || req.resolve('playwright'))
const assets = path.join(root, 'src/bookiebot/reports/assets')
const fixture = JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_TRANSACTION_WORKSPACE_FIXTURES || '/private/tmp/bookiebot-transactions-workspace.json', 'utf8'))
const {html, csp, report} = JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON || 'python', ['-c', `
import asyncio
import json
import sys
from bookiebot.reports import expense_breakdown as breakdown, phone_app
from unit_tests.reports.test_income_projection import build, income_rows
year, month = (int(part) for part in sys.argv[1].split("-"))
page = asyncio.run(phone_app._expense_app(None))
report = build(income_rows((f"{month}/2/{year}", "Fixture payroll", "6400")), month=breakdown.BudgetMonth(year, month))
print(json.dumps({"html":page.text,"csp":page.headers["Content-Security-Policy"],"report":breakdown.expense_breakdown_client_payload(report)}))
`, fixture.month], {cwd: root, env: {...process.env, PYTHONPATH: 'src'}}))
const breakdown = [
  {key:'rent',label:'Rent',amount:1600},
  {key:'grocery',label:'Groceries',amount:480},
  {key:'food',label:'Eating out',amount:670},
  {key:'shopping',label:'Shopping',amount:850},
]
for (const view of Object.values(report.modeViews)) {
  view.breakdown = breakdown.map(item => ({...item,percentage:0,color:'green'}))
  Object.assign(view.metrics,{monthlyIncome:6400,totalExpenses:3600,amountSaved:1000,incomeAfterExpenses:1800})
  view.categoryBudgets = {needs:3200,wants:1920,savings:1280}
  const remaining = {needs:1120,wants:400,savings:280}
  view.categoryBalances = {raw:remaining,remaining,deficits:{needs:0,wants:0,savings:0},transfers:[],totalOverspend:0}
  if (view.savingsInvesting) view.savingsInvesting.cashSaved = 1000
}
const portrait = {width:466,height:657}, landscape = {width:951,height:648}
const clippedPortrait = {width:382,height:657}, clippedLandscape = {width:867,height:669}
const browserOptions = engine => {
  const executablePath = process.env['BOOKIEBOT_' + engine.name().toUpperCase() + '_EXECUTABLE']
  return executablePath ? {executablePath} : {}
}

async function checkGeometry(page) {
  const geometry = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect()
    const nav = box('.bb-navigation-pane')
    const lens = box('.bb-navigation-selection')
    const tab = box('.bb-navigation-link[aria-current="page"]')
    const tools = Array.from(document.querySelectorAll('.bb-shell-icon'), element => element.getBoundingClientRect())
    const content = box('.bb-shell-masthead')
    return {
      navWidth: nav.width, navHeight: nav.height, tools: tools.map(tool => tool.width),
      room: nav.top > tools[1].bottom && tools[1].top > tools[0].bottom,
      aligned: tools.every(tool => Math.abs(tool.x + tool.width/2 - nav.x - nav.width/2)<1),
      lensAligned: Math.abs(lens.y+lens.height/2-tab.y-tab.height/2)<1,
      inside: content.right < nav.left && nav.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth,
    }
  })
  assert.deepEqual(geometry,{navWidth:60,navHeight:256,tools:[44,44],room:true,aligned:true,lensAligned:true,inside:true})
}

async function checkHorizontalDock(page) {
  await page.waitForFunction(width => {
    const tools = document.querySelector('.bb-shell-toolbar-inner').getBoundingClientRect()
    return tools.right <= width + 1 && document.documentElement.scrollWidth <= width + 1
  }, page.viewportSize().width, {timeout:5000})
  const nav = await page.locator('.bb-navigation-pane').boundingBox()
  const tools = await page.locator('.bb-shell-toolbar-inner').boundingBox()
  assert.ok(nav.width > nav.height && tools.width > tools.height)
  return {nav, tools}
}

;(async()=>{
  for (const engine of [chromium,webkit].filter(engine => !process.env.ONLY_ENGINE || engine.name()===process.env.ONLY_ENGINE)) {
    const browser = await engine.launch(browserOptions(engine))
    try {
      for (const theme of ['light','dark']) {
        const page = await browser.newPage({viewport:portrait,isMobile:true,hasTouch:true,colorScheme:theme,reducedMotion:'reduce'})
        const errors = [], posts = []
        page.on('pageerror', error => errors.push(error.message))
        await page.addInitScript(({theme, owner}) => {
          Object.defineProperty(navigator, 'standalone', {value: true})
          localStorage.setItem('bookiebot-expense-report-theme',theme)
          localStorage.setItem('bookiebot-report-view:v1:'+owner.toLowerCase(),'{"version":1,"mode":"current","chartId":"category"}')
        }, {theme,owner:report.ownerName})
        const responses = {
          '/app/expenses/data': report,
          '/app/expenses/months': {currentMonth:fixture.month,months:[{value:fixture.month,label:report.monthLabel}],coverage:{status:'complete',unavailableYears:[]}},
          '/app/reconciliation': {enabled:true,checkedAt:null,items:[]},
          '/app/transactions': fixture.results.all,
        }
        await page.route('**/*', route => {
          const request = route.request(), url = new URL(request.url())
          if (url.origin !== 'https://duo.test') return route.abort()
          if (request.method() !== 'GET') {
            posts.push(url.pathname)
            assert.equal(url.pathname,'/app/transactions/review')
            const body = request.postDataJSON()
            const item = fixture.sources.find(source => source.id===body.id)
            assert.equal(body.operation,'update')
            assert.equal(body.updates.amount,1045)
            return route.fulfill({json:{review:{item,operation:'update',reviewVersion:'duo-review',after:{...item.fields,amount:'10.45'}}}})
          }
          if (url.pathname==='/app/expenses') return route.fulfill({headers:{'Content-Security-Policy':csp},contentType:'text/html',body:html})
          if (url.pathname.startsWith('/app/assets/')) {
            const file = path.join(assets,path.basename(url.pathname))
            if (fs.existsSync(file)) return route.fulfill({path:file})
          }
          if (url.pathname==='/app/avatar.png') return route.fulfill({path:path.join(root,'assets/avatars/avatar1.PNG'),contentType:'image/png'})
          if (responses[url.pathname]) return route.fulfill({json:responses[url.pathname]})
          return route.fulfill({status:404,json:{}})
        })
        const shell = page.locator('.bb-app-shell')
        const nav = page.getByRole('navigation',{name:'Main navigation'})
        const mode = value => page.waitForFunction(value => document.querySelector('.bb-app-shell').getAttribute('data-duo-layout')===value,value)
        const settings = page.getByRole('main',{name:'Settings',exact:true})
        const switchDuo = settings.getByRole('switch',{name:'iPhone Duo layout'})
        const shot = async (name) => {
          const directory = process.env.BOOKIEBOT_DUO_SCREENSHOTS
          if (directory) await page.screenshot({path:path.join(directory,`duo-${engine.name()}-${theme}-${name}.png`)})
        }
        await page.goto('https://duo.test/app/expenses')
        await page.locator('.bb-metrics-grid').waitFor()
        assert.equal(await shell.getAttribute('data-duo-layout'),null)
        await page.getByRole('button',{name:'Settings',exact:true}).tap()
        await switchDuo.tap()
        await mode('portrait')
        await settings.getByRole('button',{name:'Back',exact:true}).tap()
        await page.locator('.bb-metrics-grid').waitFor()
        await page.waitForFunction(() => document.querySelectorAll('[data-nav-screen]').length===5)
        await checkGeometry(page)
        await shot('portrait-overview')
        await page.getByRole('button',{name:'Ask BookieBot',exact:true}).tap()
        const chat = page.getByRole('dialog',{name:'Ask BookieBot'})
        await chat.waitFor()
        await page.locator('.bb-ask-dialog[data-open="true"]').waitFor()
        await page.waitForFunction(() => document.querySelector('.bb-ask-panel-surface').getBoundingClientRect().right <= innerWidth - 83)
        await chat.getByRole('button',{name:'Close Ask BookieBot'}).tap()
        await chat.waitFor({state:'hidden'})

        if (engine.name()==='chromium' && theme==='light') {
          const touch = await page.context().newCDPSession(page)
          const home = await nav.getByRole('button',{name:'Overview',exact:true}).boundingBox()
          const receipt = await nav.getByRole('button',{name:'Transactions',exact:true}).boundingBox()
          const x = home.x + home.width / 2
          await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:home.y+home.height/2}]})
          await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:receipt.y+receipt.height/2}]})
          assert.equal(await nav.getByRole('button',{name:'Overview',exact:true}).getAttribute('aria-current'),'page')
          await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
          await touch.detach()
        } else await nav.getByRole('button',{name:'Transactions',exact:true}).tap()
        const transactions = page.getByRole('region',{name:'Recorded transactions'})
        await transactions.locator('.bb-chart-total').waitFor()
        const group = transactions.locator('.bb-daily-day-group:not(.bb-daily-single-day)').first()
        await group.locator('.bb-daily-day-header').tap()
        await page.waitForFunction(() => document.querySelector('.bb-daily-day-group').dataset.moving==='false')
        await checkGeometry(page)
        await shot('portrait-transactions')
        await group.getByRole('button',{name:'Show actions for Starbucks Coffee Company',exact:true}).press('ArrowLeft')
        await group.getByRole('button',{name:'Update Starbucks Coffee Company',exact:true}).tap()
        const editor = transactions.getByRole('region',{name:'Edit transaction'})
        const amount = editor.getByRole('textbox',{name:'Amount',exact:true})
        await amount.fill('10.45')
        await amount.evaluate(input => { window.duoDraftInput = input })
        await page.setViewportSize(landscape)
        await mode('landscape')
        const side = transactions.getByRole('complementary',{name:'Selected transaction'})
        await side.getByRole('region',{name:'Edit transaction'}).waitFor()
        assert.equal(await amount.inputValue(),'10.45')
        assert.equal(await amount.evaluate(input => input===window.duoDraftInput),true)
        await checkGeometry(page)
        await page.evaluate(() => { document.activeElement.blur(); scrollTo(0,240) })
        assert.ok((await side.boundingBox()).y >= 15)
        await page.evaluate(() => { document.activeElement.blur(); scrollTo(0,0) })
        await shot('landscape-transactions')
        await page.setViewportSize(clippedLandscape)
        await mode(null)
        await side.getByRole('region',{name:'Edit transaction'}).waitFor({timeout:5000})
        assert.equal(await amount.inputValue(),'10.45')
        assert.equal(await amount.evaluate(input => input===window.duoDraftInput),true)
        await page.evaluate(() => { document.activeElement.blur(); scrollTo(0,240) })
        const {nav: horizontalNav, tools: horizontalTools} = await checkHorizontalDock(page)
        const editorBox = await side.boundingBox()
        assert.ok(editorBox.y >= horizontalTools.y + horizontalTools.height && editorBox.y + editorBox.height <= horizontalNav.y + 1)
        await shot('clipped-landscape-transactions')
        await editor.getByRole('button',{name:'Review change'}).tap()
        await editor.getByRole('button',{name:'Confirm update'}).waitFor()
        await page.setViewportSize(clippedPortrait)
        await mode(null)
        await side.waitFor({state:'hidden'})
        await group.getByRole('button',{name:'Confirm update'}).waitFor()
        await editor.getByRole('button',{name:'Back',exact:true}).tap()
        assert.equal(await amount.inputValue(),'10.45')
        assert.equal(await amount.evaluate(input => input===window.duoDraftInput),true)
        await editor.getByRole('button',{name:'Cancel',exact:true}).tap()
        assert.deepEqual(posts,['/app/transactions/review'])

        await page.setViewportSize(landscape)
        await mode('landscape')
        await nav.getByRole('button',{name:'Overview',exact:true}).tap()
        const categories = page.getByRole('complementary',{name:'Category breakdown'})
        await categories.waitFor()
        assert.match(await categories.innerText(),/Rent\s+\$1,600.00/)
        assert.match(await categories.innerText(),/Eating out\s+\$670.00/)
        await checkGeometry(page)
        await shot('landscape-overview')
        await page.setViewportSize(clippedLandscape)
        await mode(null)
        await categories.waitFor({timeout:5000})
        await checkHorizontalDock(page)
        await shot('clipped-landscape-overview')
        await page.getByRole('combobox',{name:'Category mix filter'}).selectOption('needs')
        assert.equal(await categories.getByText('Eating out',{exact:true}).count(),0)
        await page.getByRole('button',{name:'Show category callouts'}).tap()
        await categories.waitFor({state:'hidden'})
        await page.getByRole('button',{name:'Hide category callouts'}).tap()
        await categories.waitFor()
        await page.getByRole('button',{name:'Show Calendar',exact:true}).tap()
        await categories.waitFor({state:'hidden'})
        await page.setViewportSize(clippedPortrait)
        await mode(null)
        await checkHorizontalDock(page)
        await page.setViewportSize({width:669,height:869})
        await mode(null)
        await page.getByRole('button',{name:'Settings',exact:true}).tap()
        assert.equal(await switchDuo.getAttribute('aria-checked'),'true')
        await switchDuo.tap()
        await page.setViewportSize(portrait)
        await mode(null)
        await page.reload()
        await page.locator('.bb-metrics-grid').waitFor()
        assert.equal(await shell.getAttribute('data-duo-layout'),null)
        assert.deepEqual(errors,[])
        await page.close()
        console.log(engine.name(),theme,'Duo integration passed')
      }
    } finally { await browser.close() }
  }
})().catch(error=>{console.error(error);process.exitCode=1})
