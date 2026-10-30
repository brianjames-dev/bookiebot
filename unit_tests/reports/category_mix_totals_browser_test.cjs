// Run after npm run build. Execute the shared report UI with isolated payloads.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const [plain,enrolled]=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import json
from unit_tests.reports.test_income_projection import build,income_rows
from unit_tests.reports.test_espp_tracking import plan_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload as payload
print(json.dumps([payload(build(income_rows(('9/1/2026','Fixture income','5000')))),payload(build(plan_rows(('9/11/2026','xAI paycheck','3800'))))]))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
const cases=[{name:'cash',base:plain,cash:1200,espp:[undefined,undefined],expected:[675.50,725.75]},
  {name:'cash-espp',base:enrolled,cash:1200,espp:[400,600],expected:[675.50,725.75]},
  {name:'zero-saved',base:plain,cash:0,espp:[undefined,undefined],expected:[675.50,725.75]}]
for(const fixture of cases) {
  fixture.report=JSON.parse(JSON.stringify(fixture.base))
  for(const [i,mode] of ['current','projected'].entries()) {
    const view=fixture.report.modeViews[mode],espp=fixture.espp[i]??0
    view.metrics.totalExpenses=i?725.75:675.50 // Includes a real-world-style sheet adjustment beyond itemized rows.
    view.metrics.amountSaved=fixture.cash+espp
    // Simulate an already-open report carrying the previous explanation shape.
    fixture.report.metricExplanations[mode].spent.value=view.metrics.totalExpenses+view.metrics.amountSaved
    fixture.report.metricExplanations[mode].spent.components=[{label:'Saved',amount:view.metrics.amountSaved,source:'summary',date:null}]
    view.metrics.monthlyIncome=5000+espp
    view.categoryBudgets={needs:2000,wants:1000,savings:2000}
    const remaining={needs:1500,wants:i?800:850,savings:2000-fixture.cash}
    view.categoryBalances={raw:remaining,remaining,deficits:{needs:0,wants:0,savings:0},transfers:[],totalOverspend:0}
    view.metrics.incomeAfterExpenses=view.metrics.monthlyIncome-view.metrics.totalExpenses-view.metrics.amountSaved
    view.breakdown=[{key:'rent',label:'Rent',amount:500,percentage:0,color:'green'},{key:'food',label:'Food',amount:i?200:150,percentage:0,color:'orange'},
      {key:'savings',label:'Legacy savings row',amount:999,percentage:0,color:'blue'}]
    view.categorySpending={needs:500,wants:i?200:150,savings:fixture.cash}
    if(view.savingsInvesting)Object.assign(view.savingsInvesting,{cashSaved:fixture.cash,esppContribution:espp,estimatedEsppContribution:i?200:0,combinedContributions:fixture.cash+espp})
  }
}
const css=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.js'),'utf8')
const html=(report,dark)=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script>localStorage.setItem('bookiebot-expense-report-theme','${dark?'dark':'light'}')</script><script id="bookiebot-expense-report-data" type="application/json">${JSON.stringify(report)}</script><script type="module">${js}</script></body></html>`
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value)
;(async()=>{
  let count=0
  for(const engine of [chromium,webkit]) {
    const browser=await engine.launch({headless:true})
    try {
      for(const width of [320,390]) for(const dark of [false,true]) for(const fixture of cases) {
        const page=await browser.newPage({viewport:{width,height:850},hasTouch:true,isMobile:true,reducedMotion:dark?'reduce':'no-preference'}),errors=[],requests=[]
        page.on('pageerror',e=>errors.push(e.message))
        await page.route('**/*',async route=>{
          if(route.request().url()==='https://bookie.test/report')await route.fulfill({contentType:'text/html',body:html(fixture.report,dark)})
          else if(/^category-mix-layout-[\w-]+\.js$/.test(new URL(route.request().url()).pathname.split('/').pop()))await route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,'src/bookiebot/reports/assets',new URL(route.request().url()).pathname.split('/').pop()),'utf8')})
          else {requests.push(route.request().url());await route.abort()}
        })
        await page.goto('https://bookie.test/report')
        const category=page.locator('#bb-chart-category'),total=category.locator('.bb-chart-total')
        const spentCard=page.locator('.bb-metric-card').filter({has:page.getByRole('button',{name:'Explain Spent',exact:true})}).locator('.bb-fitted-amount-text')
        await page.getByRole('button',{name:'Show Category Mix',exact:true}).click()
        const scope=category.getByRole('combobox',{name:'Category mix filter',exact:true})
        assert.equal(await scope.locator('option[value="all"]').innerText(),'All')
        await scope.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab')
        assert.equal(await scope.evaluate(el=>el===document.activeElement&&getComputedStyle(el).outlineStyle==='solid'),true,'Tab navigation retains visible keyboard focus')
        await scope.tap();await scope.selectOption('needs')
        assert.equal(await scope.evaluate(el=>getComputedStyle(el).outlineStyle),'none','Touch selection leaves no sticky focus outline')
        // Escape is keyboard input and intentionally restores keyboard focus.
        // Check the touch state before dismissing a native test popup with it.
        await page.keyboard.press('Escape')
        for(const [i,mode] of ['Current','Projected'].entries()) {
          await page.getByRole('button',{name:mode,exact:true}).click()
          await category.getByRole('combobox',{name:'Category mix filter',exact:true}).selectOption('all')
          assert.equal(await total.innerText(),money(fixture.expected[i]),`${engine.name()} ${width} ${fixture.name} ${mode}: All excludes savings and retains the canonical expense adjustment`)
          assert.equal(await total.innerText(),await spentCard.innerText(),'All and the Spent card agree')
          await page.waitForTimeout(650)
          const geometry=await category.evaluate(el=>{
            const rect=selector=>el.querySelector(selector).getBoundingClientRect()
            const host=rect('.bb-category-pie-host'),ring=rect('.recharts-pie'),center=rect('.bb-category-pie-center'),chevron=rect('.bb-category-filter-chevron'),select=rect('.bb-category-mix-filter select'),amount=rect('.bb-chart-total .bb-fitted-amount-text')
            const stage=document.querySelector('.bb-chart-carousel-band').getBoundingClientRect()
            return {fills:ring.width/Math.min(host.width,host.height),centerX:Math.abs((center.left+center.right-ring.left-ring.right)/2),centerY:Math.abs((center.top+center.bottom-ring.top-ring.bottom)/2),inset:select.right-chevron.right,dropdownWidth:select.width,totalFont:getComputedStyle(el.querySelector('.bb-chart-total')).fontSize,usedFont:getComputedStyle(el.querySelector('.bb-category-used')).fontSize,headerFits:amount.right+8<select.left,stage:stage.height,used:el.querySelector('.bb-category-used .bb-fitted-amount-text').textContent,usedCaption:el.querySelector('.bb-category-pie-center > span').textContent,budget:el.querySelector('.bb-chart-budget-note').textContent,mode:el.querySelector('.bb-chart-mode-note').textContent,captionFits:el.querySelector('.bb-category-pie-center > span').getBoundingClientRect().width<=center.width}
          })
          assert.ok(geometry.fills>.7&&geometry.fills<1,JSON.stringify(geometry))
          assert.ok(geometry.centerX<1&&geometry.centerY<1,JSON.stringify(geometry))
          assert.equal(geometry.inset,14,'The chevron retains its approved right inset')
          assert.ok(geometry.dropdownWidth < 90,'All hugs its text and chevron instead of reserving room for longer scopes')
          assert.equal(geometry.totalFont,'28px')
          assert.equal(geometry.usedFont,'30px')
          assert.equal(geometry.headerFits,true,'Exact cents fit beside the native dropdown')
          assert.equal(geometry.mode,mode)
          assert.equal(geometry.used,`${Number(((fixture.expected[i]+fixture.cash+(fixture.espp[i]??0))/(5000+(fixture.espp[i]??0))*100).toFixed(1))}%`)
          assert.equal(geometry.usedCaption,'spent + saved','Ring allocation includes savings under an explicit label')
          assert.equal(geometry.captionFits,true,'The broader allocation label fits inside the ring')
          assert.ok(!geometry.budget.includes('used'),'The percentage belongs inside the ring')
          await page.getByRole('button',{name:'Explain Spent',exact:true}).click()
          const dialog=page.getByRole('dialog')
          await dialog.waitFor()
          assert.equal(await dialog.locator('.bb-metric-explanation > .bb-chart-total').innerText(),money(fixture.expected[i]),'All, card and modal agree even with an older cached explanation')
          assert.ok(!(await dialog.innerText()).includes('Includes estimated ESPP'))
          assert.ok(!(await dialog.locator('.bb-metric-explanation dt').allTextContents()).includes('Saved'),'The expense explanation has no savings row')
          await page.keyboard.press('Escape');await page.waitForTimeout(350)
          for(const [filter,expected] of [['Needs',500],['Wants',i?200:150],['Savings',fixture.cash+(fixture.espp[i]??0)]]) {
            await category.getByRole('combobox',{name:'Category mix filter',exact:true}).selectOption(filter.toLowerCase())
            assert.equal(await total.innerText(),money(expected),`${filter} retains its own scoped total`)
            assert.equal(await category.locator('.bb-category-pie-center > span').innerText(),filter==='Savings'?'saved':'used')
            const fit=await scope.evaluate(el=>{
              const style=getComputedStyle(el),label=el.parentElement.querySelector('.bb-category-filter-label'),range=document.createRange()
              range.selectNodeContents(label)
              return {width:el.getBoundingClientRect().width,expected:range.getBoundingClientRect().width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth),height:el.getBoundingClientRect().height,inset:el.getBoundingClientRect().right-el.parentElement.querySelector('svg').getBoundingClientRect().right}
            })
            assert.ok(Math.abs(fit.width-fit.expected)<1,`${filter} width follows its current text: ${JSON.stringify(fit)}`)
            assert.ok(fit.height>=44&&fit.inset===14,'Dynamic width retains the touch target and chevron inset')
            assert.ok(fit.width>geometry.dropdownWidth,`${filter} grows from All without truncation`)
          }
          await category.getByRole('combobox',{name:'Category mix filter',exact:true}).selectOption('all')
          assert.ok(Math.abs((await scope.boundingBox()).width-geometry.dropdownWidth)<1,'All shrinks again after a longer scope')
          assert.equal(await category.getByRole('button',{name:'Categories',exact:true}).count(),0)
          await category.getByRole('button',{name:'Show category callouts',exact:true}).click()
          await category.locator('.bb-contour-callouts[data-ready="true"][data-visible="true"]').waitFor({timeout:120000})
          const labels=await category.locator('.bb-contour-label').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')))
          assert.equal(labels.filter(label=>/^Inspect (Saved|Cash saved),/.test(label)).length,Number(fixture.cash>0),'Recorded cash appears once in All for enrolled and non-enrolled reports')
          assert.equal(labels.some(label=>label.includes('ESPP')),Boolean(fixture.espp[i]))
          await category.getByRole('button',{name:'Hide category callouts',exact:true}).click();await page.waitForTimeout(dark?30:600)
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
          count++
        }
        assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'The report test never contacts an app or financial service')
        if(width===390&&dark&&fixture.name==='cash-espp')await page.screenshot({path:`/tmp/bookiebot-category-spent-${engine.name()}.png`,fullPage:true})
        if(width===390&&dark&&fixture.name==='cash-espp')await category.screenshot({path:`/tmp/bookiebot-category-layout-${engine.name()}.png`})
        await page.close()
      }
    } finally {await browser.close()}
  }
  console.log(`${count} Chromium/WebKit Category Mix/Spent mode cases passed; no API traffic`)
})().catch(error=>{console.error(error);process.exitCode=1})
