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
    let billReads = 0
    const { page, errors, unexpected } = await fixture(browser, 382, 740, dark, false, false, rail, {
      config: { householdEnabled: household },
      bills: route => {
        assert.equal(route.request().method(), "GET")
        billReads++
        return route.fulfill({ json: snapshot })
      },
      transfers: route => {
        assert.equal(route.request().method(), "GET")
        return route.fulfill({ json: { ownerName: "Brian", today: "2026-11-20", year: 2026, settingsVersion: "fixture",
          goals: [], transfers: [{ id: "saving", revision: 1, name: "Savings deposit", amountCents: 2500,
            frequency: "monthly", startsOn: "2026-12-01", effectiveFrom: "2026-11-20",
            goalId: "", fromAccount: "Checking", toAccount: "Savings", active: true, nextDate: "2026-12-01" }] } })
      },
      request: async route => {
        const { pathname } = new URL(route.request().url())
        if (pathname === "/app/notifications") {
          await route.fulfill({ json: { enabled: true, publicKey: "B" + "A".repeat(86),
            preferences: { weekly: true, weeklyDays: [0, 4], upcoming: true, reminderDaysBefore: 2, showAmounts: false, hour: 10 } } })
          return true
        }
        if (pathname === "/app/widgets/settings") {
          assert.equal(route.request().method(), "GET")
          await route.fulfill({ json: { connections: [{ id: "widget", label: "Small Widget", mode: "projected", status: "active",
            createdAt: "2026-11-20", expiresAt: "2026-12-20", lastUsedAt: "2026-11-21" }],
          scriptUrl: "/app/widgets/script", setupInstructionsUrl: "/app/widgets/help" } })
          return true
        }
        if (pathname !== "/app/household") return false
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
    const presentation = (locator, properties) => locator.evaluate((element, properties) => {
      const styles = getComputedStyle(element)
      return properties.map(property => styles[property])
    }, properties)
    const selectStyle = ["appearance", "borderRadius", "backgroundImage", "minHeight"]
    const menuStyle = ["backgroundColor", "borderColor", "borderRadius", "boxShadow", "padding"]
    const actionStyle = ["color", "borderRadius", "minHeight", "fontSize"]

    await tap(page, button("Settings"))
    await directory.waitFor()
    assert.equal(await page.locator(".bb-pull-refresh-space").count(), 0, "Settings directory has no pull gesture")
    assert.equal(await page.locator(".bb-shell-masthead").evaluate(el => getComputedStyle(el, "::before").content), "none")
    assert.deepEqual(await directory.getByRole("button").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label"))),
      ["Account", ...(household ? ["Household"] : []), "Bills", "Transfers", "Appearance", "Notifications", "Widgets", "About & updates"])
    assert.equal(await detail.isVisible(), false, "Closed Settings starts on the directory")
    await tap(page, category("Appearance"))
    await page.getByRole("switch", { name: "Raised cents" }).waitFor()
    assert.equal(await page.locator(".bb-pull-refresh-space").count(), 0, "Appearance has no pull gesture")
    assert.equal(await directory.isVisible(), false, "Only the selected category is visible in closed DUO")
    assert.equal(await button("Link Google account").isVisible(), false)
    await tap(page, button("Back"))
    await directory.waitFor()
    assert.equal(await category("Appearance").evaluate(el => el === document.activeElement), true)

    await page.setViewportSize({ width, height: 669 })
    await page.locator('.bb-page[data-duo-landscape="true"]').waitFor()
    await content("Settings").getByRole("heading", { name: "Account", exact: true }).waitFor()
    assert.equal(await category("Account").getAttribute("aria-current"), "page")
    assert.equal(await button("Refresh Settings").count(), 0)
    const sidebar = await page.locator(".bb-settings-sidebar").boundingBox()
    const back = await button("Back").boundingBox()
    const firstRow = await category("Account").boundingBox()
    assert(Math.abs(sidebar.y) < 1, "The open sidebar reaches the top of the canvas")
    assert(back.y >= sidebar.y && back.x + back.width <= sidebar.x + sidebar.width, "Back floats over the sidebar")
    assert(firstRow.y >= back.y + back.height, "The first category starts below the floating Back control")
    assert(await button("Back").evaluate(control => {
      const rect = control.getBoundingClientRect()
      return control.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    }), "The floating Back button remains tappable over the sidebar")
    await page.setViewportSize({ width, height: 480 })
    const sidebarPane = page.locator(".bb-settings-sidebar")
    await page.waitForFunction(() => document.querySelector(".bb-settings-sidebar").clientHeight === 480)
    await sidebarPane.evaluate(pane => { pane.scrollTop = 160 })
    assert((await category("Account").boundingBox()).y < back.y + back.height, "Sidebar rows can scroll behind Back")
    assert(Math.abs((await button("Back").boundingBox()).y - back.y) < 1, "Back stays fixed as the sidebar scrolls")
    await sidebarPane.evaluate(pane => { pane.scrollTop = 0 })
    await page.setViewportSize({ width, height: 669 })
    await page.waitForFunction(() => document.querySelector(".bb-settings-sidebar").clientHeight === 669)
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
    await tap(page, category("Notifications"))
    assert.equal(await button("Friday").getAttribute("aria-pressed"), "true")
    assert.equal(await button("Wednesday").getAttribute("aria-pressed"), "false")
    assert.equal(await page.getByLabel("Payment reminder timing").inputValue(), "2")
    assert.equal(await button("Send a test").count(), 0)
    assert.equal(await button("Enable on this phone").count(), 0)
    await page.setViewportSize({ width: 320, height: 740 })
    await page.locator('.bb-page:not([data-duo-landscape])').waitFor()
    assert(await detail.evaluate(pane => pane.scrollWidth <= pane.clientWidth + 1),
      "Notification preferences and registration errors fit a narrow screen")
    const timing = page.getByLabel("Payment reminder timing")
    assert((await timing.boundingBox()).width >= 136, "The selected reminder timing stays readable")
    const timingStyle = await presentation(timing, selectStyle)
    await page.setViewportSize({ width, height: 669 })
    await page.locator('.bb-page[data-duo-landscape="true"]').waitFor()
    await tap(page, category("Widgets"))
    await button("Pair a widget").waitFor()
    assert.equal(await button("Refresh widgets").count(), 0)
    assert.deepEqual(await presentation(page.getByLabel("Budget view for Small Widget"), selectStyle), timingStyle)
    const widgetMenuButton = button("Small Widget options")
    await tap(page, widgetMenuButton)
    const widgetMenu = page.locator('.bb-widget-settings .bb-report-menu-panel[data-open="true"]')
    const widgetPanelStyle = await presentation(widgetMenu, menuStyle)
    assert.equal(widgetPanelStyle[3], "none", "Options surfaces have no underglow")
    const removeStyle = await presentation(widgetMenu.getByRole("button", { name: "Remove", exact: true }), actionStyle)
    await widgetMenu.getByRole("button", { name: "Remove", exact: true }).press("Escape")
    assert.equal(await widgetMenuButton.getAttribute("aria-expanded"), "false")
    await tap(page, category("Transfers"))
    const transfers = content("Transfers")
    await tap(page, transfers.locator(".bb-bills-row").first())
    await transfers.getByRole("textbox", { name: "Amount", exact: true }).waitFor()
    assert.equal(await directory.isVisible(), true, "Transfers leaves the category sidebar available while editing")
    assert.equal(await button("Refresh transfers").count(), 1)
    await transfers.getByRole("button", { name: "Cancel", exact: true }).click()
    await tap(page, category("Bills"))
    const bills = content("Bills")
    await bills.getByText("Internet", { exact: true }).waitFor()
    assert.equal(await category("Bills").getAttribute("aria-current"), "page")
    assert.equal(await directory.isVisible(), true, "The schedule list starts on the right, with the category index visible")
    const refresh = page.waitForResponse(response => response.url().includes("/app/bills?fresh=1"))
    await button("Refresh bills").click()
    await refresh
    await tap(page, bills.locator(".bb-bills-row").first())
    const name = bills.getByRole("textbox", { name: "Name", exact: true })
    await name.fill("Internet draft")
    assert.equal(await directory.isVisible(), true, "Bills leaves the category sidebar available while editing")
    assert(await bills.evaluate(main => {
      const row = main.querySelector(".bb-bills-row").getBoundingClientRect()
      const editor = main.querySelector(".bb-bills-editor[data-open=true]").getBoundingClientRect()
      return editor.top >= row.bottom - 1 && Math.abs(editor.left - row.left) < 1
    }), "The editor sits inline beneath its row")
    await page.setViewportSize({ width: 382, height: 740 })
    await page.locator('.bb-page:not([data-duo-landscape])').waitFor()
    assert.equal(await name.inputValue(), "Internet draft")
    assert.equal(await bills.locator(".bb-bills-refresh").count(), 0)
    await page.locator(".bb-pull-refresh-space").waitFor({ state: "attached" })
    await page.locator(".bb-page").evaluate(shell => { shell.scrollTop = 0 })
    const beforePull = billReads
    await bills.locator(".bb-bills-row").first().evaluate(target => {
      const fire = (type, y) => {
        const event = new Event(type, { bubbles: true, cancelable: true })
        const points = [{ identifier: 1, clientX: 50, clientY: y }]
        Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : points }, changedTouches: { value: points } })
        target.dispatchEvent(event)
      }
      fire("touchstart", 100)
      fire("touchmove", 430)
      fire("touchend", 430)
    })
    await page.waitForFunction(() => document.querySelector(".bb-pull-refresh")?.dataset.phase === "done")
    assert.equal(billReads, beforePull + 1)
    await page.setViewportSize({ width, height: 669 })
    await page.locator('.bb-page[data-duo-landscape="true"]').waitFor()
    assert.equal(await name.inputValue(), "Internet draft")
    await bills.getByRole("button", { name: "Cancel", exact: true }).click()
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
    await tap(page, button("Shared"))
    await tap(page, button("Reimbursement options"))
    const sharedMenu = page.getByRole("dialog", { name: "Options", exact: true })
    assert.deepEqual(await presentation(sharedMenu, menuStyle), widgetPanelStyle)
    assert.deepEqual(await presentation(sharedMenu.getByRole("button", { name: "Reset balances", exact: true }), actionStyle), removeStyle)
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
