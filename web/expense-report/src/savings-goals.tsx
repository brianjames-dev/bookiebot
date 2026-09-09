import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { CollapsibleContent } from "./components/ui/motion"
import { FittedAmount } from "./components/ui/fitted-amount"
import { ReportMenu } from "./components/ui/report-menu"
import "./savings-goals.css"

export interface SavingsGoal {
  id: string; name: string; targetCents: number; startingCents: number; balanceCents: number
  contributionCents: number; contributionCount: number; targetDate: string; archived: boolean; version: number
}
interface Contribution { id: string; amountCents: number; date: string; note: string; reversedAt: string }
type Command = Record<string, unknown>
type Run = (body: Command, done: () => void) => void
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const money = (cents: number) => currency.format(cents / 100)
const compactMoney = (cents: number) => money(cents).replace(/\.00$/, "")
type GoalView = "" | "overview" | "edit" | "contribute" | "history" | "archive"
export function goalAmountCents(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null
  const [dollars, cents = ""] = value.trim().split(".")
  const result = Number(dollars) * 100 + Number(cents.padEnd(2, "0"))
  return Number.isSafeInteger(result) && result <= 10_000_000_000 ? result : null
}
export function goalProgress(goal: SavingsGoal) {
  return { percent: Math.min(100, Math.max(0, goal.balanceCents / goal.targetCents * 100)),
    remainingCents: Math.max(0, goal.targetCents - goal.balanceCents) }
}
const localDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
function useClosingContent<T>(value: T, empty: T): T {
  const [retained, setRetained] = useState(value)
  useEffect(() => {
    if (value !== empty) { setRetained(value); return }
    const timer = window.setTimeout(() => setRetained(empty), 320)
    return () => window.clearTimeout(timer)
  }, [value, empty])
  return value !== empty ? value : retained
}
class GoalRequestError extends Error { constructor(message: string, readonly status: number) { super(message) } }
async function request<T>(path: string, body?: Command, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  const timer = window.setTimeout(abort, 20_000)
  try {
    const response = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: body ? { "Content-Type": "application/json", "X-BookieBot-App": "1" } : undefined,
      body: body ? JSON.stringify(body) : undefined, signal: controller.signal, redirect: "error" })
    const data = await response.json()
    if (!response.ok) throw new GoalRequestError(data.error || "Couldn’t update savings goals.", response.status)
    return data as T
  } finally { window.clearTimeout(timer); signal?.removeEventListener("abort", abort) }
}

