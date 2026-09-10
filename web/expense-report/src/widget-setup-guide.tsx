import { useEffect, useId, useRef, useState } from "react"
import { ArrowLeft, ChevronDown } from "lucide-react"
import { CollapsibleContent } from "./components/ui/motion"
import "./widget-setup-guide.css"

const widgetTypes = [
  { value: "budget", label: "Budget" },
  { value: "upcoming", label: "Upcoming payments" },
  { value: "savings", label: "Savings goal" },
  { value: "categories", label: "Category budgets" },
  { value: "shared", label: "Shared balance" },
] as const
type WidgetType = typeof widgetTypes[number]["value"]
type WidgetTheme = "editorial" | "two-tone"
interface WidgetGoal { id: string; name: string }

function checkedGoals(value: unknown): WidgetGoal[] {
  const data = value as { goals?: unknown } | null
  if (!data || !Array.isArray(data.goals) || data.goals.length > 200) throw new Error("Invalid goals")
  const goals = data.goals as { id?: unknown; name?: unknown; archived?: unknown }[]
  if (goals.some(goal => !goal || typeof goal.id !== "string" || !/^[0-9a-f]{32}$/.test(goal.id)
    || typeof goal.name !== "string" || !goal.name.trim() || goal.name.length > 80 || /[\u0000-\u001f]/.test(goal.name)
    || typeof goal.archived !== "boolean") || new Set(goals.map(goal => goal.id)).size !== goals.length) throw new Error("Invalid goals")
  return goals.filter(goal => !goal.archived).map(goal => ({ id: goal.id as string, name: goal.name as string }))
}

