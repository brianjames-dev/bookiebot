const assert = require('node:assert/strict')
const {prepareSavingsPlan} = require('../../scripts/prepare_espp_sheet.cjs')
const headers = ['First eligible paycheck','Last eligible paycheck','Payroll source','ESPP rate']
function fixture() {
  const rows = Array.from({length:34}, () => [])
  rows[3] = ['', 'Main Income Source', 'Income Projection Mode', 'Expected Income Amount', 'Paycheck Anchor Date']
  rows[4] = ['', 'xAI', 'biweekly', 3800, '10/9/2026']
  rows[6] = ['', 'Date:', 'Source:', 'Amount:']
  rows[7] = ['', '10/9/2026', 'xAI', 3800]
  rows[8] = ['', '10/23/2026', 'xAI paycheck', 7600]
  rows[9] = ['', '10/24/2026', 'Rewards', 1000]
  rows[12] = ['', 'Monthly Income:', '', '=SUM(D8:D12)']
  rows[14] = ['', 'BUDGET: $12,400', 6200, 3720, 2480]
  rows[15] = ['', 'Name', 'Needs (50%)', 'Wants (30%)', 'Savings (20%)']
  rows[31] = ['', 'Enter Monthly Savings Contribution ➡️', 'IDEAL = $2,480', 'MINIMUM = $1,240', 1234]
  return rows
}
function writes(requests, id=0) {
  const result = new Map()
  for (const request of requests) {
    const inserted=request.insertDimension?.range
    if(inserted?.sheetId===id) {
      const shifted=[...result].map(([key,value])=>{let [row,column]=key.split(':').map(Number); return [`${row>=inserted.startIndex ? row+inserted.endIndex-inserted.startIndex : row}:${column}`,value]})
      result.clear();shifted.forEach(([key,value])=>result.set(key,value))
    }
    const update=request.updateCells
    if (!update || update.range.sheetId!==id) continue
    for (const [y,row] of (update.rows || []).entries()) for (const [x,cell] of row.values.entries())
      result.set(`${update.range.startRowIndex+y}:${update.range.startColumnIndex+x}`, cell.userEnteredValue)
  }
  return result
}
const prepared = prepareSavingsPlan({rows:fixture(),year:2026,title:'October'})
const written = writes(prepared)
assert.equal(prepared.filter(r=>r.addSheet).length,0)
assert.equal(prepared.find(r=>r.insertDimension).insertDimension.range.startIndex,6)
assert.equal(written.get('16:1').stringValue,'SpaceX ESPP this month')
assert.equal(written.get('7:1').numberValue,46318)
assert.equal(written.get('7:3').stringValue,'xAI')
assert.equal(written.get('7:4').numberValue,.05)
const deduction = written.get('16:3').formulaValue
assert.ok(!deduction.includes("'ESPP Settings'"))
assert.ok(deduction.includes('ROUND(FILTER('))
assert.ok(deduction.includes('INDEX(D:D,ROW(D10)+1):INDEX(D:D,ROW(D16)-1)'))
assert.ok(deduction.includes('DATE(2026,10,1)'))
assert.ok(deduction.includes('Check ESPP settings'))
assert.ok(deduction.includes('Check income total'))
assert.ok(written.get('35:2').formulaValue.includes('0.2-IFNA(VLOOKUP('))
assert.ok(written.get('35:3').formulaValue.includes('/2,2)'))
for (const key of ['18:2','18:3','18:4']) assert.ok(written.get(key).formulaValue.includes('TEXT('))
assert.ok(prepared.some(r=>r.updateBorders?.range.startRowIndex===16 && r.updateBorders.range.endColumnIndex===4))
assert.ok(!written.has('35:4')) // actual cash input is never overwritten
const settingsRows = [headers,['2026-10-23','','xAI',.05],['2027-01-01','','xAI',.04]]
const future = prepareSavingsPlan({rows:fixture(),year:2026,title:'November',settingsRows})
assert.equal(future.find(r=>r.insertDimension).insertDimension.range.endIndex,8)
assert.equal(writes(future).get('8:4').numberValue,.04)
assert.throws(()=>prepareSavingsPlan({rows:fixture(),year:2026,title:'October',firstPaycheckDate:'2026-02-30'}),/Invalid ESPP/)
const collision=fixture(); collision[13][4]='=unrelated formula'
assert.throws(()=>prepareSavingsPlan({rows:collision,year:2026,title:'October'}),/Occupied ESPP/)
const occupied=fixture(); occupied[5][1]='Keep me'
assert.throws(()=>prepareSavingsPlan({rows:occupied,year:2026,title:'October'}),/Inspect space/)
const inline=fixture(); inline.splice(6,0, ['', '10/23/2026','','xAI',.05]); inline[5]=['',...headers]; inline[14]=['','SpaceX ESPP this month','',0]
const again=prepareSavingsPlan({rows:inline,year:2026,title:'October',settingsRows})
assert.equal(again.filter(r=>r.insertDimension).length,3)
assert.equal(writes(again).get('7:4').numberValue,.05) // monthly snapshot wins over a different external schedule
const legacy=fixture()
legacy[3].push('', 'ESPP Income Source','ESPP Rate','ESPP First Paycheck Date','ESPP Cash Ideal Rate','ESPP Cash Minimum Rate','ESPP Last Paycheck Date')
legacy[4].push('', 'xAI',.05,'2026-10-23',.15,.075,'')
const labels=['Savings & investing','Deposited income','Eligible payroll deposits','ESPP contribution','Take-home before ESPP','Other income','Ideal cash savings','Minimum cash savings','Cash savings contributed','Combined savings + ESPP','Needs allocation','Wants allocation','Cash savings allocation','ESPP status']
labels.forEach((label,i)=>{legacy[14+i][6]=label;legacy[14+i][7]='=old formula'})
legacy[33][8]='Keep me'
const migration=prepareSavingsPlan({rows:legacy,year:2026,title:'October'})
const cleared=migration.filter(r=>r.updateCells && !r.updateCells.rows)
assert.equal(cleared.length,6)
assert.ok(cleared.some(r=>r.updateCells.range.startRowIndex===3))
assert.ok(cleared.some(r=>r.updateCells.range.startRowIndex===18))
assert.equal(migration.some(r=>r.deleteDimension),false)
assert.equal(migration.some(r=>r.updateDimensionProperties?.range.startIndex===6),false)
console.log('Inline ESPP snapshots, formulas, table borders, migration scope and collisions passed.')

const spaced=inline.map(row=>[...row]);spaced.splice(5,0,[]);spaced.splice(8,0,[]);spaced.splice(17,0,[]);
assert.ok(!prepareSavingsPlan({rows:spaced,year:2026,title:'October'}).some(r=>r.insertDimension));
const buffers=prepared.filter(r=>r.repeatCell?.cell.userEnteredFormat?.backgroundColor?.red===67/255);
assert.ok(buffers.length>=3);
