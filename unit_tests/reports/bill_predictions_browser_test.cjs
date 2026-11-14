// Real backend payloads and shipped UI; all financial routes are isolated fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {fixture,engines,tap}=require('./duo_layout_browser_test.cjs');
const {enter,panel,press}=require('./bill_pane_fit_browser_test.cjs');
const root=path.resolve(__dirname,'../..');
const data=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import calendar,json,os
from copy import deepcopy
from dataclasses import replace
from datetime import datetime
import pytest
from bookiebot.reports import bill_settings as bills,expense_breakdown as reports
from bookiebot.sheets import recurring_storage as storage
from bookiebot.sheets.recurring import BILL_TAB
from bookiebot.sheets.recurring_charges import BillCharge,CHARGES_TAB,encode_charges,source_anchor
from unit_tests.sheets.test_recurring import plan
from unit_tests.sheets.test_recurring_storage import fixture,B,TODAY
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet
p=replace(plan(),id='variable_pge',kind='variable',name='Electricity',source_label='PG&E',amount_cents=None,pull_day=22,monthly_source=True,version='v1',split_method='none')
client,_=fixture([p]); patch=pytest.MonkeyPatch()
patch.setenv('BOOKIEBOT_REIMBURSEMENTS_ENABLED','false')
patch.setattr(bills,'now_pacific',lambda:datetime(2026,11,13,12))
patch.setattr(reports,'now_pacific',lambda:datetime(2026,11,13,12))
patch.setattr(bills,'read_workbook',lambda actor,today:storage.read_workbook(actor,today,client=client))
patch.setattr(reports,'_optional_previous_year_budget_history',lambda *a,**kw:())
client.http_client.rows['November'][0][2]=client.http_client.formulas['November'][0][2]='0'
client.http_client.rows['November'].insert(0,['Monthly Income','1000'])
client.http_client.formulas['November'].insert(0,['Monthly Income','1000'])
def report():
 return reports.expense_breakdown_client_payload(reports.build_expense_breakdown_report(actor_key=B,owner_name='Brian',persons=[],month=reports.BudgetMonth(2026,11),worksheets=reports.ReportWorksheets(shared_expenses=InMemoryWorksheet([]),personal_budget=InMemoryWorksheet(client.http_client.rows['November']),bill_schedule=InMemoryWorksheet(client.http_client.rows[BILL_TAB]),bill_charges=InMemoryWorksheet(client.http_client.rows.get(CHARGES_TAB,[])),budget_history=(reports.BudgetHistoryRows(reports.BudgetMonth(2026,10),client.http_client.rows['October']),))))
