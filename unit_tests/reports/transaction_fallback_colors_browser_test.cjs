// Check actual fallback paint against Category Mix's production palette.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright')),ts=req('typescript')
const report=ts.createSourceFile('report-app.tsx',fs.readFileSync(path.join(frontend,'src/report-app.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const declaration=report.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(report)==='CATEGORY_CHART_COLORS'))
const palette=vm.runInNewContext(ts.transpileModule(declaration.getText(report)+'; CATEGORY_CHART_COLORS',{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText)
const cases=[['Rent','rent','rent'],['Mortgage','rent','rent'],['Groceries','grocery','grocery'],['Grocery','grocery','grocery'],['Gas','gas','gas'],['Fuel','gas','gas'],['Food','food','food'],['Dining','food','food'],['Shopping','shopping','shopping'],['Other needs','need_expenses','need'],['Need Expenses','need_expenses','need'],['Bills & Utilities','bills_utilities','bills'],['Static Bills & Subscriptions','static_bills_subscriptions_needs','subs-needs'],['Subs (Needs)','static_bills_subscriptions_needs','subs-needs'],['Subs (Wants)','subscriptions_wants','subs-wants'],['Income','income','income'],['Savings','savings','savings'],['ESPP','espp','espp']]
const colors={...palette,income:'hsl(var(--success))',savings:'hsl(var(--chart-5))',espp:'hsl(var(--chart-4))'}
const expected=cases.map(([category,key,token])=>({category,token,color:colors[key]}))
const bundle=req('esbuild').buildSync({stdin:{resolveDir:frontend,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{TransactionIcon,DailyTransactionDays}from'./src/daily-transactions';
 const cases=${JSON.stringify(expected)};
 const entry=category=>({date:'11/5/2026',category,amount:12,person:'Fixture',item:'Unknown purchase',location:'Unlisted fixture merchant'});
 createRoot(document.getElementById('root')).render(<><div className="fixture-grid">{cases.map(c=><div key={c.category} data-case={c.category}><TransactionIcon entry={entry(c.category)}/><span data-reference style={{color:c.color}}>{c.category}</span></div>)}<div data-case="failed"><TransactionIcon entry={{...entry('Shopping'),location:'Target'}}/></div><div data-case="loaded"><TransactionIcon entry={{...entry('Groceries'),location:'Whole Foods'}}/></div></div><div className="bb-daily-spending-content"><DailyTransactionDays groups={[{day:'5',today:false,entries:cases.slice(0,6).map(c=>entry(c.category))}]} year={2026} month={11} categoryColors={Object.fromEntries(cases.map(c=>[c.category,c.color]))}/></div></>);
 `},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
;(async()=>{let count=0
 for(const engine of [chromium,webkit]){const browser=await engine.launch();try{
  for(const width of [320,390,1280])for(const dark of [false,true]){
   const page=await browser.newPage({viewport:{width,height:900},colorScheme:dark?'dark':'light'}),errors=[],traffic=[]
   page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{
    const url=new URL(route.request().url()),name=path.basename(url.pathname)
    if(url.origin!=='https://fallback.test'){traffic.push(url.href);return route.abort()}
    if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:`<html data-theme="${dark?'dark':'light'}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;padding:16px}.fixture-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:14px;margin-bottom:24px}.fixture-grid>div{display:grid;justify-items:center;gap:4px;font-size:12px;text-align:center}</style><div id="root"></div><script>${bundle}</script></html>`})
    if(name.includes('merchant-target'))return route.fulfill({status:404,body:''})
    if(/^company-logo-[\w-]+\.(svg|png)$/.test(name)&&fs.existsSync(path.join(assets,name)))return route.fulfill({contentType:name.endsWith('.svg')?'image/svg+xml':'image/png',body:fs.readFileSync(path.join(assets,name))})
    traffic.push(url.href);return route.abort()
   })
   await page.goto('https://fallback.test/fixture');await page.locator('[data-motion-ready="true"]').waitFor()
   await page.waitForFunction(()=>document.querySelector('[data-case="loaded"] [data-ready="true"]')&&!document.querySelector('[data-case="failed"] img'))
   for(const item of expected){
    const actual=await page.locator(`[data-case="${item.category}"]`).evaluate((el,color)=>{
     const icon=el.querySelector('.bb-transaction-icon'),glyph=el.querySelector('svg'),probe=document.createElement('span');probe.style.color=color;probe.style.background=color.slice(0,-1)+' / .12)';el.append(probe)
     const result={icon:getComputedStyle(icon).color,glyph:getComputedStyle(glyph).color,reference:getComputedStyle(probe).color,background:getComputedStyle(icon).backgroundColor,expectedBackground:getComputedStyle(probe).backgroundColor,width:icon.getBoundingClientRect().width,height:icon.getBoundingClientRect().height};probe.remove();return result
    },item.color)
    assert.equal(actual.icon,actual.reference,item.category);assert.equal(actual.glyph,actual.reference,item.category);assert.equal(actual.background,actual.expectedBackground,item.category);assert.equal(actual.width,28);assert.equal(actual.height,28)
   }
   const failures=await page.locator('[data-case="failed"] .bb-transaction-icon').evaluate(el=>({ready:el.dataset.ready,color:getComputedStyle(el).color,visibility:getComputedStyle(el.querySelector('.bb-transaction-fallback')).visibility}))
   const shopping=await page.locator('[data-case="Shopping"] .bb-transaction-icon').evaluate(el=>getComputedStyle(el).color)
   assert.equal(failures.ready,'false');assert.equal(failures.color,shopping);assert.equal(failures.visibility,'visible')
   const loaded=await page.locator('[data-case="loaded"] .bb-transaction-icon').evaluate(el=>({opacity:getComputedStyle(el.querySelector('img')).opacity,visibility:getComputedStyle(el.querySelector('.bb-transaction-fallback')).visibility,filter:getComputedStyle(el.querySelector('img')).filter}))
   assert.deepEqual(loaded,{opacity:'1',visibility:'hidden',filter:'none'})
   const group=page.locator('.bb-daily-day-group'),capture=()=>group.locator('.bb-daily-bead .bb-transaction-icon').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).color)),before=await capture()
   for(const open of [true,false]){await group.locator('.bb-daily-day-header').click();await page.waitForFunction(()=>document.querySelector('.bb-daily-day-group').dataset.moving==='false');assert.deepEqual(await capture(),before)}
   if(width===390&&dark)await page.screenshot({path:'/private/tmp/bookiebot-fallback-colors-'+engine.name()+'.png'})
   await page.locator('html').evaluate(el=>el.dataset.theme=el.dataset.theme==='dark'?'light':'dark');assert.notDeepEqual(await capture(),before,'Theme changes must update fallback paint')
   const themed=await group.locator('.bb-daily-bead .bb-transaction-icon').evaluateAll(nodes=>nodes.map(n=>({actual:getComputedStyle(n).color,reference:getComputedStyle(document.querySelector(`.fixture-grid [data-token="${n.dataset.token}"]`).closest('[data-case]').querySelector('[data-reference]')).color})))
   assert(themed.every(item=>item.actual===item.reference),'Persistent fallback circles must retain the new theme palette')
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(traffic,[])
   await page.close();count++
  }
 }finally{await browser.close()}}
 console.log(JSON.stringify({cases:count,categoryChecks:count*expected.length,status:'passed'}))
})().catch(error=>{console.error(error);process.exitCode=1})