export function SavingsGoals() {
  const createId = useId()
  const archivedId = useId()
  const [goals, setGoals] = useState<SavingsGoal[]>([])
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const showCreating = useClosingContent(creating, false)
  const [archived, setArchived] = useState(false)
  const [activeGoal, setActiveGoal] = useState<{ id: string; view: GoalView } | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const pending = useRef<{ body: Command; done: () => void } | null>(null)
  const mounted = useRef(true)
  const readId = useRef(0)
  const load = useCallback(async () => {
    const id = ++readId.current
    try {
      const result = await request<{ goals: SavingsGoal[] }>("/app/goals")
      if (mounted.current && id === readId.current) { setGoals(result.goals); setLoaded(true) }
      return true
    } catch (failure) {
      if (mounted.current && id === readId.current) {
        if (failure instanceof GoalRequestError && failure.status === 401) { setGoals([]); setLoaded(false) }
        setError(failure instanceof GoalRequestError ? failure.message : "Couldn’t refresh savings goals. Previously loaded goals may be out of date.")
      }
      return false
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void load()
    const refresh = () => { if (!pending.current && document.visibilityState === "visible") void load() }
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => { mounted.current = false; readId.current += 1; window.removeEventListener("focus", refresh)
      window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh) }
  }, [load])
  const execute = async () => {
    const change = pending.current
    if (!change) return
    ++readId.current
    setBusy(true); setError("")
    try {
      await request("/app/goals", change.body)
      if (!mounted.current) return
      pending.current = null; setUncertain(false); change.done()
      await load()
    } catch (failure) {
      if (!mounted.current) return
      if (failure instanceof GoalRequestError && failure.status < 500) {
        pending.current = null; setUncertain(false)
        if (failure.status === 401) { setGoals([]); setLoaded(false); change.done() }
        if (failure.status === 409) { change.done(); await load() }
        setError(failure.message)
      } else {
        setUncertain(true)
        setError("This change may have saved. Retry the same change safely, or check the latest goals before continuing.")
      }
    } finally { if (mounted.current) setBusy(false) }
  }
  const run: Run = (body, done) => {
    if (pending.current) return
    pending.current = { body: { ...body, requestId: crypto.randomUUID() }, done }
    void execute()
  }
  const checkLatest = async () => {
    setBusy(true)
    if (await load()) { pending.current?.done(); pending.current = null; setUncertain(false); setError("") }
    if (mounted.current) setBusy(false)
  }
  const locked = busy || uncertain
  const activeGoals = goals.filter((goal) => !goal.archived)
  const oldGoals = goals.filter((goal) => goal.archived)
  const goalEntry = (goal: SavingsGoal) => <GoalEntry key={goal.id} goal={goal} run={run} disabled={locked}
    view={activeGoal?.id === goal.id ? activeGoal.view : ""}
    onViewChange={(view) => { setActiveGoal(view ? { id: goal.id, view } : null); if (view) setCreating(false) }} />
  return <Card className="bb-report-section bb-goals-section">
    <CardHeader><div className="bb-goals-heading"><CardTitle>Savings goals</CardTitle>
      <button type="button" className="bb-goals-new" disabled={locked || !loaded} aria-expanded={creating} aria-controls={createId} onClick={() => { setCreating(!creating); setActiveGoal(null); setError("") }}>＋ Goal</button></div>
    </CardHeader>
    <CardContent>
      {error && <div className="bb-goals-message" role="alert"><p>{error}</p>
        {uncertain ? <div className="bb-goals-actions"><button type="button" disabled={busy} onClick={() => void execute()}>Retry this change</button>
          <button type="button" disabled={busy} onClick={() => void checkLatest()}>Check latest</button></div>
          : <button type="button" disabled={busy} onClick={() => { setError(""); void load() }}>Refresh goals</button>}</div>}
      {!loaded && !error && <p role="status">Loading your goals…</p>}
      <CollapsibleContent id={createId} open={creating}>{showCreating && <GoalEditor disabled={locked} run={run} close={() => setCreating(false)} />}</CollapsibleContent>
      {loaded && !activeGoals.length && !creating && <p className="bb-goals-empty">No goals yet.</p>}
      <div className="bb-goals-list">{activeGoals.map(goalEntry)}</div>
      {!!oldGoals.length && <><button type="button" className="bb-goals-history-toggle" aria-expanded={archived} aria-controls={archivedId} onClick={() => setArchived(!archived)}>Archived goals ({oldGoals.length})</button>
        <div className="bb-goals-archived"><CollapsibleContent id={archivedId} open={archived}><div className="bb-goals-list">{oldGoals.map(goalEntry)}</div></CollapsibleContent></div></>}
    </CardContent>
  </Card>
}

function GoalActionPanel({ open, children }: { open: boolean; children: ReactNode }) {
  const retained = useClosingContent(open, false)
  return <CollapsibleContent open={open}>{retained && children}</CollapsibleContent>
}

function goalDateLabel(date: string) {
  if (!date) return ""
  const value = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(value.getTime())) return date
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC",
    ...(date.slice(0, 4) !== localDate().slice(0, 4) ? { year: "numeric" } : {}) }).format(value)
}

