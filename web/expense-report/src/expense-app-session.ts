import type { ExpenseReportData } from "./types"

export interface ExpenseAppConfig {
  reportUrl: string
  logoutUrl: string
  ownerName: string
  version?: string
}

export interface ExpenseAppState {
  report: ExpenseReportData | null
  selectedMonth: string | null
  phase: "loading" | "ready" | "refreshing" | "stale" | "error" | "expired" | "signed-out"
  updatedAt: number | null
  signingOut: boolean
  message: string
}

export const initialExpenseAppState: ExpenseAppState = {
  report: null, selectedMonth: null, phase: "loading", updatedAt: null, signingOut: false, message: "",
}

export function expenseReportIdentity(report: ExpenseReportData) {
  return `${report.ownerName}:${report.year}:${report.month}`
}

class ExpiredSession extends Error {}

async function requestApp<T>(fetcher: typeof fetch, url: string, controller: AbortController,
  timeoutMs: number, options: RequestInit, read: (response: Response) => Promise<T>) {
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let abort: () => void = () => {}
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new Error("Request interrupted"))
      controller.signal.addEventListener("abort", abort, { once: true })
      fetcher(url, {
        ...options,
        credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error",
        headers: { "X-BookieBot-App": "1", Accept: "application/json", ...options.headers },
        signal: controller.signal,
      }).then(async (response) => {
        if (response.status === 401) throw new ExpiredSession()
        if (!response.ok) throw new Error("Request unavailable")
        return read(response)
      }).then(resolve, reject)
    })
  } finally {
    clearTimeout(timeout)
    controller.signal.removeEventListener("abort", abort)
  }
}

type SessionOptions = {
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
  dedupMs?: number
}

/** Own request lifetime independently of report rendering and its filter state. */
export class ExpenseAppSession {
  state = initialExpenseAppState
  private listeners = new Set<(state: ExpenseAppState) => void>()
  private fetcher: typeof fetch
  private now: () => number
  private timeoutMs: number
  private dedupMs: number
  private lastCheck = -Infinity
  private revision = 0
  private disposed = false
  private controller: AbortController | null = null
  private inFlight: Promise<void> | null = null
  private logoutFlight: Promise<void> | null = null

  constructor(private config: ExpenseAppConfig, options: SessionOptions = {}) {
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? 30000
    this.dedupMs = options.dedupMs ?? 2500
  }

  subscribe(listener: (state: ExpenseAppState) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(change: Partial<ExpenseAppState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...change }
    this.listeners.forEach((listener) => listener(this.state))
  }

  private async request<T>(url: string, method: "GET" | "POST", read: (response: Response) => Promise<T>) {
    const controller = new AbortController()
    this.controller = controller
    try {
      return await requestApp(this.fetcher, url, controller, this.timeoutMs, { method }, read)
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }

  refresh(force = false): Promise<void> {
    if (this.disposed || this.state.signingOut || ["expired", "signed-out"].includes(this.state.phase)) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    if (!force && this.now() - this.lastCheck < this.dedupMs) return Promise.resolve()
    this.lastCheck = this.now()
    const revision = ++this.revision
    const selectedMonth = this.state.selectedMonth
    const reportUrl = selectedMonth
      ? `${this.config.reportUrl}${this.config.reportUrl.includes("?") ? "&" : "?"}month=${encodeURIComponent(selectedMonth)}`
      : this.config.reportUrl
    this.publish({ phase: this.state.report ? "refreshing" : "loading", message: "" })
    const job = this.request(reportUrl, "GET", async (response) => {
      const report = await response.json() as ExpenseReportData
      if (!report || typeof report.ownerName !== "string" || !Number.isInteger(report.year)
        || !Number.isInteger(report.month) || report.month < 1 || report.month > 12
        || !report.metrics || !report.incomeProjection || !report.savingsProjection
        || !Array.isArray(report.breakdown) || !Array.isArray(report.dailyEntries)) {
        throw new Error("Report unavailable")
      }
      if (selectedMonth && `${report.year}-${String(report.month).padStart(2, "0")}` !== selectedMonth) {
        throw new Error("The report month did not match the selection")
      }
      return report
    }).then((report) => {
      if (revision !== this.revision || this.disposed) return
      this.publish({ report, phase: "ready", updatedAt: this.now(), message: "" })
    }).catch((error: unknown) => {
      if (revision !== this.revision || this.disposed) return
      if (error instanceof ExpiredSession) {
        this.publish({ report: null, selectedMonth: null, updatedAt: null, phase: "expired", message: "" })
      } else {
        this.publish({ phase: this.state.report ? "stale" : "error", message: selectedMonth && !this.state.report
          ? `Couldn’t load ${selectedMonth}. Try again or return to this month.`
          : "Couldn’t refresh. Check your connection and try again." })
      }
    }).finally(() => {
      if (revision === this.revision) {
        this.inFlight = null
        this.lastCheck = this.now()
      }
    })
    this.inFlight = job
    return job
  }

  selectMonth(month: string | null): Promise<void> {
    if (this.disposed || this.state.signingOut || ["expired", "signed-out"].includes(this.state.phase)) return Promise.resolve()
    if (month !== null && !/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error("Choose a valid report month")
    if (month === this.state.selectedMonth) return this.refresh(true)
    ++this.revision
    this.controller?.abort()
    this.inFlight = null
    this.lastCheck = -Infinity
    // An old report must never sit under a newly requested month heading.
    this.publish({ selectedMonth: month, report: null, updatedAt: null, phase: "loading", message: "" })
    return this.refresh(true)
  }

  expire() {
    ++this.revision
    this.controller?.abort()
    this.inFlight = null
    this.publish({ report: null, selectedMonth: null, updatedAt: null, signingOut: false, phase: "expired", message: "" })
  }

  pause() {
    if (!this.inFlight) return
    ++this.revision
    this.controller?.abort()
    this.inFlight = null
    this.lastCheck = -Infinity
    this.publish({ phase: this.state.report ? "stale" : "error", message: "Refresh paused. Reopen or refresh to update." })
  }

  signOut(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.logoutFlight) return this.logoutFlight
    this.pause()
    const revision = ++this.revision
    this.publish({ signingOut: true, message: "" })
    this.logoutFlight = this.request(this.config.logoutUrl, "POST", async (response) => {
      if (response.status !== 204) throw new Error("Sign out unavailable")
    }).then(() => {
      if (revision === this.revision) this.publish({ report: null, selectedMonth: null, updatedAt: null, phase: "signed-out", message: "" })
    }).catch((error: unknown) => {
      if (revision !== this.revision) return
      if (error instanceof ExpiredSession) {
        this.publish({ report: null, selectedMonth: null, updatedAt: null, phase: "expired", message: "" })
      } else {
        this.publish({ phase: this.state.report ? "stale" : "error", message: "Couldn’t sign out. Check your connection and try again." })
      }
    }).finally(() => {
      if (revision === this.revision) this.publish({ signingOut: false })
      this.logoutFlight = null
    })
    return this.logoutFlight
  }

  dispose() {
    this.disposed = true
    ++this.revision
    this.controller?.abort()
    this.listeners.clear()
  }
}

export function parseExpenseAppSetupLink(value: string, origin: string): string | null {
  const trimmed = value.trim()
  const validToken = /^[A-Za-z0-9_-]{43}$/
  if (validToken.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    if (url.origin !== new URL(origin).origin || url.pathname !== "/app/connect"
      || url.search || url.username || url.password) return null
    const token = url.hash.slice(1)
    return validToken.test(token) ? token : null
  } catch {
    return null
  }
}

export interface ExpenseAppPairingState {
  phase: "input" | "checking" | "confirm" | "connecting" | "connected" | "error"
  ownerName: string | null
  message: string
}

export const initialExpenseAppPairingState: ExpenseAppPairingState = { phase: "input", ownerName: null, message: "" }

/** The private setup token never enters render state, a URL, or browser storage. */
export class ExpenseAppPairing {
  state = initialExpenseAppPairingState
  private token: string | null = null
  private listeners = new Set<(state: ExpenseAppPairingState) => void>()
  private controller: AbortController | null = null
  private inFlight: Promise<void> | null = null
  private revision = 0
  private disposed = false

