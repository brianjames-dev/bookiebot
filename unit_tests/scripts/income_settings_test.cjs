const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Sheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows; this.validations = {}; this.writes = 0; }
  getName() { return this.name; }
  getDataRange() { return { getValues: () => this.rows }; }
  getRange(a1) {
    const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
    const col = text => text.charCodeAt(0) - 65;
    const c = col(match[1]), r = Number(match[2]) - 1;
    const width = match[3] ? col(match[3]) - c + 1 : 1;
    const height = match[4] ? Number(match[4]) - r : 1;
    const range = {
      getValues: () => Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => this.rows[r+y]?.[c+x] ?? '')),
      setValues: values => { this.writes++; values.forEach((row,y) => row.forEach((v,x) => { this.rows[r+y] ??= []; this.rows[r+y][c+x] = v; })); return range; },
      setDataValidation: rule => { this.validations[a1] = rule; return range; },
    };
    for (const name of ['clearDataValidations','setFontFamily','setFontSize','setVerticalAlignment','setHorizontalAlignment','setBorder','setBackground','setFontColor','setFontWeight','setNumberFormat','setNote','clearNote']) range[name] = () => range;
    return range;
  }
}
const book = sheets => ({ getSheetByName: name => sheets[name] ?? null });
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
assert.deepEqual(plain(ctx.resolvePersonalBudgetIncomeSettings(ss,'September',false)), {source:'xAI', mode:'biweekly', anchor:'7/2/2026'});
assert.deepEqual(plain(ctx.mergePersonalBudgetIncomeSettings({source:'xAI',mode:'fixed monthly',amount:6000,anchor:'7/2/2026'},{source:'Sonic'})), {source:'Sonic'});
assert.equal(ctx.mergePersonalBudgetIncomeSettings({mode:'fixed monthly',amount:6000},{mode:'off'}).amount, undefined);
assert.equal(ctx.hasPersonalBudgetIncomeSettings(september),true);
assert.deepEqual(plain(september.validations.F3.requireValueInList), [['biweekly','fixed monthly','off'],true]);
assert.equal(september.validations.F3.setAllowInvalid[0], false);
assert.ok(september.validations.F5.requireDate);
assert.deepEqual(plain(ctx.readPersonalBudgetIncomeSettings(september)), {source:'xAI',mode:'fixed monthly',amount:6000,anchor:'7/2/2026'});
const collision = new Sheet('Other', [['','','','','Unrelated formula','=SUM(A1:A4)']]);
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
ctx.createMonthSheet = (_ss,name) => new Sheet(name, JSON.parse(JSON.stringify(template.rows)));
const october = ctx.ensureMonthExistsInPersonalBudget('personal','shared','October','brian');
assert.equal(october.created,true);
assert.deepEqual(plain(ctx.readPersonalBudgetIncomeSettings(october.sheet)), {source:'xAI',mode:'fixed monthly',amount:6000,anchor:'7/2/2026'});
assert.ok(october.sheet.validations.F3.requireValueInList);

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
assert.deepEqual(plain(ctx.readPersonalBudgetIncomeSettings(hannahNew.getSheetByName('Template'))), {source:'Sonic',mode:'off',anchor:'8/21/2026'});
console.log('Income settings migration, dropdown, rollover, year rollover, and collision checks passed.');