function GoalEntry({ goal, run, disabled, view, onViewChange }: {
  goal: SavingsGoal; run: Run; disabled: boolean; view: GoalView; onViewChange: (view: GoalView) => void
}) {
  const detailId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const progress = goalProgress(goal)
  const open = view !== ""
  const close = () => { onViewChange(""); trigger.current?.focus({ preventScroll: true }) }
  const progressBar = (mini: boolean) => <div className={`bb-goal-progress${mini ? " bb-goal-progress-mini" : ""}`}
    role="progressbar" aria-label={`${goal.name}: ${money(goal.balanceCents)} set aside of ${money(goal.targetCents)}`}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)}
    aria-valuetext={`${money(goal.balanceCents)} of ${money(goal.targetCents)}${!progress.remainingCents ? "; target reached" : ""}`}
    aria-hidden={mini && open ? true : undefined}><span style={{ width: `${progress.percent}%` }} /></div>
  return <article className="bb-goal" aria-label={goal.name} data-open={open}>
    <div className="bb-goal-heading">
      <h3><button ref={trigger} type="button" className="bb-goal-toggle" aria-expanded={open} aria-controls={detailId}
        aria-label={`${goal.name}: ${money(goal.balanceCents)} set aside`} disabled={disabled} onClick={() => onViewChange(open ? "" : "overview")}>
        <svg className="bb-goal-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
        <span className="bb-goal-name" title={goal.name}>{goal.name}</span>
        <FittedAmount className={`bb-goal-balance${!progress.remainingCents ? " bb-goal-complete" : ""}`}>{compactMoney(goal.balanceCents)}</FittedAmount>
      </button></h3>
      <ReportMenu label={`${goal.name} options`} disabled={disabled} closeOnSelect>
        {!goal.archived && <button className="bb-report-menu-action" type="button" disabled={disabled} onClick={() => onViewChange("contribute")}>Record contribution</button>}
        <button className="bb-report-menu-action" type="button" disabled={disabled} onClick={() => onViewChange("history")}>History ({goal.contributionCount})</button>
        {goal.archived ? <button className="bb-report-menu-action" type="button" disabled={disabled} onClick={() => run({ operation: "restore", goalId: goal.id, version: goal.version }, close)}>Restore goal</button> : <>
          <button className="bb-report-menu-action" type="button" disabled={disabled} onClick={() => onViewChange("edit")}>Edit goal</button>
          <button className="bb-report-menu-action bb-goal-archive-action" type="button" disabled={disabled} onClick={() => onViewChange("archive")}>Archive goal</button>
        </>}
      </ReportMenu>
    </div>
    {progressBar(true)}
    <div id={detailId}>
      <CollapsibleContent open={view === "overview"}><div className="bb-goal-overview">
        <div className="bb-goal-meta"><span>{goal.targetDate && <time dateTime={goal.targetDate} title={goal.targetDate}>By {goalDateLabel(goal.targetDate)}</time>}</span><span>{progress.remainingCents ? `${Math.round(progress.percent)}% set aside` : "Target reached"}</span></div>
        {progressBar(false)}
        <div className="bb-goal-endpoints"><span><strong>{compactMoney(progress.remainingCents)}</strong> to go</span><span><strong>{compactMoney(goal.targetCents)}</strong> goal</span></div>
      </div></CollapsibleContent>
      <GoalActionPanel open={view === "edit"}><GoalEditor key={goal.version} goal={goal} disabled={disabled} run={run} close={close} /></GoalActionPanel>
      <GoalActionPanel open={view === "contribute"}><ContributionEditor goal={goal} disabled={disabled} run={run} close={close} /></GoalActionPanel>
      <GoalActionPanel open={view === "history"}><div className="bb-goal-history-heading"><h4>Contribution history</h4><button className="bb-goal-close" type="button" onClick={close}>Close</button></div><ContributionHistory key={goal.version} goal={goal} disabled={disabled} run={run} /></GoalActionPanel>
      <GoalActionPanel open={view === "archive"}><div className="bb-goal-archive-confirm"><p>Archive {goal.name}? Its balance and history stay saved, and you can restore it later.</p>
        <div className="bb-goals-actions"><button type="button" disabled={disabled} onClick={() => run({ operation: "archive", goalId: goal.id, version: goal.version }, close)}>Archive goal</button>
          <button type="button" disabled={disabled} onClick={close}>Cancel</button></div></div></GoalActionPanel>
    </div>
  </article>
}

function GoalEditor({ goal, disabled, run, close }: { goal?: SavingsGoal; disabled: boolean; run: Run; close: () => void }) {
  const [name, setName] = useState(goal?.name ?? "")
  const [target, setTarget] = useState(goal ? (goal.targetCents / 100).toFixed(2) : "")
  const [starting, setStarting] = useState(goal ? (goal.startingCents / 100).toFixed(2) : "0")
  const [date, setDate] = useState(goal?.targetDate ?? "")
  const [error, setError] = useState("")
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const targetCents = goalAmountCents(target), startingCents = goalAmountCents(starting)
    if (!name.trim() || targetCents === null || targetCents <= 0 || startingCents === null) { setError("Enter a name, a positive target, and a starting balance with at most two decimal places."); return }
    setError(""); run({ operation: goal ? "edit" : "create", ...(goal ? { goalId: goal.id, version: goal.version } : {}),
      name, targetCents, startingCents, targetDate: date }, close)
  }
  return <form className="bb-goal-form" onSubmit={submit}><fieldset disabled={disabled}><legend>{goal ? "Edit goal" : "New savings goal"}</legend>
    <label>Goal name<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Emergency fund" /></label>
    <div className="bb-goal-fields"><label>Target ($)<input required inputMode="decimal" value={target} onChange={(event) => setTarget(event.target.value)} /></label>
      <label>Starting balance ($)<input required inputMode="decimal" value={starting} onChange={(event) => setStarting(event.target.value)} /></label></div>
    <label>Target date (optional)<input type="date" min="1900-01-01" max="2200-12-31" value={date} onChange={(event) => setDate(event.target.value)} /></label>
    <p className="bb-goals-note">Starting balance excludes recorded contributions. Count each allocation toward one goal.</p>
    {error && <p role="alert">{error}</p>}
    <div className="bb-goals-actions"><button type="submit">Save goal</button><button type="button" onClick={close}>Cancel</button></div>
  </fieldset></form>
}