before={'bills':bills.listing(B),'report':report()}
charge=before['bills']['bills'][0]['charge']
review=bills.review(B,{'operation':'amount','id':p.id,'month':'2026-11','settingsVersion':before['bills']['settingsVersion'],'chargeVersion':charge['version'],'amount':'125.67'})
client.http_client.rows['November'][1][2]=client.http_client.formulas['November'][1][2]='125.67'
c=BillCharge(p.id,'2026-11','2026-11-13',p.source_label,p.category,1,2,3,source_anchor(p.id,'2026-11'),12567,True)
client.http_client.rows[CHARGES_TAB]=client.http_client.formulas[CHARGES_TAB]=encode_charges([c],[])
client.http_client.properties[CHARGES_TAB]={'title':CHARGES_TAB,'sheetId':7}
after={'bills':bills.listing(B),'report':report()}
assert not client.http_client.sent
print(json.dumps({'before':before,'after':after,'review':review}))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}));
async function bounds(page,selector){return page.locator(selector).evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,scroll:n.scrollWidth,client:n.clientWidth}})}
async function explanation(page){
 const popup=page.getByRole('dialog',{name:'Predicted bill',exact:true});await popup.waitFor();
 assert.match(await popup.innerText(),/Average of 1 past bill/);assert.match(await popup.innerText(),/Oct 2026/);
 assert.match(await popup.innerText(),/\$60\.23/);assert.match(await popup.innerText(),/replaces the prediction/);
 const r=await bounds(page,'.bb-bill-prediction-popover[aria-hidden=false]');
 const overlay=await page.locator('.bb-page.bb-app-shell').evaluate(n=>n.dataset.duoLandscape==='true'?parseFloat(getComputedStyle(n).getPropertyValue('--bb-duo-overlay'))||0:0);
 assert(r.x>=15&&r.right<=page.viewportSize().width-overlay-15&&r.y>=15&&r.bottom<=page.viewportSize().height-15,JSON.stringify(r));
 const content=await popup.evaluate(n=>{const r=n.getBoundingClientRect(),title=n.querySelector('h3').getBoundingClientRect(),panel=n.querySelector('.k-glass>div');return {inset:title.left-r.left,width:panel.clientWidth,scroll:panel.scrollWidth}});
 assert(content.inset>=14&&content.scroll<=content.width,'Explanation glyphs have real inner clearance and cannot clip at the glass corners: '+JSON.stringify(content));
 await screenshot(page,`prediction-info-${page.viewportSize().width}`);
 await popup.getByRole('button',{name:'Close prediction explanation',exact:true}).click();await popup.waitFor({state:'hidden'});
}
async function screenshot(page,name){if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.BOOKIEBOT_SCREENSHOT_DIR,name+'.png')})}}
(async()=>{let cases=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const c of [{width:320,height:740,dark:true,rail:0},{width:382,height:740,dark:false,rail:0},{width:951,height:648,dark:true,rail:84},{width:867,height:480,dark:false,rail:0}].filter(c=>!process.env.ONLY_WIDTH||c.width===Number(process.env.ONLY_WIDTH))){
  let phase='before',confirms=0,reviews=0,transactionReads=0;
  const f=await fixture(browser,c.width,c.height,c.dark,false,false,c.rail,{
   report:()=>data[phase].report,
   bills:route=>{const req=route.request();if(req.method()==='GET')return route.fulfill({json:data[phase].bills});const body=req.postDataJSON();assert.equal(body.operation,'amount');assert.equal(body.amount,'125.67');if(new URL(req.url()).pathname.endsWith('/review')){reviews++;return route.fulfill({json:{review:data.review}})}confirms++;assert.equal(body.reviewVersion,data.review.reviewVersion);phase='after';return route.fulfill({json:{state:'done',success:true,detail:'Charge recorded.'}})},
   transactions:route=>{assert.equal(route.request().method(),'GET');transactionReads++;return route.fulfill({json:{items:[],days:[],listDays:[],total:0,totalAmountCents:0,nextOffset:null,categories:[],persons:[],month:'2026-11',snapshotVersion:'actual-only',loadedAt:'2026-11-13T12:00:00-08:00'}})}
  });const {page,errors,unexpected}=f;
  try{
   const spent=page.getByRole('button',{name:'Explain Spent, includes predicted bills',exact:true});await spent.waitFor();assert.equal(await spent.locator('.bb-prediction-glyph').count(),1);
   const cards=await page.locator('.bb-metrics-grid').boundingBox();await spent.click();const details=page.locator('dialog[open]');await details.waitFor();assert.match(await details.innerText(),/Average of 1 past bill/);await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
   await page.getByRole('button',{name:'Current',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Explain Spent',exact:true}).locator('.bb-prediction-glyph').count(),0);
   await page.getByRole('button',{name:'Projected',exact:true}).click();
   const projectedCards=await page.locator('.bb-metrics-grid').boundingBox();assert(Math.abs(projectedCards.height-cards.height)<.2&&Math.abs(projectedCards.width-cards.width)<.2,'Prediction markers preserve the four metric frames');
   // Verify the Calendar marker and its same explanation, including Current.
   await page.getByRole('button',{name:'Show Calendar',exact:true}).click();
   await page.getByRole('button',{name:'Show full month',exact:true}).click();
   const day=page.locator('[data-date="2026-11-22"] .bb-cf-date');assert.equal(await day.locator('.bb-cf-date-prediction').count(),1);await day.click();await page.locator('dialog[open]').waitFor();await page.getByRole('button',{name:'Explain predicted Electricity',exact:true}).click();await explanation(page);await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
   await page.getByRole('button',{name:'Current',exact:true}).click();assert.equal(await page.locator('[data-date="2026-11-22"] .bb-cf-combined-hit').count(),0);
   await page.getByRole('button',{name:'Projected',exact:true}).click();
   await enter(page);const row=panel(page).locator('[data-bill-id="variable_pge"]'),shell=row.locator('..');
   assert.match(await row.innerText(),/\$60\.23/);assert.equal(await row.locator('small').count(),1,'No estimate explanation label is added to the row');
   const icon=shell.getByRole('button',{name:'Explain predicted Electricity',exact:true});const hit=await icon.boundingBox();assert(hit.width>=44&&hit.height>=44);
   await icon.click();await explanation(page);assert.equal(await panel(page).locator('.bb-bills-editor[data-open=true]').count(),0,'Info does not open or change the editor');
   await press(row);await panel(page).getByRole('textbox',{name:'Name',exact:true}).fill('Retained draft');await icon.click();await explanation(page);assert.equal(await panel(page).getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Retained draft');
   await screenshot(page,`prediction-${engine.name()}-${c.width}`);
   await press(panel(page).getByRole('button',{name:/^(Enter monthly amount|Monthly amount)$/,exact:false}));
   await panel(page).getByRole('textbox',{name:'Bill amount',exact:true}).fill('125.67');await press(panel(page).getByRole('button',{name:'Review',exact:true}));
   assert.equal(reviews,1);assert.equal(confirms,0,'Review never records the actual');
   const record=panel(page).getByRole('button',{name:'Confirm amount',exact:true});await record.waitFor();await page.waitForTimeout(470);await press(record);
   await page.waitForFunction(()=>!document.querySelector('.bb-bills-row[data-predicted=true]'));assert.equal(confirms,1);assert.match(await row.innerText(),/\$125\.67/);assert.equal(await shell.locator('.bb-bill-prediction-info').count(),0,'Actual replaces the icon and forecast');
   await page.setViewportSize({width:c.width>=800?382:951,height:c.width>=800?740:648});await page.waitForTimeout(520);assert.match(await row.innerText(),/\$125\.67/);
   await page.getByRole('button',{name:'Back',exact:true}).click();await page.getByRole('button',{name:'Back',exact:true}).click();
   await page.getByRole('button',{name:'Overview',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.bb-metric-label .bb-prediction-glyph'));
   await page.getByRole('button',{name:'Transactions',exact:true}).click();await page.waitForTimeout(160);assert(transactionReads>0);assert.equal(await page.locator('.bb-transactions .bb-bill-prediction-info').count(),0);
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS predicted Bills/Overview/Calendar replacement',engine.name(),c.width,c.height);cases++;
  }catch(error){await page.screenshot({path:'/private/tmp/bookiebot-bill-prediction-failure.png'});throw error}finally{await page.close()}
 }}finally{await browser.close()}
}console.log(cases+' native prediction cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
