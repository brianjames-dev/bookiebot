import {ReportLoading} from "./report-loading"
import { useEffect, useRef, useState } from "react"
import { AnimatedDisclosure } from "./components/ui/motion"
import { useAppWorkStatus } from "./app-work-guard"
import "./phone-notifications.css"

interface Preferences {
  weekly: boolean; weeklyDays: number[]; upcoming: boolean; reminderDaysBefore: number
  showAmounts: boolean; hour: number
}
interface Settings { enabled: boolean; preferences: Preferences; publicKey: string }
const defaultPreferences: Preferences = { weekly: false, weeklyDays: [], upcoming: false, reminderDaysBefore: 1, showAmounts: false, hour: 10 }
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
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
  // The page uses no-referrer. For same-origin POST/DELETE that also makes
  // Origin null, so the server correctly refuses the save. Preserve the app
  // origin for these requests while still withholding cross-origin referrers.
  const response = await whileActive(fetch(path, { ...options, headers, credentials: "same-origin", mode: "same-origin",
    referrerPolicy: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal }), controller.signal)
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
  const preferences = value.preferences
  const days = preferences.weeklyDays ?? (preferences.weekly ? [0] : [])
  const lead = preferences.reminderDaysBefore ?? 1
  if (!Array.isArray(days) || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)
      || new Set(days).size !== days.length || (preferences.weekly && !days.length)
      || ![0, 1, 2].includes(lead)) {
    throw new Error("Could not load notification settings. Please try again.")
  }
  return { enabled: value.enabled, publicKey: value.publicKey, preferences: {
    ...preferences,
    weekly: value.enabled && preferences.weekly,
    weeklyDays: value.enabled && preferences.weekly ? days : [],
    upcoming: value.enabled && preferences.upcoming,
    reminderDaysBefore: lead,
  } }
}

export function pushKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4))
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

