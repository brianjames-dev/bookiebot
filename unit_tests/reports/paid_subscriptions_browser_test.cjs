// Production Transactions + server-generated subscription snapshots; no writers.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const fixture=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_PAID_SUBSCRIPTIONS_FIXTURE||'/private/tmp/bookiebot-paid-subscriptions-fixture.json','utf8'))
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
const bundlePromise=req('esbuild').build({stdin:{resolveDir:frontend,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{TransactionsScreen}from'./src/transactions-screen';import{ChartTooltipDismissProvider}from'./src/components/ui/chart';import{recordedEntry,recordedCategoryColors}from'./src/recorded-transaction-view';import{transactionCategory}from'./src/transaction-identity';
 const row=${JSON.stringify(fixture.results.search.items[0])};window.fallback=transactionCategory(recordedEntry({...row,title:'Unknown subscription',fields:{item:'Unknown subscription'}}));window.colors=recordedCategoryColors;
 createRoot(document.getElementById('root')).render(<ChartTooltipDismissProvider revision={0}><TransactionsScreen active ownerName="Brian" initialMonth="2026-11"/></ChartTooltipDismissProvider>);
 `},outfile:'/private/tmp/paid-subscriptions-browser-fixture.js',bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'unused-worker',setup(build){build.onResolve({filter:/\?worker&url$/},()=>({path:'unused',namespace:'worker'}));build.onLoad({filter:/.*/,namespace:'worker'},()=>({contents:'export default "data:application/javascript,"',loader:'js'}))}}]}).then(result=>result.outputFiles.find(file=>file.path.endsWith('.js')).text)
;(async()=>{const bundle=await bundlePromise;let cases=0;for(const engine of[chromium,webkit]){const browser=await engine.launch();try{for(const dark of[false,true]){
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),errors=[],writes=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url())
  if(url.origin!=='https://subscriptions.test')return route.abort()
  if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:`<html data-theme="${dark?'dark':'light'}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;padding:18px}</style><div id="root"></div><script>${bundle}</script></html>`})
  if(request.method()!=='GET'){writes.push(request.url());return route.abort()}
  if(url.pathname==='/app/transactions'){
   const q=url.searchParams,key=q.get('search')?'search':q.get('category')?'category':q.get('bucket')||q.get('kind')||'all'
   return route.fulfill({contentType:'application/json',body:JSON.stringify(fixture.results[key])})
  }
  if(url.pathname.startsWith('/app/assets/')){const file=path.join(assets,path.basename(url.pathname));if(fs.existsSync(file))return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.png')?'image/png':'image/svg+xml'})}
  return route.abort()
 })
 await page.goto('https://subscriptions.test/fixture')
 const screen=page.locator('.bb-transactions'),ready=()=>page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false')
 await ready();assert((await page.locator('.bb-daily-summary').innerText()).replace(/\s/g,'').includes('$2,693.07'))
 assert.equal(await page.getByText('YouTube Premium',{exact:true}).count(),0,'Future charges stay outside the recorded list')
 for(const[name,asset,category,token]of[['Xfinity','xfinity','Subs (Needs)','subs-needs'],['Slate Digital All Access','slate-digital','Subs (Wants)','subs-wants']]){
  const source=fixture.results.all.items.find(row=>row.title===name),row=page.locator('[data-entry-id="'+source.id+'"]')
  assert.equal(await row.locator('.bb-daily-transaction-category').textContent(),category)
  assert((await row.locator('img').getAttribute('src')).includes('company-logo-'+asset+'-'))
  assert.equal(await row.getByRole('button').count(),0,'Recurring rows have no purchase action rail')
  assert.equal(await row.locator('.bb-daily-transaction-category').evaluate(el=>el.style.color),'hsl(var(--category-'+token+'))')
  const bounds=await row.boundingBox();await page.mouse.move(bounds.x+bounds.width*.8,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+15,bounds.y+bounds.height/2,{steps:8});await page.mouse.up();await page.waitForTimeout(460)
  assert.equal(await row.locator('.bb-recorded-swipe-actions').count(),0)
 }
 const probe=await page.evaluate(()=>({fallback:window.fallback,colors:window.colors}));assert.equal(probe.fallback.icon,'repeat');assert.equal(probe.fallback.token,'subs-wants');assert.equal(probe.colors['Subs (Wants)'],'hsl(var(--category-subs-wants))')
 await screen.getByRole('button',{name:'Show spending graph',exact:true}).click();await page.waitForTimeout(470)
 const filter=screen.getByRole('combobox',{name:'Filter transactions',exact:true})
 for(const[value,key]of[['wants','wants'],['needs','needs'],['category:subscriptions_wants','category'],['all','all']]){
  await filter.selectOption(value);await ready()
  const expected=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(fixture.results[key].totalAmountCents/100)
  assert((await page.locator('.bb-daily-summary').innerText()).replace(/\s/g,'').includes(expected))
 }
 await screen.getByRole('searchbox',{name:'Search transactions',exact:true}).fill('slate');await page.waitForTimeout(300);await ready()
 assert.equal(await page.locator('.bb-daily-transaction').count(),1);assert((await page.locator('.bb-daily-summary').innerText()).replace(/\s/g,'').includes('$14.99'))
 await screen.getByRole('button',{name:'Clear search',exact:true}).click();await ready()
 await screen.getByRole('button',{name:'Hide spending graph',exact:true}).click();await page.waitForTimeout(470)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(writes,[])
 await page.screenshot({path:`/private/tmp/paid-subscriptions-${engine.name()}-${dark?'dark':'light'}.png`,fullPage:true});await page.close();cases++
 }}finally{await browser.close()}}console.log(JSON.stringify({cases,status:'passed',viewport:'390x844',financialWrites:0}))})().catch(e=>{console.error(e);process.exitCode=1})
