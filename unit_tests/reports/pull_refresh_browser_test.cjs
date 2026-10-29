// Run after npm run build; all API traffic is fulfilled from isolated fixtures.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process')
const {createRequire} = require('node:module')
const root = path.resolve(__dirname,'../..'), frontend = path.join(root,'web/expense-report')
const req = createRequire(path.join(frontend,'package.json'))
const {chromium,webkit} = process.env.BOOKIEBOT_PLAYWRIGHT_MODULE ? require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE) : req('playwright')
const report = JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON || 'python', ['-c', `
import json
from unit_tests.reports.test_income_projection import build, income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','5000'))))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
const css=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.css'),'utf8')
const js=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.js'),'utf8')
const html=dark=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName:'Brian',reportUrl:'/app/expenses/data',logoutUrl:'/app/logout'})}</script><script>localStorage.setItem('bookiebot-expense-report-theme','${dark?'dark':'light'}')</script><script type="module">${js}</script></body></html>`
const screens={Overview:'/app/expenses/data',Transactions:'/app/transactions',Shared:'/app/reimbursements',Savings:'/app/goals',Reconcile:'/app/reconciliation',Settings:'/app/widgets/settings'}
async function gesture(page,end=245,{start=80,x=16,cancel=false}={}) {
  await page.evaluate(({start,end,x,cancel})=>{
    const target=document.querySelector('.bb-shell-masthead')
    const touch=y=>({identifier:71,target,clientX:x,clientY:y,pageX:x,pageY:y})
    const fire=(type,y)=>{
      const event=new Event(type,{bubbles:true,cancelable:true})
      Object.defineProperties(event,{touches:{value:type==='touchend'||type==='touchcancel'?[]:[touch(y)]},changedTouches:{value:[touch(y)]}})
      return target.dispatchEvent(event)
    }
    fire('touchstart',start);fire('touchmove',end);fire(cancel?'touchcancel':'touchend',end)
  },{start,end,x,cancel})
}
async function waitReady(page,label) {
  await page.waitForFunction(label=>document.querySelector(`button[aria-label="Refresh ${label}"]`)?.disabled===false,label)
}
;(async()=>{
  let cases=0
  for(const engine of [chromium,webkit]) {
    const browser=await engine.launch({headless:true})
    try {
      for(const width of [320,390]) for(const dark of [false,true]) {
        const page=await browser.newPage({viewport:{width,height:780},hasTouch:true,isMobile:true,reducedMotion:dark?'reduce':'no-preference'})
        // Push permission/service-worker setup has its own tests. This fixture
        // verifies settings reads and unsaved preferences without enabling push.
        await page.addInitScript(()=>{delete window.PushManager})
        const requests=[],errors=[];let failedCheck=false,reportNumber=0
        page.on('pageerror',error=>errors.push(error.message))
        await page.route('**/*',async route=>{
          const request=route.request(),url=new URL(request.url()),name=url.pathname,body=request.postDataJSON()
          if(url.origin!=='https://bookie.test'){await route.abort();return}
          if(name==='/app/expenses'){await route.fulfill({contentType:'text/html',body:html(dark)});return}
          requests.push({name,method:request.method(),query:url.search,body})
          await new Promise(resolve=>setTimeout(resolve,90))
          let value
          if(name==='/app/expenses/data')value={...report,generatedAt:new Date(Date.now()+ ++reportNumber*1000).toISOString()}
          else if(name==='/app/reconciliation') {
            if(body?.operation==='check'&&failedCheck){failedCheck=false;await route.fulfill({status:500,json:{error:'Fixture offline'}});return}
            value={enabled:true,checkedAt:'2026-10-29T07:00:00Z',items:[]}
          } else if(name==='/app/reimbursements') value={enabled:true,ownerKey:'brian',currency:'USD',allocations:[],events:[],resets:[],resetState:'fixture'}
          else if(name==='/app/goals') value={goals:[]}
          else if(name==='/app/transactions')value={items:[],total:0,nextOffset:null,categories:[],persons:[],month:'2026-09'}
          else if(name==='/app/widgets/settings')value={connections:[],scriptUrl:'/app/widgets/script',setupInstructionsUrl:'/app/widgets/help'}
          else if(name==='/app/notifications')value={enabled:false,publicKey:'B'+'A'.repeat(86),preferences:{weekly:true,upcoming:false,showAmounts:false,hour:10}}
          else if(name==='/app/expenses/months')value={currentMonth:'2026-09',months:[{value:'2026-09',label:'September 2026'}],coverage:{status:'complete',unavailableYears:[]}}
          else if(name==='/app/version')value={version:'fixture-version'}
          else if(name.includes('avatar')){await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG8kAAAAASUVORK5CYII=','base64')});return}
          else {await route.fulfill({status:404,json:{error:'Unknown fixture endpoint'}});return}
          await route.fulfill({json:value})
        })
        await page.goto('https://bookie.test/app/expenses')
        await page.locator('.bb-app-shell').waitFor();await waitReady(page,'Overview')
        for(const [label,path] of Object.entries(screens)) {
          await (label==='Settings' ? page.getByRole('button',{name:label,exact:true}) : page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:label,exact:true})).click()
          await page.evaluate(()=>window.scrollTo(0,0));await waitReady(page,label)
          if(label==='Transactions') {await page.getByRole('searchbox',{name:'Search transactions'}).fill('coffee');await page.waitForTimeout(400);await waitReady(page,label)}
          if(label==='Savings') {await page.getByRole('button',{name:'＋ Goal',exact:true}).click();await page.getByLabel('Goal name',{exact:true}).fill('Keep this draft');await page.getByLabel('Goal name',{exact:true}).blur();await page.evaluate(()=>window.scrollTo(0,0))}
          if(label==='Settings') {await page.getByLabel('Notification delivery time').selectOption('15');await page.evaluate(()=>window.scrollTo(0,0))}
          const before=requests.filter(r=>r.name===path).length
          const reportBefore=requests.filter(r=>r.name==='/app/expenses/data').length
          const notificationsBefore=requests.filter(r=>r.name==='/app/notifications').length
          await gesture(page,150);await page.waitForTimeout(120)
          assert.equal(requests.filter(r=>r.name===path).length,before,'Short pull must not request data')
          await gesture(page)
          await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='done')
          assert.equal(requests.filter(r=>r.name===path).length,before+1,`${label} refreshes the active data once`)
          if(label==='Transactions') {
            const last=requests.filter(r=>r.name===path).at(-1)
            assert.match(last.query,/fresh=1/);assert.match(last.query,/search=coffee/)
            assert.equal(await page.getByRole('searchbox',{name:'Search transactions'}).inputValue(),'coffee')
          }
          if(label==='Savings') {
            assert.equal(requests.filter(r=>r.name==='/app/expenses/data').length,reportBefore+1,'Savings also reloads investment report data exactly once')
            assert.equal(await page.getByLabel('Goal name',{exact:true}).inputValue(),'Keep this draft')
          }
          if(label==='Settings') {
            assert.equal(requests.filter(r=>r.name==='/app/notifications').length,notificationsBefore+1,'Settings waits for notifications and widgets')
            assert.equal(await page.getByLabel('Notification delivery time').inputValue(),'15','Refresh retains unsaved notification preferences')
          }
          if(label==='Reconcile')assert.equal(requests.filter(r=>r.name===path).at(-1).body?.operation,'check')
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
          cases++
        }
        await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Reconcile',exact:true}).click();await page.evaluate(()=>window.scrollTo(0,0));await waitReady(page,'Reconcile')
        failedCheck=true;await gesture(page)
        await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='error')
        await waitReady(page,'Reconcile');await gesture(page)
        await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='done')
        assert.equal(requests.filter(r=>r.name==='/app/reconciliation').at(-1).method,'GET','Uncertain checks refresh status without repeating the bank command')
        // Real browser touch input validates native capture and prevention too.
        if(engine===chromium&&width===390&&!dark) {
          const cdp=await page.context().newCDPSession(page),before=requests.filter(r=>r.name==='/app/reconciliation').length
          await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:16,y:78}]})
          for(const y of [100,135,175,220,260])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:16,y}]})
          assert.equal(await page.locator('.bb-pull-refresh').getAttribute('data-phase'),'armed')
          assert.ok(await page.evaluate(()=>document.querySelector('#bb-reconcile-title').getBoundingClientRect().top>document.querySelector('.bb-pull-refresh').getBoundingClientRect().bottom),'The pull indicator must not cover the heading')
          await page.screenshot({path:'/tmp/bookiebot-pull-refresh-armed.png'})
          await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
          await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='done')
          assert.equal(requests.filter(r=>r.name==='/app/reconciliation').length,before+1)
          assert.equal(await page.evaluate(()=>scrollY),0,'The gesture must not reload/navigate or scroll the document')
        }
        assert.deepEqual(errors,[])
        assert.ok(requests.filter(r=>r.method==='POST').every(r=>r.name==='/app/reconciliation'&&r.body?.operation==='check'),'No financial mutation or notification POSTs')
        await page.close()
      }
    } finally {await browser.close()}
  }
  console.log(`${cases} full-app Chromium/WebKit page refresh cases passed, plus status recovery/native touch/draft preservation; all APIs isolated`)
})().catch(error=>{console.error(error);process.exitCode=1})
