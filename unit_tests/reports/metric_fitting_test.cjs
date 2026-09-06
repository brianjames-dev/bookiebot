const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("../../web/expense-report/node_modules/typescript");

const source = fs.readFileSync("web/expense-report/src/components/ui/fitted-amount.tsx", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function mount(text, available, natural, rounding = 0) {
  const refs = [];
  const effects = [];
  const windowEvents = new Map();
  const fontEvents = new Map();
  const observed = [];
  let observerCallback;
  let fontReady;
  let disconnected = false;
  let writes = 0;
  const values = new Map();
  const container = {
    clientWidth: available,
    style: {
      getPropertyValue: (name) => values.get(name) ?? "",
      setProperty: (name, value) => { writes++; values.set(name, value); },
    },
  };
  const measurement = { getBoundingClientRect: () => ({ width: natural }) };
  const visible = {
    getBoundingClientRect: () => {
      const scale = Number(values.get("--bb-amount-fit") ?? 1);
      return { width: scale > 0 ? natural * scale + rounding : 0 };
    },
  };
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require: (id) => {
      if (id === "react") return {
        useRef: () => { const ref = { current: null }; refs.push(ref); return ref; },
        useLayoutEffect: (effect) => effects.push(effect),
      };
      if (id === "react/jsx-runtime") return {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      };
      throw new Error(`Unexpected import ${id}`);
    },
    ResizeObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe(target) { observed.push(target); }
      disconnect() { disconnected = true; }
    },
    window: {
      addEventListener: (event, listener) => windowEvents.set(event, listener),
      removeEventListener: (event) => windowEvents.delete(event),
    },
    document: {
      fonts: {
        addEventListener: (event, listener) => fontEvents.set(event, listener),
        removeEventListener: (event) => fontEvents.delete(event),
        ready: { then: (callback) => { fontReady = callback; } },
      },
    },
  };
  vm.runInNewContext(compiled, context);
  const tree = module.exports.FittedAmount({ children: text, className: "bb-metric-value" });
  refs[0].current = container;
  refs[1].current = measurement;
  refs[2].current = visible;
  const cleanup = effects[0]();
  return {
    tree, container, observed, windowEvents, fontEvents, cleanup,
    natural: () => natural,
    renderedWidth: () => visible.getBoundingClientRect().width,
    setNatural: (width) => { natural = width; },
    observe: () => observerCallback(),
    fontsReady: () => fontReady(),
    scale: () => Number(values.get("--bb-amount-fit")),
    writes: () => writes,
    disconnected: () => disconnected,
  };
}

// Smaller glyph sizes can round up beyond the linear measurement estimate.
// The final visible measurement must fit even with this rendering error.
for (const available of [128, 245, 270]) {
  const rounded = mount("$123,456,789,012.34", available, 412, 3.5);
  assert.ok(rounded.renderedWidth() <= available - 1);
  const writes = rounded.writes();
  rounded.observe();
  assert.equal(rounded.writes(), writes, "corrected sizes do not repeat measurement writes");
  rounded.container.clientWidth = 100;
  rounded.observe();
  assert.ok(rounded.renderedWidth() <= 99);
  rounded.cleanup();
}

// Exact, signed and unusually long formatted amounts retain a single visible
// accessible string, while only the independent measuring copy is hidden.
for (const text of ["$0.00", "-$12,345.67", "$123,456,789,012.34", "N/A"]) {
  const fitted = mount(text, 78, text.length * 21);
  const [probe, visible] = fitted.tree.props.children;
  assert.equal(probe.props["aria-hidden"], "true");
  assert.equal(visible.props.children, text);
  assert.equal(visible.props["aria-hidden"], undefined);
  assert.ok(fitted.scale() * fitted.natural() <= 77.00001);
  assert.equal(fitted.observed.length, 2);
  const writes = fitted.writes();
  fitted.observe();
  assert.equal(fitted.writes(), writes, "identical observations do not write styles again");
  fitted.cleanup();
}

const fitted = mount("$123,456.78", 112, 200);
assert.ok(fitted.scale() < 1);
fitted.container.clientWidth = 400;
fitted.observe();
assert.equal(fitted.scale(), 1, "expanding the container restores preferred font size");
fitted.container.clientWidth = 90;
fitted.windowEvents.get("resize")();
assert.ok(fitted.scale() * fitted.natural() <= 89.00001, "browser resize/zoom refits the value");
fitted.setNatural(300);
fitted.fontEvents.get("loadingdone")();
assert.ok(fitted.scale() * fitted.natural() <= 89.00001, "loaded font metrics trigger fitting");
fitted.setNatural(150);
fitted.fontsReady();
assert.ok(Math.abs(fitted.scale() - 89 / 150) < 1e-8);
fitted.container.clientWidth = 0;
const previous = fitted.scale();
fitted.observe();
assert.equal(fitted.scale(), previous, "hidden containers do not produce invalid sizing");
fitted.cleanup();
assert.equal(fitted.disconnected(), true);
assert.equal(fitted.windowEvents.size, 0);
assert.equal(fitted.fontEvents.size, 0);
const writes = fitted.writes();
fitted.fontsReady();
assert.equal(fitted.writes(), writes, "late font resolution does not touch an unmounted value");
console.log("Metric amount fitting checks passed.");
