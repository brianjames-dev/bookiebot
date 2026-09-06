const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Sheet {
  constructor(name, rows = [[], [], [], ['', 'Date:', 'Source:', 'Amount:']]) { this.name = name; this.rows = rows; this.validations = {}; this.formulas = {}; this.writes = 0; this.insertions = 0; }
  getName() { return this.name; }
  getMaxRows() { return Math.max(20, this.rows.length); }
  getMaxColumns() { return 10; }
  setRowHeight() {}
  insertRowsBefore(row, count) { this.rows.splice(row-1, 0, ...Array.from({length:count}, () => [])); this.insertions += count; }
  value(r,c) {
    const value = this.rows[r]?.[c] ?? '';
    if (typeof value !== 'string' || !value.startsWith('=IF(')) return value;
    const match = /'([^']+)'!([B-E])5/.exec(value);
    if (!match) return value;
    const other = this.book.getSheetByName(match[1]);
    if (value.startsWith('=IF($B$5=') && this.value(4,1) !== other.value(4,1)) return '';
    const refs = [...value.matchAll(/'([^']+)'!([B-E])5/g)];
    const last = refs[refs.length-1];
    return other.value(4,last[2].charCodeAt(0)-65);
  }
  getDataRange() { return { getValues: () => this.rows.map((row,r) => row.map((_,c) => this.value(r,c))) }; }
  getRange(a1, column, rowCount=1, columnCount=1) {
    if (typeof a1 === 'number') a1 = `${String.fromCharCode(64+column)}${a1}:${String.fromCharCode(63+column+columnCount)}${a1+rowCount-1}`;
    const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
    const col = text => text.charCodeAt(0) - 65;
    const c = col(match[1]), r = Number(match[2]) - 1;
    const width = match[3] ? col(match[3]) - c + 1 : 1;
    const height = match[4] ? Number(match[4]) - r : 1;
    const range = {
      getValues: () => Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => this.value(r+y,c+x))),
      setValues: values => { this.writes++; values.forEach((row,y) => row.forEach((v,x) => { this.rows[r+y] ??= []; this.rows[r+y][c+x] = v; })); return range; },
      setFormulas: values => { this.formulas[a1] = values; return range.setValues(values); },
      setValue: value => range.setValues([[value]]),
      clear: () => range.setValues(Array.from({length:height}, () => Array(width).fill(''))),
      setDataValidation: rule => { this.validations[a1] = rule; return range; },
    };
    for (const name of ['clearDataValidations','setFontFamily','setFontSize','setVerticalAlignment','setHorizontalAlignment','setBorder','setBackground','setFontColor','setFontWeight','setNumberFormat','setNote','clearNote','setWrap']) range[name] = () => range;
    return range;
  }
}
const book = sheets => {
  const result = { getSheetByName: name => sheets[name] ?? null };
  Object.values(sheets).forEach(sheet => sheet.book = result);
  return result;
};
const ctx = vm.createContext({ console, SpreadsheetApp: {
  BorderStyle: { SOLID: 'solid' },
  newDataValidation() {
    const rule = {};
    const builder = { build: () => rule };
    for (const name of ['requireValueInList','requireNumberGreaterThanOrEqualTo','requireDate','setAllowInvalid','setHelpText']) {
      builder[name] = (...args) => { rule[name] = args; return builder; };
    }
    return builder;
  },
}});
vm.runInContext(fs.readFileSync('scripts/google-apps-script/budget-system-automation.gs','utf8'), ctx);
const plain = value => JSON.parse(JSON.stringify(value));
const legacy = new Sheet('July', [[], [], [], ['', '', '', '', 'Biweekly Income Source:', 'xAI'], ['', '', '', '', 'Biweekly Income Start:', '7/2/2026']]);
const template = new Sheet('Template');
const september = new Sheet('September');
ctx.writePersonalBudgetIncomeSettings(template, {source:'xAI', mode:'biweekly', anchor:'7/2/2026'});
ctx.writePersonalBudgetIncomeSettings(september, {source:'xAI', mode:'fixed monthly', amount:6000, anchor:'7/2/2026'});
const ss = book({Template:template, July:legacy, August:new Sheet('August'), September:september});
assert.deepEqual(plain(ctx.resolvePersonalBudgetIncomeSettings(ss,'October',false)), {source:'xAI', mode:'fixed monthly', amount:6000, anchor:'7/2/2026'});
assert.deepEqual(plain(ctx.resolvePersonalBudgetIncomeSettings(ss,'September',false)), {source:'xAI', mode:'biweekly', amount:'', anchor:'7/2/2026'});
assert.deepEqual(plain(ctx.mergePersonalBudgetIncomeSettings({source:'xAI',mode:'fixed monthly',amount:6000,anchor:'7/2/2026'},{source:'Sonic'})), {source:'Sonic'});
assert.equal(ctx.mergePersonalBudgetIncomeSettings({mode:'fixed monthly',amount:6000},{mode:'off'}).amount, 6000);
assert.equal(ctx.hasPersonalBudgetIncomeSettings(september),true);
assert.deepEqual(plain(september.validations.C5.requireValueInList), [['biweekly','fixed monthly','off'],true]);
assert.equal(september.validations.C5.setAllowInvalid[0], false);
assert.ok(september.validations.E5.requireDate);
assert.deepEqual(plain(ctx.readPersonalBudgetIncomeSettings(september)), {source:'xAI',mode:'fixed monthly',amount:6000,anchor:'7/2/2026'});
const collision = new Sheet('Other', [['','','','','Unrelated formula','=SUM(A1:A4)'],[],[],['','Date:','Source:','Amount:']]);
assert.throws(() => ctx.writePersonalBudgetIncomeSettings(collision,{}), /unrelated cells/);
assert.equal(collision.writes,0);