export function PhoneNotifications({ embedded = false }: { embedded?: boolean } = {}) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [preferences, setPreferences] = useState(defaultPreferences)
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const [supported, setSupported] = useState(false)
  const [preparing, setPreparing] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const mounted = useRef(false)
  const generation = useRef(0)
  const operation = useRef<AbortController | null>(null)
  const dirty = Boolean(settings && JSON.stringify(preferences) !== JSON.stringify(settings.preferences))
  const discard = () => { if (settings) setPreferences(settings.preferences) }
  const work = { label: "Phone notifications", pending: busy, dirty, onDiscard: discard }
  const updateWork = useAppWorkStatus(work)

  useEffect(() => {
    const controller = new AbortController()
    const revision = ++generation.current
    mounted.current = true
    const active = () => mounted.current && revision === generation.current && !controller.signal.aborted
    const timeout = window.setTimeout(() => controller.abort(), 20_000)
    const canPush = window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
    setSupported(canPush)
    setSettings(null); setRegistration(null); setBusy(false); setPreparing(true)
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
      } finally {
        window.clearTimeout(timeout)
        if (mounted.current && revision === generation.current) setPreparing(false)
      }
    })()
    return () => { mounted.current = false; generation.current++; controller.abort(); window.clearTimeout(timeout)
      operation.current?.abort(); operation.current = null }
  }, [attempt])

  const beginOperation = () => {
    if (!mounted.current || operation.current) return null
    const revision = generation.current
    const controller = new AbortController()
    operation.current = controller
    updateWork({ ...work, pending: true })
    const current = () => mounted.current && revision === generation.current && operation.current === controller
    const active = () => current() && !controller.signal.aborted
    const timeout = window.setTimeout(() => controller.abort(), 30_000)
    setBusy(true); setError("")
    return {
      controller, active,
      failed: (caught: unknown) => { if (current()) setError(caught instanceof Error ? caught.message : "Could not update notifications.") },
      finish: () => { window.clearTimeout(timeout); if (current()) { operation.current = null; setBusy(false) } },
    }
  }

  const save = async (nextPreferences: Preferences) => {
    if (!settings || (!settings.enabled && !registration)) return
    const action = beginOperation()
    if (!action) return
    setPreferences(nextPreferences)
    try {
      const body: { preferences: Preferences; subscription?: PushSubscriptionJSON } = { preferences: nextPreferences }
      if (!settings.enabled && registration) {
        // subscribe handles permission and reuses an existing subscription.
        // Call it in the tap itself: a separate permission/getSubscription
        // chain can lose Safari's user activation before subscribing.
        const subscription = await whileActive(registration.pushManager.subscribe({ userVisibleOnly: true,
          applicationServerKey: pushKeyBytes(settings.publicKey) }), action.controller.signal)
        if (!action.active()) return
        body.subscription = subscription.toJSON()
      }
      // Navigation or reconnect may replace the HttpOnly session cookie while
      // any browser permission/subscription promise is pending.
      if (!action.active()) return
      const data = await notificationRequest(endpoint, action.controller, { method: "POST", body: JSON.stringify(body) })
      if (!action.active()) return
      const saved = checkedSettings({ ...settings, ...data })
      setSettings(saved)
      setPreferences(saved.preferences)
    } catch (caught) {
      if (mounted.current && operation.current === action.controller) setPreferences(settings.preferences)
      action.failed(caught instanceof Error && caught.name === "NotAllowedError"
        ? new Error("Notifications are not allowed. Open BookieBot from your Home Screen and check iPhone Settings → Notifications → BookieBot, then try again.")
        : caught)
    }
    finally { action.finish() }
  }

  const editable = Boolean(settings && !busy && (settings.enabled || registration))
  const configured = preferences.weekly || preferences.upcoming
  const changeDay = (day: number) => {
    const days = preferences.weeklyDays
    const next = days.includes(day) ? days.filter(value => value !== day) : [...days, day].sort((a, b) => a - b)
    void save({ ...preferences, weekly: next.length > 0, weeklyDays: next })
  }
  const toggle = (key: "upcoming" | "showAmounts", label: string) => (
    <label className="bb-notification-option">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={preferences[key]} disabled={!editable || (key === "showAmounts" && !configured)}
        onChange={event => void save({ ...preferences, [key]: event.target.checked })} />
    </label>
  )

  const waitingForSetup = preparing && (!settings || (supported && !registration))
  const stateLabel = waitingForSetup ? <ReportLoading compact label="Loading notification settings…"/> :
    error && !settings ? "Unavailable" : settings?.preferences.weekly || settings?.preferences.upcoming ? "On" : "Off"
  const body = (
    <div className="bb-notification-settings" aria-busy={busy || waitingForSetup}>
      {embedded && <div className="bb-notification-embedded-state"><h2>Notifications</h2>
        {waitingForSetup && stateLabel}</div>}
      {settings && <>
        {!supported && <p>Open BookieBot from your Home Screen to receive notifications.</p>}
        <fieldset className="bb-notification-days" disabled={!editable}>
          <legend>Weekly summary</legend>
          <div className="bb-notification-weekdays">
            {weekdays.map((name, index) => <button type="button" key={name} aria-label={name}
              aria-pressed={preferences.weeklyDays.includes(index)} onClick={() => changeDay(index)}>{name.slice(0, 2)}</button>)}
          </div>
        </fieldset>
        {toggle("upcoming", "Payment reminders")}
        {preferences.upcoming && <label className="bb-notification-option"><span>Remind me</span>
          <select className="bb-option-select" aria-label="Payment reminder timing" value={preferences.reminderDaysBefore} disabled={!editable}
            onChange={event => void save({ ...preferences, reminderDaysBefore: Number(event.target.value) })}>
            <option value={0}>On due date</option><option value={1}>Day before</option><option value={2}>Two days before</option>
          </select>
        </label>}
        <label className="bb-notification-option"><span>Delivery time (Pacific)</span>
          <select className="bb-option-select" aria-label="Notification delivery time" value={preferences.hour} disabled={!editable || !configured}
            onChange={event => void save({ ...preferences, hour: Number(event.target.value) })}>
            {Array.from({ length: 15 }, (_, index) => index + 7).map(hour => <option key={hour} value={hour}>{hour % 12 || 12} {hour < 12 ? "AM" : "PM"}</option>)}
          </select>
        </label>
        {toggle("showAmounts", "Show Lock Screen amounts")}
      </>}
      {error && <p className="bb-notification-error" role="alert">{error}</p>}
      {(!settings || (supported && !registration)) && !preparing &&
        <button className="bb-toolbar-button" type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>Try again</button>}
    </div>
  )
  return <section className={`bb-notifications${embedded ? " bb-notifications-embedded" : ""}`} aria-label="Phone notifications">
    {embedded ? body : <AnimatedDisclosure summary={<><span className="bb-notification-title">Phone notifications</span><span className="bb-notification-state">{stateLabel}</span><span className="bb-disclosure-mark" aria-hidden="true" /></>}>{body}</AnimatedDisclosure>}
  </section>
}
