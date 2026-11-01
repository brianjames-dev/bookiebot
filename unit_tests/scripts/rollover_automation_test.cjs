// Execute real Apps Script entry points against isolated service doubles.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('scripts/google-apps-script/budget-system-automation.gs','utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(iso='2026-10-31T20:00:00Z') {
  const state={props:new Map(),books:new Map(),sheets:0,copies:0,closed:[],writes:[],held:false,releases:0,logs:[],triggers:[],triggerCounter:0};
  class Clock extends Date { constructor(...args){super(...(args.length?args:[iso]));} }
  const props={getProperty:key=>state.props.get(key)||null,setProperty:(key,value)=>{state.props.set(key,value);return props;}};
  const formatDate=(date,zone,format)=>{
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(x=>[x.type,x.value]));
    return format==='yyyy-MM-dd'?`${p.year}-${p.month}-${p.day}`:format==='yyyy'?p.year:new Intl.DateTimeFormat('en-US',{timeZone:zone,month:'long'}).format(date);
  };
  const lock={tryLock:()=>{if(state.held)return false;state.held=true;return true;},releaseLock:()=>{state.held=false;state.releases++;}};
  const ctx=vm.createContext({Date:Clock,console,Logger:{log:text=>state.logs.push(text)},Utilities:{formatDate},
    LockService:{getScriptLock:()=>lock},PropertiesService:{getScriptProperties:()=>props},
    SpreadsheetApp:{openById:id=>{assert.ok(state.books.has(id),id);return state.books.get(id);},flush:()=>{}},
    ScriptApp:{EventType:{CLOCK:'CLOCK'},getProjectTriggers:()=>[...state.triggers],deleteTrigger:t=>{state.triggers=state.triggers.filter(x=>x!==t);},
      newTrigger:handler=>{const data={handler},builder={timeBased:()=>builder,atHour:hour=>{data.hour=hour;return builder;},everyDays:days=>{data.days=days;return builder;},inTimezone:zone=>{data.zone=zone;return builder;},create:()=>{if(state.failTrigger){state.failTrigger--;if(!state.failTrigger)throw Error('trigger transport failure');}const t={...data,id:++state.triggerCounter,getUniqueId(){return String(this.id)},getHandlerFunction(){return this.handler},getEventType:()=>'CLOCK'};state.triggers.push(t);return t;}};return builder;}}
  });
  vm.runInContext(source,ctx);
  function book(id,personal=true){
    const b={id,sheets:new Map(),getId:()=>id,getName:()=>id+' 2026',getSheetByName:name=>b.sheets.get(name)||null,
      insertSheet:(name,options)=>{assert.equal(options.template,b.sheets.get('Template'));const s=sheet(name,b,personal);state.copies++;b.sheets.set(name,s);if(state.failCopy){state.failCopy=false;throw Error('lost insert response');}return s;}};
    const template=sheet('Template',b,personal);b.sheets.set('Template',template);state.books.set(id,b);return b;
  }
  function sheet(name,book,personal){
    const cells=new Map(),rows=new Map(),s={id:++state.sheets,name,book,personal,cells,hidden:false,settings:null,entries:[],
      getName:()=>s.name,getParent:()=>book,getSheetId:()=>s.id,getMaxColumns:()=>personal?26:40,
      hideSheet:()=>{s.hidden=true;},showSheet:()=>{s.hidden=false;},
      setName:newName=>{book.sheets.delete(s.name);s.name=newName;book.sheets.set(newName,s);if(state.failRename){state.failRename=false;throw Error('lost rename response');}},
      getRange:(row,column,numRows,numColumns)=>{
        if(numRows===2&&numColumns===40){assert.equal(row,1);assert.equal(column,1);return {getDisplayValues:()=>{
          const headers=[Array(40).fill(''),Array(40).fill('')];
          for(const [col,name,amount,person] of [[1,'GROCERY',2,4],[8,'GAS',9,10],[14,'FOOD',16,18],[22,'SHOPPING',24,26],[30,'NEEDS',32,34]]){headers[0][col-1]=name;headers[1][col-1]='Date';headers[1][amount-1]='Amount';headers[1][person-1]='Person';}
          if(s.badHeaders)headers[1][31]='';return headers;
        }};}
        return s.cell([...rows].find(([,value])=>value===row)[0]+':'+(column-1));
      },
      cell:key=>{const [label,offset='0']=key.split(':');if(!rows.has(label))rows.set(label,rows.size+1);if(!cells.has(key))cells.set(key,{formula:'',value:0,writes:0});const data=cells.get(key);return {
        getFormula:()=>data.formula,getValue:()=>data.value,getDisplayValue:()=>String(data.value),getSheet:()=>s,getA1Notation:()=>key,
        getRow:()=>rows.get(label),getColumn:()=>1+Number(offset),offset:(_dy,dx)=>s.cell(label+':'+(Number(offset)+dx)),setFormula:value=>{data.formula=value;state.writes.push([s.name,key,value]);},
        setValue:value=>{data.value=value;data.formula='';data.writes++;if(state.failSnapshotKey===key){state.failSnapshotKey=null;throw Error('lost snapshot response');}}
      };}};return s;
  }
  // Layout/calculation writers have their own real-grid integration suite.
  // Here they model the boundaries needed to test publication and recovery.
  ctx.setMonthLabel=(s,name)=>{if(!s.personal)return false;s.label=name;return true;};
  ctx.findCellByAnyExactTextInTopLeft=(s,names)=>names.includes(s.label)?s.cell('label'):null;
  ctx.findCellByExactText=(s,label)=>label==='Monthly Income:'||label==='Burn Rate'||label==='Static Bills & Subscriptions (Needs)'||label==='Subscriptions (Wants)'||s.personal?s.cell(label):null;
  ctx.findCellContainingText=ctx.findCellByExactText;
  ctx.findFirstFormulaCellToRight=label=>label.offset(0,1);
  ctx.resolvePersonalBudgetIncomeSettings=()=>({source:'Fixture employer',mode:'biweekly',amount:3800});
  ctx.writePersonalBudgetIncomeSettings=(s,settings)=>{s.settings={...settings};if(state.failConfigure){state.failConfigure=false;throw Error('configuration interrupted');}};
  ctx.inheritPersonalBudgetIncomeSettings=(_ss,s,month)=>{s.inheritedMonth=month;};
  ctx.resolvePersonalBudgetSavingsPlan=()=>({enrollments:[['2026-10-23','','Fixture employer',.05]]});
  ctx.writePersonalBudgetSavingsPlan=(s,plan,year,_recorded,month)=>{s.plan=plain(plan);s.planYear=year;s.planMonth=month;};
  ctx.hasPersonalBudgetIncomeSettings=s=>Boolean(s.settings);
  ctx.findPersonalBudgetIncomeLayout=s=>s.settings?{headerRow:8}:null;
  const config={year:2026,brianBudgetId:'brian',hannahBudgetId:'hannah',sharedExpensesId:'shared'};
  book('shared',false);book('brian');book('hannah');state.props.set('YEAR_CONFIG_2026',JSON.stringify(config));
  return {ctx,state,config,book,sheet,props};
}