// Exercise the actual rollover branch: existing choices stay put, and a new
// month takes September's settings even though Template still says biweekly.
ctx.SpreadsheetApp.openById = () => ss;
ctx.ensureMonthLabel = () => {};
ctx.updatePersonalBudgetImportRanges = () => {};
const before = september.writes;
assert.equal(ctx.ensureMonthExistsInPersonalBudget('personal','shared','September','brian').created,false);
assert.equal(september.writes,before);
ctx.createMonthSheet = (_ss,name) => { const sheet = new Sheet(name, JSON.parse(JSON.stringify(template.rows))); sheet.book = ss; return sheet; };
const october = ctx.ensureMonthExistsInPersonalBudget('personal','shared','October','brian');
assert.equal(october.created,true);
assert.deepEqual(plain(ctx.readPersonalBudgetIncomeSettings(october.sheet)), {source:'xAI',mode:'fixed monthly',amount:6000,anchor:'7/2/2026'});
assert.ok(october.sheet.validations.C5.requireValueInList);
assert.ok(october.sheet.formulas['B5:E5'][0][0].includes("'September'!B5"));
september.getRange('D5').setValue(6500);
assert.equal(ctx.readPersonalBudgetIncomeSettings(october.sheet).amount,6500);
october.sheet.getRange('D5').setValue(7000);
september.getRange('D5').setValue(6600);
assert.equal(ctx.readPersonalBudgetIncomeSettings(october.sheet).amount,7000);
september.getRange('D5').setValue(6000);
assert.equal(template.insertions,3);
assert.deepEqual(template.getRange('B7:D7').getValues()[0],['Date:','Source:','Amount:']);
assert.deepEqual(template.getRange('B6:E6').getValues()[0],['','','','']);
const insertions = template.insertions;
ctx.writePersonalBudgetIncomeSettings(template,ctx.readPersonalBudgetIncomeSettings(template));
assert.equal(template.insertions,insertions);
assert.equal(ctx.shiftedPersonalBudgetAction({worksheet:'expense',row:5},3),null);
assert.equal(ctx.shiftedPersonalBudgetAction({worksheet:'income',row:0},3),null);
assert.deepEqual(plain(ctx.shiftedPersonalBudgetAction({worksheet:'income',row:5,metadata:{income_header_row:'4',income_summary_row:'6',income_anchor_values:'old'}},3)),
  {worksheet:'income',row:8,metadata:{income_header_row:'7',income_summary_row:'9'}});
