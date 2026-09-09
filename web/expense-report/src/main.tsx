import React from "react"
import { createRoot } from "react-dom/client"
import "./konsta.css"

import { ExpenseReportApp } from "./report-app"
import { FreshExpenseApp } from "./fresh-expense-app"
import type { ExpenseAppConfig } from "./expense-app-session"
import type { ExpenseReportData } from "./types"
import "./styles.css"
import "./expense-app-shell.css"

function readReportData(): ExpenseReportData {
  const script = document.getElementById("bookiebot-expense-report-data")
  if (!script?.textContent) {
    throw new Error("Missing expense report data")
  }
  return JSON.parse(script.textContent) as ExpenseReportData
}

const root = document.getElementById("bookiebot-expense-report-root")

if (root) {
  const appConfig = document.getElementById("bookiebot-expense-app-config")
  createRoot(root).render(
    <React.StrictMode>
      {appConfig?.textContent
        ? <FreshExpenseApp config={JSON.parse(appConfig.textContent) as ExpenseAppConfig} />
        : <ExpenseReportApp report={readReportData()} />}
    </React.StrictMode>,
  )
}
