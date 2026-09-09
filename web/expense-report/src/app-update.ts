const validVersion = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(value)
const DISMISSED_KEY = "bookiebot:update-dismissed:v1"
type VersionStorage = Pick<Storage, "getItem" | "setItem">
const sessionDismissed = new Set<string>()
function sessionStorage(): VersionStorage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage } catch { return null }
}

export function requestAppUpdate() {
  window.dispatchEvent(new Event("bookiebot:request-app-update"))
}

/** Version checks never fetch expense data or trigger an automatic reload. */
export class AppVersionWatcher {
  private controller: AbortController | null = null
  private flight: Promise<void> | null = null
  private listeners = new Set<(version: string | null) => void>()
  private availabilityListeners = new Set<(version: string | null) => void>()
  private dismissed = new Set<string>()
  private disposed = false
  availableVersion: string | null = null

  private storage: VersionStorage | null
  constructor(private initialVersion: string, private options: { fetch?: typeof fetch; timeoutMs?: number; storage?: VersionStorage | null } = {}) {
    this.storage = options.storage === undefined ? sessionStorage() : options.storage
    try {
      const saved = JSON.parse(this.storage?.getItem(DISMISSED_KEY) ?? "[]")
      if (Array.isArray(saved)) this.dismissed = new Set(saved.filter(validVersion).slice(-50))
    } catch { /* Blocked storage never prevents using or updating the app. */ }
    if (options.storage === undefined) sessionDismissed.forEach(version => this.dismissed.add(version))
  }

  get noticeVersion() { return this.availableVersion && !this.dismissed.has(this.availableVersion) ? this.availableVersion : null }

  subscribe(listener: (version: string | null) => void) {
    this.listeners.add(listener)
    listener(this.noticeVersion)
    return () => { this.listeners.delete(listener) }
  }

  subscribeAvailability(listener: (version: string | null) => void) {
    this.availabilityListeners.add(listener)
    listener(this.availableVersion)
    return () => { this.availabilityListeners.delete(listener) }
  }

  private publish(version: string | null) {
    if (this.disposed || version === this.availableVersion) return
    this.availableVersion = version
    this.availabilityListeners.forEach(listener => listener(version))
    this.listeners.forEach(listener => listener(this.noticeVersion))
  }

  check(): Promise<void> {
    if (this.disposed || !validVersion(this.initialVersion)) return Promise.resolve()
    if (this.flight) return this.flight
    const controller = new AbortController()
    this.controller = controller
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8000)
    this.flight = (async () => {
      try {
        const response = await (this.options.fetch ?? fetch)("/app/version", {
          credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error",
          headers: { "X-BookieBot-App": "1", Accept: "application/json" }, signal: controller.signal,
        })
        if (response.status === 401) { this.publish(null); return }
        if (!response.ok) return
        const data = await response.json()
        if (controller.signal.aborted || this.disposed || !validVersion(data?.version)) return
        this.publish(data.version !== this.initialVersion ? data.version : null)
      } catch { /* Offline/server errors leave the current app usable. */ }
      finally {
        clearTimeout(timer)
        if (this.controller === controller) { this.controller = null; this.flight = null }
      }
    })()
    return this.flight
  }

  dismiss() {
    if (!this.availableVersion) return
    this.dismissed.add(this.availableVersion)
    if (this.options.storage === undefined) sessionDismissed.add(this.availableVersion)
    try { this.storage?.setItem(DISMISSED_KEY, JSON.stringify([...this.dismissed].slice(-50))) } catch { /* Remains dismissed in memory. */ }
    this.listeners.forEach(listener => listener(null))
  }

  dispose() {
    this.disposed = true
    this.controller?.abort()
    this.listeners.clear()
    this.availabilityListeners.clear()
  }
}

export function watchAppVersionLifecycle(watcher: AppVersionWatcher, win = window, doc = document) {
  const check = () => {
    if (doc.visibilityState === "visible" && win.navigator.onLine !== false) void watcher.check()
  }
  const interval = win.setInterval(check, 5 * 60 * 1000)
  win.addEventListener("focus", check)
  win.addEventListener("online", check)
  doc.addEventListener("visibilitychange", check)
  check()
  return () => {
    win.clearInterval(interval)
    win.removeEventListener("focus", check)
    win.removeEventListener("online", check)
    doc.removeEventListener("visibilitychange", check)
  }
}