function WidgetCustomizer({ open }: { open: boolean }) {
  const [type, setType] = useState<WidgetType>("budget")
  const [theme, setTheme] = useState<WidgetTheme>("editorial")
  const [goalId, setGoalId] = useState("")
  const [goals, setGoals] = useState<WidgetGoal[]>([])
  const [goalsLoaded, setGoalsLoaded] = useState(false)
  const [goalsLoading, setGoalsLoading] = useState(false)
  const [goalsError, setGoalsError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [message, setMessage] = useState("")
  const mounted = useRef(true)
  const parameter = `${type};${theme}${type === "savings" && goalId ? `;goal=${goalId}` : ""}`
  const currentParameter = useRef(parameter)
  currentParameter.current = parameter
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setMessage("") }, [parameter])

  useEffect(() => {
    if (!open || type !== "savings") return
    let active = true
    const controller = new AbortController()
    const fail = (message: string) => {
      setGoals([]); setGoalId(""); setGoalsLoaded(false); setGoalsLoading(false); setGoalsError(message)
    }
    const timer = window.setTimeout(() => {
      if (!active) return
      active = false; controller.abort(); fail("Goals couldn’t load. Try again.")
    }, 15_000)
    setGoalsLoading(true); setGoalsError("")
    // Read this signed-in owner's goal names only; the configuration never grants
    // access or sends a savings mutation. Closing the chooser cancels this read.
    void fetch("/app/goals", { method: "GET", credentials: "same-origin", mode: "same-origin", referrerPolicy: "same-origin",
      cache: "no-store", redirect: "error", signal: controller.signal })
      .then(async response => {
        if (!response.ok) {
          if (active && response.status === 401) fail("Your sign-in expired. Reconnect BookieBot to choose a goal.")
          throw new Error(response.status === 401 ? "Signed out" : "Goals unavailable")
        }
        const next = checkedGoals(await response.json())
        if (active) {
          setGoals(next); setGoalsLoaded(true)
          setGoalId(previous => next.some(goal => goal.id === previous) ? previous : "")
        }
      })
      .catch(failure => { if (active && (!(failure instanceof Error) || failure.message !== "Signed out")) fail("Goals couldn’t load. Try again.") })
      .finally(() => { if (active) { window.clearTimeout(timer); setGoalsLoading(false) } })
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [open, type, attempt])

  const copyParameter = async () => {
    const copied = parameter
    try {
      await navigator.clipboard.writeText(copied)
      if (mounted.current && currentParameter.current === copied) setMessage("Copied. Paste into Edit Widget → Parameter.")
    } catch {
      if (mounted.current && currentParameter.current === copied) setMessage("Select and copy the parameter below.")
    }
  }

  return <div className="bb-widget-guide-extra-body">
    <p>Choose a widget, then paste its parameter into <strong>Edit Widget → Parameter</strong>.</p>
    <div className="bb-widget-customize-fields">
      <label>Widget type<select aria-label="Widget type" value={type} onChange={event => {
        if (widgetTypes.some(widget => widget.value === event.target.value)) setType(event.target.value as WidgetType)
      }}>{widgetTypes.map(widget => <option key={widget.value} value={widget.value}>{widget.label}</option>)}</select></label>
      <label>Theme<select aria-label="Widget theme" value={theme} onChange={event => {
        if (event.target.value === "editorial" || event.target.value === "two-tone") setTheme(event.target.value)
      }}><option value="editorial">Editorial</option><option value="two-tone">Two-tone</option></select></label>
      {type === "savings" && <label className="bb-widget-goal-choice">Goal<select aria-label="Widget savings goal" value={goalId} disabled={goalsLoading} onChange={event => {
        if (!event.target.value || goals.some(goal => goal.id === event.target.value)) setGoalId(event.target.value)
      }}><option value="">First active goal</option>{goals.map(goal => <option key={goal.id} value={goal.id}>{goal.name}</option>)}</select></label>}
    </div>
    {type === "savings" && goalsLoading && <p className="bb-settings-note" role="status">Loading goals…</p>}
    {type === "savings" && goalsError && <p className="bb-widget-error" role="alert">{goalsError} <button type="button" className="bb-settings-action" onClick={() => setAttempt(value => value + 1)}>Retry goals</button></p>}
    {type === "savings" && goalsLoaded && !goalsLoading && goals.length === 0 && <p className="bb-settings-note">No active goals yet. Add one in Savings.</p>}
    <div className="bb-widget-parameter-copy">
      <label>Parameter<input aria-label="Widget parameter" readOnly value={parameter} onFocus={event => event.target.select()} spellCheck={false} /></label>
      <button type="button" className="bb-toolbar-button" disabled={type === "savings" && goalsLoading && Boolean(goalId)} onClick={() => void copyParameter()}>Copy parameter</button>
    </div>
    {message && <p className="bb-settings-note" role="status">{message}</p>}
    <p className="bb-settings-note">Use a different parameter for each widget. Preview in Scriptable → <strong>Widget &amp; preview</strong>. No new pairing needed.</p>
    <p className="bb-settings-note">Leave Parameter empty for Budget in your saved theme. Never put a setup code here.</p>
  </div>
}

