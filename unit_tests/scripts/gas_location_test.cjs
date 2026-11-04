const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('scripts/google-apps-script/budget-system-automation.gs','utf8');
const ctx = vm.createContext({console, SpreadsheetApp: {}});
vm.runInContext(source,ctx);
function shared(shift) {
  const headers=[Array(40+shift).fill(''),Array(40+shift).fill('')];
  for(const [col,category,amount,person] of [[1,'GROCERY',2,4],[8,'GAS',9,10],[14,'FOOD',16,18],[22,'SHOPPING',24,26],[30,'NEEDS',32,34]]) {
    const c=value=>value+(value>=10?shift:0);
    headers[0][c(col)-1]=category; headers[1][c(col)-1]='Date'; headers[1][c(amount)-1]='Amount'; headers[1][c(person)-1]='Person';
  }
  if(shift)headers[1][9]='Location';
  const stamps=[];
  const sheet={headers,stamps,getMaxColumns:()=>40+shift,getName:()=> 'November',getRange:(r,c,n=1,w=1)=>({
    getDisplayValues:()=>headers.slice(r-1,r-1+n).map(row=>row.slice(c-1,c-1+w)),
    getValue:()=>'',setValue:value=>stamps.push({r,c,value})})};
  return sheet;
}
for(const shift of [0,1]) {
  const sheet=shared(shift);
  ctx.SpreadsheetApp.openById=()=>({getSheetByName:()=>sheet});
  assert.equal(ctx.sharedExpenseColumnShift(sheet),shift);
  ctx.validatePreparedBudgetMonthTab(sheet,{}, {},null);
  for(const [owner,row] of [['brian',4],['hannah',5]]) {
    const rules=ctx.personalBudgetImportRules('shared','November',owner);
    assert.deepEqual(Array.from(rules,r=>r.sharedExpenseCell),(shift?['F','M','AK','U','AC']:['F','L','AJ','T','AB']).map(col=>col+row));
    const imports=[];
    const personal={getName:()=> 'November'};
    ctx.findCellByExactText=(_sheet,label)=>({getRow:()=>1,getColumn:()=>1});
    personal.getRange=()=>({setFormula:formula=>imports.push(formula)});
    ctx.updatePersonalBudgetImportRanges(personal,'shared','November',owner);
    assert.ok(imports.some(value=>value.includes(`'November'!${shift?'M':'L'}${row}`)));
  }
  ctx.isKnownSharedExpensesSpreadsheet=()=>true;
  for(const [amount,date] of [[2,1],[9,8],[16,14],[24,22],[32,30]]) {
    const amountColumn=amount+(amount>=10?shift:0);
    ctx.handleSharedExpensesEdit({source:{getId:()=> 'shared'},range:{getSheet:()=>sheet,getRow:()=>3,getColumn:()=>amountColumn}});
    assert.equal(sheet.stamps.at(-1).c,date+(date>=10?shift:0));
  }
  const before=sheet.stamps.length;
  // Editing a merchant, person, or header must never stamp a purchase date.
  for(const [r,c] of [[3,shift?10:17],[2,9],[3,shift?11:10]])
    ctx.handleSharedExpensesEdit({source:{getId:()=> 'shared'},range:{getSheet:()=>sheet,getRow:()=>r,getColumn:()=>c}});
  assert.equal(sheet.stamps.length,before);
  sheet.headers[1][9]='Unknown';
  assert.throws(()=>ctx.sharedExpenseColumnShift(sheet),/Gas headers/);
}
console.log('Gas layouts, both owners’ imports, all downstream date stamps, and unknown-header guards passed.');
