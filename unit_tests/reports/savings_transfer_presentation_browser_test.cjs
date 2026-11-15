// Execute the production bundle against canonical Python report/list fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {fixture,engines,tap}=require('./duo_layout_browser_test.cjs');
const {press}=require('./bill_pane_fit_browser_test.cjs');
const root=path.resolve(__dirname,'../..');
const values=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',String.raw`
import json
from datetime import datetime,date
from unittest.mock import patch
from bookiebot.reports import expense_breakdown as r,transactions as tx
from bookiebot.sheets.savings_transfers import Transfer
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet as WS
from unit_tests.reports.test_income_projection import income_rows
B='676638528590970917'
plans=(Transfer('transfer-1234',1,'Emergency savings',15000,'monthly','2026-11-15','2026-11-15','goal-1','Checking','Savings'),Transfer('transfer-5678',1,'Vacation savings',25000,'once','2026-11-20','2026-11-15'))
personal=income_rows(('11/1/2026','Fixture income','5000'),settings=(('Main Income Source','Fixture income'),('Income Projection Mode','off')))
personal.append(['','Enter Monthly Savings Contribution','Ideal = $1000','Minimum = $500','50'])
with patch.object(r,'now_pacific',return_value=datetime(2026,11,15,12)):
 report=r.build_expense_breakdown_report(actor_key=B,owner_name='Brian',persons=['Brian'],month=r.BudgetMonth(2026,11),worksheets=r.ReportWorksheets(WS([],title='November'),WS(personal,title='November'),transfer_plans=plans))
 payload=r.expense_breakdown_client_payload(report)
rows=tx._transfer_rows(B,'2026-11',plans,as_of=date(2026,11,15),goal_names={'goal-1':'Emergency fund'})
with patch.object(tx,'load_transactions',return_value=rows):
 listings={key:tx.listing(B,{'month':'2026-11','view':'daily',**query}) for key,query in [('all',{'scope':'spending_or_transfers'}),('transfers',{'kind':'transfer'}),('savings',{'kind':'savings'}),('needs',{'scope':'spending','bucket':'needs'}),('wants',{'scope':'spending','bucket':'wants'})]}
print(json.dumps({'report':payload,'listings':listings}))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString());
(async()=>{let count=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const c of [{width:382,height:740,dark:false,rail:0},{width:867,height:480,dark:false,rail:0},{width:951,height:648,dark:true,rail:84}].filter(c=>!process.env.ONLY_WIDTH||c.width===Number(process.env.ONLY_WIDTH))){
  const reads=[];const {page,errors,unexpected}=await fixture(browser,c.width,c.height,c.dark,false,false,c.rail,{months:{currentMonth:'2026-11',months:[{value:'2026-11',label:'November 2026'}],coverage:{status:'complete',unavailableYears:[]}},report:()=>values.report,transactions:async route=>{assert.equal(route.request().method(),'GET');const query=new URL(route.request().url()).searchParams;assert.equal(query.get('month'),'2026-11');reads.push(Object.fromEntries(query));const filter=query.get('kind')==='transfer'?'transfers':query.get('kind')==='savings'?'savings':query.get('bucket')||'all';return route.fulfill({json:values.listings[filter]})}});
  try{
   const saved=page.locator('.bb-savings-metric-card .bb-metric-value'),mix=page.locator('.bb-category-mix-page'),filter=mix.getByRole('combobox',{name:'Category mix filter',exact:true});
   await page.waitForTimeout(550);assert.match(await saved.innerText(),/450/);assert.equal(await mix.locator('.bb-chart-total').innerText(),'$0.00','Transfers never inflate Spent');
   await filter.selectOption('savings');await page.waitForTimeout(300);assert.equal(await mix.locator('.bb-chart-total').innerText(),'$450.00');
   if(c.width>=800){assert.match(await mix.locator('.bb-duo-category-list').innerText(),/Savings transfers/);assert.match(await mix.locator('.bb-duo-category-list').innerText(),/400/);}
   await filter.selectOption('transfers');await page.waitForTimeout(300);assert.equal(await mix.locator('.bb-chart-total').innerText(),'$400.00');assert.match(await mix.innerText(),/of cash saved/);
   await page.getByRole('button',{name:'Current',exact:true}).scrollIntoViewIfNeeded();await press(page.getByRole('button',{name:'Current',exact:true}));assert.match(await saved.innerText(),/200/);assert.equal(await mix.locator('.bb-chart-total').innerText(),'$150.00');
   if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await mix.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.BOOKIEBOT_SCREENSHOT_DIR,`transfer-category-${engine.name()}-${c.width}.png`)})}
   await press(page.getByRole('button',{name:'Show Calendar',exact:true}));const calendar=page.locator('.bb-cashflow-calendar');
   await calendar.waitFor({state:'visible'});assert.match(await calendar.locator('.bb-cf-legend').innerText(),/Transfers/);const event=calendar.getByRole('button',{name:/Emergency savings · Savings transfer/});assert(await event.count()>0);await press(event.first());const details=page.locator('dialog[open]');assert.match(await details.innerText(),/Savings transfer/);await page.keyboard.press('Escape');await page.waitForTimeout(350);
   await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));const transactions=page.getByRole('region',{name:'Recorded transactions',exact:true});await transactions.locator('.bb-recorded-swipe').first().waitFor();assert.match(await transactions.innerText(),/Emergency savings/);assert.match(await transactions.innerText(),/Transfer/);assert.equal(reads.at(-1).scope,'spending_or_transfers');
   const chooser=transactions.getByRole('combobox',{name:'Filter transactions',exact:true});await chooser.selectOption('transfers');await page.waitForTimeout(500);assert.equal(reads.at(-1).kind,'transfer');const row=transactions.locator('.bb-recorded-swipe').first();await press(row.locator('.bb-recorded-row-access'));const info=c.width>=800?transactions.locator('.bb-recorded-detail-pane'):transactions.locator('.bb-recorded-detail');await info.waitFor();assert.match(await info.innerText(),/Saved, without counting as Needs or Wants spending/);assert.match(await info.innerText(),/Emergency fund/);assert.equal(await info.getByRole('button',{name:/Edit|Split|Delete/}).count(),0);
   if(process.env.BOOKIEBOT_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.BOOKIEBOT_SCREENSHOT_DIR,`transfer-transaction-${engine.name()}-${c.width}.png`)});
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS savings-only transfer presentation',engine.name(),c.width,c.height);count++;
  }catch(error){await page.screenshot({path:'/private/tmp/bookiebot-transfer-presentation-failure.png'});throw error}finally{await page.close()}
 }}finally{await browser.close()}
}console.log(count+' native transfer presentation cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
