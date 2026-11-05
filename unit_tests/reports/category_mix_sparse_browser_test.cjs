// Run after npm run build. Full phone shell, real CSP/worker, synthetic budgets
// or a private read-only category fixture. Measure cold work, not just cache hits.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
let report=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import json
from unit_tests.reports.test_income_projection import build,income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','5000'))))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
const externalFixture=process.env.BOOKIEBOT_CATEGORY_REPORT_FIXTURE
if(externalFixture)report=JSON.parse(fs.readFileSync(externalFixture,'utf8'))
else {
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
}
const monthKey=`${report.year}-${String(report.month).padStart(2,'0')}`
const snapshotPrefix=path.basename(process.env.BOOKIEBOT_CATEGORY_SNAPSHOT_PREFIX||'category-sparse')
const slowdown=Number(process.env.BOOKIEBOT_CATEGORY_CPU_SLOWDOWN||1)
async function measureReadiness(control,event) {
  await control.evaluate((el,event)=>el.addEventListener(event,()=>{
    window.__categoryActionAt=performance.now();window.__categoryReadyAt=undefined
    window.__categoryReadyObserver?.disconnect()
    const host=document.querySelector('#bb-chart-category'),observer=new MutationObserver(()=>{
      if(host.querySelector('.bb-contour-callouts[data-ready="true"]')){
        window.__categoryReadyAt=performance.now();observer.disconnect()
      }
    })
    window.__categoryReadyObserver=observer
    observer.observe(host,{subtree:true,attributes:true,childList:true})
  },{once:true}),event)
}
function expectedCount(view,filter) {
  const needs=['rent','bills_utilities','static_bills_subscriptions_needs','need_expenses','grocery','gas'],wants=['food','shopping','subscriptions_wants']
  let count=view.breakdown.filter(item=>item.amount>0&&(filter==='all'?item.key!=='savings':filter==='needs'?needs.includes(item.key):filter==='wants'?wants.includes(item.key):false)).length
  if(filter==='all'||filter==='savings')count+=Number((view.savingsInvesting?.cashSaved??view.metrics.amountSaved)>0)+Number((view.savingsInvesting?.esppContribution??0)>0)
  if(filter!=='all')count+=view.categoryBalances.transfers.filter(t=>t.from===filter&&t.amount>0).length
  const remaining=filter==='all'?Object.values(view.categoryBalances.remaining).reduce((sum,n)=>sum+n,0):view.categoryBalances.remaining[filter]
  return count+Number(remaining>0)
}
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
const csp=fs.readFileSync(path.join(root,'src/bookiebot/reports/phone_app.py'),'utf8').match(/"Content-Security-Policy": "([^"]+)"/)[1]
const html=dark=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName:'Brian',reportUrl:'/app/expenses/data',logoutUrl:'/app/logout'})}</script><script type="module" src="/app/assets/expense-report-app.js"></script></body></html>`
async function checkGeometry(category,expected,checkPlacement=false,breakdown=[]) {
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
    const left=boxes.find(b=>b.id==='left'),leftPath=paths.find(p=>p.dataset.category==='left'),center=el.querySelector('.bb-category-pie-center').getBoundingClientRect()
    return {labels:labels.length,paths:paths.length,amounts:Object.fromEntries(labels.map(n=>[n.dataset.category,n.querySelector('.bb-contour-amount tspan').textContent])),visible:labels.every(n=>+getComputedStyle(n).opacity>.99),parentOpacity:getComputedStyle(svg).opacity,overlap,intrusion,minSeparation,fits:boxes.every(({box:b})=>b.x>=0&&b.y>=0&&b.x+b.width<=host.width+.1&&b.y+b.height<=host.height+.1),left:left?{x:left.box.x+left.box.width/2,y:left.box.y+left.box.height/2,length:leftPath.getTotalLength()}:null,foodLength:paths.find(p=>p.dataset.category==='food')?.getTotalLength(),center:{x:host.width/2,y:center.y+center.height/2-host.y}}
  })
  assert.equal(state.labels,expected,JSON.stringify(state));assert.equal(state.paths,expected,JSON.stringify(state))
  assert.equal(state.visible,true,JSON.stringify(state));assert.equal(state.fits,true,JSON.stringify(state))
  assert.equal(state.overlap,false,JSON.stringify(state));assert.equal(state.intrusion,false,JSON.stringify(state))
  assert.ok(state.minSeparation>=1.4,JSON.stringify(state))
  if(expected)assert.equal(state.parentOpacity,'1')
  const dollars=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})
  for(const item of breakdown)if(Object.hasOwn(state.amounts,item.key))assert.equal(state.amounts[item.key],dollars.format(item.amount),'Rendered category amounts retain the source totals')
  if(checkPlacement){assert.ok(state.left.x<state.center.x&&state.left.y<state.center.y,'The broad left slice can use the upper-left free space');assert.ok(state.left.length>=18&&state.left.length<65,'Income left uses a visible short stem instead of a long detour');assert.ok(state.foodLength<55,'Readability scoring must not replace a short clear stem with a distant card')}
}
;(async()=>{
  let count=0
  for(const engine of [chromium,webkit]) {
    const browser=await engine.launch({headless:true})
    try {for(const dark of [false,true]) {
      const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:3,hasTouch:true,isMobile:true,reducedMotion:dark?'reduce':'no-preference'}),errors=[],unexpected=[],workerErrors=[],readiness=[]
      if(engine===chromium&&slowdown>1){const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:slowdown})}
      page.on('pageerror',e=>errors.push(e.message))
      await page.addInitScript(dark=>{delete window.PushManager;localStorage.setItem('bookiebot-expense-report-theme',dark?'dark':'light');window.__workerErrors=[];window.__categoryLayouts=[];const Native=Worker;window.Worker=class extends Native{
        constructor(...args){super(...args);this.addEventListener('error',e=>window.__workerErrors.push(e.message));this.addEventListener('message',e=>{if(this.timing){this.timing.ms=performance.now()-this.timing.started;this.timing.complete=Boolean(e.data.scene?.routes)&&!e.data.scene.curvedRoutes?.some(r=>r.smoothing==='unresolved')}})}
        postMessage(scene){this.timing={started:performance.now(),items:scene.items.length};window.__categoryLayouts.push(this.timing);super.postMessage(scene)}
      }},dark)
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url()),name=url.pathname.split('/').pop()
        if(url.pathname==='/app/expenses')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':csp},body:html(dark)})
        if(name==='expense-report-app.js'||/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,name),'utf8')})
        const fixtures={'/app/expenses/data':report,'/app/reconciliation':{enabled:false,items:[]},'/app/reimbursements':{enabled:true,ownerKey:'brian',currency:'USD',allocations:[],events:[],resets:[],resetState:'fixture'},'/app/goals':{goals:[]},'/app/transactions':{items:[],total:0,nextOffset:null,categories:[],persons:[],month:monthKey},'/app/widgets/settings':{connections:[]},'/app/notifications':{enabled:false},'/app/expenses/months':{currentMonth:monthKey,months:[{value:monthKey,label:`${report.monthLabel} ${report.year}`}],coverage:{status:'complete',unavailableYears:[]}},'/app/version':{version:'fixture-version'}}
        if(fixtures[url.pathname])return route.fulfill({json:fixtures[url.pathname]})
        if(name==='avatar.png')return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG8kAAAAASUVORK5CYII=','base64')})
        unexpected.push({path:url.pathname,method:route.request().method()});return route.abort()
      })
      await page.goto('https://bookie.test/app/expenses')
      const category=page.locator('#bb-chart-category')
      await page.getByRole('button',{name:'Show Category Mix',exact:true}).click()
      // Open before the worker finishes, rather than waiting for labels first.
      await measureReadiness(category.getByRole('button',{name:'Show category callouts',exact:true}),'click')
      await category.getByRole('button',{name:'Show category callouts',exact:true}).click()
      for(const [index,mode] of ['Current','Projected'].entries()) {
        if(index)await measureReadiness(page.getByRole('button',{name:mode,exact:true}),'click')
        await page.getByRole('button',{name:mode,exact:true}).click()
        for(const filter of ['all','needs','wants','savings']) {
          if(filter!=='all')await measureReadiness(category.getByRole('combobox',{name:'Category mix filter',exact:true}),'change')
          await category.getByRole('combobox',{name:'Category mix filter',exact:true}).selectOption(filter)
          try{await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor({timeout:8000})}
          catch(error){console.error(engine.name(),dark?'dark':'light',mode,filter,await page.evaluate(()=>window.__categoryLayouts));throw error}
          // Observe the actual ready mutation; Playwright's selector polling
          // can add hundreds of milliseconds after the frame already rendered.
          const wait=await page.evaluate(()=>window.__categoryReadyAt-window.__categoryActionAt);readiness.push(wait)
          assert.ok(wait<(engine===chromium&&slowdown>1?3000:1500),`First reveal/mode/filter handoff must be timely (${mode}/${filter}: ${wait}ms)`)
          await page.waitForTimeout(dark?30:750)
          await checkGeometry(category,expectedCount(report.modeViews[mode.toLowerCase()],filter),!externalFixture&&index===1&&filter==='all',report.modeViews[mode.toLowerCase()].breakdown)
          count++
          if(filter==='all'){
            await page.evaluate(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}))
            await page.waitForTimeout(500)
            await category.screenshot({path:`/private/tmp/${snapshotPrefix}-${engine.name()}-${mode}-${dark?'dark':'light'}.png`})
          }
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
        await page.waitForTimeout(dark?30:750);await checkGeometry(category,expectedCount(report.modeViews.projected,'all'))
      }
      await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Transactions',exact:true}).click()
      await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Overview',exact:true}).click()
      await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor()
      await page.waitForTimeout(dark?30:750);await checkGeometry(category,expectedCount(report.modeViews.projected,'all'))
      workerErrors.push(...await page.evaluate(()=>window.__workerErrors))
      assert.deepEqual(errors,[]);assert.deepEqual(workerErrors,[]);assert.deepEqual(unexpected,[])
      const timings=await page.evaluate(()=>window.__categoryLayouts.filter(t=>t.ms!==undefined))
      assert.ok(timings.length>=2,'Exercise cold worker calculations as well as cached returns')
      for(const timing of timings){assert.equal(timing.complete,true,'Every completed worker returns a usable layout');assert.ok(timing.ms<(engine===chromium&&slowdown>1?3000:1500),`Cold layout must not delay the reveal for seconds: ${JSON.stringify(timing)}`)}
      console.log(engine.name(),dark?'dark':'light','all Current/Projected scopes and repeated reveals passed; maximum cold layout',Math.round(Math.max(...timings.map(t=>t.ms))),'ms; maximum reveal wait',Math.max(...readiness),'ms',engine===chromium?`CPU ${slowdown}x`:'')
      await page.close()
    }}finally{await browser.close()}
  }
  console.log(`${count} ${externalFixture?report.monthLabel:'November-like'} full-shell callout cases passed at iPhone 13 Pro size`)
})().catch(error=>{console.error(error);process.exitCode=1})
