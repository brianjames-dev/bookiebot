// Shipped app: retained inner scroll and editors survive OS-style root pan/resume.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const out='/private/tmp/bookiebot-branded-resume';fs.mkdirSync(out,{recursive:true});
const settle=page=>page.waitForTimeout(400);
(async()=>{let count=0;for(const engine of engines){const browser=await engine.launch({headless:true});try{for(const [width,height]of [[951,669],[867,480]]){
 const {page,errors,unexpected}=await fixture(browser,width,height,true);const tag=engine.name()+'-'+width+'-'+height;
 try{
  let reference;
  for(const tab of ['Overview','Transactions','Shared','Savings']){
   await tap(page,page.getByRole('button',{name:tab,exact:true}));await settle(page);
   const box=await page.locator('.bb-shell-masthead .bb-chat-portrait').boundingBox();assert(box);if(!reference)reference=box;else assert.deepEqual(box,reference,'Every main tab shares the exact portrait position and size');
  }
  await tap(page,page.getByRole('button',{name:'Overview',exact:true}));
  await page.setViewportSize({width:382,height:657});await settle(page);
  const surface=page.locator('.bb-page');await surface.evaluate(el=>el.scrollTop=180);await settle(page);
  await page.evaluate(()=>{
   // Desktop engines cannot reproduce an iOS-restored root pan while CSS
   // forbids document scrolling. Replay that OS-reported offset, then let the
   // real lifecycle handler repair it without touching native inner scroll.
   let restored=28;const native=window.scrollTo.bind(window);
   Object.defineProperty(window,'scrollY',{configurable:true,get:()=>restored});
   window.scrollTo=(...args)=>{if((typeof args[0]==='object'&&args[0].top===0)||(args[0]===0&&args[1]===0))restored=0;native(...args)};
  });assert.equal(await page.evaluate(()=>window.scrollY),28);
  const contentY=await surface.evaluate(el=>el.scrollTop);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await settle(page);
  assert.equal(await page.evaluate(()=>window.scrollY),0);assert.equal(await surface.evaluate(el=>el.scrollTop),contentY,'Resume preserves the user’s content position');
  assert.equal((await surface.boundingBox()).y,0);
  // A fold while backgrounded must be recognized even with no visible resize.
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'))});
  await page.setViewportSize({width,height});await settle(page);assert.equal(await surface.getAttribute('data-duo-landscape'),null);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))});await settle(page);
  assert.equal(await surface.getAttribute('data-duo-landscape'),'true');assert.equal((await surface.boundingBox()).y,0);
  await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await settle(page);
  const search=page.getByRole('searchbox');await search.fill('Fixture');await search.evaluate(el=>el.__retained=true);await search.blur();
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await settle(page);assert.equal(await search.inputValue(),'Fixture');assert(await search.evaluate(el=>el.__retained),'Resume retains the same draft DOM');
  await page.setViewportSize({width:382,height:657});await settle(page);await page.evaluate(()=>window.dispatchEvent(new Event('orientationchange')));await settle(page);
  assert.equal(await surface.getAttribute('data-duo-landscape'),null);assert.equal((await surface.boundingBox()).y,0);assert.equal(await search.inputValue(),'Fixture');
  const nav=await page.locator('.bb-navigation-pane').boundingBox();assert(nav&&nav.y+nav.height<=657&&nav.y+nav.height>620,'The original body-level dock remains at the viewport bottom');
  await page.screenshot({path:out+'/'+tag+'-resumed.png'});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);count++;console.log('PASS resume/fold canvas, scroll/draft and header parity',tag);
 }catch(error){await page.screenshot({path:out+'/failure-'+tag+'.png',fullPage:true});throw error}finally{await page.close()}
 }}finally{await browser.close()}}console.log(count+' native resume/header cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