// Pacific boundaries, leap February, January and both daylight-saving changes.
for(const [iso,key,day] of [['2026-11-01T06:59:59Z','2026-10',31],['2026-11-01T07:00:00Z','2026-11',1],['2027-01-01T07:59:59Z','2026-12',31],['2027-01-01T08:00:00Z','2027-01',1],['2026-03-08T09:59:59Z','2026-03',8],['2026-03-08T10:00:00Z','2026-03',8],['2026-11-01T09:00:00Z','2026-11',1]]){
 const {ctx}=fixture();const p=ctx.budgetMonthPeriod(new Date(iso));assert.equal(p.key,key);assert.equal(p.day,day);
}
assert.equal(fixture().ctx.budgetMonthPeriod(new Date('2028-02-29T20:00Z')).daysInMonth,29);
assert.equal(fixture().ctx.budgetMonthPeriod(new Date('2026-12-31T20:00Z'),1).key,'2027-01');
// The live shared ledger has category/field headers, not a month heading. It
// still requires the actual column layout; missing personal headings fail.
{
 const {ctx,state,config}=fixture(),period=ctx.budgetMonthPeriod(new Date('2026-11-01T20:00Z'));
 const shared=ctx.prepareBudgetMonthTab('shared',config,period,null);
 assert.equal(shared.label,undefined);assert.equal(shared.name,'November');
 shared.badHeaders=true;assert.throws(()=>ctx.validatePreparedBudgetMonthTab(shared,config,period,null),/Shared template headers.*NEEDS/);
 const b=state.books.get('brian'),personal=b.insertSheet('_BookieBot Preparing 2026-11',{template:b.getSheetByName('Template')});
 assert.throws(()=>ctx.validatePreparedBudgetMonthTab(personal,config,period,'brian'),/month label/);
}
{
 const {ctx,state}=fixture();ctx.closePreviousBudgetMonthAt(new Date('2026-01-01T08:00Z'));ctx.closePreviousBudgetMonthAt(new Date('2026-11-01T07:00Z'));
 assert.ok(![...state.props.keys()].some(key=>key.startsWith('BUDGET_MONTH_CLOSED_')),'Unavailable history is never recorded as a completed close');
}

