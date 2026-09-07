import { useEffect, useRef, useState } from "react"
import { AnimatedDisclosure } from "./components/ui/motion"
import "./phone-notifications.css"

interface Preferences { weekly: boolean; upcoming: boolean; showAmounts: boolean; hour: number }
interface Settings { enabled: boolean; preferences: Preferences; publicKey: string }
const endpoint = "/app/notifications"
const headers = { "X-BookieBot-App": "1", "Content-Type": "application/json" }

async function whileActive<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new Error("Notification request interrupted. Please try again."))
      if (signal.aborted) { abort(); return }
      signal.addEventListener("abort", abort, { once: true })
      promise.then(resolve, reject)
    })
  } finally { signal.removeEventListener("abort", abort) }
}

async function notificationRequest(path: string, controller: AbortController, options: RequestInit = {}) {
  const response = await whileActive(fetch(path, { ...options, headers, credentials: "same-origin", mode: "same-origin",
    cache: "no-store", redirect: "error", signal: controller.signal }), controller.signal)
  const data = await whileActive(response.json(), controller.signal)
  if (!response.ok) throw new Error(data.error || "Could not update notifications. Please try again.")
  return data
}

function checkedSettings(data: unknown): Settings {
  const value = data as Partial<Settings> | null
  if (!value || typeof value.enabled !== "boolean" || typeof value.publicKey !== "string"
      || !/^[A-Za-z0-9_-]{87}$/.test(value.publicKey) || !value.preferences
      || ![value.preferences.weekly, value.preferences.upcoming, value.preferences.showAmounts].every(flag => typeof flag === "boolean")
      || !Number.isInteger(value.preferences.hour) || value.preferences.hour < 7 || value.preferences.hour > 21) {
    throw new Error("Could not load notification settings. Please try again.")
  }
  return value as Settings
}

export function pushKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4))
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

