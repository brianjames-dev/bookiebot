// Real mounted Settings controllers and the production bundle; no financial writes.
const assert=require('node:assert/strict');
const {fixture,tap,engines,report}=require('./duo_layout_browser_test.cjs');
const delay=page=>page.waitForTimeout(400);
(async()=>{let cases=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{
   for(const [width,height]of [[382,657],[867,480]].filter(([w])=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
    const count={report:0,changes:0,notifications:0,widgets:0},state={revision:1,fail:false};
    const {page,errors,unexpected}=await fixture(browser,width,height,true,false,false,0,{report:()=>{count.report++;return report}});
    await page.addInitScript(()=>{delete window.PushManager});
    await page.route('**/app/account/changes',route=>{count.changes++;return route.fulfill({json:{revision:state.revision,ledgerVersion:'stable-ledger-'+state.revision}})});
    await page.route('**/app/notifications',route=>{assert.equal(route.request().method(),'GET');count.notifications++;return route.fulfill({json:{enabled:false,publicKey:'B'+'A'.repeat(86),preferences:{weekly:true,upcoming:false,showAmounts:false,hour:10}}})});
    await page.route('**/app/widgets/settings',route=>{assert.equal(route.request().method(),'GET');count.widgets++;return route.fulfill({json:{connections:[],scriptUrl:'/app/widgets/script',setupInstructionsUrl:'/app/widgets/help'}})});
    // The outer fixture counts successful reports; count failures here.
    await page.route('**/app/expenses/data',route=>{if(state.fail){count.report++;return route.fulfill({status:503,json:{error:'Google Sheets is temporarily busy.',code:'sheets_rate_limited'}})}return route.fallback()});
    await page.clock.install();Object.keys(count).forEach(key=>count[key]=0);
    await page.reload();await page.locator('.bb-metrics-grid').waitFor();await delay(page);
    const startup=count.report;
    await tap(page,page.getByRole('button',{name:'Settings',exact:true}));
    await tap(page,page.getByRole('button',{name:'Widgets',exact:true}));
    await page.getByRole('button',{name:'Pair a widget',exact:true}).waitFor();
    if(width<800)await tap(page,page.getByRole('button',{name:'Back',exact:true}));
    await tap(page,page.getByRole('button',{name:'Notifications',exact:true}));
    await page.getByRole('button',{name:'Monday',exact:true}).waitFor();await delay(page);
    assert.equal(count.report,startup,'Opening Settings must reuse the current Overview, not start a report/busy-state loop: '+JSON.stringify(count));
    const stable={...count};await page.clock.fastForward(20000);await delay(page);
    assert.equal(count.report,stable.report);assert.equal(count.notifications,stable.notifications);assert.equal(count.widgets,stable.widgets,'Unchanged cursor does not refresh/flicker Settings');
    state.revision++;await page.clock.fastForward(20000);await delay(page);
    assert.equal(count.report,startup+1,'One remote change causes one Overview refresh');
    assert.equal(count.notifications,stable.notifications,'Financial updates leave notification controls stable');
    assert.equal(count.widgets,stable.widgets,'Financial updates leave widget controls stable');
    const refreshed={...count};await delay(page);assert.deepEqual(count,refreshed,'The refresh finishing must not trigger itself again');
    state.fail=true;state.revision++;await page.clock.fastForward(20000);await delay(page);
    const failed=count.report;assert.equal(failed,refreshed.report+1);
    assert.equal(await page.getByRole('button',{name:'Refresh Settings',exact:true}).count(),0);
    assert.equal(await page.locator('.bb-pull-refresh-space').count(),0);
    await page.clock.fastForward(20000);await delay(page);assert.equal(count.report,failed);
    await page.clock.fastForward(20000);await delay(page);assert.equal(count.report,failed,'A Sheets 429 waits at least a minute before automatic retry');
    state.fail=false;await page.clock.fastForward(20000);await delay(page);assert.equal(count.report,failed+1);
    const recovered={...count};await page.clock.fastForward(20000);await delay(page);assert.equal(count.report,recovered.report);
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();cases++;console.log('PASS bounded shared refresh, phone preferences and 429 recovery',engine.name(),width,JSON.stringify(count));
   }
  }finally{await browser.close();}
 }
 console.log(cases+' native shared refresh-loop cases passed');
})().catch(error=>{console.error(error);process.exit(1)});
