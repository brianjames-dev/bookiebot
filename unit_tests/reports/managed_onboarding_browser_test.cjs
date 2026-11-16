// Real app assets, HTTP routes and isolated SQL; only Google verification is stubbed.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'));
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright');
const shots=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-managed-onboarding-shots';fs.mkdirSync(shots,{recursive:true});
const server=spawn(process.env.BOOKIEBOT_TEST_PYTHON||'python',['unit_tests/reports/managed_onboarding_browser_server.py'],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')},stdio:['ignore','pipe','pipe']});
let stderr='';server.stderr.on('data',data=>stderr+=data);
const ready=new Promise((resolve,reject)=>{let output='';server.stdout.on('data',data=>{output+=data;const match=output.match(/READY (\d+)/);if(match)resolve('http://127.0.0.1:'+match[1])});server.on('exit',code=>reject(new Error(`Test server exited ${code}: ${stderr}`)));setTimeout(()=>reject(new Error('Server startup timed out: '+stderr)),20000).unref()});
async function visible(page){return page.locator('.bb-managed-detail .bi-step-pane[data-scene="edit"]').filter({visible:true}).last()}
async function settle(page){await page.waitForFunction(()=>[...document.querySelectorAll('.bi-step-viewport')].every(el=>el.dataset.moving!=='true'));await page.evaluate(()=>document.fonts.ready);}
async function confirm(page){await page.getByRole('button',{name:'Confirm',exact:true}).tap();await page.getByRole('button',{name:'Confirm',exact:true}).waitFor({state:'hidden'});}
async function setup(page,name,invite=''){
 if(invite)await page.getByRole('button',{name:'Join household',exact:true}).tap();
 if(invite)await page.getByLabel('Invitation link or code',{exact:true}).fill(invite);
 else await page.getByLabel('Household name',{exact:true}).fill('Our household');
 await page.getByLabel('Your name',{exact:true}).fill(name);
 await page.getByLabel('Monthly take-home',{exact:true}).fill('4500');
 await page.getByRole('button',{name:'Review',exact:true}).tap();
 await page.getByRole('heading',{name:'Review budget',exact:true}).waitFor();
 await confirm(page);await page.locator('.bb-metrics-grid').waitFor();
}
async function select(page,name){await page.locator('.bb-bottom-navigation').getByRole('button',{name,exact:true}).tap();}
async function add(page,{name,amount,kind='expense',split=false,goal=''}){
 await select(page,'Transactions');await page.getByRole('button',{name:'Add transaction',exact:true}).tap();
 const edit=await visible(page);
 await edit.getByLabel('Transaction name',{exact:true}).fill(name);await edit.getByLabel('Transaction amount',{exact:true}).fill(amount);
 await edit.getByLabel('Transaction date',{exact:true}).fill('2026-11-10');
 await edit.getByLabel('Transaction type',{exact:true}).selectOption(kind);
 if(split)await edit.getByLabel('Share equally with this household',{exact:true}).check();
 if(goal)await edit.getByLabel('Savings goal',{exact:true}).selectOption({label:goal});
 await edit.getByRole('button',{name:'Review',exact:true}).tap();await confirm(page);
 await page.locator('.bb-bills-row').filter({hasText:name}).waitFor();
}
(async()=>{const origin=await ready;let cases=0;
 for(const engine of [chromium,webkit].filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{
 for(const [width,height] of [[382,657],[867,480]]){
  const context=await browser.newContext({viewport:{width,height},isMobile:true,hasTouch:true});const errors=[],requests=[];
  const create=async(subject)=>{const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).pathname));await page.route('https://accounts.google.com/**',route=>{const query=new URL(route.request().url()).searchParams;return route.fulfill({contentType:'text/html',body:'<script>location.replace('+JSON.stringify(origin+'/app/auth/google/callback?state='+query.get('state')+'&code='+subject)+')</script>'})});return page;};
  const alex=await create(`${engine.name()}-${width}-alex`);await alex.goto(origin+'/app/expenses');
  await alex.getByRole('button',{name:'Continue with Google',exact:true}).first().tap();await alex.getByRole('heading',{name:'Your household',exact:true}).waitFor();
  assert(!requests.includes('/app/expenses/data'),'New users must never fetch the legacy Sheets report');
  await setup(alex,'Alex');await alex.getByRole('button',{name:'Settings',exact:true}).tap();await alex.getByRole('button',{name:/iPhone DUO layout/}).tap();
  await alex.getByRole('button',{name:'Create invitation link',exact:true}).tap();const invitation=await alex.getByLabel('Household invitation',{exact:true}).inputValue();
  // A second browser joins; personal income stays private, sharing is explicit.
  const otherContext=await browser.newContext({viewport:{width,height},isMobile:true,hasTouch:true}),sam=await otherContext.newPage();
  sam.on('pageerror',e=>errors.push(e.message));await sam.route('https://accounts.google.com/**',route=>{const q=new URL(route.request().url()).searchParams;return route.fulfill({contentType:'text/html',body:'<script>location.replace('+JSON.stringify(origin+'/app/auth/google/callback?state='+q.get('state')+'&code='+engine.name()+'-'+width+'-sam')+')</script>'})});
  await sam.goto(invitation);await sam.getByRole('button',{name:'Continue with Google',exact:true}).first().tap();await setup(sam,'Sam',invitation);
  await add(alex,{name:'Private paycheck',amount:'4500',kind:'income'});
  await add(alex,{name:'Shared rent',amount:'100',split:true});
  await sam.reload();await select(sam,'Transactions');assert.equal(await sam.getByText('Private paycheck',{exact:true}).count(),0);
  await select(sam,'Shared');await sam.locator('.bb-bills-row').filter({hasText:'Shared rent'}).tap();
  let edit=await visible(sam);await edit.getByLabel('Repayment amount',{exact:true}).fill('50');await edit.getByRole('button',{name:'Report repayment',exact:true}).tap();await confirm(sam);
  await alex.reload();await select(alex,'Shared');await alex.locator('.bb-bills-row').filter({hasText:'Shared rent'}).tap();
  edit=await visible(alex);await edit.getByRole('button',{name:'Confirm received',exact:true}).tap();await confirm(alex);
  await select(alex,'Transactions');await alex.locator('.bb-bills-row').filter({hasText:'Shared rent'}).getByText('$50.00',{exact:true}).waitFor();
  // Same DOM/editor state survives both fold directions and its review.
  await alex.getByRole('button',{name:'Add transaction',exact:true}).tap();edit=await visible(alex);await edit.getByLabel('Transaction name',{exact:true}).fill('Retained draft');await edit.getByLabel('Transaction amount',{exact:true}).fill('12.34');
  await alex.setViewportSize({width:width===382?867:382,height:width===382?480:657});edit=await visible(alex);assert.equal(await edit.getByLabel('Transaction name',{exact:true}).inputValue(),'Retained draft');
  await edit.getByRole('button',{name:'Review',exact:true}).tap();await alex.setViewportSize({width,height});await alex.getByRole('heading',{name:'Review change',exact:true}).waitFor();
  await settle(alex);await alex.screenshot({path:path.join(shots,`${engine.name()}-${width}-review.png`)});await confirm(alex);
  // Drop a committed response. Reload recovers the same SQL receipt, once.
  await alex.getByRole('button',{name:'Add transaction',exact:true}).tap();edit=await visible(alex);await edit.getByLabel('Transaction name',{exact:true}).fill('Exactly once');await edit.getByLabel('Transaction amount',{exact:true}).fill('9.87');await edit.getByRole('button',{name:'Review',exact:true}).tap();
  await alex.route('**/app/budget/confirm',async route=>{await route.fetch();await route.abort()},{times:1});await alex.getByRole('button',{name:'Confirm',exact:true}).tap();await alex.getByRole('button',{name:'Retry confirmation',exact:true}).waitFor();await alex.reload();await alex.locator('.bb-metrics-grid').waitFor();await select(alex,'Transactions');assert.equal(await alex.locator('.bb-bills-row').filter({hasText:'Exactly once'}).count(),1);
  // Abort before commit, then fail the first recovery read. The default
  // Overview must not trap the pending confirmation behind disabled navigation.
  await alex.getByRole('button',{name:'Add transaction',exact:true}).tap();edit=await visible(alex);await edit.getByLabel('Transaction name',{exact:true}).fill('Recover pending');await edit.getByLabel('Transaction amount',{exact:true}).fill('7.65');await edit.getByRole('button',{name:'Review',exact:true}).tap();
  await alex.route('**/app/budget/confirm',route=>route.abort(),{times:1});await alex.getByRole('button',{name:'Confirm',exact:true}).tap();await alex.getByRole('button',{name:'Retry confirmation',exact:true}).waitFor();
  await alex.route('**/app/budget/reviews/*',route=>route.fulfill({status:503,json:{error:'Fixture recovery unavailable'}}),{times:1});await alex.route('**/app/budget?*',route=>route.fulfill({status:503,json:{error:'Fixture budget unavailable'}}),{times:1});await alex.reload();
  await alex.getByRole('button',{name:'Check last confirmation',exact:true}).waitFor({timeout:5000});await alex.getByRole('button',{name:'Check last confirmation',exact:true}).tap();await alex.getByRole('button',{name:'Retry confirmation',exact:true}).waitFor();await alex.getByRole('button',{name:'Retry confirmation',exact:true}).tap();
  await alex.locator('.bb-bills-row').filter({hasText:'Recover pending'}).waitFor();assert.equal(await alex.locator('.bb-bills-row').filter({hasText:'Recover pending'}).count(),1);
  await alex.getByRole('button',{name:'Settings',exact:true}).tap();await settle(alex);await alex.screenshot({path:path.join(shots,`${engine.name()}-${width}-settings.png`)});
  const reportCalls=requests.filter(p=>p==='/app/expenses/data');assert.equal(reportCalls.length,0);
  assert.deepEqual(errors,[]);await otherContext.close();await context.close();cases++;console.log('PASS Google onboarding, private/join/shared repayment, folds and recovery',engine.name(),width);
 }
 }finally{await browser.close()}
 }
 console.log(`${cases} database-backed native cases passed; screenshots ${shots}`);
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>server.kill('SIGTERM'));
