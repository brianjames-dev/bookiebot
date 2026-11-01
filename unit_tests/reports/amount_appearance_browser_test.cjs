// Exercise the shipped app with isolated report data and no external requests/writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const report=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import json
from unit_tests.reports.test_income_projection import build, income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('11/1/2026','Fixture income','5000'))))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
Object.assign(report,{ownerName:'Brian',year:2026,month:11,monthLabel:'November 2026'})
for(const mode of ['current','projected'])Object.assign(report.modeViews[mode].metrics,{monthlyIncome:7473.86,totalExpenses:270.70,amountSaved:599.86,incomeAfterExpenses:6603.30})
const css=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.js'),'utf8')
const appearanceKey='bookiebot-amount-appearance:v1:brian'
const html=dark=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName:'Brian',reportUrl:'/app/expenses/data',logoutUrl:'/app/logout'})}</script><script>localStorage.setItem('bookiebot-expense-report-theme','${dark?'dark':'light'}')</script><script type="module">${js}</script></body></html>`
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value)
async function geometry(page,alignment,size,emphasis){
  await page.locator('.bb-metrics-grid').waitFor({state:'visible'})
  const result=await page.locator('.bb-metrics-grid').evaluate(grid=>{
    const ctx=document.createElement('canvas').getContext('2d')
    const ascent=(el,text)=>{const s=getComputedStyle(el);ctx.font=`${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;return ctx.measureText(text).actualBoundingBoxAscent}
    return {overflow:document.documentElement.scrollWidth>innerWidth,values:[...grid.querySelectorAll('.bb-metric-value')].map(box=>{
      const text=box.querySelector('.bb-fitted-amount-text'),integer=text.querySelector('.bb-amount-integer'),fraction=text.querySelector('.bb-amount-fraction')
      const rect=text.getBoundingClientRect(),outer=box.getBoundingClientRect()
      const detail=fraction?{ratio:parseFloat(getComputedStyle(fraction).fontSize)/parseFloat(getComputedStyle(integer).fontSize),integerFont:getComputedStyle(integer).fontSize,fractionFont:getComputedStyle(fraction).fontSize,available:box.clientWidth,scale:box.style.getPropertyValue('--bb-amount-fit'),opacity:getComputedStyle(fraction).opacity,shift:-new DOMMatrix(getComputedStyle(fraction).transform).f,expectedShift:ascent(integer,integer.textContent.replace(/[^\d]/g,''))-ascent(fraction,fraction.textContent.slice(1))}:{}
      return {value:text.textContent,inner:text.innerText,fit:rect.right<=outer.right+1,...detail}
    })}
  })
  assert.equal(result.overflow,false);assert.equal(result.values.length,4)
  for(const value of result.values){
    assert.equal(value.inner,value.value,'Copyable text retains one exact amount')
    assert.ok(value.fit,JSON.stringify(result))
    if(alignment!=='uniform'){
      assert.ok(Math.abs(value.ratio-size/100)<.005,JSON.stringify(value));assert.equal(Number(value.opacity),emphasis/100)
      assert.ok(Math.abs(value.shift-value.expectedShift)<1,JSON.stringify(value))
    }else assert.equal(value.opacity,undefined)
  }
  return result
}
;(async()=>{
  let cases=0
  for(const engine of [chromium,webkit]){
    const browser=await engine.launch({headless:true})
    try{for(const width of [320,390,1280])for(const dark of [false,true]){
      const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,isMobile:width<768,reducedMotion:dark?'reduce':'no-preference'})
      page.setDefaultTimeout(10000)
      const errors=[],unexpected=[];let long=false
      console.log('Case',engine.name(),width,dark?'dark':'light')
      page.on('pageerror',error=>errors.push(error.message))
      await page.addInitScript(()=>{delete window.PushManager})
      await page.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url()),name=url.pathname
        if(url.origin!=='https://bookie.test'||request.method()!=='GET'){unexpected.push(`${request.method()} ${url}`);return route.abort()}
        if(/^\/app\/assets\/category-mix-layout-[A-Za-z0-9_-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,'src/bookiebot/reports/assets',path.basename(name)))})
        if(name==='/app/expenses')return route.fulfill({contentType:'text/html',body:html(dark)})
        let value
        if(name==='/app/expenses/data'){
          value=JSON.parse(JSON.stringify(report))
          if(long)for(const mode of ['current','projected'])Object.assign(value.modeViews[mode].metrics,{monthlyIncome:123456789012.34,totalExpenses:12345678901.67,amountSaved:1234567890.99,incomeAfterExpenses:-123456789.56})
        }else if(name==='/app/expenses/months')value={currentMonth:'2026-11',months:[{value:'2026-11',label:'November 2026'}],coverage:{status:'complete',unavailableYears:[]}}
        else if(name==='/app/reconciliation')value={enabled:true,checkedAt:null,items:[]}
        else if(name==='/app/reimbursements')value={enabled:true,ownerKey:'brian',currency:'USD',allocations:[],events:[],resets:[],resetState:'fixture'}
        else if(name==='/app/goals')value={goals:[]}
        else if(name==='/app/notifications')value={enabled:false,publicKey:'B'+'A'.repeat(86),preferences:{weekly:true,upcoming:false,showAmounts:false,hour:10}}
        else if(name==='/app/widgets/settings')value={connections:[],scriptUrl:'/app/widgets/script',setupInstructionsUrl:'/app/widgets/help'}
        else if(name==='/app/version')value={version:'amount-fixture'}
        else if(name.includes('avatar'))return route.fulfill({contentType:'image/png',body:fs.readFileSync(path.join(root,'assets/avatars/avatar7.png'))})
        else{unexpected.push(`${request.method()} ${url}`);return route.fulfill({status:404,json:{error:'Unknown fixture'}})}
        return route.fulfill({json:value})
      })
      await page.goto('https://bookie.test/app/expenses')
      await page.locator('.bb-metrics-grid').waitFor({state:'visible'})
      await geometry(page,'raised',50,55)
      assert.deepEqual(await page.locator('.bb-metrics-grid .bb-metric-value .bb-fitted-amount-text').allTextContents(),[7473.86,270.70,6603.30,599.86].map(money))
      const height=await page.locator('.bb-chart-carousel-band').evaluate(node=>node.getBoundingClientRect().height)
      await page.getByRole('button',{name:'Settings',exact:true}).click()
      const settings=page.getByRole('main',{name:'Settings',exact:true})
      await settings.waitFor({state:'visible'})
      const toggle=settings.getByRole('switch',{name:'Raised cents',exact:true})
      assert.equal(await toggle.getAttribute('aria-checked'),'true')
      assert.ok(await toggle.evaluate(el=>{const r=el.getBoundingClientRect();return r.height>=44&&r.width>=44}))
      assert.equal(await settings.locator('section[aria-labelledby="bb-appearance-title"]').locator('select,input').count(),0,'Appearance exposes one simple cents toggle')
      await toggle.click()
      assert.equal(await toggle.getAttribute('aria-checked'),'false')
      await settings.getByRole('button',{name:'Back',exact:true}).click()
      await geometry(page,'uniform',50,55)
      assert.equal(await page.locator('.bb-chart-carousel-band').evaluate(node=>node.getBoundingClientRect().height),height,'Appearance does not resize the common graph section')
      await page.reload();await page.locator('.bb-metrics-grid').waitFor()
      assert.equal(await page.locator('.bb-metrics-grid .bb-amount-fraction').count(),0,'Full-size selection survives reload')
      await page.getByRole('button',{name:'Settings',exact:true}).click()
      assert.equal(await toggle.getAttribute('aria-checked'),'false')
      await toggle.focus();await page.keyboard.press('Space')
      assert.equal(await toggle.getAttribute('aria-checked'),'true')
      const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),appearanceKey)
      assert.deepEqual(saved,{version:1,raisedCents:true})
      await settings.getByRole('button',{name:'Back',exact:true}).click()
      await geometry(page,'raised',50,55)
      if(width===390&&dark){await page.screenshot({path:`/private/tmp/bookiebot-amount-overview-${engine.name()}.png`});await page.getByRole('button',{name:'Settings',exact:true}).click();await settings.screenshot({path:`/private/tmp/bookiebot-amount-settings-${engine.name()}.png`})}
      long=true;await page.goto('https://bookie.test/app/expenses')
      await page.locator('.bb-metrics-grid').waitFor({state:'visible'})
      const fitted=await geometry(page,'raised',50,55)
      assert.deepEqual(fitted.values.map(row=>row.value),[123456789012.34,12345678901.67,-123456789.56,1234567890.99].map(money))
      assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[])
      cases++;await page.close()
    }}finally{await browser.close()}
  }
  console.log(`Amount appearance: ${cases} Chromium/WebKit layout, settings, reload, alignment and long-value cases passed.`)
})().catch(error=>{console.error(error);process.exit(1)})
