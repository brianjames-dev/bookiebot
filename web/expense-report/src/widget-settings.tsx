import { useEffect, useId, useRef, useState } from "react"
import { CollapsibleContent } from "./components/ui/motion"
import { useAppWorkStatus } from "./app-work-guard"
import "./widget-settings.css"

type WidgetMode = "current" | "projected"
interface Connection { id: string; label: string; mode: WidgetMode; status: "pending" | "active"; createdAt: string; expiresAt: string; lastUsedAt: string | null }
interface Pairing { id: string; setupCode: string; expiresAt: string }
interface Settings { connections: Connection[]; scriptUrl: string; setupInstructionsUrl: string }
interface WidgetSettingsProps { ownerName: string; defaultMode: WidgetMode; onOpenGuide: () => void }
const endpoint = "/app/widgets/settings"
const isDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value))
const isMode = (value: unknown): value is WidgetMode => value === "current" || value === "projected"
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128

function checkedSettings(value: unknown): Settings {
  const data = value as Partial<Settings> | null
  if (!data || !Array.isArray(data.connections) || data.connections.length > 5
    || data.scriptUrl !== "/app/widgets/script" || data.setupInstructionsUrl !== "/app/widgets/help"
    || data.connections.some(row => !row || !isId(row.id) || typeof row.label !== "string" || !row.label.trim() || row.label.length > 100
      || !isMode(row.mode) || (row.status !== "pending" && row.status !== "active") || !isDate(row.createdAt)
      || !isDate(row.expiresAt) || (row.lastUsedAt !== null && !isDate(row.lastUsedAt)))
    || new Set(data.connections.map(row => row.id)).size !== data.connections.length) {
    throw new Error("Couldn’t read widget settings. Refresh widgets to try again.")
  }
  return data as Settings
}

function checkedPairing(value: unknown, settings: Settings): Pairing {
  const pairing = value as Partial<Pairing> | null
  if (!pairing || !isId(pairing.id) || typeof pairing.setupCode !== "string" || !isDate(pairing.expiresAt)
    || !settings.connections.some(row => row.id === pairing.id && row.status === "pending")) throw new Error("Pairing response was incomplete.")
  const url = new URL(pairing.setupCode)
  if (url.origin !== window.location.origin || url.pathname !== "/app/widgets/connect" || url.search
    || !/^#bbw_pair_[A-Za-z0-9_-]{20,200}$/.test(url.hash)) throw new Error("Pairing response was incomplete.")
  return pairing as Pairing
}

async function whileActive<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new Error("The request took too long. Refresh widgets to check its status."))
      if (signal.aborted) { abort(); return }
      signal.addEventListener("abort", abort, { once: true })
      promise.then(resolve, reject)
    })
  } finally { signal.removeEventListener("abort", abort) }
}

async function widgetRequest(controller: AbortController, body?: Record<string, unknown>) {
  const response = await whileActive(fetch(endpoint, {
    method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
    headers: { "X-BookieBot-App": "1", "Content-Type": "application/json" }, credentials: "same-origin",
    mode: "same-origin", referrerPolicy: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
  }), controller.signal)
  const data = await whileActive(response.json(), controller.signal)
  if (!response.ok) throw new Error(response.status === 401 ? "Your sign-in expired. Reconnect BookieBot to manage widgets."
    : typeof data?.error === "string" && data.error.length < 240 ? data.error : "Couldn’t update widgets. Refresh widgets to try again.")
  return data
}

function dateLabel(value: string) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function WidgetSettings(props: WidgetSettingsProps) {
  // Each signed-in person owns a separate controller, including transient setup secrets.
  return <WidgetSettingsContent key={props.ownerName} {...props} />
}

