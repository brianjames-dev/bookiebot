// Exercise the shipped Settings card, including the screenshot's inline-label bug.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const shots=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-settings-account-shots';fs.mkdirSync(shots,{recursive:true});
const email='a.very.long.account.address.for.layout.checks.repeated.to.exceed.the.available.width.at.every.viewport@example.test';
async function reveal(card){await card.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));}
async function geometry(card){return card.evaluate(el=>{
 const rect=n=>n.getBoundingClientRect().toJSON(),row=el.querySelector('.bb-setting-row');
 return {row:rect(row),font:getComputedStyle(row).fontSize,card:rect(el),width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
  buttons:[...el.querySelectorAll('button')].map(n=>({text:n.textContent,r:rect(n),font:getComputedStyle(n).fontSize,color:getComputedStyle(n).color}))};
})}
function checkRows(value){
 assert(value.buttons.length>0);
 for(const button of value.buttons){
  assert(button.r.height>=44,'Each account action is a full touch target');
  assert(Math.abs(button.r.x-value.row.x)<1&&Math.abs(button.r.width-value.row.width)<1,'Account actions align with the account details: '+JSON.stringify(value));
  assert.equal(button.font,value.font,'Account actions use the Settings row text size');
 }
 for(let i=1;i<value.buttons.length;i++)assert(value.buttons[i-1].r.bottom<=value.buttons[i].r.top,'Account labels must occupy separate rows: '+JSON.stringify(value));
 assert(value.scrollWidth<=value.width,'Account content cannot widen the viewport');
}
(async()=>{let count=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{
   for(const dark of [false,true].filter(d=>!process.env.ONLY_THEME||process.env.ONLY_THEME===(d?'dark':'light')))
   for(const [width,height]of [[320,657],[382,657],[867,480]].filter(([w])=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
    const {page,errors,unexpected}=await fixture(browser,width,height,dark);let mode='unlinked',starts=0;
    await page.route('**/app/account',route=>mode==='unavailable'?route.fulfill({status:503,json:{error:'Unavailable'}}):route.fulfill({json:{id:'fixture-account',name:'Brian',googleEnabled:true,google:{connected:mode==='linked',email:mode==='linked'?email:null}}}));
    await page.route('**/app/auth/google/start',route=>{assert.equal(route.request().postDataJSON().action,'link');starts++;return route.fulfill({status:503,json:{error:'Sign-in is temporarily unavailable. Try again.'}})});
    const card=page.locator('section[aria-label="Account sign-in"]');
    const settings=async()=>{await tap(page,page.getByRole('button',{name:'Settings',exact:true}));if(width<800)await tap(page,page.getByRole('button',{name:'Account',exact:true}));await card.waitFor();};
    await settings();const link=card.getByRole('button',{name:'Link Google account',exact:true}),signout=card.getByRole('button',{name:'Sign out',exact:true});
    await link.waitFor();await reveal(card);checkRows(await geometry(card));
    assert.notEqual((await geometry(card)).buttons[0].color,(await geometry(card)).buttons[1].color,'Sign out has a distinct destructive affordance');
    await link.focus();await page.keyboard.press(engine.name()==='webkit'?'Alt+Tab':'Tab');assert(await signout.evaluate(el=>el===document.activeElement),await page.evaluate(()=>document.activeElement.outerHTML.slice(0,400)));
    assert.notEqual(await signout.evaluate(el=>getComputedStyle(el).outlineStyle),'none','Keyboard focus stays visible');
    await signout.evaluate(el=>el.blur());
    await page.screenshot({path:path.join(shots,`${engine.name()}-${width}-${dark?'dark':'light'}.png`)});
    await tap(page,link);await card.getByRole('alert').waitFor();assert.equal(starts,1);checkRows(await geometry(card));
    mode='linked';await page.reload();await page.locator('.bb-metrics-grid').waitFor();await settings();await card.getByText(email,{exact:true}).waitFor();await reveal(card);checkRows(await geometry(card));
    assert.equal(await link.count(),0);const bounds=await card.locator('.bb-account-email').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth,overflow:getComputedStyle(el).textOverflow}));
    assert(bounds.scroll>bounds.width&&bounds.overflow==='ellipsis','Long linked accounts truncate without moving the actions');
    mode='unavailable';await page.reload();await page.locator('.bb-metrics-grid').waitFor();await settings();await card.getByRole('status').waitFor();await reveal(card);checkRows(await geometry(card));
    assert.equal(await signout.count(),1,'Sign out remains available when account metadata fails');
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();count++;console.log('PASS Account rows, long email, errors and focus',engine.name(),width,dark?'dark':'light');
   }
  }finally{await browser.close();}
 }
 console.log(`${count} native Settings Account cases passed; screenshots ${shots}`);
})().catch(error=>{console.error(error);process.exit(1)});
