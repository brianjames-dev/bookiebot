import React from "react"
import { createRoot } from "react-dom/client"

import { ExpenseReportApp } from "./report-app"
import type { ExpenseReportData } from "./types"
import "./styles.css"

function readReportData(): ExpenseReportData {
  const script = document.getElementById("bookiebot-expense-report-data")
  if (!script?.textContent) {
    throw new Error("Missing expense report data")
  }
  return JSON.parse(script.textContent) as ExpenseReportData
}

const root = document.getElementById("bookiebot-expense-report-root")

if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <ExpenseReportApp report={readReportData()} />
    </React.StrictMode>,
  )
}
