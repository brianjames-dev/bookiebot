import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { CollapsibleContent } from "./components/ui/motion"
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
  return <Card className="bb-report-section bb-goals-section">
    <CardHeader><div className="bb-goals-heading"><CardTitle>Savings goals</CardTitle>
      <button type="button" disabled={locked || !loaded} aria-expanded={creating} aria-controls={createId} onClick={() => { setCreating(!creating); setError("") }}>＋ Goal</button></div>
      <p className="bb-goals-note">Personal plans across months. Record money you’ve set aside; these allocations don’t move money or change monthly Saved.</p>
    </CardHeader>
    <CardContent>
      {error && <div className="bb-goals-message" role="alert"><p>{error}</p>
        {uncertain ? <div className="bb-goals-actions"><button type="button" disabled={busy} onClick={() => void execute()}>Retry this change</button>
          <button type="button" disabled={busy} onClick={() => void checkLatest()}>Check latest</button></div>
          : <button type="button" disabled={busy} onClick={() => { setError(""); void load() }}>Refresh goals</button>}</div>}
      {!loaded && !error && <p role="status">Loading your goals…</p>}
      <CollapsibleContent id={createId} open={creating}>{showCreating && <GoalEditor disabled={locked} run={run} close={() => setCreating(false)} />}</CollapsibleContent>
      {loaded && !activeGoals.length && !creating && <p className="bb-goals-empty">Give your next milestone a name—an emergency fund, a trip, or something you’re looking forward to.</p>}
      <div className="bb-goals-list">{activeGoals.map((goal) => <GoalEntry key={goal.id} goal={goal} run={run} disabled={locked} />)}</div>
      {!!oldGoals.length && <><button type="button" className="bb-goals-history-toggle" aria-expanded={archived} aria-controls={archivedId} onClick={() => setArchived(!archived)}>Archived goals ({oldGoals.length})</button>
        <CollapsibleContent id={archivedId} open={archived}><div className="bb-goals-list">{oldGoals.map((goal) => <GoalEntry key={goal.id} goal={goal} run={run} disabled={locked} />)}</div></CollapsibleContent></>}
    </CardContent>
  </Card>
}

function GoalEntry({ goal, run, disabled }: { goal: SavingsGoal; run: Run; disabled: boolean }) {
  const detailId = useId()
  const [mode, setMode] = useState<"" | "edit" | "contribute" | "history" | "archive">("")
  const displayedMode = useClosingContent(mode, "")
  const progress = goalProgress(goal)
  const choose = (value: typeof mode) => setMode(mode === value ? "" : value)
  return <article className="bb-goal" aria-label={goal.name}>
    <div className="bb-goal-title"><h3>{goal.name}</h3>{goal.targetDate && <span>By {goal.targetDate}</span>}</div>
    <p className="bb-goal-amount"><strong>{money(goal.balanceCents)}</strong><span>of {money(goal.targetCents)}</span></p>
    <div className="bb-goal-progress" role="progressbar" aria-label={`${goal.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)}><span style={{ width: `${progress.percent}%` }} /></div>
    <p className="bb-goals-note">{progress.remainingCents ? `${money(progress.remainingCents)} to go` : "Target reached"} · {money(goal.startingCents)} starting balance</p>
    <div className="bb-goals-actions">
      {goal.archived ? <button type="button" disabled={disabled} onClick={() => run({ operation: "restore", goalId: goal.id, version: goal.version }, () => setMode(""))}>Restore</button> : <>
        <button type="button" disabled={disabled} aria-expanded={mode === "contribute"} aria-controls={detailId} onClick={() => choose("contribute")}>Add contribution</button>
        <button type="button" disabled={disabled} aria-expanded={mode === "edit"} aria-controls={detailId} onClick={() => choose("edit")}>Edit</button>
        <button type="button" disabled={disabled} aria-expanded={mode === "archive"} aria-controls={detailId} onClick={() => choose("archive")}>Archive</button></>}
      <button type="button" disabled={disabled} aria-expanded={mode === "history"} aria-controls={detailId} onClick={() => choose("history")}>History ({goal.contributionCount})</button>
    </div>
    <CollapsibleContent id={detailId} open={mode !== ""}><div className="bb-goal-detail">
      {displayedMode === "edit" && <GoalEditor key={goal.version} goal={goal} disabled={disabled} run={run} close={() => setMode("")} />}
      {displayedMode === "contribute" && <ContributionEditor goal={goal} disabled={disabled} run={run} close={() => setMode("")} />}
      {displayedMode === "history" && <ContributionHistory key={goal.version} goal={goal} disabled={disabled} run={run} />}
      {displayedMode === "archive" && <><p>Archive {goal.name}? Its balance and contribution history stay saved, and you can restore it later.</p>
        <div className="bb-goals-actions"><button type="button" disabled={disabled} onClick={() => run({ operation: "archive", goalId: goal.id, version: goal.version }, () => setMode(""))}>Archive goal</button>
          <button type="button" disabled={disabled} onClick={() => setMode("")}>Cancel</button></div></>}
    </div></CollapsibleContent>
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
    <p className="bb-goals-note">Enter only the amount already allocated to this goal before its contribution history. Don’t count the same money toward multiple goals.</p>
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
  }}><fieldset disabled={disabled}><legend>Add to {goal.name}</legend>
    <div className="bb-goal-fields"><label>Amount ($)<input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <label>Date<input required type="date" max={localDate()} value={date} onChange={(event) => setDate(event.target.value)} /></label></div>
    <label>Note (optional)<input maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} placeholder="September allocation" /></label>
    <p className="bb-goals-note">Record an allocation you already made. No bank transfer or monthly sheet entry is created.</p>
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
  return <div className="bb-goal-history"><p className="bb-goals-note">Reversing removes a contribution from this goal’s balance and keeps its record. It does not move or refund money.</p>
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
      <div className="bb-goal-reverse"><p>Remove {money(entry.amountCents)} from this goal’s balance?</p>
        <div className="bb-goals-actions"><button type="button" disabled={disabled} onClick={() => run({ operation: "reverse", goalId: goal.id, version: goal.version, contributionId: entry.id }, close)}>Confirm reversal</button>
          <button type="button" disabled={disabled} onClick={close}>Cancel</button></div>
      </div>
    </CollapsibleContent>
  </div>
}
