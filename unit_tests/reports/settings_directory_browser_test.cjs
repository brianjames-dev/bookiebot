// Shipped bundle, synthetic accounts and schedules. Navigation only reads data.
const assert = require("node:assert/strict")
const { fixture, tap, engines } = require("./duo_layout_browser_test.cjs")

const snapshot = {
  month: "2026-11", today: "2026-11-20", settingsVersion: "fixture", ownerName: "Brian",
  partnerName: "Hannah", incomeBasisPoints: 6500, splitsEnabled: true,
  bills: [{
    id: "internet", name: "Internet", type: "fixed", amountCents: 5900, cadence: "monthly",
    pullDay: 21, pullMonths: [], category: "bills_utilities", account: "", active: true,
    effectiveFrom: "2026-11", splitMethod: "none", payerBasisPoints: 10000,
    nextDate: "2026-11-21", version: "fixture", charge: { available: false, month: "2026-11" },
  }],
}

async function check(engine, { width, rail, dark, household }) {
  const browser = await engine.launch()
  try {
    const { page, errors, unexpected } = await fixture(browser, 382, 740, dark, false, false, rail, {
      config: { householdEnabled: household },
      bills: route => {
        assert.equal(route.request().method(), "GET")
        return route.fulfill({ json: snapshot })
      },
      request: async route => {
        if (new URL(route.request().url()).pathname !== "/app/household") return false
        assert.equal(route.request().method(), "GET")
        await route.fulfill({ json: { account: { id: "fixture", name: "Brian" }, provider: "sheets", household: null } })
        return true
      },
    })
    const button = name => page.getByRole("button", { name, exact: true })
    const directory = page.getByRole("navigation", { name: "Settings categories" })
    const category = name => directory.getByRole("button", { name, exact: true })
    const detail = page.locator(".bb-settings-detail")
    const content = label => page.getByRole("main", { name: label, exact: true })

    await tap(page, button("Settings"))
    await directory.waitFor()
    assert.deepEqual(await directory.getByRole("button").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label"))),
      ["Account", ...(household ? ["Household"] : []), "Bills", "Transfers", "Appearance", "Notifications", "Widgets", "About & updates"])
    assert.equal(await detail.isVisible(), false, "Closed Settings starts on the directory")
    await tap(page, category("Appearance"))
    await page.getByRole("switch", { name: "Raised cents" }).waitFor()
    assert.equal(await directory.isVisible(), false, "Only the selected category is visible in closed DUO")
    assert.equal(await button("Link Google account").isVisible(), false)
    await tap(page, button("Back"))
    await directory.waitFor()
    assert.equal(await category("Appearance").evaluate(el => el === document.activeElement), true)

    await page.setViewportSize({ width, height: 669 })
    await page.locator('.bb-page[data-duo-landscape="true"]').waitFor()
    await content("Settings").getByRole("heading", { name: "Account", exact: true }).waitFor()
    assert.equal(await category("Account").getAttribute("aria-current"), "page")
    const divider = page.getByRole("separator", { name: "Settings sidebar width" })
    await divider.press("ArrowRight")
    assert.equal(await divider.getAttribute("aria-valuenow"), "41")
    await page.waitForFunction(() => {
      const work = document.querySelector(".bb-settings-workspace").getBoundingClientRect()
      const split = document.querySelector(".bb-settings-divider").getBoundingClientRect()
      return Math.abs((split.left + split.width / 2 - work.left) / work.width - .41) < .005
    })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const handle = await divider.boundingBox()
    const hit = await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.outerHTML.slice(0,250), { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 })
    assert(hit?.includes("bb-settings-divider"), JSON.stringify({handle,hit}))
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 63, handle.y + handle.height / 2, { steps: 6 })
    await page.mouse.up()
    const draggedWidth = Number(await divider.getAttribute("aria-valuenow"))
    assert(draggedWidth < 41 && draggedWidth >= 28, "Drag adjusts the usable-width split: " + draggedWidth)
    assert.equal(await page.evaluate(() => window.getSelection().toString()), "", "Dragging does not select Settings labels")
    assert.equal(await divider.evaluate(el => el.matches(":focus-visible")), false, "Dragging clears the divider's focus marker")
    const measure = () => page.evaluate(() => {
      const workspace = document.querySelector(".bb-settings-workspace").getBoundingClientRect()
      const sidebar = document.querySelector(".bb-settings-sidebar").getBoundingClientRect()
      const detail = document.querySelector(".bb-settings-detail").getBoundingClientRect()
      const shell = document.querySelector(".bb-page")
      return { workspace: workspace.width, sidebar: sidebar.width, detail: detail.width, end: detail.right,
        overlay: parseFloat(shell.style.getPropertyValue("--bb-duo-overlay")), viewport: innerWidth, scroll: shell.scrollHeight - shell.clientHeight }
    })
    await page.waitForFunction(expected => {
      const workspace = document.querySelector(".bb-settings-workspace").getBoundingClientRect()
      const sidebar = document.querySelector(".bb-settings-sidebar").getBoundingClientRect()
      return Math.abs(sidebar.width / workspace.width * 100 - expected) < .5
    }, draggedWidth)
    const geometry = await measure()
    assert(Math.abs(geometry.sidebar / geometry.workspace * 100 - draggedWidth) < .5, JSON.stringify({ geometry, draggedWidth }))
    assert(Math.abs(geometry.end + geometry.overlay - geometry.viewport) < 1, "Both panes stay within the usable canvas")
    assert(geometry.scroll < 2, "Only the Settings panes can scroll in open DUO")

    if (household) {
      await tap(page, category("Household"))
      await button("Create household").waitFor()
    }
    await tap(page, category("Bills"))
    const bills = content("Bills")
    await bills.getByText("Internet", { exact: true }).waitFor()
    assert.equal(await category("Bills").getAttribute("aria-current"), "page")
    assert.equal(await directory.isVisible(), true, "The schedule list starts on the right, with the category index visible")
    await tap(page, bills.locator(".bb-bills-row").first())
    const name = bills.getByRole("textbox", { name: "Name", exact: true })
    await name.fill("Internet draft")
    await page.setViewportSize({ width: 382, height: 740 })
    await page.locator('.bb-page:not([data-duo-landscape])').waitFor()
    assert.equal(await name.inputValue(), "Internet draft")
    await page.setViewportSize({ width, height: 669 })
    await page.locator('.bb-page[data-duo-landscape="true"]').waitFor()
    assert.equal(await name.inputValue(), "Internet draft")
    await tap(page, bills.getByRole("button", { name: "Cancel", exact: true }))
    await directory.waitFor()
    assert.equal(Number(await divider.getAttribute("aria-valuenow")), draggedWidth)
    await tap(page, category("Appearance"))
    await page.setViewportSize({ width: 382, height: 740 })
    await page.locator('.bb-page:not([data-duo-landscape])').waitFor()
    assert.equal(await page.locator(".bb-settings-screen-heading").innerText(), "Appearance")
    assert.equal(await directory.isVisible(), false)
    await tap(page, button("Back"))
    await directory.waitFor()
    await tap(page, button("Back"))
    await page.locator('.bb-page[data-screen="overview"]').waitFor()
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
    console.log("PASS grouped Settings, category routing, resize, gutter, fold and draft", engine.name(), width)
  } finally {
    await browser.close()
  }
}

;(async () => {
  for (const engine of engines) {
    await check(engine, { width: 951, rail: 84, dark: true, household: true })
    await check(engine, { width: 867, rail: 0, dark: false, household: false })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
