const validVersion = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(value)

/** Version checks never fetch expense data or trigger an automatic reload. */
export class AppVersionWatcher {
  private controller: AbortController | null = null
  private flight: Promise<void> | null = null
  private listeners = new Set<(version: string | null) => void>()
  private dismissed = new Set<string>()
  private disposed = false
  availableVersion: string | null = null

  constructor(private initialVersion: string, private options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {}

  subscribe(listener: (version: string | null) => void) {
    this.listeners.add(listener)
    listener(this.availableVersion)
    return () => { this.listeners.delete(listener) }
  }

  private publish(version: string | null) {
    if (this.disposed || version === this.availableVersion) return
    this.availableVersion = version
    this.listeners.forEach((listener) => listener(version))
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
        this.publish(data.version !== this.initialVersion && !this.dismissed.has(data.version) ? data.version : null)
      } catch { /* Offline/server errors leave the current app usable. */ }
      finally {
        clearTimeout(timer)
        if (this.controller === controller) { this.controller = null; this.flight = null }
      }
    })()
    return this.flight
  }

  dismiss() {
    if (this.availableVersion) this.dismissed.add(this.availableVersion)
    this.publish(null)
  }

  dispose() {
    this.disposed = true
    this.controller?.abort()
    this.listeners.clear()
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
