// Shipped bundle, synthetic report only; no authenticated APIs or financial writes.
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
report.dailyEntries=[['Grocery',120,'9/1/2026'],['Food',30,'9/2/2026'],['Shopping',15,'']].map(([category,amount,date])=>({category,amount,date,item:`Fixture ${category}`,person:'Brian',location:''}))
for(const view of Object.values(report.modeViews))view.calendarEvents=[]
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(assets,'expense-report-app.js'),'utf8')
const html=dark=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script>localStorage.setItem('bookiebot-expense-report-theme','${dark?'dark':'light'}')</script><script id="bookiebot-expense-report-data" type="application/json">${JSON.stringify(report)}</script><script type="module" src="/app.js"></script></body></html>`
async function layout(page){return page.locator('.bb-daily-section').evaluate(section=>{
 const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,center:r.top+r.height/2}}
 const dropdown=section.querySelector('select[aria-label="Daily spending filter"]'),title=section.querySelector('h2'),button=section.querySelector('.bb-daily-transactions-toggle'),row=section.querySelector('.bb-daily-amount-row'),amount=row.querySelector('.bb-fitted-amount-text'),integer=amount.querySelector('.bb-amount-integer')||amount,reference=document.querySelector('select[aria-label="Category mix filter"]')
 return {dropdown:rect(dropdown),title:rect(title),button:rect(button),row:rect(row),amount:rect(amount),integer:rect(integer),value:amount.textContent,overflow:document.documentElement.scrollWidth>innerWidth,styles:[dropdown,reference].map(el=>{const s=getComputedStyle(el);return[s.borderRadius,s.padding,s.fontSize,s.backgroundColor]}),radius:getComputedStyle(button).borderRadius,chevronGap:rect(dropdown).right-rect(dropdown.parentElement.querySelector('svg')).right}
})}
;(async()=>{let cases=0
 for(const engine of [chromium,webkit]){const browser=await engine.launch({headless:true})
 try{for(const width of [320,390,861,1280])for(const dark of [false,true]){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,isMobile:width<768,colorScheme:dark?'dark':'light',reducedMotion:dark?'reduce':'no-preference'})
  const errors=[],traffic=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000)
  await page.route('**/*',async route=>{const url=new URL(route.request().url()),name=path.basename(url.pathname)
   if(route.request().method()!=='GET'||url.origin!=='https://bookie.test'){traffic.push(route.request().method()+' '+url);return route.abort()}
   if(url.pathname==='/report')return route.fulfill({contentType:'text/html',body:html(dark)})
   if(name==='app.js')return route.fulfill({contentType:'application/javascript',body:js})
   if(/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,name))})
   traffic.push(url.pathname);return route.abort()
  })
  await page.goto('https://bookie.test/report')
  const section=page.locator('.bb-daily-section'),filter=section.getByRole('combobox',{name:'Daily spending filter',exact:true}),button=section.getByRole('button',{name:'Transactions',exact:true}),amount=section.locator('.bb-daily-amount-row .bb-fitted-amount-text')
  await section.waitFor();await section.scrollIntoViewIfNeeded()
  assert.deepEqual(await filter.locator('option').allTextContents(),['All','Needs','Wants']);assert.equal(await section.getByRole('tablist').count(),0)
  const stage=await page.locator('.bb-chart-carousel-band').evaluate(el=>el.getBoundingClientRect().height),allWidth=(await filter.boundingBox()).width
  for(const [scope,total,count]of[['needs','$120.00',1],['wants','$45.00',2],['all','$165.00',3]]){
   await filter.selectOption(scope);await page.waitForFunction(total=>document.querySelector('.bb-daily-amount-row .bb-fitted-amount-text').textContent===total,total)
   const m=await layout(page)
   assert.equal(m.overflow,false,JSON.stringify(m));assert.deepEqual(m.styles[0],m.styles[1]);assert.equal(m.radius,'24px');assert.ok(m.dropdown.height>=44&&m.button.height>=44);assert.ok(m.chevronGap>=14)
   assert.ok(m.title.right+7<=m.dropdown.left,JSON.stringify(m));assert.ok(Math.abs(m.title.center-m.dropdown.center)<1,JSON.stringify(m))
   assert.ok(m.amount.right+10<=m.button.left,JSON.stringify(m));assert.ok(Math.abs(m.integer.center-m.button.center)<2,JSON.stringify(m));assert.ok(Math.abs(m.row.right-m.button.right)<1,JSON.stringify(m));assert.ok(m.amount.width>20)
   if(scope==='needs')assert.ok(m.dropdown.width>allWidth,'Dropdown follows the selected string')
   await button.click();assert.equal(await button.getAttribute('aria-expanded'),'true');await section.locator('.bb-daily-transactions').waitFor({state:'visible'})
   assert.equal(await section.locator('tbody tr').count(),count);assert.equal(await filter.inputValue(),scope)
   assert.equal(await amount.textContent(),total,'Disclosure does not alter the total')
   const id=await button.getAttribute('aria-controls');assert.equal(await page.locator(`[id="${id}"]`).getAttribute('inert'),null)
   await button.focus();await page.keyboard.press('Space');assert.equal(await button.getAttribute('aria-expanded'),'false')
  }
  assert.equal((await filter.boundingBox()).width,allWidth);assert.equal(await page.locator('.bb-chart-carousel-band').evaluate(el=>el.getBoundingClientRect().height),stage)
  if(width===390&&dark){await button.evaluate(el=>el.blur());await page.waitForTimeout(400);await section.screenshot({path:`/private/tmp/bookiebot-daily-controls-${engine.name()}.png`})}
  await page.evaluate(()=>localStorage.setItem('bookiebot-amount-appearance:v1:brian',JSON.stringify({version:1,raisedCents:false})));await page.reload();await section.waitFor();assert.equal(await section.locator('.bb-daily-amount-row .bb-amount-fraction').count(),0)
  const plain=await layout(page);assert.ok(Math.abs(plain.integer.center-plain.button.center)<2);assert.equal(plain.overflow,false)
  assert.deepEqual(errors,[]);assert.deepEqual(traffic,[]);cases++;console.log(engine.name(),width,dark?'dark/reduced':'light','PASS');await page.close()
 }}finally{await browser.close()}}
 console.log(`${cases} Chromium/WebKit Daily Spending dropdown, alignment, disclosure, scopes and appearance cases passed.`)
})().catch(error=>{console.error(error);process.exit(1)})