function WidgetSettingsContent({ ownerName, defaultMode, onOpenGuide }: WidgetSettingsProps) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const initialLabel = `${ownerName}’s iPhone`
  const [label, setLabel] = useState(initialLabel)
  const [mode, setMode] = useState<WidgetMode>(defaultMode)
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const mounted = useRef(false)
  const operation = useRef<AbortController | null>(null)
  const copyGeneration = useRef(0)
  const currentPairing = useRef<Pairing | null>(null)
  currentPairing.current = pairing
  const id = useId()
  const dirty = Boolean(pairing || (formOpen && (label !== initialLabel || mode !== defaultMode)))
  const discard = () => { copyGeneration.current++; setPairing(null); setFormOpen(false); setLabel(initialLabel); setMode(defaultMode); setMessage("") }
  const work = { label: "Widget pairing", pending: busy, dirty, onDiscard: discard }
  const updateWork = useAppWorkStatus(work)

  const acceptSettings = (data: Settings) => {
    setSettings(data); setNeedsRefresh(false)
    const previous = currentPairing.current
    if (!previous) return
    const row = data.connections.find(connection => connection.id === previous.id)
    if (row?.status === "pending" && Date.parse(previous.expiresAt) > Date.now()) return
    if (row?.status === "active") setMessage(row.lastUsedAt
      ? "Widget connected. Add it to your Home Screen in Scriptable."
      : "Pairing accepted. Run BookieBot in Scriptable and check the preview.")
    copyGeneration.current++; setPairing(null)
  }

  const run = async (body?: Record<string, unknown>) => {
    if (!mounted.current || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    const active = () => mounted.current && operation.current === controller
    const timer = window.setTimeout(() => controller.abort(), 20_000)
    updateWork({ ...work, pending: true }); setBusy(true); setError(""); setMessage("")
    try {
      const data = await widgetRequest(controller, body)
      if (!active() || controller.signal.aborted) return
      const next = checkedSettings(data)
      const created = body?.operation === "pair" ? checkedPairing(data.pairing, next) : null
      acceptSettings(next)
      if (created) { copyGeneration.current++; setPairing(created); setFormOpen(false); setLabel(initialLabel); setMode(defaultMode) }
      else if (body?.operation === "revoke") { setConfirmRevoke(null); setMessage("Widget access removed.") }
      else if (body?.operation === "mode") setMessage("Mode saved. It will appear when iOS next refreshes the widget.")
    } catch (caught) {
      if (!active()) return
      if (body) setNeedsRefresh(true)
      setError(body?.operation === "pair"
        ? "Couldn’t confirm pairing. Refresh widgets before trying again, then remove any unused pending pairing."
        : caught instanceof Error ? caught.message : "Couldn’t load widgets. Refresh widgets to try again.")
    } finally {
      window.clearTimeout(timer)
      if (active()) { operation.current = null; setBusy(false); setLoading(false) }
    }
  }

  useEffect(() => {
    mounted.current = true
    void run()
    return () => { mounted.current = false; copyGeneration.current++; operation.current?.abort(); operation.current = null }
  }, [])

  useEffect(() => {
    if (!pairing) return
    const remaining = Math.max(0, Date.parse(pairing.expiresAt) - Date.now())
    const timer = window.setTimeout(() => {
      copyGeneration.current++; setPairing(null); setMessage("The setup code expired. Remove the pending pairing, then create a new one.")
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [pairing])

  const copy = async () => {
    if (!pairing) return
    const revision = ++copyGeneration.current, currentPair = pairing.id
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(pairing.setupCode)
      if (mounted.current && revision === copyGeneration.current && currentPairing.current?.id === currentPair) setMessage("Setup code copied. Paste it when you run BookieBot in Scriptable.")
    } catch {
      if (mounted.current && revision === copyGeneration.current && currentPairing.current?.id === currentPair) setMessage("Select and copy the setup code below, then paste it in Scriptable.")
    }
  }
  const canCreate = Boolean(settings && settings.connections.length < 5 && !busy && !needsRefresh && !pairing)
  return <section className="bb-settings-section bb-widget-settings" aria-labelledby={`${id}-title`}>
    <div className="bb-widget-heading"><h2 id={`${id}-title`}>Widgets</h2><button className="bb-settings-action" type="button" disabled={busy} onClick={() => void run()} aria-label="Refresh widgets">{busy && !loading ? "Checking…" : "Refresh"}</button></div>
    <p className="bb-settings-note">{ownerName}’s budget remaining and available today, on the Home Screen.<br />Read-only access. Each person pairs their own widget.</p>
    <div className="bb-widget-actions">
      <button className="bb-toolbar-button" type="button" onClick={onOpenGuide}>Set up widget</button>
      <button type="button" className="bb-settings-action" disabled={!canCreate} aria-expanded={formOpen} aria-controls={`${id}-form`} onClick={() => { setFormOpen(value => !value); setError("") }}>Pair a widget</button>
    </div>
    <CollapsibleContent open={formOpen} id={`${id}-form`}>
      <form className="bb-widget-form" onSubmit={event => { event.preventDefault(); if (canCreate && label.trim()) void run({ operation: "pair", label: label.trim(), mode }) }}>
        <label>Widget name<input autoComplete="off" maxLength={60} value={label} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
        <label>Budget view<select aria-label="New widget budget view" value={mode} disabled={busy} onChange={event => setMode(event.target.value as WidgetMode)}><option value="current">Current</option><option value="projected">Projected</option></select></label>
        <div className="bb-widget-actions"><button className="bb-toolbar-button" type="submit" disabled={!canCreate || !label.trim()}>Create setup code</button><button className="bb-settings-action" type="button" disabled={busy} onClick={discard}>Cancel</button></div>
      </form>
    </CollapsibleContent>
    <CollapsibleContent open={Boolean(pairing)}>
      {pairing && <div className="bb-widget-pairing">
        <h3>Connect in Scriptable</h3>
        <ol><li>Open Scriptable and run your BookieBot script.</li><li>Paste this setup code and tap Pair this phone.</li><li>Wait for your name and figures, then select that same script in Edit Widget.</li></ol>
        <label className="bb-widget-code-label">Setup code<input aria-label="Widget setup code" value={pairing.setupCode} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} /></label>
        <div className="bb-widget-actions"><button className="bb-toolbar-button" type="button" onClick={() => void copy()}>Copy setup code</button><a className="bb-settings-action" href="scriptable:///">Open Scriptable</a><button className="bb-settings-action" type="button" onClick={() => { copyGeneration.current++; setPairing(null); setMessage("") }}>Done</button></div>
        <p className="bb-settings-note">Expires {dateLabel(pairing.expiresAt)}. Keep this code private.</p>
      </div>}
    </CollapsibleContent>
    {loading && <p className="bb-settings-note" role="status">Loading widgets…</p>}
    {settings && <div className="bb-widget-connections">
      {settings.connections.length === 0 && <p className="bb-settings-note">No widgets paired yet.</p>}
      {settings.connections.map(connection => <div className="bb-widget-connection" key={connection.id}>
        <div className="bb-widget-connection-heading"><strong>{connection.label}</strong><span>{connection.status === "pending" ? "Awaiting setup" : connection.lastUsedAt ? "Connected" : "Paired"}</span></div>
        <p className="bb-settings-note">{connection.status === "pending" ? `Setup expires ${dateLabel(connection.expiresAt)}` : connection.lastUsedAt ? `Last checked ${dateLabel(connection.lastUsedAt)}` : "Run BookieBot in Scriptable to verify its first refresh."}</p>
        <div className="bb-widget-connection-controls"><select aria-label={`Budget view for ${connection.label}`} value={connection.mode} disabled={busy || needsRefresh} onChange={event => { if (event.target.value !== connection.mode) void run({ operation: "mode", id: connection.id, mode: event.target.value }) }}><option value="current">Current</option><option value="projected">Projected</option></select>
          <button className="bb-settings-action" type="button" disabled={busy || needsRefresh} aria-expanded={confirmRevoke === connection.id} onClick={() => setConfirmRevoke(value => value === connection.id ? null : connection.id)}>Remove</button></div>
        <CollapsibleContent open={confirmRevoke === connection.id}><div className="bb-widget-revoke"><p>Remove access for {connection.label}? Its next refresh will require pairing again.</p><div className="bb-widget-actions"><button className="bb-toolbar-button" type="button" disabled={busy || needsRefresh} onClick={() => void run({ operation: "revoke", id: connection.id })}>Remove widget access</button><button className="bb-settings-action" type="button" disabled={busy} onClick={() => setConfirmRevoke(null)}>Keep widget</button></div></div></CollapsibleContent>
      </div>)}
      {settings.connections.length >= 5 && <p className="bb-settings-note">Five widgets are paired. Remove one to add another.</p>}
    </div>}
    {error && <p className="bb-widget-error" role="alert">{error}</p>}
    {message && <p className="bb-settings-note" role="status">{message}</p>}
    <p className="bb-settings-note bb-widget-help">iOS controls refresh timing; check the widget’s timestamp. <button type="button" className="bb-settings-action" onClick={onOpenGuide}>Setup guide</button></p>
  </section>
}
