// Real app bundle; all financial reads/writes below are isolated synthetic fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines,report}=require('./duo_layout_browser_test.cjs');
const canonical=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_TRANSACTION_WORKSPACE_FIXTURES||'/private/tmp/bookiebot-transactions-workspace.json','utf8'));
const poses=process.env.BOOKIEBOT_DUO_POSE?[process.env.BOOKIEBOT_DUO_POSE.split('x').map(Number)]:[[382,657],[867,480],[867,669],[951,648]];
const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
async function title(page){return page.locator('.bb-page > .bb-report-header').evaluate(header=>{
 const h=header.querySelector('h1'),r=h.getBoundingClientRect(),s=getComputedStyle(h),surface=document.querySelector('.bb-page');
 return {text:h.textContent,x:r.x,y:r.y,font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,line:s.lineHeight,buttons:h.querySelectorAll('button').length,background:getComputedStyle(surface).backgroundColor};
});}
;(async()=>{let count=0;
for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{
 for(const dark of [false,true])for(const [width,height]of poses){
  const wide=width>=800,stores=new Map(),reads=[],commands=[];let undo=null;
  function rows(month){if(!stores.has(month))stores.set(month,canonical.sources.slice(0,5).map((r,i)=>({...r,id:month+':polish-'+i,month,date:month+r.date.slice(7),version:'fixture-'+i,fields:{...r.fields,date:month+r.date.slice(7)},splitOptions:{...r.splitOptions,custom:true}})));return stores.get(month);}
  const sample=rows('2026-10')[0];
  const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{
   report:url=>{const value=structuredClone(report),month=url.searchParams.get('month')||'2026-10';value.year=Number(month.slice(0,4));value.month=Number(month.slice(5));value.monthLabel=new Date(month+'-01T12:00:00').toLocaleDateString('en-US',{month:'long',year:'numeric'});return value;},
   transactions:route=>{
    const req=route.request(),url=new URL(req.url()),body=req.postDataJSON(),reply=value=>route.fulfill({json:value});
    if(req.method()==='GET'){
     const month=url.searchParams.get('month')||'2026-10',items=rows(month),days=[];reads.push(month);
     for(const row of items){let day=days.find(d=>d.date===row.date);if(!day){day={month,date:row.date,count:0,totalCents:0,needsCents:0,wantsCents:0};days.push(day)}day.count++;day.totalCents+=row.amountCents;day.wantsCents+=row.amountCents;}
     return reply({items,days,total:items.length,totalAmountCents:items.reduce((n,r)=>n+r.amountCents,0),nextOffset:null,categories:['food','shopping','grocery'],persons:['Brian'],month,snapshotVersion:'fixture-'+commands.length});
    }
    const row=body.operation==='undo'?{...undo.row,id:undo.id}:rows(body.month).find(r=>r.id===body.id);assert(row);
    const review={item:row,operation:body.operation,destination:body.destination,reviewVersion:'fixture-review',after:{...row.fields,...body.updates,...(body.updates?.amount?{amount:(body.updates.amount/100).toFixed(2)}:{})}};
    if(url.pathname.endsWith('/review'))return reply({review});
    assert.equal(url.pathname,'/app/transactions');assert.equal(body.reviewVersion,review.reviewVersion);commands.push(body);
    const summary={...review,title:row.title,date:row.date,category:row.categoryLabel,location:row.location,person:row.person,amountCents:row.amountCents,before:row.fields};
    if(body.operation==='undo')stores.set(row.month,undo.rows.map((r,i)=>process.env.BOOKIEBOT_TEST_EXTRA_ID_CHANGE&&i===1?{...r,id:r.id+'-shifted'}:r));
    else{undo={row,id:row.id+'-saved',rows:structuredClone(rows(row.month))};stores.set(row.month,rows(row.month).map(r=>r.id===row.id?{...r,id:undo.id,fields:review.after,amountCents:body.updates.amount,category:body.destination||r.category,categoryLabel:body.destination?'Shopping':r.categoryLabel}:r));}
    return reply({state:'done',success:true,summary,...(body.operation==='undo'?{}:{undo:{month:row.month,id:undo.id}})});
   }
  });
  await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>document.fonts.ready);const original=await title(page);
  for(const [label,key]of [['Shared','shared'],['Savings','savings'],['Reconcile','reconcile'],['Transactions','transactions']]){
   await tap(page,page.getByRole('button',{name:label,exact:true}));await page.locator('.bb-page[data-screen="'+key+'"]').waitFor();
   const current=await title(page);assert.equal(current.text,label);
   for(const property of ['x','y','font','size','weight','line','background'])assert.equal(current[property],original[property],label+' shares Overview title '+property);
   assert.equal(current.buttons,key==='transactions'?1:0,'Only Transactions adds a month picker');
   const bands=await page.locator('.bb-page > main:not([hidden]) > .bb-report-section').evaluateAll(nodes=>nodes.map(n=>({color:getComputedStyle(n).backgroundColor,shadow:getComputedStyle(n).boxShadow})));
   assert(bands.every(b=>(b.color==='rgba(0, 0, 0, 0)'||b.color===original.background)&&b.shadow==='none'),'Main sections must not paint alternate full-width background bands: '+JSON.stringify(bands));
  }
  const ready=()=>page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false');await ready();
  const monthButton=page.locator('.bb-page > .bb-report-header').getByRole('button',{name:'Report month',exact:true});
  await monthButton.click();await page.getByRole('dialog',{name:'Report month',exact:true}).getByRole('button',{name:'September 2026',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.bb-transaction-scope')?.textContent.includes('September 2026'));await ready();assert.equal(reads.at(-1),'2026-09');
  await monthButton.click();await page.getByRole('dialog',{name:'Report month',exact:true}).getByRole('button',{name:'October 2026',exact:true}).click();await ready();
  await page.waitForFunction(()=>document.querySelector('.bb-transaction-scope')?.textContent.includes('October 2026'));
  if(wide){
   const g=await page.locator('.bb-daily-plot').evaluate(plot=>{const box=plot.querySelector('.bb-chart-box').getBoundingClientRect(),line=plot.querySelector('.recharts-cartesian-grid-horizontal line').getBoundingClientRect();return{body:box.toJSON(),line:line.toJSON()}});
   assert(Math.abs(g.body.right-g.line.right-8)<1,'Daily Spending uses Overview’s 8px internal right margin');
   assert(g.line.width>g.body.width*.75,'Automatic dollar-axis width gives the plot the same width policy as Overview');
  }
  const header=page.locator('.bb-daily-day-header').first();await header.click();await page.waitForFunction(()=>document.querySelector('.bb-daily-day-group')?.dataset.moving==='false');
  const access=page.getByRole('button',{name:'Show actions for Starbucks Coffee Company',exact:true});
  if(wide){
   await access.click();
   const paint=await page.locator('.bb-recorded-results').evaluate(scroller=>{const row=scroller.querySelector('[data-duo-selected="true"]'),r=row.getBoundingClientRect(),s=scroller.getBoundingClientRect();return{gap:s.right-r.right,isolation:getComputedStyle(scroller.querySelector('.bb-transaction-list')).isolation,access:getComputedStyle(row.querySelector('.bb-recorded-row-access')).transform}});
   assert(paint.gap>=8,'The native scroll indicator has a clear strip above row paint');assert.equal(paint.isolation,'isolate');assert.equal(paint.access,'none');
   await page.getByRole('button',{name:/^Edit Starbucks/}).click();
  }else{await access.press('ArrowLeft');await page.getByRole('button',{name:'Update Starbucks Coffee Company',exact:true}).click();}
  const editor=page.getByRole('region',{name:'Edit transaction',exact:true});await editor.getByRole('textbox',{name:'Amount',exact:true}).fill('12.75');await editor.getByRole('textbox',{name:'Item',exact:true}).fill('Changed fixture');await editor.getByRole('combobox',{name:'Update category',exact:true}).selectOption('shopping');
  await editor.getByRole('button',{name:'Review change',exact:true}).click();await editor.getByRole('button',{name:'Confirm update',exact:true}).click();
  const popup=page.getByRole('dialog',{name:'Purchase updated',exact:true});await popup.waitFor();await popup.getByRole('button',{name:'Undo',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.bb-transactions')?.dataset.savePhase==='animating');
  const change=page.locator('[data-change-key="row:'+sample.id+'-saved:amount"]');assert.equal(await change.getAttribute('data-value'),money(sample.amountCents));
  assert(await change.evaluate(el=>el.getAnimations({subtree:true}).length)>0,'Undo runs the digit reel animations');
  assert.equal(await page.locator('[data-change-key="row:'+sample.id+'-saved:item"]').getAttribute('data-change-state'),'text','Undo also animates changed descriptions');
  await ready();assert.equal(commands.length,2);assert.deepEqual(commands.map(c=>c.operation),['move','undo']);
  assert.equal(rows('2026-10')[0].fields.item,sample.fields.item);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  if(process.env.BOOKIEBOT_DUO_SHOTS){fs.mkdirSync(process.env.BOOKIEBOT_DUO_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.BOOKIEBOT_DUO_SHOTS,`polish-${engine.name()}-${width}x${height}-${dark?'dark':'light'}.png`)});}
  await page.close();count++;console.log('PASS Duo polish',engine.name(),width,height,dark?'dark':'light');
 }
 }finally{await browser.close()}
}
console.log(count+' title/month/surface/axis/scrollbar/Undo cases passed');
})().catch(error=>{console.error(error);process.exitCode=1});