export function PhoneNotifications() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [preferences, setPreferences] = useState<Preferences>({ weekly: true, upcoming: false, showAmounts: false, hour: 10 })
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const [supported, setSupported] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const mounted = useRef(false)
  const generation = useRef(0)
  const operation = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const revision = ++generation.current
    mounted.current = true
    const active = () => mounted.current && revision === generation.current && !controller.signal.aborted
    const timeout = window.setTimeout(() => controller.abort(), 20_000)
    const canPush = window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
    setSupported(canPush)
    setSettings(null); setRegistration(null); setBusy(false)
    setError("")
    void (async () => {
      try {
        const data = checkedSettings(await notificationRequest(endpoint, controller))
        if (!active()) return
        setSettings(data)
        setPreferences(data.preferences)
        if (canPush) {
          await whileActive(navigator.serviceWorker.register("/app/notifications/worker.js", { scope: "/app/", updateViaCache: "none" }), controller.signal)
          if (!active()) return
          const ready = await whileActive(navigator.serviceWorker.ready, controller.signal)
          if (active()) setRegistration(ready)
        }
      } catch (caught) {
        if (mounted.current && revision === generation.current) setError(caught instanceof Error ? caught.message : "Could not load notifications.")
      } finally { window.clearTimeout(timeout) }
    })()
    return () => { mounted.current = false; generation.current++; controller.abort(); window.clearTimeout(timeout)
      operation.current?.abort(); operation.current = null }
  }, [attempt])

  const beginOperation = () => {
    if (!mounted.current || operation.current) return null
    const revision = generation.current
    const controller = new AbortController()
    operation.current = controller
    const current = () => mounted.current && revision === generation.current && operation.current === controller
    const active = () => current() && !controller.signal.aborted
    const timeout = window.setTimeout(() => controller.abort(), 30_000)
    setBusy(true); setError(""); setMessage("")
    return {
      controller, active,
      failed: (caught: unknown) => { if (current()) setError(caught instanceof Error ? caught.message : "Could not update notifications.") },
      finish: () => { window.clearTimeout(timeout); if (current()) { operation.current = null; setBusy(false) } },
    }
  }

  const save = async () => {
    if (!settings || !registration) return
    const action = beginOperation()
    if (!action) return
    try {
      // Ask directly inside the tap handler, before any awaited network work.
      const permission = await whileActive(Notification.requestPermission(), action.controller.signal)
      if (!action.active()) return
      if (permission !== "granted") throw new Error("Notifications are not allowed. You can change this in iPhone Settings → Notifications → BookieBot.")
      let subscription = await whileActive(registration.pushManager.getSubscription(), action.controller.signal)
      if (!action.active()) return
      if (!subscription) {
        subscription = await whileActive(registration.pushManager.subscribe({ userVisibleOnly: true,
          applicationServerKey: pushKeyBytes(settings.publicKey) }), action.controller.signal)
        if (!action.active()) return
      }
      // Navigation or reconnect may replace the HttpOnly session cookie while
      // any browser permission/subscription promise is pending.
      if (!action.active()) return
      const data = await notificationRequest(endpoint, action.controller, { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON(), preferences }) })
      if (!action.active()) return
      setSettings({ ...settings, ...data })
      setMessage("Notification preferences saved for this phone.")
    } catch (caught) { action.failed(caught) }
    finally { action.finish() }
  }

  const turnOff = async () => {
    if (!settings) return
    const action = beginOperation()
    if (!action) return
    try {
      if (!action.active()) return
      await notificationRequest(endpoint, action.controller, { method: "DELETE" })
      if (!action.active()) return
      setSettings({ ...settings, enabled: false })
      setMessage("Notifications are off for this phone.")
      // The authenticated server subscription is the delivery opt-in. Leave
      // the shared browser endpoint intact: another page may have reconnected
      // while this request was pending, and deleting it would revoke that page.
    } catch (caught) { action.failed(caught) }
    finally { action.finish() }
  }

  const sendTest = async () => {
    if (!settings?.enabled) return
    const action = beginOperation()
    if (!action) return
    try {
      if (!action.active()) return
      const data = await notificationRequest(`${endpoint}/test`, action.controller, { method: "POST" })
      if (!action.active()) return
      setMessage(data.message)
    } catch (caught) { action.failed(caught) }
    finally { action.finish() }
  }

  const toggle = (key: "weekly" | "upcoming" | "showAmounts", label: string) => (
    <label className="bb-notification-option">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={preferences[key]} disabled={busy} onChange={(event) => setPreferences({ ...preferences, [key]: event.target.checked })} />
    </label>
  )

  return <section className="bb-notifications" aria-label="Phone notifications">
    <AnimatedDisclosure summary={<><span className="bb-disclosure-mark" aria-hidden="true" /><span>Phone notifications</span><span className="bb-notification-state">{settings?.enabled ? "On" : "Off"}</span></>}>
      <div className="bb-notification-settings">
        <p>Choose what this phone receives. Each phone has its own preferences.</p>
        {!supported && <p>On iPhone, open BookieBot from your Home Screen to enable notifications. Requires iOS 16.4 or later.</p>}
        {toggle("weekly", "Weekly check-in · Mondays")}
        {toggle("upcoming", "Scheduled payments · day before")}
        <p className="bb-notification-hint">Payment reminders are additional to your Discord reminders and start only when selected.</p>
        <label className="bb-notification-option"><span>Delivery time · Pacific</span><select aria-label="Notification delivery time" value={preferences.hour} disabled={busy} onChange={(event) => setPreferences({ ...preferences, hour: Number(event.target.value) })}>
          {Array.from({ length: 15 }, (_, index) => index + 7).map((hour) => <option key={hour} value={hour}>{hour % 12 || 12} {hour < 12 ? "AM" : "PM"}</option>)}
        </select></label>
        {toggle("showAmounts", "Show amounts on the Lock Screen")}
        <p className="bb-notification-hint">Amounts stay private unless you enable them. Signing out or resetting phone access stops future sends.</p>
        <div className="bb-notification-actions">
          <button className="bb-toolbar-button" type="button" onClick={() => void save()} disabled={busy || !settings || !registration || !supported || (!preferences.weekly && !preferences.upcoming)}>{busy ? "Saving…" : settings?.enabled ? "Save preferences" : "Enable on this phone"}</button>
          {settings?.enabled && <button className="bb-toolbar-button" type="button" disabled={busy} onClick={() => void turnOff()}>Turn off</button>}
          {settings?.enabled && <button className="bb-toolbar-button" type="button" disabled={busy} onClick={() => void sendTest()}>Send a test</button>}
          {(!settings || (supported && !registration)) && error && <button className="bb-toolbar-button" type="button" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>Try again</button>}
        </div>
        {error && <p className="bb-notification-error" role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
      </div>
    </AnimatedDisclosure>
  </section>
}
