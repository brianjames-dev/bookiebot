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
const source = fs.readFileSync(path.join(frontend, "src/components/ui/motion.tsx"), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
})
const runtime = vm.createContext({ exports: {}, require: frontendRequire })
vm.runInContext(outputText, runtime)
const { CollapsibleContent, AnimatedDisclosure } = runtime.exports

// Retaining the same content in both states permits the exit animation to run.
// Inert protects links/buttons while those retained children are collapsed.
for (const open of [false, true]) {
  const markup = renderToStaticMarkup(React.createElement(
    CollapsibleContent,
    { open, id: "expense-details" },
    React.createElement("button", null, "View receipt"),
  ))
  assert.ok(markup.includes("View receipt"), "Collapsed content must remain mounted")
  assert.ok(markup.includes('id="expense-details"'))
  assert.ok(markup.includes(`aria-hidden="${!open}"`))
  assert.equal(markup.includes('inert=""'), !open, "Only collapsed content must be inert")
}

const disclosure = renderToStaticMarkup(React.createElement(
  AnimatedDisclosure,
  { summary: React.createElement("strong", null, "Shared dinner") },
  React.createElement("p", null, "Partner share $35.00"),
))
assert.ok(disclosure.includes('<button type="button"'))
assert.ok(disclosure.includes('aria-expanded="false"'))
const contentId = /aria-controls="([^"]+)"/.exec(disclosure)?.[1]
assert.ok(contentId, "The disclosure button must identify its content")
assert.ok(disclosure.includes(`id="${contentId}"`))
assert.ok(disclosure.includes("Shared dinner"))
assert.ok(disclosure.includes("Partner share $35.00"))
assert.ok(disclosure.includes('inert=""'))

console.log("Expense report disclosure accessibility checks passed")
