const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const req = createRequire(path.resolve("web/expense-report/package.json"))
const React = req("react")
const renderer = req("react-test-renderer")
const ts = req("typescript")
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const documentEvents = new Map(), windowEvents = new Map(), frames = new Map(), properties = new Map()
let tree, focused, serial = 0, selection = null
class TestNode {
  constructor(kind, month) { this.kind = kind; this.dataset = month ? { month } : {}; this.disabled = false }
  focus() { focused = this }
  contains(node) { return this === node || this.kind === "panel" && node.kind === "month" }
}
const triggerNode = new TestNode("trigger")
triggerNode.getBoundingClientRect = () => ({ left:250, top:400, bottom:444 })
const monthNodes = new Map()
const monthNode = (month) => {
  if (!monthNodes.has(month)) monthNodes.set(month, new TestNode("month", month))
  const node = monthNodes.get(month)
  node.disabled = tree.root.findByProps({ "data-month":month }).props.disabled
  return node
}
const gridButtons = () => tree.root.findAllByType("button").filter(node => node.props["data-month"])
const panelNode = new TestNode("panel")
panelNode.querySelectorAll = () => gridButtons().map(node => monthNode(node.props["data-month"]))
panelNode.querySelector = selector => {
  const node = gridButtons().find(node => !node.props.disabled && (selector.includes("aria-pressed") ? node.props["aria-pressed"] : true))
  return node ? monthNode(node.props["data-month"]) : null
}
const popoverNode = { offsetWidth:288, offsetHeight:268, style:{ setProperty:(key,value)=>properties.set(key,value) } }
const document = {
  body:{}, addEventListener:(name,fn)=>documentEvents.set(name,fn),
  removeEventListener:(name,fn)=>{ if (documentEvents.get(name) === fn) documentEvents.delete(name) },
}
const window = {
  innerWidth:320, innerHeight:480,
  addEventListener:(name,fn)=>windowEvents.set(name,fn),
  removeEventListener:(name,fn)=>{ if (windowEvents.get(name) === fn) windowEvents.delete(name) },
}
const source = ts.transpileModule(fs.readFileSync("web/expense-report/src/components/ui/month-picker.tsx", "utf8"), {
  compilerOptions:{ module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX },
}).outputText
const runtime = { exports:{}, document, window, Node:TestNode, HTMLButtonElement:TestNode,
  requestAnimationFrame:fn=>{ frames.set(++serial,fn);return serial }, cancelAnimationFrame:id=>frames.delete(id),
  require:name=>name === "react" ? React : name === "react-dom" ? { createPortal:children=>children }
    : name === "konsta/react" ? { Popover:({ children, ...props })=>React.createElement("test-popover",props,children) }
      : name.endsWith(".css") ? {} : req(name),
}
vm.runInNewContext(source,runtime)
let disabled = false, value = "2026-09"
const options = [{value:"2024-12",label:"December 2024"},{value:"2026-08",label:"August 2026"},
  {value:"2026-09",label:"September 2026"},{value:"2026-13",label:"Invalid month"}]
const component = () => React.createElement(runtime.exports.MonthPicker, { label:"Report month",value,options,disabled,onSelect:next=>{selection=next} })
renderer.act(()=>{ tree=renderer.create(component(),{createNodeMock:element=>element.type === "test-popover" ? popoverNode
  : element.props.className === "bb-month-panel" ? panelNode : element.props.className === "bb-month-trigger" ? triggerNode : null}) })
const trigger = () => tree.root.findByProps({className:"bb-month-trigger"})
const popup = () => tree.root.findByType("test-popover")
const button = label => tree.root.findAllByType("button").find(node=>node.props["aria-label"]===label)
const click = node => renderer.act(()=>node.props.onClick())
const open = () => { click(trigger()); renderer.act(()=>{ for (const fn of frames.values()) fn(); frames.clear() }) }
const dispatch = (event,detail) => renderer.act(()=>documentEvents.get(event)?.(detail))
assert.equal(trigger().props["aria-haspopup"],"dialog")
assert.equal(trigger().props["aria-expanded"],false)
assert.equal(popup().props.inert,true)
open()
assert.equal(popup().props.opened,true)
assert.equal(popup().props.inert,false)
assert.equal(focused.dataset.month,"2026-09","Opening focuses the selected month")
assert.equal(gridButtons().length,12)
assert.deepEqual(gridButtons().filter(node=>!node.props.disabled).map(node=>node.props["data-month"]),["2026-08","2026-09"])
assert.equal(button("Next year").props.disabled,true)
assert.equal(properties.get("--bb-month-left"),"16px","A right-edge trigger stays within a narrow viewport")
assert.equal(properties.get("--bb-month-top"),"124px","The picker flips above a low trigger rather than leaving the viewport")
assert.equal(properties.get("--bb-month-origin"),"center bottom")
assert.equal(selection,null,"Opening and positioning never select or fetch a report")
click(button("Previous year"))
assert.equal(button("Previous year").props.disabled,true)
assert.deepEqual(gridButtons().filter(node=>!node.props.disabled).map(node=>node.props["data-month"]),["2024-12"])
assert.equal(selection,null,"Browsing years does not change the selected month")
click(button("Next year"))
renderer.act(()=>tree.root.findByProps({className:"bb-month-panel"}).props.onKeyDown({
  key:"Home", target:monthNode("2026-09"), preventDefault:()=>{},
}))
assert.equal(focused.dataset.month,"2026-08","Home skips unavailable months")
dispatch("focusin",{target:monthNode("2026-08")})
assert.equal(popup().props.opened,true,"Moving focus inside the popover keeps it open")
click(button("August 2026"))
assert.equal(selection,"2026-08")
assert.equal(popup().props.opened,false)
assert.equal(focused,triggerNode,"Selecting a month returns focus without scrolling")
open()
let prevented=false
dispatch("keydown",{key:"Escape",preventDefault:()=>{prevented=true}})
assert.ok(prevented)
assert.equal(popup().props.opened,false)
assert.equal(focused,triggerNode)
assert.equal(documentEvents.size,0)
open()
dispatch("pointerdown",{target:new TestNode("outside")})
assert.equal(popup().props.opened,false,"An outside pointer closes the popover")
open()
dispatch("focusin",{target:new TestNode("outside")})
assert.equal(popup().props.opened,false,"Keyboard focus leaving the popover dismisses it")
open()
renderer.act(()=>windowEvents.get("bookiebot:screen-change")?.())
assert.equal(popup().props.opened,false,"Navigation dismisses a portal whose report screen remains mounted but hidden")
open()
disabled=true
renderer.act(()=>tree.update(component()))
assert.equal(popup().props.opened,false,"Disabling the control closes its live popover")
assert.equal(trigger().props.disabled,true)
disabled=false
renderer.act(()=>tree.update(component()))
open()
value="2026-08"
renderer.act(()=>tree.update(component()))
assert.equal(popup().props.opened,false,"An externally changed report cannot retain a stale open picker")
open()
renderer.act(()=>tree.unmount())
assert.equal(documentEvents.size,0)
assert.equal(windowEvents.size,0)
assert.equal(frames.size,0)
console.log("Month grid availability, automatic focus, dismissal and viewport checks passed")
