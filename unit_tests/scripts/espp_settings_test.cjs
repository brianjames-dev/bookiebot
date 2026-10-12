const assert = require('node:assert/strict')
const {prepareSavingsPlan} = require('../../scripts/prepare_espp_sheet.cjs')

function fixture() {
  const rows = Array.from({length:34}, () => [])
  rows[3] = ['', 'Main Income Source', 'Income Projection Mode', 'Expected Income Amount', 'Paycheck Anchor Date']
  rows[4] = ['', 'xAI', 'biweekly', 3800, '10/9/2026']
  rows[6] = ['', 'Date:', 'Source:', 'Amount:']
  rows[7] = ['', '10/9/2026', 'xAI', 3800]
  rows[8] = ['', '10/23/2026', 'xAI paycheck', 7600]
  rows[9] = ['', '10/24/2026', 'Rewards', 1000]
  rows[12] = ['', 'Monthly Income:', '', 12400]
  rows[14] = ['', 'BUDGET: $12,400', 6200, 3720, 2480]
  rows[15] = ['', 'Name', 'Needs (50%)', 'Wants (30%)', 'Savings (20%)']
  rows[31] = ['', 'Enter Monthly Savings Contribution ➡️', 'IDEAL = $2,480', 'MINIMUM = $1,240', 1234]
  return rows
}
const rows = fixture()
const prepared = prepareSavingsPlan({rows, year:2026, title:'October'})
const written = new Map()
for (const request of prepared) {
  if (!request.updateCells) continue
  const {range, rows: data} = request.updateCells
  data.forEach((row,y) => row.values.forEach((cell,x) => written.set(`${range.startRowIndex+y}:${range.startColumnIndex+x}`, cell.userEnteredValue)))
}
assert.equal(written.get('4:6').stringValue,'xAI')
assert.equal(written.get('4:7').numberValue,.05)
assert.equal(written.get('4:8').numberValue,46318) // 2026-10-23
assert.equal(written.get('4:9').numberValue,.15)
assert.equal(written.get('4:10').numberValue,.075)
assert.equal(written.get('14:2').formulaValue,'=TEXT(H25,"$#,##0.00")')
assert.equal(written.get('14:4').formulaValue,'=TEXT(H27,"$#,##0.00")')
assert.equal(written.get('15:4').stringValue,'Cash savings')
assert.equal(written.get('14:3').formulaValue,'=TEXT(H26,"$#,##0.00")')
assert.equal(written.get('12:3'),undefined) // Income total remains owned by its original formula.
assert.equal(written.get('31:4'),undefined) // Actual cash savings remains editable, untouched.
assert.equal(written.get('7:3'),undefined) // No deposit is rewritten.
const deduction = written.get('17:7').formulaValue
assert.ok(deduction.includes('ROUND(FILTER('))
assert.ok(deduction.includes('*$H$5/(1-$H$5),2)'))
assert.ok(deduction.includes('INDEX(D:D,ROW(D7)+1):INDEX(D:D,ROW(D13)-1)'))
assert.ok(deduction.includes('DATE(2026,10,1)'))
assert.ok(deduction.includes('(income|paycheck|payroll|salary|wages)'))
assert.ok(written.get('20:7').formulaValue.includes('*$J$5+H20*20%'))
assert.ok(written.get('21:7').formulaValue.includes('*$K$5+H20*10%'))
// Only the added region, allocation values/header, and target labels can change.
for (const key of written.keys()) {
  const [row,column] = key.split(':').map(Number)
  assert.ok(column >= 6 || (row===14 && column>=2 && column<=4) || (row===15 && column===4) || (row===31 && (column===2 || column===3)), `Unexpected mutation: ${key}`)
}
for (const collision of [[3,6], [4,11], [15,7]]) {
  const changed = fixture(); changed[collision[0]][collision[1]] = '=unrelated formula'
  assert.throws(() => prepareSavingsPlan({rows:changed,year:2026,title:'October'}), /Occupied/)
}
assert.throws(() => prepareSavingsPlan({rows,year:2026,title:'October',firstPaycheckDate:'2026-02-30'}), /Invalid ESPP/)
const pending = prepareSavingsPlan({rows,year:2026,title:'Template',firstPaycheckDate:''})
assert.ok(pending.length)
// Rerunning setup preserves actuals and updates references rather than duplicating a block.
const installed = fixture()
for (const [key,value] of written) {
  const [row,column] = key.split(':').map(Number)
  installed[row] ??= []
  installed[row][column] = value.formulaValue ?? value.stringValue ?? value.numberValue
}
const again = prepareSavingsPlan({rows:installed,year:2026,title:'October'})
assert.ok(again.length < prepared.length)
// Upgrade the original beside-income block without deleting it with a paycheck.
const besideIncome = fixture()
for (let i=0;i<14;i++) {
  besideIncome[6+i] ??= []
  besideIncome[6+i][6] = installed[14+i][6]
  besideIncome[6+i][7] = installed[14+i][7]
}
const moved = prepareSavingsPlan({rows:besideIncome,year:2026,title:'October'})
const move = moved.find(request => request.cutPaste).cutPaste
assert.equal(move.source.startRowIndex,6)
assert.equal(move.destination.rowIndex,14)
assert.equal(rows[31][4],1234)
console.log('ESPP settings, mutation scope, formula boundaries, collisions and repeat setup passed.')
