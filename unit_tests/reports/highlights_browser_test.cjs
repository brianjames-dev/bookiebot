// Actual shipped bundle and synthetic report only. No authenticated APIs/writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const report=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import json
from unit_tests.reports.test_income_projection import build,income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','5000'))))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
report.ownerName='Brian'
report.dailyEntries=report.topEntries=[['Rent',2100,'Rent'],['PG&E',274.52,'Bills & utilities'],['Costco',187.46,'Groceries'],['REI',124.95,'Shopping'],['Xfinity',89,'Bills & utilities'],['Whole Foods',68.42,'Groceries'],['Shell',54.76,'Gas'],['Amazon',42.18,'Shopping'],['Chipotle',18.65,'Food'],['Starbucks',12.40,'Food'],['Trader Joe’s snack',8.99,'Food']].map(([item,amount,category])=>({item,amount,category,date:'9/2/2026',person:'Brian',location:''}))
report.merchantOccurrences=[['Starbucks',12,92.60],['Amazon',8,237.18],['Trader Joe’s',6,218.45],['Whole Foods',5,306.18],['Chipotle',4,78.92],['Shell',3,164.28],['Target',2,86.34],['Costco',2,374.92],['REI',1,124.95],['Xfinity',1,89]].map(([label,count,amount])=>({label,count,amount}))
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(assets,'expense-report-app.js'),'utf8')
function fixture(variant){
 const result=JSON.parse(JSON.stringify(report))
 if(variant==='single'){result.topEntries=result.topEntries.slice(1,2);result.merchantOccurrences=result.merchantOccurrences.slice(0,1)}
 if(variant==='empty'){result.topEntries=[];result.merchantOccurrences=[]}
 if(variant==='large'){result.topEntries=[{...result.topEntries[1],item:'A complete, exceptionally long merchant name',amount:1000000}];result.merchantOccurrences=[{label:'Another exceptionally long merchant name',amount:1234567.89,count:1000000}]}
 return result
}
const html=(dark,variant)=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script>localStorage.setItem('bookiebot-expense-report-theme','${dark?'dark':'light'}')</script><script id="bookiebot-expense-report-data" type="application/json">${JSON.stringify(fixture(variant))}</script><script type="module" src="/app.js"></script></body></html>`
async function geometry(active){return active.evaluate(el=>{
 const svg=el.querySelector('.recharts-surface').getBoundingClientRect(),bars=[...el.querySelectorAll('.recharts-bar-rectangle')].map(el=>{const b=el.getBoundingClientRect();return{y:b.y,height:b.height}})
 return {height:svg.height,bars,labels:[...el.querySelectorAll('.bb-highlight-label,.bb-highlight-value')].map(el=>{const b=el.getBoundingClientRect();return{text:el.textContent,left:b.left-svg.left,right:b.right-svg.left,font:parseFloat(getComputedStyle(el).fontSize)}}),width:svg.width}
})}
;(async()=>{let cases=0
 for(const engine of [chromium,webkit].filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true})
  try{for(const width of [320,390,768,1280].filter(w=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH)))for(const dark of [false,true]){
   const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,isMobile:width<768,colorScheme:dark?'dark':'light',reducedMotion:dark?'reduce':'no-preference'})
   const errors=[],traffic=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000)
   await page.route('**/*',route=>{
    const url=new URL(route.request().url()),name=path.basename(url.pathname)
    if(route.request().method()!=='GET'||url.origin!=='https://bookie.test'){traffic.push(route.request().method()+' '+url);return route.abort()}
    if(url.pathname==='/report')return route.fulfill({contentType:'text/html',body:html(dark,url.searchParams.get('variant'))})
    if(name==='app.js')return route.fulfill({contentType:'application/javascript',body:js})
    if(/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,name))})
    if(/^company-logo-[\w-]+\.(svg|png)$/.test(name)&&fs.existsSync(path.join(assets,name)))return route.fulfill({contentType:name.endsWith('.svg')?'image/svg+xml':'image/png',body:fs.readFileSync(path.join(assets,name))})
    traffic.push(url.pathname);return route.abort()
   })
   await page.goto('https://bookie.test/report')
   const section=page.locator('.bb-highlights-section'),chooser=section.getByRole('combobox',{name:'Highlights view',exact:true})
   await section.waitFor();await section.scrollIntoViewIfNeeded()
   const identity=await section.locator('.bb-insight-view').evaluateAll(panels=>{panels.forEach((p,i)=>p.dataset.fixtureIdentity=String(i));return panels.map(p=>p.dataset.fixtureIdentity)})
   const initialHeight=await section.evaluate(el=>el.getBoundingClientRect().height)
   for(const value of ['largest','merchants']){
    await chooser.selectOption(value);await page.waitForTimeout(300)
    const active=section.locator('.bb-insight-view[data-state="active"]'),g=await geometry(active)
    assert.equal(g.bars.length,8);assert.equal(g.height,258)
    for(let i=0;i<g.bars.length;i++){
     assert.ok(Math.abs(g.bars[i].height-20)<.3)
     if(i)assert.ok(Math.abs(g.bars[i].y-g.bars[i-1].y-28)<.3,'20px bars keep exactly 8px between rows')
    }
    for(const label of g.labels)assert.ok(label.left>=-.5&&label.right<=g.width+.5&&label.font>=12,JSON.stringify(label))
    assert.ok(g.labels.some(l=>l.text==='Whole Foods'),'Phone names stay visible')
    assert.ok(g.labels.some(l=>l.text===(value==='largest'?'$274.52':'12×')))
    assert.ok(!g.labels.some(l=>l.text==='Rent'),'Rent is still excluded')
    assert.equal(await section.getByRole('region').count(),1)
    const header=await section.locator('.bb-highlights-heading').evaluate(el=>{const a=el.querySelector('h2').getBoundingClientRect(),b=el.querySelector('select').getBoundingClientRect();return{a:a.y+a.height/2,b:b.y+b.height/2,right:a.right,left:b.left}})
    assert.ok(Math.abs(header.a-header.b)<1&&header.right+10<=header.left)
    assert.ok(Math.abs(await section.evaluate(el=>el.getBoundingClientRect().height)-initialHeight)<.5,'Picker does not resize the card')
    for(const endpoint of ['first','last']){
     await active.locator('.recharts-bar-rectangle')[endpoint]().tap()
     const tip=active.getByRole('tooltip'),name=endpoint==='first'?(value==='largest'?'PG&E':'Starbucks'):(value==='largest'?'Chipotle':'Costco')
     await tip.locator('.bb-chart-tooltip-title').filter({hasText:name}).waitFor();await page.waitForTimeout(220)
     const box=await tip.evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return{x:r.x,right:r.right,width:r.width,padding:parseFloat(s.padding),radius:parseFloat(s.borderRadius),background:s.backgroundColor,text:el.textContent,overflow:el.scrollWidth>el.clientWidth}})
     assert.ok(Math.abs(box.width-200)<.1&&box.x>=0&&box.right<=width+.5,JSON.stringify(box))
     assert.equal(box.padding,12);assert.equal(box.radius,16);assert.equal(box.overflow,false);assert.notEqual(box.background,'rgba(0, 0, 0, 0)')
     assert.ok(box.text.includes(value==='largest'?'Expense amount':'Total spent'))
     if(endpoint==='first')assert.ok(box.text.includes(value==='largest'?'$274.52':'$92.60'))
     if(width===390&&endpoint==='first')await section.screenshot({path:`/private/tmp/bookiebot-highlights-approved-${engine.name()}-${dark?'dark':'light'}-${value}.png`})
    }
   }
   for(const view of ['largest','merchants','largest','merchants']){await chooser.selectOption(view);await page.waitForTimeout(35)}
   await page.waitForTimeout(300)
   assert.deepEqual(await section.locator('.bb-insight-view').evaluateAll(p=>p.map(el=>el.dataset.fixtureIdentity)),identity)
   assert.equal(await section.getByRole('region').count(),1)
   assert.equal(await section.getByRole('button',{name:/View all/}).count(),0)
   if(width===390&&dark){
    const active=section.locator('.bb-insight-view[data-state="active"]')
    await active.locator('.recharts-bar-rectangle').first().tap()
    await active.getByRole('tooltip').waitFor()
    await active.getByRole('tooltip').waitFor({state:'hidden',timeout:6500})
    await page.evaluate(()=>scrollBy(0,10));await page.waitForTimeout(100)
    assert.equal(await active.getByRole('tooltip').isVisible(),false,'Scroll cannot revive an expired thumbnail')
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
   if(width===320&&dark){for(const variant of ['single','empty','large']){
    await page.goto('https://bookie.test/report?variant='+variant);await section.waitFor();await section.scrollIntoViewIfNeeded()
    for(const value of ['largest','merchants']){
     await chooser.selectOption(value);await page.waitForTimeout(300)
     const active=section.locator('.bb-insight-view[data-state="active"]'),g=await geometry(active)
     assert.equal(g.bars.length,variant==='empty'?0:1,'Sparse/empty data cannot preserve stale rows')
     for(const label of g.labels)assert.ok(label.left>=-.5&&label.right<=g.width+.5,'Large exact values stay in the SVG: '+JSON.stringify(label)+' width='+g.width)
     if(variant==='large'){
      await active.locator('.recharts-bar-rectangle').first().tap()
      const tip=active.getByRole('tooltip');await tip.waitFor()
      assert.ok((await tip.textContent()).includes(value==='largest'?'A complete, exceptionally long merchant name':'Another exceptionally long merchant name'))
     }
    }
    cases++
   }}
   assert.deepEqual(errors,[]);assert.deepEqual(traffic,[],'No external APIs or financial writes')
   cases++;await page.close()
  }}finally{await browser.close()}
 }
 console.log(`${cases} approved Highlights bundle cases passed: exact spacing, eight rows, visible labels, 200px thumbnails, sparse/large data, native crossfade, timeout and no writes`)
})().catch(error=>{console.error(error);process.exitCode=1})
