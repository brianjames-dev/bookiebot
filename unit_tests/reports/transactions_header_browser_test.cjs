// Production app, read-only synthetic ledger. No live financial requests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines,report}=require('./duo_layout_browser_test.cjs');
const poses=process.env.BOOKIEBOT_DUO_POSE?[process.env.BOOKIEBOT_DUO_POSE.split('x').map(Number)]:[[320,657],[382,657],[466,678],[867,480],[867,669],[951,648]];
function listing(month){
 const items=Array.from({length:20},(_,i)=>({id:'header-'+i,actionId:'header-'+i,version:'fixture-v1',month:month==='all'?'2026-10':month,date:(month==='all'?'2026-10':month)+'-'+String(i+1).padStart(2,'0'),title:'Fixture purchase '+i,location:'Fixture',person:'Brian',kind:'expense',category:'food',categoryLabel:'Food',amountCents:1000+i*250,split:'',fields:{},editableFields:[],capabilities:{},reasons:{}}));
 return {items,total:items.length,nextOffset:null,categories:['food'],persons:['Brian'],month,days:items.map(row=>({month:row.month,date:row.date,count:1,totalCents:row.amountCents,needsCents:0,wantsCents:row.amountCents})),totalAmountCents:items.reduce((sum,row)=>sum+row.amountCents,0)};
}
const ready=page=>page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false');
const stamp=page=>page.locator('.bb-brand-status time').getAttribute('datetime');
const advance=page=>page.evaluate(()=>window.__headerClock+=120_000);
const updated=page=>page.waitForFunction(()=>document.querySelector('.bb-brand-status time')?.dateTime===new Date(window.__headerClock).toISOString());
;(async()=>{let count=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{
   for(const dark of [false,true])for(const [width,height]of poses){
    const reads=[],state={fail:false,hold:false,release:null};
    const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{
     report:url=>({...structuredClone(report),...(url.searchParams.get('month')==='2026-09'?{year:2026,month:9,monthLabel:'September 2026'}:{})}),
     transactions:async route=>{
      assert.equal(route.request().method(),'GET');const month=new URL(route.request().url()).searchParams.get('month');reads.push(month);
      if(state.hold)await new Promise(resolve=>state.release=resolve);
      return route.fulfill(state.fail?{status:503,json:{error:'Offline fixture'}}:{json:listing(month)});
     }
    });
    const overviewTime=await stamp(page),overviewY=await page.locator('#bb-main-page-title').evaluate(el=>el.getBoundingClientRect().y);
    await page.evaluate(()=>{
     const NativeDate=Date;window.__headerClock=Date.now()+120_000;
     window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[window.__headerClock]))}static now(){return window.__headerClock}};
    });
    state.hold=true;await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));
    await page.getByText('Not updated yet',{exact:true}).waitFor();assert.equal(await page.locator('.bb-brand-status time').count(),0);
    await page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='true');
    while(!state.release)await page.waitForTimeout(10);state.hold=false;state.release();await ready(page);await updated(page);
    const transactionTime=await stamp(page);assert.equal(transactionTime,await page.evaluate(()=>new Date(window.__headerClock).toISOString()));assert.notEqual(transactionTime,overviewTime);
    assert.equal(await page.getByRole('heading',{name:'Daily Spending',exact:true}).count(),0,'The redundant chart title is gone');
    const bounds=await page.evaluate(()=>{
     const rect=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();
     return {title:rect('#bb-main-page-title'),all:rect('.bb-transaction-all-months'),month:rect('.bb-transaction-scope'),header:rect('.bb-page > .bb-report-header'),page:rect('.bb-page'),graph:rect('.bb-recorded-graph-reveal'),bodyWidth:document.documentElement.scrollWidth,windowWidth:innerWidth};
    });
    assert.equal(bounds.title.y,overviewY,'Transactions retains the shared title position');
    assert(Math.abs(bounds.title.y+bounds.title.height/2-bounds.all.y-bounds.all.height/2)<=1,'All months is centered on the title row: '+JSON.stringify(bounds));
    assert(bounds.all.x>=bounds.title.right+4&&bounds.all.right<=bounds.header.right+1,'Title and All months fit without overlap');
    assert(bounds.all.height>=44,'All months keeps its touch target');
    assert(bounds.month.y-bounds.title.bottom>=-1&&bounds.month.y-bounds.title.bottom<=10,'Month caption sits directly beneath the title: '+JSON.stringify(bounds));
    assert(bounds.bodyWidth<=bounds.windowWidth,'The header never creates horizontal overflow');
    if(width>=800){
     const graphTop=await page.locator('.bb-daily-plot').evaluate(el=>el.getBoundingClientRect().top);
     assert(graphTop<bounds.graph.y+20,'No empty title row remains above the graph');
     assert(bounds.all.right<width-60,'All months stays in the left pane, clear of the native strip');
    }
    const all=page.getByRole('button',{name:'All recorded months',exact:true});await advance(page);await all.click();await ready(page);await updated(page);
    assert.equal(reads.at(-1),'all');assert.equal(await all.getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.bb-transaction-scope').innerText(),'All months');
    assert.notEqual(await stamp(page),transactionTime);await all.click();await ready(page);assert.equal(reads.at(-1),'2026-10');
    const lastGood=await stamp(page);state.fail=true;await advance(page);
    await page.getByRole('searchbox',{name:'Search transactions',exact:true}).fill('missing');await page.getByRole('alert').getByText('Offline fixture',{exact:true}).waitFor();await ready(page);assert.equal(await stamp(page),lastGood,'Failed reads retain the last successful update');
    state.fail=false;await advance(page);await page.getByRole('button',{name:'Refresh transactions',exact:true}).click();await ready(page);await updated(page);assert.notEqual(await stamp(page),lastGood);
    const beforeMonth=await stamp(page);await advance(page);
    await page.getByRole('button',{name:'Report month',exact:true}).click();await page.getByRole('dialog',{name:'Report month',exact:true}).getByRole('button',{name:'September 2026',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.bb-transaction-scope')?.textContent==='September 2026');await ready(page);await updated(page);assert.equal(reads.at(-1),'2026-09');assert.notEqual(await stamp(page),beforeMonth);
    const retained=await stamp(page);await advance(page);await tap(page,page.getByRole('button',{name:'Overview',exact:true}));await page.locator('.bb-page[data-screen="overview"]').waitFor();assert.notEqual(await stamp(page),retained,'Overview keeps its own status');
    await tap(page,page.getByRole('button',{name:'Shared',exact:true}));await page.locator('.bb-page[data-screen="shared"]').waitFor();assert.equal(await page.locator('.bb-transaction-all-months:visible').count(),0,'Transaction control is hidden on other tabs');
    await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await ready(page);await updated(page);assert.equal(await stamp(page),await page.evaluate(()=>new Date(window.__headerClock).toISOString()),'Reopening Transactions reports its own successful refresh');
    if(process.env.BOOKIEBOT_DUO_SHOTS){await page.getByRole('button',{name:'Clear search',exact:true}).click();await ready(page);await page.screenshot({path:path.join(process.env.BOOKIEBOT_DUO_SHOTS,`transactions-header-${engine.name()}-${width}x${height}-${dark?'dark':'light'}.png`)});}
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();count++;console.log('PASS Transactions header',engine.name(),width,height,dark?'dark':'light');
   }
  }finally{await browser.close();}
 }
 console.log('PASS',count,'Transactions title/control/caption/update-time cases');
})().catch(error=>{console.error(error);process.exitCode=1});