assert.equal(ctx.shiftedPersonalBudgetAction({worksheet:'income',row:10,metadata:{type:'payment'}},3).row,13);

// New annual workbook templates inherit the prior year's last effective plan.
const brianNew = book({Template:new Sheet('Template')});
const hannahOld = book({Template:new Sheet('Template'), December:new Sheet('December', [['Main Income Source:','Sonic'],['Income Projection Mode:','off'],['Paycheck Anchor Date:','8/21/2026']])});
const hannahNew = book({Template:new Sheet('Template')});
const books = {brianOld:ss, hannahOld, brianNew, hannahNew};
ctx.getYearConfig = () => ({brianBudgetId:'brianOld',hannahBudgetId:'hannahOld'});
ctx.SpreadsheetApp.openById = id => books[id];
ctx.ensureMonthExistsInSharedExpenses = () => {};
ctx.ensureMonthExistsInPersonalBudget = () => {};
ctx.relinkAllPersonalBudgetSheetsForYear = () => {};
ctx.initializeNewYearFiles({year:2027,brianBudgetId:'brianNew',hannahBudgetId:'hannahNew',sharedExpensesId:'shared'});
assert.equal(ctx.readPersonalBudgetIncomeSettings(brianNew.getSheetByName('Template')).amount,6000);
assert.deepEqual(plain(ctx.readPersonalBudgetIncomeSettings(hannahNew.getSheetByName('Template'))), {source:'Sonic',mode:'off',amount:'',anchor:'8/21/2026'});
console.log('Income settings migration, dropdown, rollover, year rollover, and collision checks passed.');

// Plan row-reference shifts without altering data until the layout is moved.
const migrationLog = new Sheet('Log', [
 ['id','created_at','user_key','status','undone_at','action_json'],
 ['a','','676638528590970917','active','',JSON.stringify({worksheet:'income',row:10,metadata:{type:'payment'}})],
 ['b','','830984827904851969','active','',JSON.stringify({worksheet:'income',row:10})],
 ['c','','676638528590970917','active','',JSON.stringify({worksheet:'expense',row:10})],
]);
const ledger = new Sheet('Shared Reimbursements', [
 ['source_worksheet','expense_date','source_row'],
 ['income','9/1/2026',10], ['income','8/1/2026',10], ['expense','9/1/2026',10],
]);
ctx.SpreadsheetApp.openById = () => book({'_BookieBot Action Log - 2026-09':migrationLog});
const planned = ctx.planPersonalBudgetReferenceShift({year:2026,sharedExpensesId:'shared'},book({'Shared Reimbursements':ledger}),'brian','September');
assert.equal(planned.length,2);
assert.equal(migrationLog.writes,0);
assert.equal(ledger.writes,0);
planned.forEach(write => write.range.setValue(write.value));
assert.equal(JSON.parse(migrationLog.rows[1][5]).row,13);
assert.equal(JSON.parse(migrationLog.rows[2][5]).row,10);
assert.equal(ledger.rows[1][2],13);
assert.equal(ledger.rows[2][2],10);
assert.equal(ledger.rows[3][2],10);
const restored = ctx.shiftedPersonalBudgetAction({worksheet:'income',kind:'restore_row',row:5,previous_values:['','9/2/2026','xAI','3100','Paycheck Anchor Date:','7/2/2026'],metadata:{source_type:'income',income_amount_column:'4',income_anchor_values:'old',income_row_property_start_column:'2',income_row_properties:JSON.stringify({cells:[{},{},{},{},{}]})}},3);
assert.equal(restored.previous_values.length,4);
assert.equal(JSON.parse(restored.metadata.income_row_properties).cells.length,3);
assert.equal(restored.metadata.income_anchor_values,undefined);
