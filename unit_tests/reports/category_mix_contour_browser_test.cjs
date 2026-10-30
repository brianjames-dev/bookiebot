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
const css=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.js'),'utf8')
const html=(report,dark)=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-report-data" type="application/json">${JSON.stringify(report)}</script><script type="module" src="/app/assets/expense-report-app.js"></script></body></html>`
const csp=fs.readFileSync(path.join(root,"src/bookiebot/reports/phone_app.py"),"utf8").match(/"Content-Security-Policy": "([^"]+)"/)[1]
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value)

const report=JSON.parse(JSON.stringify(enrolled))
const values=[['rent','Rent',2500],['bills_utilities','Bills & Utilities',380],['static_bills_subscriptions_needs','Subscriptions (Needs)',180],['need_expenses','Need transactions',650],['grocery','Grocery',680],['gas','Gas',250],['food','Food',1329.32],['shopping','Shopping',540],['subscriptions_wants','Subscriptions (Wants)',160]]
for(const view of Object.values(report.modeViews)) {
 view.breakdown=values.map(([key,label,amount])=>({key,label,amount,percentage:0,color:'green'}))
 Object.assign(view.metrics,{monthlyIncome:9983.08,totalExpenses:6669.32,amountSaved:1996.62,incomeAfterExpenses:1317.14})
 view.categoryBudgets={needs:4991.54,wants:2994.92,savings:1596.62}
 view.categoryBalances={raw:{needs:351.54,wants:965.6,savings:0},remaining:{needs:351.54,wants:965.6,savings:0},deficits:{needs:0,wants:0,savings:0},transfers:[],totalOverspend:0}
 Object.assign(view.savingsInvesting,{cashSaved:1596.62,esppContribution:400,estimatedEsppContribution:0,combinedContributions:1996.62})
}
;(async()=>{
 let count=0
 for(const engine of [chromium,webkit]) {
  const browser=await engine.launch({headless:true})
  try {
   for(const width of ((process.env.BOOKIEBOT_CONTOUR_PREVIEW||process.env.BOOKIEBOT_CONTOUR_FINAL)?[390]:[320,390,1280]))for(const dark of (process.env.BOOKIEBOT_CONTOUR_PREVIEW?[true]:[false,true])) {
    const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,colorScheme:dark?'dark':'light',reducedMotion:dark?'reduce':'no-preference'}),errors=[],unexpected=[]
    page.on('pageerror',error=>errors.push(error.message))
    await page.route('**/*',async route=>{
     const url=new URL(route.request().url()),name=url.pathname.split('/').pop()
     if(url.pathname==='/report')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':csp},body:html(report,dark)})
     if(name==='expense-report-app.js')return route.fulfill({contentType:'application/javascript',body:js})
     if(/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,'src/bookiebot/reports/assets',name),'utf8')})
     unexpected.push(url.pathname);await route.abort()
    })
    const start=Date.now();await page.goto('https://bookie.test/report')
    const category=page.locator('#bb-chart-category')
    await page.getByRole('button',{name:'Show Category Mix',exact:true}).click()
    await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor({timeout:120000})
    console.log(engine.name(),width,dark?'dark':'light','first-layout-ms',Date.now()-start)
    const originalHeight=(await page.locator('.bb-chart-carousel-band').boundingBox()).height
    for(const filter of (process.env.BOOKIEBOT_CONTOUR_PREVIEW?['all']:['all','needs','wants','savings'])) {
     await category.getByRole('combobox',{name:'Category mix filter',exact:true}).selectOption(filter)
     if(!dark&&filter!=='all')assert.equal(await category.locator('.bb-contour-callouts').getAttribute('data-ready'),'false','Final callouts stay hidden while sectors morph')
     await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor({timeout:120000})
     await page.waitForTimeout(dark?50:700)
     const geometry=await category.evaluate(el=>{
      const svg=el.querySelector('.bb-contour-callouts'),host=el.querySelector('.bb-category-pie-host').getBoundingClientRect(),center=el.querySelector('.bb-category-pie-center').getBoundingClientRect(),labels=[...svg.querySelectorAll('.bb-contour-label')],paths=[...svg.querySelectorAll('.bb-contour-stem')]
      const boxes=labels.map(label=>({id:label.dataset.category,box:label.querySelector('rect').getBBox()}))
      let overlap=false,intrusion=null,minSeparation=Infinity;const samples=[],byId=new Map()
      for(let i=0;i<boxes.length;i++)for(const b of boxes.slice(i+1)){const a=boxes[i].box,c=b.box;if(a.x<c.x+c.width+5&&a.x+a.width>c.x-5&&a.y<c.y+c.height+5&&a.y+a.height>c.y-5)overlap=true}
      for(const p of paths){const pts=[];for(let at=0;at<=p.getTotalLength();at+=.9){const point=p.getPointAtLength(at);pts.push([point.x,point.y]);for(const b of boxes){if(b.id===p.dataset.category)continue;const r=Math.min(18,b.box.height/2),qx=Math.abs(point.x-b.box.x-b.box.width/2)-b.box.width/2+r,qy=Math.abs(point.y-b.box.y-b.box.height/2)-b.box.height/2+r;if(Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r<.5)intrusion={stem:p.dataset.category,box:b.id}}}samples.push({id:p.dataset.category,pts});byId.set(p.dataset.category,p)}
      const cells=new Map();for(const route of samples)for(const p of route.pts){const x=Math.floor(p[0]/4),y=Math.floor(p[1]/4);for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of cells.get(`${x+dx},${y+dy}`)||[])if(q.id!==route.id)minSeparation=Math.min(minSeparation,Math.hypot(q.p[0]-p[0],q.p[1]-p[1]));const key=`${x},${y}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push({id:route.id,p})}
      return {hostCenter:(host.left+host.right)/2,ringWidth:el.querySelector(".recharts-pie").getBoundingClientRect().width,paths:paths.length,labels:labels.length,overlap,intrusion,minSeparation,curved:paths.every(p=>/[CQ]/.test(p.getAttribute('d'))),fits:boxes.every(({box:b})=>b.x>=0&&b.y>=0&&b.x+b.width<=host.width+.1&&b.y+b.height<=host.height+.1),whole:labels.every(label=>/^\$[\d,]+$/.test(label.querySelector('.bb-contour-amount').textContent)),centered:labels.every(label=>{const b=label.querySelector('rect').getBBox();return Math.abs(Number(label.querySelector('.bb-contour-name').getAttribute('x'))-b.x-b.width/2)<.1}),matched:labels.every(label=>label.dataset.category==='left'||getComputedStyle(label.querySelector('.bb-contour-name')).fill===getComputedStyle(byId.get(label.dataset.category)).stroke),textFits:labels.every(label=>label.querySelector('.bb-contour-name').getBBox().width<=label.querySelector('rect').getBBox().width-7),nameFont:labels.map(label=>getComputedStyle(label.querySelector('.bb-contour-name')).fontSize),percentFont:getComputedStyle(el.querySelector('.bb-category-used')).fontSize,captionFits:el.querySelector('.bb-category-pie-center > span').getBoundingClientRect().width<=center.width,hostWidth:host.width,hostHeight:host.height,names:labels.map(label=>label.querySelector('.bb-contour-name').textContent),overflow:document.documentElement.scrollWidth>innerWidth}
     })
     assert.equal(geometry.paths,geometry.labels,JSON.stringify(geometry));assert.ok(geometry.labels>0,JSON.stringify(geometry))
     for(const key of ['curved','fits','whole','centered','matched','textFits','captionFits'])assert.equal(geometry[key],true,JSON.stringify({engine:engine.name(),width,filter,key,geometry}))
     assert.equal(geometry.overlap,false,JSON.stringify(geometry));assert.equal(geometry.intrusion,null,JSON.stringify(geometry));assert.ok(geometry.minSeparation>=1.4,JSON.stringify(geometry));assert.equal(geometry.overflow,false)
     assert.ok(Math.abs(geometry.hostCenter-width/2)<1,'The labeled ring stays centered in the page');assert.equal(geometry.percentFont,'32px');assert.equal((await page.locator('.bb-chart-carousel-band').boundingBox()).height,originalHeight)
     if(filter==='all'){if(width===390)assert.ok(Math.abs(geometry.ringWidth-220)<1,'The selected ring diameter is retained');assert.equal(geometry.paths,12);assert.ok(geometry.names.includes('Other needs'));assert.ok(geometry.names.includes('Bills & utils'));assert.ok(geometry.names.includes('Needs subs'));assert.ok(geometry.names.includes('Wants subs'))}
     count++
    }
    await category.getByRole('combobox',{name:'Category mix filter',exact:true}).selectOption('all')
    await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor()
    await category.getByRole('button',{name:'Categories',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor()
    assert.ok((await dialog.innerText()).includes('$1,329.32'),'The modal retains exact cents')
    await page.keyboard.press('Escape');await page.waitForTimeout(350)
    await category.locator('.bb-chart-kicker').click()
    await category.screenshot({path:`/private/tmp/refined-flow-${engine.name()}-${width}-${dark?'dark':'light'}.png`})
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[],'Only the public local geometry worker is requested')
    await page.close()
   }
  }finally{await browser.close()}
 }
 console.log(`${count} production Chromium/WebKit Refined flow cases passed`)
})().catch(error=>{console.error(error);process.exitCode=1})
