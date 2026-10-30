const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm')
const {createRequire} = require('node:module'), path = require('node:path')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const React = req('react'), Renderer = req('react-test-renderer'), ts = req('typescript')
global.IS_REACT_ACT_ENVIRONMENT = true
const source = ts.createSourceFile('report-app.tsx', fs.readFileSync('web/expense-report/src/report-app.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set(['ChartCarouselNavigation', 'ChartCarouselIndicators'])
const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
assert.equal(declarations.length, 2)
const runtime = {exports: {}, require: req, FittedAmount: ({children}) => React.createElement('span', null, children), clamp: (value, min, max) => Math.max(min, Math.min(max, value))}
vm.runInNewContext(ts.transpileModule(declarations.map(node => node.getText(source)).join('\n') + '\nexports.Navigation=ChartCarouselNavigation', {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX},
}).outputText, runtime)
const all = [{id: 'category', title: 'Category Mix'}, {id: 'burn-rate', title: 'Burn Rate'}, {id: 'calendar', title: 'Calendar'}, {id: 'bills', title: 'Bills & Utilities'}]
for (const panels of [all, all.filter(panel => panel.id !== 'burn-rate')]) {
  let tree
  function Harness() {
    const [activeIndex, onSelect] = React.useState(0)
    return React.createElement(runtime.exports.Navigation, {panels, activeIndex, onSelect})
  }
  try {
    Renderer.act(() => {tree = Renderer.create(React.createElement(Harness))})
    const buttons = () => tree.root.findAllByType('button')
    const title = () => tree.root.findByType('h2').findByType('span').children.join('')
    const active = index => {
      assert.equal(title(), panels[index].title, 'The sole visible title follows the selected graph')
      assert.equal(buttons().filter(button => button.props['aria-pressed']).length, 1)
      assert.equal(buttons()[index].props['aria-pressed'], true)
    }
    assert.equal(buttons().length, panels.length, 'No marker is rendered for missing burn-rate data')
    assert.equal(tree.root.findByType('h2').props['aria-live'], 'polite')
    panels.forEach((panel, index) => {
      const button = buttons()[index]
      assert.equal(button.props['aria-label'], `Show ${panel.title}`)
      assert.equal(button.props['aria-controls'], `bb-chart-${panel.id}`)
      assert.equal(button.findByType('span').props['aria-hidden'], 'true')
      assert.deepEqual(button.findByType('span').children, [], 'Markers do not repeat the graph titles visually')
      Renderer.act(() => button.props.onClick())
      active(index)
    })
    const key = name => {
      let prevented = false
      Renderer.act(() => tree.root.findByProps({role: 'group'}).props.onKeyDown({key: name, preventDefault() {prevented = true}}))
      return prevented
    }
    assert.equal(key('ArrowRight'), true); active(panels.length - 1)
    assert.equal(key('ArrowLeft'), true); active(panels.length - 2)
    Renderer.act(() => buttons()[0].props.onClick())
    assert.equal(key('ArrowLeft'), true); active(0)
    assert.equal(key('ArrowRight'), true); active(1)
    assert.equal(key('Tab'), false); active(1)
  } finally {if (tree) Renderer.act(() => tree.unmount())}
}
console.log('Quiet header: current title, dynamic named markers, click/keyboard selection and bounded endpoints passed.')
