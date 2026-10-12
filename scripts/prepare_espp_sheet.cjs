// Prepare the actual Apps Script setup as an atomic Sheets API batch.
// This adapter only reads stdin and emits requests; it cannot access an account.
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")

function prepareSavingsPlan({rows, year, title, firstPaycheckDate = "2026-10-23"}) {
  rows = rows.map(row => [...row])
  const requests = []
  const columnNumber = letters => [...letters].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0)
  const columnName = value => { let name = ""; for (; value; value = Math.floor((value-1)/26)) name = String.fromCharCode(65+(value-1)%26)+name; return name }
  const sheet = {getName: () => title, getParent: () => ({getName: () => `Budget ${year}`}),
    getMaxRows: () => Math.max(rows.length, 40), getMaxColumns: () => 12,
    setColumnWidth: (column, width) => dimension("COLUMNS", column, 1, width),
    setColumnWidths: (column, count, width) => dimension("COLUMNS", column, count, width),
    setRowHeight: (row, height) => dimension("ROWS", row, 1, height),
    getDataRange: () => sheet.getRange(1, 1, Math.max(1, rows.length), 12),
    getRange(a1, column, height = 1, width = 1) {
      let row
      if (typeof a1 === "string") {
        const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1)
        if (!match) throw new Error(`Unsupported range ${a1}`)
        row = Number(match[2]); column = columnNumber(match[1])
        height = match[4] ? Number(match[4])-row+1 : 1; width = match[3] ? columnNumber(match[3])-column+1 : 1
      } else row = a1
      const grid = {sheetId: 0, startRowIndex: row-1, endRowIndex: row-1+height, startColumnIndex: column-1, endColumnIndex: column-1+width}
      const repeat = (cell, fields) => { requests.push({repeatCell: {range: grid, cell, fields}}); return range }
      const format = (value, fields) => repeat({userEnteredFormat: value}, `userEnteredFormat.${fields}`)
      const range = {
        getRow: () => row, getColumn: () => column,
        _grid: grid,
        getA1Notation: () => `${columnName(column)}${row}${height === 1 && width === 1 ? "" : `:${columnName(column+width-1)}${row+height-1}`}`,
        offset: (dy, dx) => sheet.getRange(row+dy, column+dx),
        getValues: () => Array.from({length: height}, (_, y) => Array.from({length: width}, (_, x) => rows[row-1+y]?.[column-1+x] ?? "")),
        setValues(values) {
          const data = values.map((valuesRow, y) => ({values: valuesRow.map((value, x) => {
            rows[row-1+y] ??= []; rows[row-1+y][column-1+x] = value
            const entered = value && typeof value.getFullYear === "function"
              ? {numberValue: (Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())-Date.UTC(1899,11,30))/86400000}
              : typeof value === "number" ? {numberValue: value}
              : String(value).startsWith("=") ? {formulaValue: value} : {stringValue: String(value)}
            return {userEnteredValue: entered}
          })}))
          requests.push({updateCells: {range: {...grid, endRowIndex: row-1+values.length, endColumnIndex: column-1+values[0].length}, rows: data, fields: "userEnteredValue"}})
          return range
        },
        setFormula: value => range.setValues([[value]]),
        moveTo(destination) {
          const values = range.getValues()
          for (let y=0;y<height;y++) for (let x=0;x<width;x++) { rows[row-1+y] ??= []; rows[row-1+y][column-1+x] = "" }
          const target = destination._grid
          for (let y=0;y<height;y++) for (let x=0;x<width;x++) { rows[target.startRowIndex+y] ??= []; rows[target.startRowIndex+y][target.startColumnIndex+x] = values[y][x] }
          requests.push({cutPaste:{source:grid,destination:{sheetId:0,rowIndex:target.startRowIndex,columnIndex:target.startColumnIndex},pasteType:"PASTE_NORMAL"}})
          return range
        },
        setFontFamily: value => format({textFormat:{fontFamily:value}}, "textFormat.fontFamily"),
        setFontSize: value => format({textFormat:{fontSize:value}}, "textFormat.fontSize"),
        setFontWeight: value => format({textFormat:{bold:value === "bold"}}, "textFormat.bold"),
        setFontColor: value => format({textFormat:{foregroundColor:color(value)}}, "textFormat.foregroundColor"),
        setBackground: value => format({backgroundColor:color(value)}, "backgroundColor"),
        setWrap: value => format({wrapStrategy:value ? "WRAP" : "CLIP"}, "wrapStrategy"),
        setVerticalAlignment: value => format({verticalAlignment:value.toUpperCase()}, "verticalAlignment"),
        setNumberFormat: pattern => format({numberFormat:{type:pattern.includes("%") ? "PERCENT" : pattern.includes("yyyy") ? "DATE" : "CURRENCY", pattern}}, "numberFormat"),
        setDataValidation: value => repeat({dataValidation:value}, "dataValidation"),
        setNote: value => repeat({note:value}, "note"),
      }
      return range
    },
  }
  function dimension(type, start, count, pixels) {
    requests.push({updateDimensionProperties: {range: {sheetId:0, dimension:type, startIndex:start-1, endIndex:start-1+count}, properties:{pixelSize:pixels}, fields:"pixelSize"}})
  }
  function color(hex) { return {red:parseInt(hex.slice(1,3),16)/255, green:parseInt(hex.slice(3,5),16)/255, blue:parseInt(hex.slice(5,7),16)/255} }
  function find(_sheet, text, contains) {
    for (let r=0; r<rows.length; r++) for (let c=0; c<rows[r].length; c++) {
      const value = String(rows[r][c]).toLowerCase()
      if (contains ? value.includes(text.toLowerCase()) : value === text.toLowerCase()) return sheet.getRange(r+1,c+1)
    }
    return null
  }
  const context = vm.createContext({console, SpreadsheetApp:{newDataValidation() {
    const rule = {strict:true, showCustomUi:true}
    const builder = {requireNumberBetween: (low,high) => { rule.condition = {type:"NUMBER_BETWEEN",values:[{userEnteredValue:String(low)},{userEnteredValue:String(high)}]}; return builder },
      requireDate: () => { rule.condition = {type:"DATE_IS_VALID"}; return builder }, setAllowInvalid: allow => { rule.strict = !allow; return builder }, build: () => rule}
    return builder
  }}})
  vm.runInContext(fs.readFileSync(path.join(__dirname,"google-apps-script/budget-system-automation.gs"),"utf8"), context)
  context.findCellByExactText = (value,text) => find(value,text,false)
  context.findCellContainingText = (value,text) => find(value,text,true)
  context.writePersonalBudgetSavingsPlan(sheet, ["xAI", .05, firstPaycheckDate, .15, .075, ""], year)
  return requests
}

module.exports = {prepareSavingsPlan}
if (require.main === module) process.stdout.write(JSON.stringify(prepareSavingsPlan(JSON.parse(fs.readFileSync(0,"utf8")))))
