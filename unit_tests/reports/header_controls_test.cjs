const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")

const frontend = path.join(__dirname, "../../web/expense-report")
const frontendRequire = createRequire(path.join(frontend, "package.json"))
const ts = frontendRequire("typescript")
const React = frontendRequire("react")
const { renderToStaticMarkup } = frontendRequire("react-dom/server")

function load(relative) {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(frontend, "src", relative), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  })
  const runtime = vm.createContext({ exports: {}, require: frontendRequire })
  vm.runInContext(outputText, runtime)
  return runtime.exports
}

const { AppRefreshControl } = load("app-refresh-control.tsx")
const render = (changes = {}) => renderToStaticMarkup(React.createElement(AppRefreshControl, {
  state: { phase: "ready", updatedAt: Date.now(), signingOut: false, message: "", ...changes },
  refresh: () => {},
}))
const ready = render()
assert.ok(ready.includes('aria-label="Refresh expenses"'), "Icon-only refresh retains a useful accessible name")
assert.ok(ready.includes("Updated "))
assert.ok(ready.includes("dateTime=") && ready.includes("title="), "Compact time retains the full timestamp")
assert.ok(!ready.includes("up to date") && !ready.includes("Sign out"))
assert.ok(!ready.includes('disabled=""'))
const refreshing = render({ phase: "refreshing" })
assert.ok(refreshing.includes("is-refreshing") && refreshing.includes('disabled=""'))
assert.ok(refreshing.includes("Refreshing…"))
const stale = render({ phase: "stale", message: "Couldn’t refresh. Check your connection and try again." })
assert.ok(stale.includes("Couldn’t refresh") && stale.includes("Showing "))
assert.ok(!stale.includes("Updated "), "A failed refresh must never suggest old data is freshly updated")
const unavailable = render({ phase: "error", updatedAt: null, message: "Couldn’t refresh." })
assert.ok(unavailable.includes("Couldn’t refresh") && !unavailable.includes("<time"))
assert.ok(render({ signingOut: true }).includes('disabled=""'))
const old = render({ updatedAt: new Date(2020, 0, 2, 8, 15).getTime() })
assert.ok(/Updated [^<]*Jan/.test(old), "An older update must include its date, not just a misleading clock time")

const { ReportMenu } = load("components/ui/report-menu.tsx")
const menu = renderToStaticMarkup(React.createElement(ReportMenu, null, React.createElement("button", null, "Sign out")))
assert.ok(menu.includes('aria-expanded="false"') && menu.includes('inert=""'))
const id = /aria-controls="([^"]+)"/.exec(menu)?.[1]
assert.ok(id && menu.includes(`id="${id}"`))
assert.ok(menu.includes("Sign out"), "Closed menu retains its children for an animated exit")
console.log("Compact header status and disclosure checks passed")
