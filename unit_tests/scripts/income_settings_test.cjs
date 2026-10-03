const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const pendingFormulaWrites = [];
const validationErrors = [];
const flush = () => {
  const writes = pendingFormulaWrites.splice(0);
  for (const write of writes) write();
};
const isDate = value => (value instanceof Date && Number.isFinite(value.getTime())) ||
  (typeof value === 'string' && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value) && Number.isFinite(Date.parse(value)));
function accepts(rule, value) {
  if (!rule || rule.setAllowInvalid?.[0] !== false || value === '') return true;
  if (rule.requireValueInList) return rule.requireValueInList[0].includes(value);
  // Native Apps Script setValue accepts negative numeric values under this
  // strict rule, while rejecting text. Keep the rule itself unchanged below.
  if (rule.requireNumberGreaterThanOrEqualTo) return typeof value === 'number';
  if (rule.requireDate) return isDate(value);
  throw new Error('Unsupported mock validation');
}

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
      setValues: values => { this.writes++; values.forEach((row,y) => row.forEach((v,x) => {
        const rule = this.validations[`${String.fromCharCode(65+c+x)}${r+y+1}`];
        if (!(typeof v === 'string' && v.startsWith('=')) && !accepts(rule, v)) throw new Error(rule.setHelpText[0]);
        this.rows[r+y] ??= []; this.rows[r+y][c+x] = v;
      })); return range; },
      setFormulas: values => {
        const rulesAtWrite = {...this.validations};
        const write = () => {
          if (this.formulaWriteError) throw this.formulaWriteError;
          // Reproduce the observed host failure: B/C formulas persist before
          // a typed D5 validator rejects the queued formula and reports later.
          if (this.deferFormulaWrites) {
            values.forEach((row,y) => row.forEach((formula,x) => {
              const address = `${String.fromCharCode(65+c+x)}${r+y+1}`;
              const rule = rulesAtWrite[address] || this.validations[address];
              if (rule?.setAllowInvalid?.[0] === false && (rule.requireNumberGreaterThanOrEqualTo || rule.requireDate)) {
                throw new Error(rule.setHelpText[0]);
              }
              this.rows[r+y] ??= []; this.rows[r+y][c+x] = formula;
            }));
          }
          this.formulas[a1] = values;
          return range.setValues(values);
        };
        if (this.deferFormulaWrites) pendingFormulaWrites.push(write);
        else write();
        return range;
      },
      setValue: value => range.setValues([[value]]),
      clear: () => range.setValues(Array.from({length:height}, () => Array(width).fill(''))),
      setDataValidation: rule => {
        if (this.validationWriteError) throw this.validationWriteError;
        for (let y=0; y<height; y++) for (let x=0; x<width; x++) this.validations[`${String.fromCharCode(65+c+x)}${r+y+1}`] = rule;
        return range;
      },
      getDataValidations: () => Array.from({length:height}, (_,y) => Array.from({length:width}, (_,x) => this.validations[`${String.fromCharCode(65+c+x)}${r+y+1}`] ?? null)),
      setDataValidations: rules => {
        if (this.validationWriteError) throw this.validationWriteError;
        rules.forEach((row,y) => row.forEach((rule,x) => {
          const address = `${String.fromCharCode(65+c+x)}${r+y+1}`;
          if (rule) this.validations[address] = rule;
          else delete this.validations[address];
        }));
        return range;
      },
      clearDataValidations: () => {
        for (let y=0; y<height; y++) for (let x=0; x<width; x++) delete this.validations[`${String.fromCharCode(65+c+x)}${r+y+1}`];
        return range;
      },
    };
    for (const name of ['setFontFamily','setFontSize','setVerticalAlignment','setHorizontalAlignment','setBorder','setBackground','setFontColor','setFontWeight','setNumberFormat','setNote','clearNote','setWrap']) range[name] = () => range;
    return range;
  }
}
const book = sheets => {
  const result = { getSheetByName: name => sheets[name] ?? null };
  Object.values(sheets).forEach(sheet => sheet.book = result);
  return result;
};
const ctx = vm.createContext({ console, Logger: {log: message => validationErrors.push(message)}, SpreadsheetApp: {
  BorderStyle: { SOLID: 'solid' },
  flush,
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

function inheritanceFixture(settings) {
  const previous = new Sheet('September');
  const current = new Sheet('October');
  ctx.writePersonalBudgetIncomeSettings(previous, settings);
  ctx.writePersonalBudgetIncomeSettings(current, settings);
  const workbook = book({September:previous, October:current});
  current.deferFormulaWrites = true;
  return {previous, current, workbook};
}

// Model the production incident, including the delayed error and B/C partial
// write. No formula read or validation behavior is hidden by a no-op mock.
const failed = inheritanceFixture({source:'xAI', mode:'biweekly', amount:3775, anchor:'7/2/2026'});
failed.current.getRange('D5').setDataValidation(ctx.SpreadsheetApp.newDataValidation()
  .requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).setHelpText('Expected take-home amount').build());
failed.current.getRange('B5:E5').setFormulas(october.sheet.formulas['B5:E5']);
assert.equal(failed.current.rows[4][1], 'xAI');
assert.throws(flush, /Expected take-home amount/);
assert.ok(failed.current.rows[4][1].startsWith('='));
assert.ok(failed.current.rows[4][2].startsWith('='));
assert.equal(failed.current.rows[4][3], 3775);
assert.equal(failed.current.rows[4][4], '7/2/2026');
ctx.inheritPersonalBudgetIncomeSettings(failed.workbook, failed.current, 'October');
assert.equal(pendingFormulaWrites.length, 0);
assert.ok(failed.current.rows[4].slice(1,5).every(value => value.startsWith('=')));
assert.equal(failed.current.value(4,3), 3775);

for (const settings of [
  {source:'xAI', mode:'biweekly', amount:3775, anchor:'7/2/2026'},
  {source:'xAI', mode:'biweekly', amount:'', anchor:''},
  {source:'xAI', mode:'biweekly', amount:0, anchor:''},
  {source:'Sonic', mode:'off', amount:2232.47, anchor:'8/21/2026'},
]) {
  const {previous, current, workbook} = inheritanceFixture(settings);
  const otherRows = plain(current.rows.filter((_, index) => index !== 4));
  const originalValidations = current.getRange('B5:E5').getDataValidations()[0];
  ctx.inheritPersonalBudgetIncomeSettings(workbook, current, 'October');
  assert.equal(pendingFormulaWrites.length, 0, 'formulas must be committed before returning');
  assert.deepEqual(plain(current.getRange('B5:E5').getValues()[0]), Object.values(settings));
  assert.deepEqual(plain(current.rows.filter((_, index) => index !== 4)), otherRows);
  current.getRange('B5:E5').getDataValidations()[0].forEach((rule, index) => assert.equal(rule, originalValidations[index]));
  for (const column of ['C','D','E']) {
    assert.equal(current.validations[`${column}5`].setAllowInvalid[0], false);
    assert.ok(accepts(current.validations[`${column}5`], current.value(4,column.charCodeAt(0)-65)));
  }
  assert.throws(() => current.getRange('C5').setValue('weekly'), /Biweekly/);
  assert.equal(current.validations.D5.requireNumberGreaterThanOrEqualTo[0], 0);
  assert.throws(() => current.getRange('D5').setValue('not income'), /Expected take-home/);
  assert.throws(() => current.getRange('E5').setValue('not a date'), /Biweekly only/);

  previous.getRange('D5').setValue(4000);
  assert.equal(current.value(4,3), 4000);
  current.getRange('B5').setValue('Different employer');
  assert.equal(current.value(4,3), '');
  assert.equal(current.value(4,4), '');
  assert.ok(accepts(current.validations.D5, current.value(4,3)));
  assert.ok(accepts(current.validations.E5, current.value(4,4)));
  current.getRange('D5').setValue(5000);
  current.getRange('E5').setValue('9/4/2026');
  previous.getRange('D5').setValue(4500);
  assert.equal(current.value(4,3), 5000);
  assert.equal(current.value(4,4), '9/4/2026');

  ctx.SpreadsheetApp.openById = () => workbook;
  const currentBefore = plain(current.rows);
  const validationsBefore = plain(current.validations);
  ctx.ensureMonthExistsInPersonalBudget('personal','shared','October','brian');
  assert.deepEqual(plain(current.rows), currentBefore, 'daily rollover must preserve existing overrides');
  assert.deepEqual(plain(current.validations), validationsBefore);
}
ctx.SpreadsheetApp.openById = () => ss;

// Native smoke tests found identical negative-number setter behavior before
// and after restoration. Do not claim the script setter enforces the UI rule.
const negativeValue = inheritanceFixture({source:'xAI', mode:'biweekly', amount:3775, anchor:''});
negativeValue.current.getRange('D5').setValue(-1);
assert.equal(negativeValue.current.value(4,3), -1);
ctx.inheritPersonalBudgetIncomeSettings(negativeValue.workbook, negativeValue.current, 'October');
negativeValue.current.getRange('D5').setValue(-1);
assert.equal(negativeValue.current.value(4,3), -1);
assert.equal(negativeValue.current.validations.D5.requireNumberGreaterThanOrEqualTo[0], 0);
assert.equal(negativeValue.current.validations.D5.setAllowInvalid[0], false);

// Restore validators even if committing formulas fails, without masking the
// original failure when restoring validation independently fails as well.
const writeFailure = inheritanceFixture({source:'xAI', mode:'biweekly', amount:3775, anchor:''});
const originalError = new Error('Simulated formula commit failure');
writeFailure.current.formulaWriteError = originalError;
assert.throws(() => ctx.inheritPersonalBudgetIncomeSettings(writeFailure.workbook, writeFailure.current, 'October'), error => error === originalError);
assert.ok(writeFailure.current.validations.C5);
assert.ok(writeFailure.current.validations.D5);
assert.ok(writeFailure.current.validations.E5);
writeFailure.current.validationWriteError = new Error('Simulated validation restoration failure');
assert.throws(() => ctx.inheritPersonalBudgetIncomeSettings(writeFailure.workbook, writeFailure.current, 'October'), error => error === originalError);
assert.match(validationErrors.at(-1), /validation restoration failure/);
delete writeFailure.current.formulaWriteError;
assert.throws(() => ctx.inheritPersonalBudgetIncomeSettings(writeFailure.workbook, writeFailure.current, 'October'), /validation restoration failure/);

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
console.log('Income settings migration, validation-safe rollover, deferred failure recovery, overrides, year rollover, and collision checks passed.');

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
