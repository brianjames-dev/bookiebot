// Run after npm run build. Geometry uses the real app; APIs are isolated fixtures.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process')
const {createRequire} = require('node:module')
const root = path.resolve(__dirname,'../..'), frontend = path.join(root,'web/expense-report')
const req = createRequire(path.join(frontend,'package.json'))
const {chromium,webkit} = process.env.BOOKIEBOT_PLAYWRIGHT_MODULE ? require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE) : req('playwright')
const measureOnly=process.argv.includes('--measure-only')
const [report,investedReport]=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import json
from unit_tests.reports.test_income_projection import build, income_rows
from unit_tests.reports.test_espp_tracking import plan_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps([expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','5000')))),expense_breakdown_client_payload(build(plan_rows(('9/11/2026','xAI paycheck','3800'))))]))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
for(const data of [report,investedReport]) {
  data.dailyEntries=data.topEntries=Array.from({length:12},(_,i)=>({date:`9/${i+1}/2026`,category:'Food',amount:20+i,person:'Brian',item:`Fixture purchase ${i+1}`,location:`Fixture merchant ${i+1}`}))
  data.merchantOccurrences=Array.from({length:12},(_,i)=>({label:`Fixture merchant ${i+1}`,amount:20+i,count:i+1}))
  for(const view of Object.values(data.modeViews)) {
    view.utilityHistory=[{key:'water',label:'Water',currentAmount:60,averageAmount:55,deltaAmount:5,history:[{label:'September',amount:60,month:9}]}]
    view.calendarEvents.push({kind:'bill',label:'Internet',amount:60,day:10,group:'static_bills_subscriptions_needs',projectedOnly:false})
  }
}
const goals=[false,false,true,true].map((archived,i)=>({id:`fixture-goal-${i}`,name:`Fixture ${archived?'archived':'active'} goal ${i}`,targetCents:100000,startingCents:10000,balanceCents:20000,contributionCents:10000,contributionCount:1,targetDate:'',archived,version:1}))
const css=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.css'),'utf8')
const js=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.js'),'utf8')
const html=dark=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName:'Brian',reportUrl:'/app/expenses/data',logoutUrl:'/app/logout'})}</script><script>localStorage.setItem('bookiebot-expense-report-theme','${dark?'dark':'light'}')</script><script type="module">${js}</script></body></html>`
async function gap(page,section,button) {return page.evaluate(({section,button})=>{const edge=document.querySelector(section),control=document.querySelector(button);if(!edge||!control)throw new Error(`Missing spacing target: ${!edge?section:button}`);return edge.getBoundingClientRect().bottom-control.getBoundingClientRect().bottom},{section,button})}
const dailyButton='.bb-daily-section button.bb-details-toggle',insightButton='.bb-highlights-section .bb-tabs-content[data-state="active"] .bb-expand-toggle'
const closeEnough=(actual,reference,message)=>assert.ok(Math.abs(actual-reference)<.6,`${message}: ${actual}px versus Categories ${reference}px`)
;(async()=>{
  let cases=0
  for(const engine of [chromium,webkit]) {
    const browser=await engine.launch({headless:true})
    try {
      for(const width of (measureOnly?[390]:[320,390,768,1280])) for(const dark of [false,true]) {
        const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,isMobile:width<768,reducedMotion:dark?'reduce':'no-preference'})
        const errors=[],writes=[]
        page.on('pageerror',e=>errors.push(e.message))
        await page.addInitScript(()=>{delete window.PushManager})
        await page.route('**/*',async route=>{
          const request=route.request(),url=new URL(request.url()),name=url.pathname
          if(url.origin!=='https://bookie.test'){await route.abort();return}
          if(request.method()!=='GET'){writes.push(name);await route.abort();return}
          let value
          if(name==='/app/expenses'){await route.fulfill({contentType:'text/html',body:html(dark)});return}
          if(name==='/app/expenses/data')value=dark?investedReport:report
          else if(name==='/app/expenses/months')value={currentMonth:'2026-09',months:[{value:'2026-09',label:'September 2026'}],coverage:{status:'complete',unavailableYears:[]}}
          else if(name==='/app/goals')value={goals}
          else if(name==='/app/reconciliation')value={enabled:true,checkedAt:'2026-10-29T07:00:00Z',items:[]}
          else if(name==='/app/reimbursements')value={enabled:true,ownerKey:'brian',currency:'USD',allocations:[],events:[],resets:[],resetState:'fixture'}
          else if(name==='/app/widgets/settings')value={connections:[],scriptUrl:'/app/widgets/script',setupInstructionsUrl:'/app/widgets/help'}
          else if(name==='/app/notifications')value={enabled:false,publicKey:'B'+'A'.repeat(86),preferences:{weekly:true,upcoming:false,showAmounts:false,hour:10}}
          else if(name==='/app/version')value={version:'fixture-version'}
          else if(name.includes('avatar')){await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG8kAAAAASUVORK5CYII=','base64')});return}
          else {await route.fulfill({status:404,json:{error:'Unknown fixture endpoint'}});return}
          await route.fulfill({json:value})
        })
        await page.goto('https://bookie.test/app/expenses')
        await page.locator('.bb-highlights-section').waitFor()
        await page.getByRole('button',{name:'Show Burn Rate',exact:true}).click()
        await page.waitForTimeout(350)
        const reference=await gap(page,'.bb-chart-carousel-band','#bb-chart-burn-rate .bb-burn-month-panel')
        const measured={engine:engine.name(),width,dark,balance:reference,daily:await gap(page,'.bb-daily-section',dailyButton),largest:await gap(page,'.bb-highlights-section',insightButton)}
        if(!measureOnly) {
          closeEnough(reference,Math.min(32,Math.max(16,width*.03))+2,'Keep the approved Categories spacing')
          closeEnough(measured.daily,reference,'Daily Transactions footer')
          closeEnough(measured.largest,reference,'Largest View all footer, including the final section')
          await page.locator(insightButton).click();await page.waitForTimeout(350)
          closeEnough(await gap(page,'.bb-highlights-section',insightButton),reference,'Expanded largest footer')
          await page.locator(insightButton).click();await page.waitForTimeout(350)
          closeEnough(await gap(page,'.bb-highlights-section',insightButton),reference,'Recollapsed largest footer')
          await page.getByRole('tab',{name:'Most Frequent',exact:true}).click()
          await page.waitForTimeout(350)
          closeEnough(await gap(page,'.bb-highlights-section',insightButton),reference,'Most Frequent View all footer')
          await page.locator(insightButton).click();await page.waitForTimeout(350)
          closeEnough(await gap(page,'.bb-highlights-section',insightButton),reference,'Expanded Most Frequent footer')
          await page.locator(dailyButton).click();await page.waitForTimeout(350)
          assert.equal(await page.locator('.bb-daily-transactions tbody tr').count(),12,'Transactions still reveals the full list')
          closeEnough(await gap(page,'.bb-daily-section','.bb-daily-transactions'),reference,'Expanded daily content bottom')
          await page.locator(dailyButton).click();await page.waitForTimeout(350)
          closeEnough(await gap(page,'.bb-daily-section',dailyButton),reference,'Recollapsed Transactions footer')
          for(const [title,id] of [['Burn Rate','burn-rate'],['Calendar','calendar'],['Bills & Utilities','bills']]) {
            await page.getByRole('button',{name:`Show ${title}`,exact:true}).click();await page.waitForTimeout(350)
            const control=id==='burn-rate'?'#bb-chart-burn-rate .bb-burn-month-panel':`#bb-chart-${id} .bb-chart-page-footer .bb-details-toggle`
            closeEnough(await gap(page,'.bb-chart-carousel-band',control),reference,`${title} Details footer`)
            if(id==='bills') {
              await page.locator(control).click();await page.waitForTimeout(350)
              assert.equal(await page.locator(control).getAttribute('aria-expanded'),'true')
              await page.locator(control).click();await page.waitForTimeout(350)
              closeEnough(await gap(page,'.bb-chart-carousel-band',control),reference,`${title} recollapsed footer`)
            }
          }
          await page.getByRole('button',{name:'Show Category Mix',exact:true}).click();await page.waitForTimeout(350)
          assert.equal(await page.getByRole('button',{name:'Categories',exact:true}).count(),0,'Category inspection now lives on slices and callouts')
          const reserved=await page.locator('.bb-category-mix-page').evaluate(el=>getComputedStyle(el).gridTemplateRows.split(' ').at(-1))
          assert.equal(reserved,'42px','Category Mix retains its approved former-footer space')
          if(width===390&&dark)await page.screenshot({path:`/tmp/bookiebot-overview-spacing-${engine.name()}.png`,fullPage:true})
        }
        await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Savings',exact:true}).click()
        await page.getByRole('button',{name:'Archived goals (2)',exact:true}).waitFor()
        measured.archived=await gap(page,'.bb-goals-section','.bb-goals-history-toggle')
        if(measureOnly)console.log(JSON.stringify(measured))
        else {
          closeEnough(measured.archived,reference,'Archived goals footer')
          await page.locator('.bb-goals-history-toggle').click();await page.waitForTimeout(350)
          assert.equal(await page.locator('.bb-goals-archived .bb-goal').count(),2)
          closeEnough(await gap(page,'.bb-goals-section','.bb-goals-archived'),reference,'Expanded archived content bottom')
          await page.locator('.bb-goals-history-toggle').click();await page.waitForTimeout(350)
          closeEnough(await gap(page,'.bb-goals-section','.bb-goals-history-toggle'),reference,'Recollapsed archived footer')
          await page.locator('.bb-goals-section .bb-report-menu-trigger').nth(1).click()
          await page.locator('.bb-goals-section .bb-report-menu-panel[data-open="true"]').waitFor()
          assert.equal(await page.locator('.bb-investments-section').count(),Number(dark),'Cover Savings both as the last section and before Investments')
          await page.keyboard.press('Escape')
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No horizontal overflow')
          assert.deepEqual(errors,[]);assert.deepEqual(writes,[])
          if(width===390&&dark){await page.waitForTimeout(350);await page.screenshot({path:`/tmp/bookiebot-section-spacing-${engine.name()}.png`,fullPage:true})}
        }
        cases++;await page.close()
      }
    } finally {await browser.close()}
  }
  console.log(measureOnly?`${cases} Chromium/WebKit baseline measurements recorded`:`${cases} Chromium/WebKit section spacing cases passed; all APIs isolated`)
})().catch(error=>{console.error(error);process.exitCode=1})