export function WidgetSetupGuide({ onBack, onPair }: { onBack: () => void; onPair: () => void }) {
  const [source, setSource] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [showCode, setShowCode] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [showCustomize, setShowCustomize] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const customizeId = useId()
  const helpId = useId()
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    let active = true
    const timer = window.setTimeout(() => {
      active = false; controller.abort(); setLoading(false)
      setError("The script couldn’t load. Try again when connected.")
    }, 15_000)
    setLoading(true); setError("")
    // Public configured source only. Pairing credentials are never part of this request.
    void fetch("/app/widgets/script", { credentials: "omit", mode: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Script unavailable")
        const text = await response.text()
        if (!text.startsWith("// BookieBot Home Screen widget") || text.length > 100_000 || text.includes("__BOOKIEBOT_ORIGIN__")) throw new Error("Invalid script")
        if (active) setSource(text)
      })
      .catch(() => { if (active) setError("The script couldn’t load. Try again when connected.") })
      .finally(() => { if (active) { window.clearTimeout(timer); setLoading(false) } })
    return () => { mounted.current = false; active = false; controller.abort(); window.clearTimeout(timer) }
  }, [attempt])

  const copyScript = async () => {
    if (!source) return
    try {
      await navigator.clipboard.writeText(source)
      if (mounted.current) setMessage("Copied. Paste into Scriptable.")
    } catch {
      if (mounted.current) { setShowCode(true); setMessage("Select and copy the script below, then paste it in Scriptable.") }
    }
  }

  return <div className="bb-widget-guide">
    <div className="bb-settings-heading"><button type="button" className="bb-settings-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to Settings</button><h1>Widget setup</h1></div>
    <ol className="bb-widget-guide-steps">
      <li><h2>Copy to Scriptable</h2><p>Install <a href="https://apps.apple.com/app/scriptable/id1405459188" target="_blank" rel="noreferrer">Scriptable</a>, tap <strong>+</strong>, paste the script and name it <strong>BookieBot</strong>.</p>
        <div className="bb-widget-actions"><button type="button" className="bb-toolbar-button" disabled={loading || !source} onClick={() => void copyScript()}>{loading ? "Loading script…" : "Copy script"}</button></div>
        <p className="bb-settings-note">Already installed? Replace the code in the same script.</p>
        {error && <p className="bb-widget-error" role="alert">{error} <button type="button" className="bb-settings-action" onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
        {message && <p className="bb-settings-note" role="status">{message}</p>}
        <CollapsibleContent open={showCode}><label className="bb-widget-script-label">Select all and copy<textarea aria-label="BookieBot script" readOnly spellCheck={false} value={source} onFocus={event => event.target.select()} /></label></CollapsibleContent>
      </li>
      <li><h2>Pair your account</h2><p>Create a setup code, then run BookieBot in Scriptable and paste it when asked.</p><div className="bb-widget-actions"><button className="bb-toolbar-button" type="button" onClick={onPair}>Get a setup code</button></div><p className="bb-settings-note">Use your own account. Keep the code private; it expires in 10 minutes.</p></li>
      <li><h2>Add the widget</h2><p>Hold your Home Screen → <strong>Edit → Add Widget → Scriptable</strong>. Choose Small or Medium, then <strong>Edit Widget → Script → BookieBot</strong>.</p><p className="bb-settings-note">Both sizes can use the same script.</p></li>
    </ol>
    <div className="bb-widget-guide-extras">
      <section aria-label="Widget customization">
        <button type="button" className="bb-widget-guide-disclosure" aria-expanded={showCustomize} aria-controls={customizeId} onClick={() => setShowCustomize(value => !value)}>Customize<ChevronDown aria-hidden="true" /></button>
        <CollapsibleContent open={showCustomize} id={customizeId}><WidgetCustomizer open={showCustomize} /></CollapsibleContent>
      </section>
      <section aria-label="Setup help">
        <button type="button" className="bb-widget-guide-disclosure" aria-expanded={showHelp} aria-controls={helpId} onClick={() => setShowHelp(value => !value)}>Help<ChevronDown aria-hidden="true" /></button>
        <CollapsibleContent open={showHelp} id={helpId}>
          <div className="bb-widget-guide-extra-body bb-widget-guide-help">
            <div><h3>Updating an existing script</h3><p>Replace its code and keep the same name. Your pairing stays connected; no need to pair again.</p></div>
            <div><h3>Still says “Pair this phone”?</h3><p>Run the updated script <a href="scriptable:///">inside Scriptable</a> and enter a fresh setup code if asked. In Edit Widget, select that exact script. Check your name and figures in its preview.</p></div>
            <div><h3>Refreshes &amp; tapping</h3><p>iOS controls refresh timing; check the timestamp. Leave When Interacting at <strong>Open App</strong> and Parameter empty unless customizing a widget.</p><p>Tapping a paired widget opens BookieBot in your browser, which may need a separate sign-in.</p></div>
          </div>
        </CollapsibleContent>
      </section>
    </div>
    <button type="button" className="bb-settings-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to Settings</button>
  </div>
}