function ContributionEditor({ goal, disabled, run, close }: { goal: SavingsGoal; disabled: boolean; run: Run; close: () => void }) {
  const [amount, setAmount] = useState("")
  const [date, setDate] = useState(localDate)
  const [note, setNote] = useState("")
  const [error, setError] = useState("")
  return <form className="bb-goal-form" onSubmit={(event) => {
    event.preventDefault(); const cents = goalAmountCents(amount)
    if (cents === null || cents <= 0) { setError("Enter a positive amount with at most two decimal places."); return }
    setError(""); run({ operation: "contribute", goalId: goal.id, version: goal.version, amountCents: cents, date, note }, close)
  }}><fieldset disabled={disabled}><legend>Record contribution</legend>
    <div className="bb-goal-fields"><label>Amount ($)<input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <label>Date<input required type="date" max={localDate()} value={date} onChange={(event) => setDate(event.target.value)} /></label></div>
    <label>Note (optional)<input maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} placeholder="September allocation" /></label>
    <p className="bb-goals-note">Records money set aside; no transfer or change to monthly Saved.</p>
    {error && <p role="alert">{error}</p>}
    <div className="bb-goals-actions"><button type="submit">Record contribution</button><button type="button" onClick={close}>Cancel</button></div>
  </fieldset></form>
}

function ContributionHistory({ goal, disabled, run }: { goal: SavingsGoal; disabled: boolean; run: Run }) {
  const [entries, setEntries] = useState<Contribution[]>([])
  const [next, setNext] = useState<number | null>(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [reversing, setReversing] = useState("")
  const load = useCallback(async (offset: number, signal?: AbortSignal) => {
    setLoading(true); setError("")
    try { const result = await request<{ contributions: Contribution[]; nextOffset: number | null }>(`/app/goals/${encodeURIComponent(goal.id)}/contributions?offset=${offset}`, undefined, signal)
      if (!signal?.aborted) { setEntries((previous) => offset ? [...previous, ...result.contributions] : result.contributions); setNext(result.nextOffset) }
    } catch { if (!signal?.aborted) setError("Couldn’t load contribution history. Try again.") }
    finally { if (!signal?.aborted) setLoading(false) }
  }, [goal.id])
  useEffect(() => { const controller = new AbortController(); void load(0, controller.signal); return () => controller.abort() }, [load])
  return <div className="bb-goal-history"><div className="bb-goal-starting"><span>Starting balance</span><strong>{money(goal.startingCents)}</strong></div>
    {entries.map((entry) => <ContributionHistoryRow key={entry.id} entry={entry} goal={goal} run={run} disabled={disabled}
      open={reversing === entry.id} onToggle={() => setReversing(reversing === entry.id ? "" : entry.id)} onClose={() => setReversing("")} />)}
    {loading && <p role="status">Loading contributions…</p>}
    {!loading && !entries.length && !error && <p>No contributions yet.</p>}
    {error && <p role="alert">{error}</p>}
    {next !== null && <button type="button" disabled={loading || disabled} onClick={() => void load(next)}>{error ? "Try again" : "Load more"}</button>}
  </div>
}

function ContributionHistoryRow({ entry, goal, run, disabled, open, onToggle, onClose }: {
  entry: Contribution; goal: SavingsGoal; run: Run; disabled: boolean; open: boolean; onToggle: () => void; onClose: () => void
}) {
  const confirmationId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const canReverse = !entry.reversedAt && !goal.archived
  const expanded = Boolean(open && canReverse)
  const close = () => { onClose(); trigger.current?.focus({ preventScroll: true }) }
  return <div className="bb-goal-history-row"><div><strong>{money(entry.amountCents)}</strong><span>{entry.date}{entry.note ? ` · ${entry.note}` : ""}</span>
    {entry.reversedAt && <span>Reversed</span>}</div>
    {canReverse && <button ref={trigger} type="button" disabled={disabled} aria-expanded={expanded} aria-controls={confirmationId} onClick={onToggle}>Reverse</button>}
    <CollapsibleContent id={confirmationId} open={expanded}>
      <div className="bb-goal-reverse"><p>Remove {money(entry.amountCents)} from this goal’s balance? Its history stays saved; no money moves.</p>
        <div className="bb-goals-actions"><button type="button" disabled={disabled} onClick={() => run({ operation: "reverse", goalId: goal.id, version: goal.version, contributionId: entry.id }, close)}>Confirm reversal</button>
          <button type="button" disabled={disabled} onClick={close}>Cancel</button></div>
      </div>
    </CollapsibleContent>
  </div>
}