// Evening preparation publishes all three complete tabs without freezing the
// active month, and leaves an existing month/its transactions entirely alone.
{
 const {ctx,state}=fixture();const earlier=state.books.get('brian').insertSheet('October',{template:state.books.get('brian').getSheetByName('Template')});
 earlier.entries.push({day:31,amount:123.45});earlier.settings={amount:7000};
 ctx.closePreviousBudgetMonthAt=()=>assert.fail('Advance preparation must never close a month');
 ctx.prepareBudgetMonths();assert.ok(state.books.get('brian').getSheetByName('November'));
 assert.deepEqual(earlier.entries,[{day:31,amount:123.45}]);assert.equal(earlier.settings.amount,7000);
 for(const id of ['brian','hannah']){const s=state.books.get(id).getSheetByName('November');assert.equal(s.planMonth,'November');assert.equal(s.planYear,2026);assert.equal(s.inheritedMonth,'November');assert.equal(s.hidden,false);}
 const count=state.copies,writes=state.writes.length;ctx.prepareBudgetMonths();assert.equal(state.copies,count);assert.equal(state.writes.length,writes);
}
// No next-month provisioning outside the seven-day preparation window.
{
 const {ctx,state}=fixture('2026-11-02T20:00Z');ctx.prepareBudgetMonths();
 assert.ok(state.books.get('brian').getSheetByName('November'));assert.equal(state.books.get('brian').getSheetByName('December'),null);
}
// Failures before insert response, during configuration and after committed
// rename each recover the same pinned tab, with no duplicate/live overwrite.
for(const failure of ['failCopy','failConfigure','failRename']){
 const {ctx,state,config}=fixture(),period=ctx.budgetMonthPeriod(new Date('2026-11-01T20:00Z'));
 state[failure]=true;assert.throws(()=>ctx.withBudgetRolloverLock(()=>ctx.prepareBudgetMonthTab('brian',config,period,'brian')));
 const b=state.books.get('brian'),pending=b.getSheetByName('November')||b.getSheetByName('_BookieBot Preparing 2026-11');assert.ok(pending);
 if(failure!=='failRename')assert.equal(b.getSheetByName('November'),null,'Unfinished copy never uses the canonical month name');
 else pending.entries.push({day:1,amount:42});
 const id=pending.id;ctx.withBudgetRolloverLock(()=>ctx.prepareBudgetMonthTab('brian',config,period,'brian'));
 assert.equal(b.getSheetByName('November').id,id);assert.equal(state.copies,1);assert.equal(state.held,false);
 if(failure==='failRename')assert.deepEqual(pending.entries,[{day:1,amount:42}]);
}
// Foreign staging tabs and removed/replaced pinned tabs fail closed.
{
 const {ctx,state,config}=fixture(),p=ctx.budgetMonthPeriod(new Date('2026-11-01T20:00Z')),b=state.books.get('brian');
 b.insertSheet('_BookieBot Preparing 2026-11',{template:b.getSheetByName('Template')});
 assert.throws(()=>ctx.prepareBudgetMonthTab('brian',config,p,'brian'),/Unclaimed/);
 b.sheets.delete('_BookieBot Preparing 2026-11');
 ctx.prepareBudgetMonthTab('brian',config,p,'brian');b.sheets.delete('November');
 assert.throws(()=>ctx.prepareBudgetMonthTab('brian',config,p,'brian'),/removed or renamed/);
}
// A second run cannot create, close or release a lock owned by another run.
{
 const {ctx,state}=fixture();state.held=true;assert.equal(ctx.budgetSystemRollover().status,'busy');assert.equal(state.copies,0);assert.equal(state.releases,0);
 state.held=false;ctx.prepareBudgetMonthsAt=()=>{throw Error('failed prep');};ctx.closePreviousBudgetMonthAt=()=>state.closed.push('closed');
 assert.throws(()=>ctx.budgetSystemRollover(),/failed prep/);assert.deepEqual(state.closed,['closed']);assert.equal(state.held,false);
}
// Closing resumes per owner/cell after a committed-but-lost write. November
// entries are unaffected, and completed owners are never frozen again.
{
 const {ctx,state,config}=fixture('2026-11-01T07:00Z');
 for(const id of ['brian','hannah']){const b=state.books.get(id),s=b.insertSheet('October',{template:b.getSheetByName('Template')});for(const label of ['Burn Rate','Static Bills & Subscriptions (Needs)','Subscriptions (Wants)']){const cell=s.cell(label+':1');cell.setFormula('=SUM(1,2)');s.cells.get(label+':1').value=3;}}
 state.failSnapshotKey='Static Bills & Subscriptions (Needs):1';assert.throws(()=>ctx.withBudgetRolloverLock(()=>ctx.closePreviousBudgetMonthAt(new Date('2026-11-01T07:00Z'))),/lost snapshot/);
 assert.equal(state.props.get('BUDGET_MONTH_CLOSED_V1_2026-10_hannah'),'closed');
 ctx.withBudgetRolloverLock(()=>ctx.closePreviousBudgetMonthAt(new Date('2026-11-02T20:00Z')));
 for(const id of ['brian','hannah'])for(const cell of state.books.get(id).getSheetByName('October').cells.values())if(cell.writes)assert.equal(cell.writes,1);
 const old=state.books.get('brian').getSheetByName('October');old.cell('Burn Rate:1').setFormula('=99');ctx.closePreviousBudgetMonthAt(new Date('2026-11-03T20:00Z'));assert.equal(old.cell('Burn Rate:1').getFormula(),'=99','A completed close is never replayed');
 const bad=old.cell('bad');bad.setFormula('=IMPORTRANGE()');old.cells.get('bad').value='#REF!';assert.throws(()=>ctx.snapshotFormulaCellValue(bad,'Fixture'),/not ready/);assert.equal(bad.getFormula(),'=IMPORTRANGE()');
}
// Trigger replacement is repeatable and survives a partial installation while
// preserving an old clock and unrelated edit handlers.
{
 const {ctx,state}=fixture();const old=ctx.ScriptApp.newTrigger('budgetSystemRollover').timeBased().atHour(1).create();
 const edit={getHandlerFunction:()=>'handleSharedExpensesEdit',getEventType:()=>'ON_EDIT'};state.triggers.push(edit);
 state.failTrigger=2;assert.throws(()=>ctx.installBudgetRolloverTriggers(),/transport/);assert.ok(state.triggers.includes(old));
 ctx.installBudgetRolloverTriggers();ctx.installBudgetRolloverTriggers();
 assert.equal(state.triggers.length,3);assert.ok(state.triggers.includes(edit));
 assert.deepEqual(state.triggers.filter(x=>x!==edit).map(x=>[x.handler,x.hour,x.days,x.zone]),[['prepareBudgetMonths',20,1,'America/Los_Angeles'],['budgetSystemRollover',1,1,'America/Los_Angeles']]);
}
// Existing production sheets use the older Needs label; strict closing accepts
// that spelling without silently skipping the intended snapshot.
{
 const {ctx,state}=fixture(),b=state.books.get('brian'),s=b.insertSheet('October',{template:b.getSheetByName('Template')});
 const lookup=ctx.findCellByExactText;ctx.findCellByExactText=(sheet,label)=>label==='Static Bills & Subscriptions (Needs)'?null:lookup(sheet,label);
 s.cell('Subscriptions (Needs):1').setFormula('=10');s.cells.get('Subscriptions (Needs):1').value=10;
 assert.equal(ctx.snapshotPersonalBudgetMonthOutputs('brian','October','brian',true),1);
 assert.equal(s.cell('Subscriptions (Needs):1').getFormula(),'');
}
// Annual file IDs are checkpointed independently, including a lost copy result.
// Initialization failure cannot publish an incomplete year or duplicate files.
for(const point of ['copy','initialize']){
 const {ctx,state}=fixture(),files=new Map(),folder={getFilesByName:name=>{const list=[...files.values()].filter(x=>x.name===name);return {hasNext:()=>list.length>0,next:()=>list.shift()};}};
 let copies=0,fail=true;
 ctx.getOrCreateChildFolder=()=>folder;
 ctx.DriveApp={getFolderById:()=>folder,getFileById:()=>({makeCopy:name=>{const file={name,id:'annual'+ ++copies,getId(){return this.id;},getMimeType:()=>'application/vnd.google-apps.spreadsheet'};files.set(file.id,file);if(point==='copy'&&fail){fail=false;throw Error('lost Drive copy');}return file;}})};
 ctx.initializeNewYearFiles=()=>{if(point==='initialize'&&fail){fail=false;throw Error('interrupted initialization');}};
 ctx.prepareBudgetMonthTabs=(_config,period)=>assert.equal(period.key,'2027-01');ctx.installBudgetEditTriggersForYearConfig=()=>{};
 assert.throws(()=>ctx.withBudgetRolloverLock(()=>ctx.getOrCreateYearFiles(2027)));
 assert.equal(state.props.has('YEAR_CONFIG_2027'),false);
 const config=ctx.withBudgetRolloverLock(()=>ctx.getOrCreateYearFiles(2027));assert.equal(config.year,2027);assert.equal(copies,3);
 assert.equal(ctx.getOrCreateYearFiles(2027).brianBudgetId,config.brianBudgetId);assert.equal(copies,3);
}
console.log('Pacific preparation/closing, validated publication, lock, retry, trigger and annual recovery contracts passed.');
