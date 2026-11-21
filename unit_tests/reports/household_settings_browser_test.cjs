// Existing connected workspaces receive membership controls, never new-budget setup.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const shots='/private/tmp/bookiebot-household-settings-shots';fs.mkdirSync(shots,{recursive:true});
async function act(page,button){await button.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await tap(page,button)}
(async()=>{let cases=0;
 for(const engine of engines){const browser=await engine.launch({headless:true});try{
 for(const [width,height] of [[382,657],[867,480]]){
  const {page,errors,unexpected}=await fixture(browser,width,height,true,false,false,0,{config:{householdEnabled:true,onboardingUrl:'/app/bootstrap'},bootstrap:{phase:'ready',provider:'sheets',account:{id:'legacy-brian',name:'Brian'}}});
  let household=null,reads=0,reviews=0,confirms=0,finances=0;
  page.on('request',r=>{if(new URL(r.url()).pathname==='/app/expenses/data')finances++});
  await page.route('**/app/account',r=>r.fulfill({json:{id:'legacy-brian',name:'Brian',googleEnabled:true,google:{connected:true,email:'fixture@example.test'}}}));
  await page.route('**/app/household**',route=>{const name=new URL(route.request().url()).pathname;
   if(name==='/app/household'){reads++;return route.fulfill({json:{account:{id:'legacy-brian',name:'Brian'},provider:'sheets',household}})}
   if(name.endsWith('/review')){reviews++;return route.fulfill({json:{reviewId:'a'.repeat(32),title:'Review household',items:[{label:'Create household',value:'Our household'},{label:'Your budget',value:'Keep the existing connected workbook and all financial history.'}]}})}
   if(name.endsWith('/confirm')){confirms++;household={name:'Our household',role:'owner',members:[{id:'legacy-brian',name:'Brian',provider:'sheets'},{id:'legacy-hannah',name:'Hannah',provider:'sheets'}]};return route.fulfill({json:{completed:true}})}
   if(name.endsWith('/invite'))return route.fulfill({json:{token:'x'.repeat(43)}});
   return route.abort();
  });
  await tap(page,page.getByRole('button',{name:'Settings',exact:true}));await tap(page,page.getByRole('button',{name:'Household',exact:true}));const card=page.getByRole('region',{name:'Household settings'});
  await card.getByRole('button',{name:'Create household',exact:true}).waitFor();const before=finances;
  await act(page,card.getByRole('button',{name:'Create household',exact:true}));await card.getByLabel('Household name',{exact:true}).fill('Our household');
  await act(page,card.getByRole('button',{name:'Review',exact:true}));await card.getByRole('heading',{name:'Review household',exact:true}).waitFor();
  assert.equal(confirms,0);assert.equal(household,null,'Review must not create membership');
  await act(page,card.getByRole('button',{name:'Confirm',exact:true}));await card.getByText('Hannah',{exact:true}).waitFor();
  await act(page,card.getByRole('button',{name:'Invite a household member',exact:true}));await card.getByLabel('Household invitation',{exact:true}).waitFor();
  assert((await card.getByLabel('Household invitation',{exact:true}).inputValue()).includes('#invite='));
  assert.equal(await card.getByText('Connected workbook',{exact:true}).count(),2);
  assert.equal(await page.getByText('Monthly take-home ($)',{exact:true}).count(),0,'Existing people must not see new financial setup');
  assert.equal(confirms,1);assert.equal(reviews,1);assert.equal(reads,2,'Only initial and post-confirmation metadata reads');assert.equal(finances,before,'Household changes must not refresh/write Sheets reports');
  await card.evaluate(el=>el.scrollIntoView({block:'center'}));await page.screenshot({path:path.join(shots,`${engine.name()}-${width}.png`)});
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();cases++;console.log('PASS Existing workbook household review, membership and invitation',engine.name(),width);
 }
 }finally{await browser.close()}}
 console.log(`${cases} existing-workspace household native cases passed`);
})().catch(error=>{console.error(error);process.exit(1)});
