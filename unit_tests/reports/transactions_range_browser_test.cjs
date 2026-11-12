// Real production UI, synthetic read-only transactions. The black-backing case
// models WebKit 322885; current desktop WebKit cannot prove physical iOS paint.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {fixture,tap,engines,report}=require('./duo_layout_browser_test.cjs');
const poses=process.env.BOOKIEBOT_DUO_POSE?[process.env.BOOKIEBOT_DUO_POSE.split('x').map(Number)]:[[382,657],[867,480],[867,669],[951,648]];
const ledger=[];
function add(date,location,category='food',amount=1000){const id='range-'+ledger.length;ledger.push({id,actionId:id,month:date.slice(0,7),version:'fixture-v1',date,title:'Fixture '+id,location,person:'Brian',kind:'expense',category,categoryLabel:category==='gas'?'Gas':'Food',amountCents:amount,split:'',fields:{item:'Fixture '+id},editableFields:[],capabilities:{},reasons:{}})}
for(const month of ['2025-10','2025-11','2026-07','2026-08','2026-09','2026-10','2026-11'])add(month+'-20','Unknown fixture');
add('2026-10-08','Chevron','gas');add('2026-10-08','Costco','gas');add('2026-10-10','Whole Foods','grocery');add('2026-10-10','Unknown fixture');
for(let i=0;i<51;i++)add('2026-09-15','Fixture September '+i,'food',100+i);
add('2026-09-02','Fixture other day');
const days=rows=>{const values=new Map();for(const row of rows){const d=values.get(row.date)||{date:row.date,month:row.month,count:0,totalCents:0,needsCents:0,wantsCents:0};d.count++;d.totalCents+=row.amountCents;d[row.category==='food'?'wantsCents':'needsCents']+=row.amountCents;values.set(row.date,d)}return [...values.values()]};
const ready=page=>page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false');
async function graphReady(page){await page.waitForFunction(()=>document.querySelector('.bb-recorded-graph-clip')?.getAttribute('aria-busy')==='false'&&document.querySelector('.bb-daily-plot'));}
async function point(page,labels,label){return page.locator('.bb-daily-plot .bb-chart-motion-surface').evaluate((el,{labels,label})=>{const r=el.querySelector('.recharts-cartesian-grid-horizontal line').getBoundingClientRect(),b=el.getBoundingClientRect();return{x:r.left+r.width*(labels.indexOf(label)+.5)/labels.length,y:Math.max(20,b.top+Math.min(90,b.height/2))}},{labels,label});}
async function scrub(page,from,to){await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:5});await page.mouse.up();}
async function touchScrub(page,from,to){const client=await page.context().newCDPSession(page);try{await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});for(let i=1;i<=6;i++){await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*i/6,y:from.y+(to.y-from.y)*i/6}]});await page.waitForTimeout(20)}await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})}finally{await client.detach()}}
async function backingPixels(page,unsafe){
 const style=await page.addStyleTag({content:'.bb-daily-bead-body{background:#000!important}'+(unsafe?'.bb-daily-bead-body{border-radius:0!important;overflow:visible!important}':'')});
 try{
  const points=await page.locator('.bb-daily-single-day .bb-daily-bead-body, .bb-daily-bead:has([data-merchant="chevron"]) .bb-daily-bead-body, .bb-daily-bead:has([data-merchant="costco"]) .bb-daily-bead-body').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect(),c=getComputedStyle(document.querySelector('.bb-page')).backgroundColor.match(/[\d.]+/g).slice(0,3).map(Number);return{x:r.x+(n.querySelector('[data-merchant=\"costco\"]')?27:1),y:r.y+1,color:c}}));assert(points.length);
  const file='/private/tmp/bookiebot-backing-'+(unsafe?'unsafe':'bounded')+'.png';await page.screenshot({path:file});
  return JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`import json,sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB');p=json.loads(sys.argv[2]);print(json.dumps([list(im.getpixel((round(v['x']),round(v['y'])))) for v in p]))`,file,JSON.stringify(points)],{encoding:'utf8'})).map((color,i)=>({color,expected:points[i].color}));
 }finally{await style.evaluate(el=>el.remove());}
}
;(async()=>{let count=0;
for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const dark of [false,true])for(const [width,height]of poses){
  const reads=[],state={fail:false};const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{
   report:url=>{const value=url.searchParams.get('month')||'2026-10';return{...structuredClone(report),year:Number(value.slice(0,4)),month:Number(value.slice(5)),monthLabel:new Date(value+'-01T12:00:00').toLocaleDateString('en-US',{month:'long',year:'numeric'})}},
   transactions:async route=>{
    assert.equal(route.request().method(),'GET','Graph/list interaction is read-only');const q=new URL(route.request().url()).searchParams;reads.push(Object.fromEntries(q));
    if(q.get('month')==='all'&&state.fail)return route.fulfill({status:503,json:{error:'Graph source offline fixture'}});
    const all=ledger.filter(row=>(q.get('month')==='all'||row.month===q.get('month'))&&(!q.get('bucket')||q.get('bucket')===(row.category==='food'?'wants':'needs'))).sort((a,b)=>b.date.localeCompare(a.date));
    const visible=all.filter(row=>!q.get('day')||row.date===q.get('day')),offset=Number(q.get('offset')||0);
    return route.fulfill({json:{items:visible.slice(offset,offset+40),total:visible.length,nextOffset:visible.length>offset+40?offset+40:null,days:days(all),totalAmountCents:all.reduce((sum,row)=>sum+row.amountCents,0),categories:['food','gas','grocery'],persons:['Brian'],month:q.get('month'),snapshotVersion:'fixture-'+q.get('month')+'-'+q.get('bucket')}});
   }
  });
  await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await page.locator('.bb-transactions .bb-daily-day-group').first().waitFor();await ready(page);
  const total=await page.locator('.bb-daily-amount-row').innerText(),listBefore=await page.locator('.bb-transaction-list').innerText();assert(reads.every(r=>r.month==='2026-10'));
  if(width<800){await page.getByRole('button',{name:'Show spending graph',exact:true}).click();await page.locator('.bb-recorded-graph-reveal[data-open="true"]').waitFor();}
  await graphReady(page);
  if(engine.name()==='chromium'&&width===382&&!dark){
   await page.locator('.bb-daily-plot').scrollIntoViewIfNeeded();const start=await page.locator('.bb-daily-plot').evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:Math.max(120,r.top+100)}}),before=await page.locator('.bb-page').evaluate(el=>el.scrollTop);
   await touchScrub(page,start,{x:start.x,y:start.y-85});await page.waitForTimeout(100);assert.equal(await page.locator('.bb-recorded-day-chip').count(),0,'Native vertical pan never selects a date');assert(await page.locator('.bb-page').evaluate(el=>el.scrollTop)>before+20,'Touch still scrolls the closed page');
  }
  const period=page.getByRole('combobox',{name:'Graph period',exact:true});assert.equal(await period.inputValue(),'0');
  if(width>=800){
   const geometry=await page.evaluate(()=>{const box=s=>document.querySelector(s).getBoundingClientRect(),title=box('#bb-main-page-title'),caption=box('.bb-transaction-scope'),legend=box('.bb-daily-legend li'),ticks=[...document.querySelectorAll('.bb-daily-spending-x-axis-label')].map(n=>n.getBoundingClientRect());return{gap:caption.top-title.bottom,legendGap:legend.top-Math.max(...ticks.map(r=>r.bottom))}});
   assert(geometry.gap>=-16&&geometry.gap<=0,'The month sits close to the title: '+JSON.stringify(geometry));assert(geometry.legendGap>=0&&geometry.legendGap<=18,'The legend follows the date labels closely: '+JSON.stringify(geometry));
   await page.waitForFunction(()=>[...document.querySelectorAll('[data-merchant="chevron"] img')].every(img=>img.complete&&img.naturalWidth));
   const unsafe=await backingPixels(page,true);assert(unsafe.some(p=>p.color.every(c=>c<5)),'The fixture exposes a rectangular black backing: '+JSON.stringify(unsafe));
   const bounded=await backingPixels(page,false);assert(bounded.every(p=>p.color.every((c,i)=>Math.abs(c-p.expected[i])<=3)),'Round backing clips remove black corners while preserving transparent gaps: '+JSON.stringify(bounded));
  }
  await period.selectOption('3');await page.waitForFunction(()=>!document.querySelector('.bb-recorded-graph-status'));await graphReady(page);assert.equal(reads.at(-1).month,'all');
  assert.equal(await page.locator('.bb-transaction-list').innerText(),listBefore,'The range selector does not change the list');assert.equal(await page.locator('.bb-daily-amount-row').innerText(),total);
  const historyCount=reads.length;await period.selectOption('6');await graphReady(page);assert.equal(reads.length,historyCount,'Window changes reuse the full daily snapshot');await period.selectOption('12');await graphReady(page);
  const renderedLabels=await page.locator('.bb-daily-spending-x-axis-label').allTextContents();assert(renderedLabels.some(label=>label.includes('Nov')),'The year-boundary window renders prior November');
  await period.selectOption('3');await graphReady(page);
  const labels3=days(ledger.filter(r=>r.month>='2026-08'&&r.month<='2026-10')).map(d=>d.date).sort();
  if(width<800)await page.locator('.bb-daily-plot').scrollIntoViewIfNeeded();
  const from=await point(page,labels3,'2026-08-20'),to=await point(page,labels3,'2026-09-15');
  if(engine.name()==='chromium'&&width===867&&height===669&&!dark)await touchScrub(page,from,to);else await scrub(page,from,to);
  await page.waitForFunction(()=>document.querySelector('.bb-transaction-scope')?.textContent==='September 2026');await page.getByRole('button',{name:/Sep 15/}).waitFor();await ready(page);
  assert(reads.some(r=>r.month==='2026-09'&&r.day==='2026-09-15'),'Release selects the final date and jumps the list month');assert.equal(await period.inputValue(),'3');
  await page.locator('.bb-daily-day-header').click();await page.waitForFunction(()=>document.querySelector('.bb-daily-day-group')?.dataset.moving==='false');assert.equal(await page.locator('.bb-transaction-list [data-entry-id]').count(),40);await page.getByRole('button',{name:'Load more transactions',exact:true}).click();await ready(page);assert.equal(await page.locator('.bb-transaction-list [data-entry-id]').count(),51,'A chosen date remains complete beyond the first page');
  assert.equal(await page.getByRole('button',{name:/Sep 15/}).count(),1,'The follow-up click cannot undo drag selection');
  await page.getByRole('button',{name:/Sep 15/}).click();await ready(page);await period.selectOption('0');await graphReady(page);
  state.fail=true;await period.selectOption('3');await page.getByRole('alert').getByText('Graph source offline fixture',{exact:true}).waitFor();assert.equal(await page.locator('.bb-transaction-scope').innerText(),'September 2026');state.fail=false;await page.getByRole('button',{name:'Retry graph',exact:true}).click();await graphReady(page);
  if(process.env.BOOKIEBOT_DUO_SHOTS)await page.screenshot({path:path.join(process.env.BOOKIEBOT_DUO_SHOTS,`transactions-range-${engine.name()}-${width}x${height}-${dark?'dark':'light'}.png`)});
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();count++;console.log('PASS range/release/backing',engine.name(),width,height,dark?'dark':'light');
 }}finally{await browser.close()}
}
console.log('PASS',count,'Transactions range/date pagination/spacing/backing cases');
})().catch(error=>{console.error(error);process.exitCode=1});
