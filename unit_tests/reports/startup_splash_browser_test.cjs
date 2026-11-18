// Actual first-paint HTML and shipped assets, with isolated account/report responses.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,engines}=require('./duo_layout_browser_test.cjs');
const htmlPath=process.env.BOOKIEBOT_SPLASH_HTML,html=fs.readFileSync(htmlPath,'utf8');
const data=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_OVERVIEW_FIXTURE,'utf8'));
const assets=path.resolve(__dirname,'../../src/bookiebot/reports/assets');
const version=JSON.parse(html.match(/id="bookiebot-expense-app-config" type="application\/json">(.*?)<\/script>/s)[1]).version;
const output='/private/tmp/bookiebot-overview-shots';fs.mkdirSync(output,{recursive:true});
(async()=>{let cases=0;for(const engine of engines){const browser=await engine.launch({headless:true});try{for(const [width,height,dark] of [[382,657,true],[951,669,false]])for(const failure of [false,true]){
 let releaseAccount,releaseReport;
 const f=await fixture(browser,width,height,dark,false,false,0,{waitForReady:false,init:page=>page.addInitScript(dark=>{
  localStorage.setItem('bookiebot-expense-report-theme',dark?'dark':'light');localStorage.setItem('bookiebot:duo-layout:brian','true');
 },dark),request:async route=>{const url=new URL(route.request().url()),name=url.pathname;
  if(name==='/app/expenses'){await route.fulfill({contentType:'text/html',body:html});return true}
  if(['/app/assets/expense-report-app.js','/app/assets/expense-report-app.css'].includes(name)){await route.fulfill({contentType:name.endsWith('.js')?'application/javascript':'text/css',body:fs.readFileSync(path.join(assets,path.basename(name)))});return true}
  if(name==='/app/assets/theme.js'){await route.fulfill({contentType:'application/javascript',body:fs.readFileSync(htmlPath+'.theme.js','utf8')});return true}
  if(name==='/app/bootstrap'){await new Promise(resolve=>releaseAccount=resolve);await route.fulfill(failure?{status:503,json:{error:'Temporary fixture failure'}}:{json:{phase:'ready',provider:'sheets',account:{id:'legacy-brian',name:'Brian'}}});return true}
  if(name==='/app/expenses/data'){await new Promise(resolve=>releaseReport=resolve);await route.fulfill({json:data.initial.reports.brian});return true}
  if(name==='/app/reimbursements'){await route.fulfill({json:data.initial.snapshots.brian});return true}
  if(name==='/app/version'){await route.fulfill({json:{version}});return true}
  if(name==='/app/manifest.webmanifest'){await route.fulfill({json:{name:'BookieBot',start_url:'/app/expenses',display:'standalone'}});return true}
  if(name==='/app/household'){await route.fulfill({json:{household:null,invitations:[]}});return true}
  return false;
 }});
 const {page,errors,unexpected}=f,tag=engine.name()+'-'+width+(failure?'-error':'');
 try{
  await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>document.querySelector('.bb-startup-pending'));
  await page.locator('#bookiebot-startup-splash').evaluate(el=>el.__sameSplash=true);
  const ring=page.locator('#bookiebot-startup-splash .bb-report-loading-spinner');
  const check=async(w,h)=>{const b=await page.locator('.bb-startup-brand').boundingBox();assert(b);assert(Math.abs(b.x+b.width/2-w/2)<1);assert(Math.abs(b.y+b.height/2-h/2)<1);assert.equal(await ring.evaluate(el=>getComputedStyle(el).width),'36px');assert.equal(await page.locator('#bookiebot-startup-splash h1').innerText(),'BookieBot');assert(await page.locator('.bb-startup-logo').evaluate(el=>el.complete&&el.naturalWidth>0));assert.equal(await page.locator('#bookiebot-expense-report-root').getAttribute('inert'),'');assert.equal(await page.locator('h1').filter({hasText:'Opening BookieBot'}).count(),0)};
  await check(width,height);await page.screenshot({path:output+'/'+tag+'-splash.png'});
  await page.setViewportSize({width:width<800?951:382,height:width<800?669:657});await check(width<800?951:382,width<800?669:657);await page.setViewportSize({width,height});
  releaseAccount();if(!failure){await page.waitForFunction(()=>!document.querySelector('.bb-startup-pending'));assert(await page.locator('#bookiebot-startup-splash').evaluate(el=>el.__sameSplash),'One splash survives provider transition');if(!releaseReport)await page.waitForRequest(r=>new URL(r.url()).pathname==='/app/expenses/data',{timeout:5000});await check(width,height);releaseReport();await page.locator('.bb-metrics-grid').waitFor({state:'attached'})}else await page.getByRole('heading',{name:'Couldn’t open BookieBot',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.bb-startup-splash[data-leaving]'));
  const opacity=await page.locator('#bookiebot-startup-splash').evaluate(el=>parseFloat(getComputedStyle(el).opacity));assert(opacity>0&&opacity<=1,'Splash exits through opacity rather than disappearing at readiness');
  assert.equal(await page.locator('#bookiebot-expense-report-root').getAttribute('inert'),null);
  await page.locator('#bookiebot-startup-splash').waitFor({state:'detached'});await page.screenshot({path:output+'/'+tag+'-ready.png'});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);cases++;console.log('PASS startup splash, fold and readiness',tag);
 }catch(error){await page.screenshot({path:output+'/failure-'+tag+'.png',fullPage:true});throw error}finally{releaseAccount?.();releaseReport?.();await page.close()}
 }}finally{await browser.close()}}console.log(cases+' native splash cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
