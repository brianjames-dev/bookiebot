// Run after npm run build. Full phone shell, real CSP/worker, synthetic budgets.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const report=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import json
from unit_tests.reports.test_income_projection import build,income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','5000'))))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
Object.assign(report,{year:2026,month:11,monthLabel:'November'})
const values=[['rent','Rent',2100],['bills_utilities','Bills & Utilities',240],['static_bills_subscriptions_needs','Subscriptions (Needs)',176],['need_expenses','Need transactions',465],['grocery','Grocery',25],['gas','Gas',10],['food','Food',13],['shopping','Shopping',13],['subscriptions_wants','Subscriptions (Wants)',34]]
for(const [mode,view] of Object.entries(report.modeViews)) {
  const current=mode==='current',needs=3016,wants=60,income=current?0:6874
  view.breakdown=values.map(([key,label,amount])=>({key,label,amount,percentage:0,color:'green'}))
  Object.assign(view.metrics,{monthlyIncome:income,totalExpenses:needs+wants,amountSaved:0,incomeAfterExpenses:income-needs-wants})
  view.categoryBudgets={needs:income*.5,wants:income*.3,savings:income*.2}
  const remaining={needs:income*.5-needs,wants:income*.3-wants,savings:income*.2}
  view.categoryBalances={raw:remaining,remaining,deficits:{needs:current?needs:0,wants:current?wants:0,savings:0},transfers:[],totalOverspend:current?needs+wants:0}
  if(view.savingsInvesting)Object.assign(view.savingsInvesting,{cashSaved:0,esppContribution:0,estimatedEsppContribution:0,combinedContributions:0})
}
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
const csp=fs.readFileSync(path.join(root,'src/bookiebot/reports/phone_app.py'),'utf8').match(/"Content-Security-Policy": "([^"]+)"/)[1]
const html=dark=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName:'Brian',reportUrl:'/app/expenses/data',logoutUrl:'/app/logout'})}</script><script type="module" src="/app/assets/expense-report-app.js"></script></body></html>`
async function checkGeometry(category,expected) {
  const state=await category.evaluate(el=>{
    const svg=el.querySelector('.bb-contour-callouts'),labels=[...svg.querySelectorAll('.bb-contour-label')],paths=[...svg.querySelectorAll('.bb-contour-stem')]
    const boxes=labels.map(label=>({id:label.dataset.category,box:label.querySelector('rect').getBBox()})),samples=[],cells=new Map()
    let intrusion=false,minSeparation=Infinity,overlap=false
    for(let i=0;i<boxes.length;i++)for(const {box:b} of boxes.slice(i+1)){const a=boxes[i].box;if(a.x<b.x+b.width+5&&a.x+a.width>b.x-5&&a.y<b.y+b.height+5&&a.y+a.height>b.y-5)overlap=true}
    for(const path of paths)for(let at=0;at<path.getTotalLength();at+=.65){
      const p=path.getPointAtLength(at),id=path.dataset.category;samples.push({id,x:p.x,y:p.y})
      for(const box of boxes){if(box.id===id)continue;const b=box.box,r=Math.min(18,b.height/2),qx=Math.abs(p.x-b.x-b.width/2)-b.width/2+r,qy=Math.abs(p.y-b.y-b.height/2)-b.height/2+r;if(Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r<.8)intrusion=true}
    }
    for(const p of samples){const x=Math.floor(p.x/4),y=Math.floor(p.y/4);for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of cells.get(`${x+dx},${y+dy}`)||[])if(q.id!==p.id)minSeparation=Math.min(minSeparation,Math.hypot(q.x-p.x,q.y-p.y));const key=`${x},${y}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(p)}
    const host=el.querySelector('.bb-category-pie-host').getBoundingClientRect()
    return {labels:labels.length,paths:paths.length,visible:labels.every(n=>+getComputedStyle(n).opacity>.99),parentOpacity:getComputedStyle(svg).opacity,overlap,intrusion,minSeparation,fits:boxes.every(({box:b})=>b.x>=0&&b.y>=0&&b.x+b.width<=host.width+.1&&b.y+b.height<=host.height+.1)}
  })
  assert.equal(state.labels,expected,JSON.stringify(state));assert.equal(state.paths,expected,JSON.stringify(state))
  assert.equal(state.visible,true,JSON.stringify(state));assert.equal(state.fits,true,JSON.stringify(state))
  assert.equal(state.overlap,false,JSON.stringify(state));assert.equal(state.intrusion,false,JSON.stringify(state))
  assert.ok(state.minSeparation>=1.4,JSON.stringify(state))
  if(expected)assert.equal(state.parentOpacity,'1')
}
;(async()=>{
  let count=0
  for(const engine of [chromium,webkit]) {
    const browser=await engine.launch({headless:true})
    try {for(const dark of [false,true]) {
      const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:3,hasTouch:true,isMobile:true,reducedMotion:dark?'reduce':'no-preference'}),errors=[],unexpected=[],workerErrors=[]
      page.on('pageerror',e=>errors.push(e.message))
      await page.addInitScript(dark=>{delete window.PushManager;localStorage.setItem('bookiebot-expense-report-theme',dark?'dark':'light');window.__workerErrors=[];const Native=Worker;window.Worker=class extends Native{constructor(...args){super(...args);this.addEventListener('error',e=>window.__workerErrors.push(e.message))}}},dark)
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url()),name=url.pathname.split('/').pop()
        if(url.pathname==='/app/expenses')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':csp},body:html(dark)})
        if(name==='expense-report-app.js'||/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,name),'utf8')})
        const fixtures={'/app/expenses/data':report,'/app/reconciliation':{enabled:false,items:[]},'/app/reimbursements':{enabled:true,ownerKey:'brian',currency:'USD',allocations:[],events:[],resets:[],resetState:'fixture'},'/app/goals':{goals:[]},'/app/transactions':{items:[],total:0,nextOffset:null,categories:[],persons:[],month:'2026-11'},'/app/widgets/settings':{connections:[]},'/app/notifications':{enabled:false},'/app/expenses/months':{currentMonth:'2026-11',months:[{value:'2026-11',label:'November 2026'}],coverage:{status:'complete',unavailableYears:[]}},'/app/version':{version:'fixture-version'}}
        if(fixtures[url.pathname])return route.fulfill({json:fixtures[url.pathname]})
        if(name==='avatar.png')return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG8kAAAAASUVORK5CYII=','base64')})
        unexpected.push({path:url.pathname,method:route.request().method()});return route.abort()
      })
      await page.goto('https://bookie.test/app/expenses')
      const category=page.locator('#bb-chart-category')
      await page.getByRole('button',{name:'Show Category Mix',exact:true}).click()
      // Open before the worker finishes, rather than waiting for labels first.
      await category.getByRole('button',{name:'Show category callouts',exact:true}).click()
      for(const [index,mode] of ['Current','Projected'].entries()) {
        await page.getByRole('button',{name:mode,exact:true}).click()
        for(const [filter,n] of [['all',9],['needs',6],['wants',3],['savings',0]]) {
          await category.getByRole('combobox',{name:'Category mix filter',exact:true}).selectOption(filter)
          await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor({timeout:60000})
          await page.waitForTimeout(dark?30:750)
          await checkGeometry(category,n+index)
          count++
          if(filter==='all')await category.screenshot({path:`/private/tmp/category-sparse-${engine.name()}-${mode}-${dark?'dark':'light'}.png`})
        }
      }
      // Cached filter return, repeated close/reopen and retained app navigation.
      await category.getByRole('combobox',{name:'Category mix filter',exact:true}).selectOption('all')
      await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor()
      for(let i=0;i<2;i++) {
        await category.getByRole('button',{name:'Hide category callouts',exact:true}).click()
        await page.waitForTimeout(dark?30:800)
        await category.getByRole('button',{name:'Show category callouts',exact:true}).click()
        await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor()
        await page.waitForTimeout(dark?30:750);await checkGeometry(category,10)
      }
      await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Transactions',exact:true}).click()
      await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Overview',exact:true}).click()
      await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor()
      await page.waitForTimeout(dark?30:750);await checkGeometry(category,10)
      workerErrors.push(...await page.evaluate(()=>window.__workerErrors))
      assert.deepEqual(errors,[]);assert.deepEqual(workerErrors,[]);assert.deepEqual(unexpected,[])
      console.log(engine.name(),dark?'dark':'light','all Current/Projected scopes and repeated reveals passed')
      await page.close()
    }}finally{await browser.close()}
  }
  console.log(`${count} November-like full-shell callout cases passed at iPhone 13 Pro size`)
})().catch(error=>{console.error(error);process.exitCode=1})