  constructor(private fetcher: typeof fetch = fetch, private timeoutMs = 15000) {}

  subscribe(listener: (state: ExpenseAppPairingState) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(change: Partial<ExpenseAppPairingState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...change }
    this.listeners.forEach((listener) => listener(this.state))
  }

  check(input: string, origin: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    this.token = parseExpenseAppSetupLink(input, origin)
    if (!this.token) {
      this.publish({ phase: "error", ownerName: null, message: "Paste the complete private setup link from BookieBot." })
      return Promise.resolve()
    }
    return this.run("/app/pairing", "checking", async (response) => {
      const data = await response.json() as { ownerName?: unknown }
      if (typeof data.ownerName !== "string" || !data.ownerName.trim()) throw new Error("Account unavailable")
      return data.ownerName
    })
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    if (this.state.phase !== "confirm" || !this.token) return Promise.resolve()
    return this.run("/app/connect", "connecting", async () => null)
  }

  private run(url: string, phase: "checking" | "connecting", read: (response: Response) => Promise<string | null>) {
    const revision = ++this.revision
    const controller = new AbortController()
    this.controller = controller
    this.publish({ phase, message: "", ...(phase === "checking" ? { ownerName: null } : {}) })
    const job = requestApp(this.fetcher, url, controller, this.timeoutMs, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: this.token }),
    }, read).then((ownerName) => {
      if (revision !== this.revision || this.disposed) return
      if (phase === "connecting") this.token = null
      this.publish({ phase: phase === "checking" ? "confirm" : "connected", ownerName })
    }).catch((error: unknown) => {
      if (revision !== this.revision || this.disposed) return
      this.token = null
      this.publish({ phase: "error", ownerName: null, message: error instanceof ExpiredSession
        ? "That setup link expired or was already used. Request /expense_app in Discord and paste a new link."
        : "Couldn’t connect. Check your connection or request a new /expense_app link in Discord." })
    }).finally(() => {
      if (revision === this.revision) {
        this.inFlight = null
        this.controller = null
      }
    })
    this.inFlight = job
    return job
  }

  reset() {
    ++this.revision
    this.controller?.abort()
    this.controller = null
    this.inFlight = null
    this.token = null
    this.publish(initialExpenseAppPairingState)
  }

  dispose() {
    this.disposed = true
    this.reset()
    this.listeners.clear()
  }
}

export function watchExpenseAppLifecycle(session: ExpenseAppSession, browser: Window = window, page: Document = document) {
  const refresh = () => { if (page.visibilityState === "visible") void session.refresh() }
  const show = (event: PageTransitionEvent) => { if (event.persisted) void session.refresh(true) }
  const pause = () => session.pause()
  browser.addEventListener("focus", refresh)
  browser.addEventListener("online", refresh)
  browser.addEventListener("pageshow", show)
  browser.addEventListener("pagehide", pause)
  page.addEventListener("visibilitychange", refresh)
  return () => {
    browser.removeEventListener("focus", refresh)
    browser.removeEventListener("online", refresh)
    browser.removeEventListener("pageshow", show)
    browser.removeEventListener("pagehide", pause)
    page.removeEventListener("visibilitychange", refresh)
  }
}
