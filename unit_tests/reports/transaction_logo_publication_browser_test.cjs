// Real Daily Spending/Calendar components must render the reviewed bytes and alias.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'))
const publication=read('docs/logo-review/publications/2026-11-02-reviewed-logos.json'),catalogs={company:read('web/expense-report/src/company-logos.json'),merchant:read('web/expense-report/src/merchant-logos.json')}
const cases=publication.changes.map(change=>{const[kind,id]=change.key.split(':'),item=catalogs[kind].find(i=>i.id===id);return{key:change.key,kind,id,name:item.name,label:item.aliases[0],asset:item.asset,sha256:change.sha256}})
cases.push({key:'merchant:starbucks',kind:'merchant',id:'starbucks',name:'Starbucks',label:'Starbucks Coffee Company',asset:catalogs.merchant.find(i=>i.id==='starbucks').asset})
const bundle=req('esbuild').buildSync({stdin:{resolveDir:frontend,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{TransactionIcon,DailyTransactionDays}from'./src/daily-transactions';import{CompanyMedallion}from'./src/cashflow-calendar';
 const cases=${JSON.stringify(cases)},entry=c=>({date:'11/5/2026',category:c.kind==='company'?'Static Bills & Subscriptions':c.id==='starbucks'?'Food':'Shopping',amount:12,person:'Fixture',item:'Purchase',location:c.label});
 createRoot(document.getElementById('root')).render(<><div className="fixture-grid">{cases.map(c=><div key={c.key} data-case={c.key}><TransactionIcon entry={entry(c)} eager/><span>{c.name}</span>{c.kind==='company'&&<CompanyMedallion event={{label:c.label,kind:'subscription',amount:12,day:5,group:'subscriptions_wants',projectedOnly:false}}/>}</div>)}</div><div className="bb-daily-spending-content"><DailyTransactionDays groups={[{day:'5',today:false,entries:cases.map(entry)}]} year={2026} month={11} categoryColors={{Shopping:'hsl(var(--category-shopping))',Food:'hsl(var(--category-food))','Static Bills & Subscriptions':'hsl(var(--category-subs-needs))'}}/></div></>);
 `},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
;(async()=>{let count=0
for(const engine of[chromium,webkit]){const browser=await engine.launch();try{
 for(const width of[320,390,1280])for(const dark of[false,true]){
  const page=await browser.newPage({viewport:{width,height:1000},colorScheme:dark?'dark':'light'}),errors=[],traffic=[];page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/*',route=>{const url=new URL(route.request().url()),name=path.basename(url.pathname)
   if(url.origin!=='https://logos.test'){traffic.push(url.href);return route.abort()}
   if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:`<html data-theme="${dark?'dark':'light'}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{padding:18px}#root{max-width:650px;margin:auto}.fixture-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:18px 10px;margin-bottom:32px}.fixture-grid>div{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;text-align:center}</style><div id="root"></div><script>${bundle}</script></html>`})
   if(/^company-logo-[\w-]+\.(png|svg)$/.test(name)&&fs.existsSync(path.join(assets,name)))return route.fulfill({contentType:name.endsWith('.png')?'image/png':'image/svg+xml',body:fs.readFileSync(path.join(assets,name))})
   traffic.push(url.href);return route.abort()
  })
  await page.goto('https://logos.test/fixture');await page.locator('[data-motion-ready="true"]').waitFor();await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0))
  for(const c of cases){const icon=page.locator(`[data-case="${c.key}"] .bb-transaction-icon`)
   assert.equal(await icon.getAttribute('data-merchant'),c.id);assert.equal(await icon.getAttribute('data-ready'),'true');assert((await icon.locator('img').getAttribute('src')).endsWith('/'+c.asset))
   const paint=await icon.evaluate(n=>({size:n.getBoundingClientRect().width,padding:getComputedStyle(n.querySelector('img')).padding,opacity:getComputedStyle(n.querySelector('img')).opacity,filter:getComputedStyle(n.querySelector('img')).filter}))
   assert.deepEqual(paint,{size:28,padding:'0px',opacity:'1',filter:'none'})
   if(c.sha256)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(assets,c.asset))).digest('hex'),c.sha256)
   if(c.kind==='company'){const calendar=page.locator(`[data-case="${c.key}"] .bb-cf-medallion`);assert.equal(await calendar.getAttribute('data-logo-ready'),'true');assert.equal(await calendar.getAttribute('data-prepared-circle'),'true');assert((await calendar.locator('img').getAttribute('src')).endsWith('/'+c.asset))}
  }
  const group=page.locator('.bb-daily-day-group'),header=group.locator('.bb-daily-day-header'),imageIds=()=>group.locator('.bb-transaction-icon img').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('src')))
  const before=await imageIds();await group.evaluate(n=>window.initialLogoNodes=[...n.querySelectorAll('img')]);await header.click();await page.waitForFunction(()=>document.querySelector('.bb-daily-day-group').dataset.moving==='false')
  await group.locator('.bb-daily-transaction-name',{hasText:'Starbucks'}).waitFor();assert.equal(await group.locator('.bb-daily-transaction-name',{hasText:'Starbucks Coffee Company'}).count(),0)
  await group.locator('.bb-transaction-icon img').evaluateAll(nodes=>nodes.forEach(n=>n.loading='eager'));await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0))
  const expanded=await imageIds();assert.equal(expanded.length,12);assert(before.every(src=>expanded.includes(src)))
  await header.click();await page.waitForFunction(()=>document.querySelector('.bb-daily-day-group').dataset.moving==='false');assert.deepEqual(await imageIds(),expanded)
  assert(await page.evaluate(()=>initialLogoNodes.every(n=>n.isConnected)),'Existing circle images must survive expansion/collapse')
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(traffic,[])
  if(width===390)await page.screenshot({path:`/private/tmp/published-logos-${engine.name()}-${dark?'dark':'light'}.png`,fullPage:true})
  await page.close();count++
 }
}finally{await browser.close()}}
console.log(JSON.stringify({cases:count,publishedLogos:11,matchedAlias:'Starbucks Coffee Company',status:'passed'}))
})().catch(e=>{console.error(e);process.exitCode=1})
