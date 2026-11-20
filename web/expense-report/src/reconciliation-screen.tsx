import { ReportLoading, SavingButton } from "./report-loading"
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Check, ChevronDown, Circle, CircleCheck, EyeOff, ListChecks, Plus, RefreshCw, TriangleAlert, X } from "lucide-react"
import { usePageRefresh } from "./page-refresh"
import { useAppWorkStatus } from "./app-work-guard"
import { ReimbursementLedger } from "./reimbursement-ledger"
import { TransactionIcon } from "./daily-transactions"
import { EditorExpansion, EditorScenes } from "./transaction-editor-workspace"
import { AppUpdatedTime } from "./app-refresh-control"
import "./reconciliation-screen.css"

type ReviewStatus = "needs_review" | "pending" | "checked" | "ignored"

function updatePillEdges(strip: HTMLDivElement) {
  strip.dataset.earlier = String(strip.scrollLeft > 1)
  strip.dataset.more = String(strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1)
}

function revealPill(strip: HTMLDivElement, button: HTMLElement | null) {
  if (!button || !strip.clientWidth) return
  const bounds = strip.getBoundingClientRect(), target = button.getBoundingClientRect()
  if (target.left < bounds.left) strip.scrollLeft += target.left - bounds.left - 9
  if (target.right > bounds.right - 13) strip.scrollLeft += target.right - bounds.right + 13
  updatePillEdges(strip)
}
interface ReceiptLink { allocationId: string; partner: string; bankAmountCents: number; outstandingCents: number }
interface SharedAmountPlan {
  token: string; allocationId: string; allocationVersion: number; reviewId: number; method: "income" | "equal" | "fronted" | "custom"
  payer: string; partner: string; previousGrossCents: number; grossCents: number
  previousPayerShareCents: number; payerShareCents: number; previousPartnerShareCents: number; partnerShareCents: number
  receivedCents: number; remainingCents: number; recovery: boolean
}
type SharedAmount = SharedAmountPlan | { blocked: string }
interface Suggestion {
  id: string; item: string; date: string; amountCents: number; category: string
  amountMismatch: boolean; kind: "recorded" | "schedule"; confirmable: boolean; recorded?: boolean; confidence?: number
  sharedAmount?: SharedAmount
}
export interface ReconciliationItem {
  id: number; version: string; stateVersion?: string; loadedAt?: number; status: ReviewStatus; date: string; merchant: string
  amountCents: number; currency: "USD"; accountLabel: string; suggestions: Suggestion[]
  receipt?: ReceiptLink
  logging?: { allowed: boolean; kind: "expense" | "income"; categories: string[]; paymentMethods: string[]; reason: string }; matchedSuggestionId?: string | null; needsCheck?: boolean; readOnly?: boolean; scheduleRecovery?: boolean; matchLabel?: string | null
}
interface ConnectionIssue { id: number; institution: string; needsReconnect: boolean; reconnectUrl?: string }
interface PreparedReview { fromId: number; id: number; intent?: "amount" | "log"; suggestionId?: string }
interface Snapshot { enabled: boolean; checkedAt: string | null; items: ReconciliationItem[]; notice?: string; connections?: ConnectionIssue[]; receiptFollowup?: { id: number; receipt: ReceiptLink }; preparedReview?: PreparedReview }
type Command = { operation: "check" } | { operation: "prepare" | "confirm" | "update_match" | "update_schedule" | "recover_schedule" | "log" | "ignore" | "reopen"; id: number; version: string; suggestionId?: string; fields?: Record<string, string>; scheduleVersion?: string; updateFuture?: boolean; splitMethod?: string; sharedAmountToken?: string; reviewIntent?: "amount" | "log" }
type ReviewCommand = Exclude<Command, { operation: "check" }>
const endpoint = "/app/reconciliation"
const isText = (value: unknown, max = 300): value is string => typeof value === "string" && value.length <= max
const isDate = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value))
const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)
const validSharedAmount = (value: SharedAmount) => value && ("blocked" in value ? isText(value.blocked, 500) && Boolean(value.blocked)
  : isText(value.token, 64) && /^[a-f0-9]{64}$/.test(value.token) && isText(value.allocationId, 200)
    && isAmount(value.allocationVersion) && value.allocationVersion > 0 && isAmount(value.reviewId) && value.reviewId > 0
    && ["income", "equal", "fronted", "custom"].includes(value.method) && isText(value.payer) && isText(value.partner)
    && [value.previousGrossCents, value.grossCents, value.previousPayerShareCents, value.payerShareCents, value.previousPartnerShareCents,
      value.partnerShareCents, value.receivedCents, value.remainingCents].every(amount => isAmount(amount) && amount >= 0)
    && value.grossCents > 0 && value.payerShareCents + value.partnerShareCents === value.grossCents
    && value.previousPayerShareCents + value.previousPartnerShareCents === value.previousGrossCents
    && value.partnerShareCents - value.receivedCents === value.remainingCents && typeof value.recovery === "boolean")
const validReceipt = (value: ReceiptLink) => value && isText(value.allocationId, 200) && Boolean(value.allocationId)
  && isText(value.partner) && Boolean(value.partner) && isAmount(value.bankAmountCents) && value.bankAmountCents > 0
  && isAmount(value.outstandingCents) && value.outstandingCents >= 0 && value.outstandingCents <= value.bankAmountCents
function validItem(value: unknown): value is ReconciliationItem {
  const item = value as ReconciliationItem | null
  return Boolean(item && Number.isSafeInteger(item.id) && item.id !== 0 && isText(item.version) && item.version
    && (item.stateVersion === undefined || isText(item.stateVersion))
    && (item.logging === undefined || (typeof item.logging.allowed === "boolean" && ["expense", "income"].includes(item.logging.kind)
      && Array.isArray(item.logging.categories) && item.logging.categories.every(value => isText(value))
      && Array.isArray(item.logging.paymentMethods) && item.logging.paymentMethods.every(value => isText(value)) && isText(item.logging.reason)))
    && ["needs_review", "pending", "checked", "ignored"].includes(item.status) && (item.date === "" || isDate(item.date))
    && isText(item.merchant, 500) && isAmount(item.amountCents) && item.currency === "USD" && isText(item.accountLabel)
    && (item.needsCheck === undefined || typeof item.needsCheck === "boolean")
    && (item.scheduleRecovery === undefined || typeof item.scheduleRecovery === "boolean")
    && (item.receipt === undefined || (item.status === "checked" && validReceipt(item.receipt) && item.receipt.bankAmountCents === item.amountCents))
    && (item.readOnly === undefined || typeof item.readOnly === "boolean")
    && (item.matchLabel === undefined || item.matchLabel === null || isText(item.matchLabel))
    && Array.isArray(item.suggestions) && item.suggestions.length <= 25 && item.suggestions.every(suggestion =>
      suggestion && isText(suggestion.id) && suggestion.id && isText(suggestion.item, 500) && isDate(suggestion.date)
      && isAmount(suggestion.amountCents) && isText(suggestion.category) && typeof suggestion.amountMismatch === "boolean"
      && ["recorded", "schedule"].includes(suggestion.kind) && typeof suggestion.confirmable === "boolean"
      && (suggestion.recorded === undefined || typeof suggestion.recorded === "boolean")
      && (suggestion.sharedAmount === undefined || (validSharedAmount(suggestion.sharedAmount) && ("blocked" in suggestion.sharedAmount
        || suggestion.sharedAmount.grossCents === Math.abs(item.amountCents) && suggestion.sharedAmount.reviewId === item.id)))
      && (suggestion.confidence === undefined || (Number.isFinite(suggestion.confidence) && suggestion.confidence >= 0 && suggestion.confidence <= 1))))
}
function checkedSnapshot(value: unknown): Snapshot {
  const data = value as Snapshot | null
  if (!data || typeof data.enabled !== "boolean" || (data.checkedAt !== null && !isDate(data.checkedAt))
    || !Array.isArray(data.items) || data.items.length > 300 || !data.items.every(validItem)
    || new Set(data.items.map(item => item.id)).size !== data.items.length
    || (data.preparedReview !== undefined && (!isAmount(data.preparedReview.fromId) || data.preparedReview.fromId >= 0
      || !isAmount(data.preparedReview.id) || data.preparedReview.id <= 0 || !data.items.some(item => item.id === data.preparedReview?.id)
      || data.preparedReview.intent !== undefined && !["amount", "log"].includes(data.preparedReview.intent)
      || data.preparedReview.suggestionId !== undefined && !isText(data.preparedReview.suggestionId, 200)))
    || (data.receiptFollowup !== undefined && (!validReceipt(data.receiptFollowup.receipt)
      || !data.items.some(item => item.id === data.receiptFollowup?.id && item.status === "checked" && item.amountCents === data.receiptFollowup.receipt.bankAmountCents)))
    || (data.notice !== undefined && !isText(data.notice, 500))
    || (data.connections !== undefined && (!Array.isArray(data.connections) || data.connections.length > 50
      || !data.connections.every(connection => connection && Number.isSafeInteger(connection.id) && connection.id > 0
        && isText(connection.institution) && typeof connection.needsReconnect === 'boolean'
        && (!connection.needsReconnect || (typeof connection.reconnectUrl === 'string'
          && /^\/bank\/link\?token=[A-Za-z0-9_.%-]+$/.test(connection.reconnectUrl))))))) throw new Error("Couldn’t read the latest bank review.")
  return data
}
class ReviewRequestError extends Error { constructor(message: string, readonly status: number, readonly notApplied = false) { super(message) } }
async function request(path: string, controller: AbortController, body?: Command): Promise<unknown> {
  let abort = () => {}
  const timeout = window.setTimeout(() => controller.abort(), body?.operation === "check" ? 60_000 : 20_000)
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(new Error("The bank check took too long. Try again."))
      if (controller.signal.aborted) { abort(); return }
      controller.signal.addEventListener("abort", abort, { once: true })
      void fetch(path, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin", mode: "same-origin", referrerPolicy: "same-origin", cache: "no-store", redirect: "error",
        headers: { "X-BookieBot-App": "1", "Content-Type": "application/json" }, signal: controller.signal,
      }).then(async response => {
        const value = await response.json()
        if (!response.ok) throw new ReviewRequestError(response.status === 401 ? "Reconnect BookieBot to review your bank transactions."
          : isText(value?.error) ? value.error : "Couldn’t finish the bank review. Try again.", response.status, value?.outcome === "not_applied")
        return value
      }).then(resolve, reject)
    })
  } finally { window.clearTimeout(timeout); controller.signal.removeEventListener("abort", abort) }
}

export function useReconciliation(enabled = true) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [pendingReview, setPendingReview] = useState<ReviewCommand | null>(null)
  const [revision, setRevision] = useState(0)
  const [resetReview, setResetReview] = useState(0)
  const mounted = useRef(false), current = useRef<AbortController | null>(null), blocked = useRef(false)
  const updateWork = useAppWorkStatus({ label: "Bank reconciliation", pending: busy, uncertain: needsRefresh })
  const load = useCallback(async (body?: Command) => {
    if (!mounted.current || current.current || (body && blocked.current)) return
    const controller = new AbortController()
    current.current = controller; setBusy(true); setPendingReview(body && body.operation !== "check" ? body : null); setError("")
    updateWork({ label: "Bank reconciliation", pending: true, uncertain: blocked.current })
    const active = () => mounted.current && current.current === controller
    try {
      const next = checkedSnapshot(await request(endpoint, controller, body))
      if (!active()) return
      if (blocked.current) setResetReview(value => value + 1)
      if (blocked.current || (body && ["update_match", "update_schedule", "recover_schedule", "log"].includes(body.operation))) window.dispatchEvent(new Event("bookiebot:transactions-changed"))
      setSnapshot(next); setRevision(value => value + 1); blocked.current = false; setNeedsRefresh(false)
      return true
    } catch (failure) {
      if (!active()) return
      const known = failure instanceof ReviewRequestError && failure.status < 500
      if (failure instanceof ReviewRequestError && [401, 403].includes(failure.status)) {
        setSnapshot(null); blocked.current = false; setNeedsRefresh(false); setRevision(value => value + 1)
      } else if (body && known && [400, 404, 409].includes(failure.status)
        && (["prepare", "confirm", "ignore", "reopen"].includes(body.operation) || failure.notApplied)) {
        // Metadata conflicts and explicit no-write rejections can safely close
        // stale choices and read current state once. Never retry the command;
        // unknown financial outcomes retain their recovery lock.
        blocked.current = false; setNeedsRefresh(false); setResetReview(value => value + 1)
        setPendingReview(null)
        try {
          const next = checkedSnapshot(await request(endpoint, controller))
          if (!active()) return
          setSnapshot(next); setRevision(value => value + 1)
        } catch (refreshFailure) {
          if (!active()) return
          if (refreshFailure instanceof ReviewRequestError && [401, 403].includes(refreshFailure.status)) setSnapshot(null)
          setError(`${failure.message} Couldn’t refresh the review. Try again.`)
          return
        }
      } else if (body) { blocked.current = true; setNeedsRefresh(true) }
      setError(body && !known ? "This check may have finished. Check its status before trying another change."
        : failure instanceof Error ? failure.message : "Couldn’t load bank transactions.")
      return false
    } finally { if (active()) { current.current = null; setBusy(false); setPendingReview(null) } }
  }, [updateWork])
  useEffect(() => {
    if (!enabled) return
    mounted.current = true; void load()
    const refresh = () => { if (document.visibilityState === "visible" && !blocked.current) void load() }
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => { mounted.current = false; current.current?.abort(); current.current = null
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh)
      document.removeEventListener("visibilitychange", refresh) }
  }, [load, enabled])
  const rejectAccess = useCallback((message: string) => {
    current.current?.abort(); current.current = null
    setSnapshot(null); setRevision(value => value + 1); setError(message); setBusy(false); setPendingReview(null)
    blocked.current = false; setNeedsRefresh(false)
  }, [])
  return { snapshot, error, busy, needsRefresh, revision, resetReview, pendingReview, load, rejectAccess }
}
type Controller = ReturnType<typeof useReconciliation>
const filterLabels = { needs_review: "Needs review", pending: "Pending", checked: "Checked" } as const
type Filter = keyof typeof filterLabels
const dateLabel = (value: string) => value ? new Date(value.includes("T") ? value : `${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Date unavailable"
const money = (value: number) => `${value < 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(value) / 100)}`
const statusLabel = (value: ReviewStatus) => value === "ignored" ? "Ignored" : value === "checked" ? "Matched" : value === "pending" ? "Pending" : "Needs review"

export function ReconciliationScreen({ controller, embeddedHeader=false, wide=false, headerActions, statusTarget, aliases }: {
  controller: Controller; embeddedHeader?: boolean; wide?: boolean; headerActions?: HTMLElement | null
  statusTarget?: HTMLElement | null; aliases?: Record<string, string>
}) {
  const { snapshot, error, busy, needsRefresh, revision, resetReview, pendingReview, load, rejectAccess } = controller
  const [filter, setFilter] = useState<Filter>("needs_review")
  const [openId, setOpenId] = useState<number | null>(null)
  const [details, setDetails] = useState<Record<number, ReconciliationItem>>({})
  const [detailError, setDetailError] = useState("")
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailFailedId, setDetailFailedId] = useState<number | null>(null)
  const [detailRevision, setDetailRevision] = useState(0)
  const [scheduleError, setScheduleError] = useState<{ id: number; message: string } | null>(null)
  const onScheduleError = useCallback((id: number, message: string) => {
    setScheduleError(previous => message ? { id, message } : previous?.id === id ? null : previous)
  }, [])
  const [receiptTarget, setReceiptTarget] = useState<(ReceiptLink & { review?: boolean }) | null>(null)
  const receiptPanel = useRef<HTMLDivElement>(null)
  const rejectReceiptAccess = useCallback((message: string) => { setReceiptTarget(null); setDetails({}); rejectAccess(message) }, [rejectAccess])
  useEffect(() => { if (receiptTarget) receiptPanel.current?.scrollIntoView({ block: "start" }) }, [receiptTarget])
  useEffect(() => {
    const refresh = () => { setDetails({}); setDetailRevision(value => value + 1) }
    window.addEventListener("bookiebot:reimbursements-changed", refresh)
    return () => window.removeEventListener("bookiebot:reimbursements-changed", refresh)
  }, [])
  useEffect(() => { setOpenId(null); setDetails({}) }, [resetReview])
  const preparedId = snapshot?.preparedReview?.id
  const locked = busy || needsRefresh || Boolean(receiptTarget)
  const reviewing = Boolean(receiptTarget || pendingReview)
  const rows = snapshot?.items ?? []
  const matchesFilter = (item: ReconciliationItem) => filter === "checked" ? ["checked", "ignored"].includes(item.status) : item.status === filter
  const openRow = rows.find(item => item.id === openId && matchesFilter(item))
  useEffect(() => { if (needsRefresh) setDetails(previous => Object.fromEntries(Object.entries(previous).map(([id, item]) => [id, { ...item, loadedAt: 0 }]))) }, [needsRefresh])
  useEffect(() => { if (openId !== null && !openRow) setOpenId(null) }, [openId, openRow])
  useEffect(() => {
    if (preparedId === undefined) return
    const prepared = snapshot?.items.find(item => item.id === preparedId)
    if (!prepared) return
    setFilter(["checked", "ignored"].includes(prepared.status) ? "checked" : prepared.status === "pending" ? "pending" : "needs_review")
    setDetails({}); setOpenId(preparedId)
  }, [preparedId])
  // Keep source previews for unchanged bank/review versions for up to 30 seconds.
  // Every financial confirmation still validates fresh server-side evidence.
  useEffect(() => { setDetails(previous => Object.fromEntries(Object.entries(previous).filter(([id, detail]) => {
    const row = rows.find(entry => entry.id === Number(id))
    return row && (row.stateVersion ?? row.version) === (detail.stateVersion ?? detail.version)
  }))) }, [revision])
  useEffect(() => {
    setDetailError("")
    setDetailFailedId(null)
    if (openId === null || !openRow || !snapshot?.enabled) { setLoadingDetail(false); return }
    const cached = details[openId]
    if (cached && (cached.stateVersion ?? cached.version) === (openRow.stateVersion ?? openRow.version)
      && Date.now() - (cached.loadedAt ?? 0) < 30_000) { setLoadingDetail(false); return }
    const controller = new AbortController(); let active = true
    setLoadingDetail(true)
    void request(`${endpoint}/${openId}`, controller).then(value => {
      const item = (value as { item?: unknown })?.item
      if (!validItem(item) || item.id !== openId) throw new Error("This transaction changed. Check again.")
      if (active) setDetails(previous => ({ ...previous, [item.id]: { ...item, loadedAt: Date.now() } }))
    }).catch(failure => { if (active) {
      if (failure instanceof ReviewRequestError && [401, 403].includes(failure.status)) { setDetails({}); rejectAccess(failure.message) }
      else if (failure instanceof ReviewRequestError && [404, 409].includes(failure.status)) {
        // Close the obsolete review before refreshing so a changing bank row
        // cannot create a detail → list → detail retry loop.
        setDetails({}); setOpenId(null); void load()
      }
      setDetailError(failure instanceof Error ? failure.message : "Couldn’t load suggestions.")
      setDetailFailedId(openId)
    } })
      .finally(() => { if (active) setLoadingDetail(false) })
    return () => { active = false; controller.abort() }
  }, [openId, revision, detailRevision, snapshot?.enabled, rejectAccess, load])
  const visibleRows = rows.filter(matchesFilter)
  // A preview can arrive mid-expansion. Only regroup on a queue change,
  // keeping the selected row and its editor in place while it loads.
  const [groupPreviews, setGroupPreviews] = useState<typeof details>({})
  useLayoutEffect(() => { setGroupPreviews(details) }, [filter, revision])
  const activeDetailError = openRow && detailFailedId === openRow.id ? detailError
    : openRow && scheduleError?.id === openRow.id ? scheduleError.message : ""
  const refreshQueue = () => load(needsRefresh || error || activeDetailError || !snapshot?.enabled ? undefined : { operation: "check" })
  const pageRefresh = usePageRefresh(receiptTarget ? null : "reconcile", {
    refresh: refreshQueue,
    disabled: busy || Boolean(receiptTarget),
  })
  const recovery = openRow ? details[openRow.id]?.scheduleRecovery : false
  const shortStatus = busy && !pendingReview ? "Checking…" : needsRefresh ? "Check saved status" : error ? "Check failed"
    : activeDetailError ? "Review unavailable" : recovery ? "Verify saved payment" : snapshot?.notice ? "Bank update needed" : ""
  const statusDetail = error || activeDetailError || snapshot?.notice
  const status = shortStatus
    ? <><span title={statusDetail || undefined}>{shortStatus}</span>{statusDetail && <span className="sr-only">{statusDetail}</span>}</>
    : snapshot?.checkedAt ? <AppUpdatedTime updatedAt={Date.parse(snapshot.checkedAt)} /> : <span>Not updated yet</span>
  const pillStrip = useRef<HTMLDivElement>(null)
  const pillDrag = useRef<{ x: number; left: number; moved: boolean } | null>(null)
  useLayoutEffect(() => {
    const strip = pillStrip.current
    if (!strip) return
    revealPill(strip, strip.querySelector('[aria-pressed=true]'))
    updatePillEdges(strip)
    const observer = new ResizeObserver(() => updatePillEdges(strip))
    observer.observe(strip)
    return () => observer.disconnect()
  }, [filter, wide, headerActions, snapshot?.enabled])
  const filters = snapshot?.enabled && <div ref={pillStrip} className="bb-reconcile-filters" role="group" aria-label="Transaction status"
    onScroll={event => updatePillEdges(event.currentTarget)}
    onFocus={event => { if (event.target.matches(":focus-visible")) revealPill(event.currentTarget, event.target) }}
    onPointerDown={event => {
      pillDrag.current = event.pointerType === "mouse" && event.button === 0
        ? { x: event.clientX, left: event.currentTarget.scrollLeft, moved: false } : null
    }}
    onPointerMove={event => {
      const drag = pillDrag.current, strip = event.currentTarget
      if (!drag || !event.buttons || strip.scrollWidth <= strip.clientWidth) return
      const delta = event.clientX - drag.x
      if (!drag.moved && Math.abs(delta) < 5) return
      if (!drag.moved) strip.setPointerCapture(event.pointerId)
      drag.moved = true
      strip.scrollLeft = drag.left - delta
    }}
    onClickCapture={event => {
      if (event.detail && pillDrag.current?.moved) { event.preventDefault(); event.stopPropagation() }
      pillDrag.current = null
    }}>
    {(Object.keys(filterLabels) as Filter[]).map(value => <button type="button" key={value} disabled={reviewing} aria-pressed={filter === value} onClick={() => { setFilter(value); setOpenId(null) }}>
      <span>{filterLabels[value]}<small>{rows.filter(item => value === "checked" ? ["checked", "ignored"].includes(item.status) : item.status === value).length}</small></span></button>)}
  </div>
  const check = (wide || !pageRefresh) && <button type="button" className={"bb-reconcile-check"+(wide?" bb-reconcile-icon-check":"")}
    aria-label={wide ? needsRefresh ? "Check status" : "Check bank transactions" : undefined}
    disabled={snapshot?.enabled === false || (!snapshot && !error) || busy || Boolean(receiptTarget)} onClick={() => void refreshQueue()}>
    <RefreshCw className={busy&&!pendingReview?"sr-refresh-spinning":undefined} size={17} aria-hidden="true" />{!wide && (busy ? "Checking…" : needsRefresh ? "Check status" : "Check")}</button>
  const toolbar = <>{filters}{check}</>
  const reviewContent = (item: ReconciliationItem, active: boolean) => {
    const detail = details[item.id], pending = pendingReview?.id === item.id ? pendingReview : null
    const failure = active && detailFailedId === item.id ? detailError : ""
    const loading = active && !failure && !detail
    const disabled = locked || active && (loadingDetail || Boolean(failure))
    return <div className="bb-reconcile-row-details">
      {loading && <div className="bb-reconcile-detail-loading"><ReportLoading label="Finding sheet entries…"/></div>}
      {detail && <>
        {detail.matchLabel && <p className="bb-reconcile-matched"><Check size={15} aria-hidden="true" />{detail.matchLabel}</p>}
        {detail.receipt && <button type="button" className="bb-reconcile-action bb-reconcile-outline" disabled={disabled}
          onClick={() => setReceiptTarget({ ...detail.receipt!, review: detail.receipt!.outstandingCents > 0 })}>{detail.receipt.outstandingCents > 0 ? "Mark" : "View"} {detail.receipt.partner}’s share{detail.receipt.outstandingCents > 0 ? " received" : ""}</button>}
        {detail.scheduleRecovery && <SavingButton type="button" className="bb-reconcile-action bb-reconcile-outline" disabled={disabled} saving={pending?.operation === "recover_schedule"}
          onClick={() => void load({ operation: "recover_schedule", id: detail.id, version: detail.stateVersion ?? detail.version })}>Verify saved payment change</SavingButton>}
        {detail.readOnly && !detail.scheduleRecovery && <p className="bb-reconcile-muted">Finish this transaction in BookieBot.</p>}
        <ReviewChoices key={detail.version} item={detail} active={active} aliases={aliases} initialReview={snapshot?.preparedReview?.id === detail.id ? snapshot.preparedReview : undefined} disabled={disabled} pending={pending} onCommand={command => void load(command)} onRejectAccess={rejectAccess} revision={revision} onScheduleError={onScheduleError} />
        {!detail.readOnly && ["checked", "ignored"].includes(detail.status) && <SavingButton type="button" className="bb-reconcile-action bb-reconcile-secondary" disabled={disabled}
          saving={pending?.operation === "reopen"} onClick={() => void load({operation:"reopen",id:detail.id,version:detail.stateVersion??detail.version})}>Reopen review</SavingButton>}
      </>}
    </div>
  }
  const groups = new Map<string, ReconciliationItem[]>()
  for (const row of visibleRows) {
    const savedPreview = groupPreviews[row.id]
    const preview = savedPreview && (savedPreview.stateVersion ?? savedPreview.version) === (row.stateVersion ?? row.version) ? savedPreview : undefined
    const best = recommendedFor(preview ?? row)
    const label = filter !== "needs_review" ? "" : best ? best.amountMismatch ? "Amount changes" : "Exact matches"
      : preview && !preview.suggestions.length && !preview.readOnly ? "No budget entry" : "To check"
    const group = groups.get(label) ?? []
    if (!groups.has(label)) groups.set(label, group)
    group.push(row)
  }
  const list = [...groups.entries()].flatMap(([label, items]) => [
    ...(label ? [<h2 className="bb-reconcile-group" key={label}>{label}<span>{items.length}</span></h2>] : []),
    ...items.map(item => <TransactionRow key={item.id} item={item} open={openId === item.id} wide={wide} aliases={aliases} disabled={reviewing}
      onToggle={() => setOpenId(value => value === item.id ? null : item.id)}>{!wide && reviewContent(item,openId===item.id)}</TransactionRow>),
  ])
  return <section className="bb-reconcile" data-wide={wide || undefined} aria-labelledby={embeddedHeader?'bb-main-page-title':'bb-reconcile-title'}>
    {statusTarget && createPortal(status, statusTarget)}
    <div className="bb-reconcile-left">
    <div className="bb-reconcile-heading">{!embeddedHeader&&<div><h1 id="bb-reconcile-title">Reconcile</h1><div className="bb-app-status" role="status">{status}</div></div>}
      {headerActions ? createPortal(toolbar, headerActions) : toolbar}</div>
    {receiptTarget && <div ref={receiptPanel}><ReimbursementLedger key={receiptTarget.allocationId} fallback={<p>Shared payments are currently unavailable.</p>}
      matchedReceipt={receiptTarget} onClose={() => setReceiptTarget(null)} onRejectAccess={rejectReceiptAccess} /></div>}
    {!receiptTarget && snapshot?.receiptFollowup && <div className="bb-reconcile-message" role="status"><p>Bank match saved. Receiving your partner’s share is a separate step.</p>
      <button type="button" className="bb-reconcile-action bb-reconcile-outline" disabled={locked} onClick={() => setReceiptTarget({ ...snapshot.receiptFollowup!.receipt, review: true })}>Review {snapshot.receiptFollowup.receipt.partner}’s share</button></div>}
    {!snapshot && !error && <ReportLoading label="Loading bank transactions…"/>}
    {snapshot?.connections?.some(connection => connection.needsReconnect) && <div className="bb-reconcile-recovery-actions">
      {snapshot.connections.filter(connection => connection.needsReconnect).map(connection => <a key={connection.id}
        className="bb-reconcile-action" href={connection.reconnectUrl}>Reconnect {connection.institution}</a>)}
    </div>}
    {filter === "pending" && visibleRows.length > 0 && <p className="bb-reconcile-muted">Bank amounts may change. Matches stay tentative until posted.</p>}
    {snapshot?.enabled && !visibleRows.length && <div className="bb-reconcile-empty"><Check size={22} aria-hidden="true" /><p>{filter === "needs_review" ? snapshot.connections?.length ? "No saved transactions need review." : "Nothing needs review." : filter === "pending" ? "No pending transactions." : "No checked transactions yet."}</p></div>}
    <div className="bb-reconcile-list">{list}</div>
    </div>
    {wide && <RightReview item={openRow} ready={!openRow || Boolean(details[openRow.id]) || detailFailedId===openRow.id}
      render={reviewContent} close={() => setOpenId(null)} locked={reviewing}/>}
  </section>
}
const recommendedFor = (item: ReconciliationItem) => item.suggestions.find((_, index) => index === 0 && (item.suggestions[0].confidence ?? 1) >= .72)

function RightReview({ item, ready, render, close, locked }: {
  item?: ReconciliationItem; ready: boolean; render: (item: ReconciliationItem, active: boolean) => ReactNode
  close: () => void; locked: boolean
}) {
  const [shown, setShown] = useState<ReconciliationItem>()
  const [previous, setPrevious] = useState<ReconciliationItem>()
  const pane = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if ((item && !ready && shown) || item?.id === shown?.id) return
    setPrevious(shown)
    setShown(item)
  }, [item, ready, shown])
  useLayoutEffect(() => {
    const node = pane.current
    if (!node || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (previous) setPrevious(undefined)
      return
    }
    const panels = [...node.querySelectorAll<HTMLElement>(':scope > [data-review-layer]')]
    const animations = panels.map(panel => {
      const leaving = panel.dataset.reviewLayer === "old"
      const from = panel.style.opacity || (leaving ? "1" : ".22")
      return panel.animate([{opacity:from},{opacity:leaving?0:1}], {duration:320,easing:"cubic-bezier(.22,.8,.25,1)",fill:"both"})
    })
    let active = true
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (!active) return
      panels.forEach(panel => { panel.style.opacity = panel.dataset.reviewLayer === "old" ? "0" : "1" })
      animations.forEach(animation => animation.cancel())
      setPrevious(undefined)
    })
    return () => {
      active = false
      panels.forEach(panel => { panel.style.opacity = getComputedStyle(panel).opacity })
      animations.forEach(animation => animation.cancel())
    }
  }, [shown?.id])
  const pending = Boolean(item && item.id !== shown?.id)
  return <aside className="bb-reconcile-right" aria-label="Transaction review" aria-busy={pending || undefined}>
    {item && <div className="bb-reconcile-inspector-tools">
      <button className="bb-reconcile-dismiss" type="button" disabled={locked} aria-label="Close review" onClick={close}><X size={16} aria-hidden="true"/></button>
    </div>}
    <div ref={pane} className="bb-reconcile-pane">
      {previous && <div key={previous.id} data-review-layer="old" inert aria-hidden="true">{render(previous,false)}</div>}
      {shown ? <div key={shown.id} data-review-layer="current" inert={pending} aria-hidden={pending || undefined}>{render(shown,!pending && shown.id===item?.id)}</div>
        : <div data-review-layer="current" key="blank" className="bb-reconcile-empty">Choose a transaction to review.</div>}
    </div>
  </aside>
}

function MatchComparison({item, selected, aliases}: {item: ReconciliationItem; selected?: Suggestion; aliases?: Record<string,string>}) {
  const difference = selected && Math.abs(item.amountCents) - selected.amountCents
  return <>
    <div className="bb-reconcile-comparison" aria-label="Bank and budget comparison">
      <div><small>{item.amountCents<0?"Bank deposit":"Bank charge"}</small><strong>{money(item.amountCents)}</strong>
        <div className="bb-reconcile-compare-source"><ReconcileIcon title={item.merchant} aliases={aliases}/><span>{item.merchant}<small>{dateLabel(item.date)} · {item.accountLabel}</small></span></div>
      </div>
      <div data-budget data-matched={Boolean(selected)}><small>{item.status==="pending"&&selected?"Tentative entry":"Budget entry"}</small><strong>{selected?money(selected.amountCents):"—"}</strong>
        {selected ? <div className="bb-reconcile-compare-source"><ReconcileIcon title={selected.item} category={selected.category} aliases={aliases}/><span>{selected.item}<small>{dateLabel(selected.date)} · {selected.kind==="schedule" ? selected.recorded ? "Scheduled payment" : "Scheduled · not recorded in sheet" : selected.category}</small></span></div>
          : <small>{item.status==="checked"?"Match recorded":item.status==="ignored"?"Ignored for matching":item.suggestions.length?"Choose an entry":"No matching entry"}</small>}
      </div>
    </div>
    {selected && <p className="bb-reconcile-match-result" data-difference={Boolean(difference)}>{difference
      ? <><TriangleAlert size={14} aria-hidden="true"/>{`${difference > 0 ? "+" : "−"}${money(Math.abs(difference))} difference`}</>
      : <><CircleCheck size={14} aria-hidden="true"/>Amounts match</>}</p>}
  </>
}

function ReconcileIcon({title,category="",aliases}: {title:string;category?:string;aliases?:Record<string,string>}) {
  return <TransactionIcon entry={{item:title,location:title,category,amount:0,date:"",person:""}} aliases={aliases}/>
}

function ReviewChoices({ item, initialReview, disabled, pending, active, aliases, onCommand, onRejectAccess, revision, onScheduleError }: {
  item: ReconciliationItem; initialReview?: PreparedReview; disabled: boolean; pending: ReviewCommand | null; active: boolean
  aliases?: Record<string,string>; onCommand: (command: Command) => void; onRejectAccess: (message: string) => void
  revision: number; onScheduleError: (id: number, message: string) => void
}) {
  const recommended = recommendedFor(item)
  const initialSelection = initialReview?.suggestionId
    ? item.suggestions.find(s => s.id === initialReview.suggestionId)?.id ?? "" : recommended?.id ?? ""
  const [selectedId, setSelectedId] = useState(initialSelection)
  const [reviewAmount, setReviewAmount] = useState(initialReview?.intent === "amount" && Boolean(initialSelection))
  const showingAmount = useRef(false)
  showingAmount.current = active && reviewAmount
  const reportScheduleError = useCallback((id: number, message: string) => {
    if (!message || showingAmount.current) onScheduleError(id, message)
  }, [onScheduleError])
  const [logging, setLogging] = useState<"" | "edit" | "review">(initialReview?.intent === "log" ? "edit" : "")
  const [ignoring, setIgnoring] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>((): Record<string, string> => item.amountCents < 0
    ? { source: item.merchant, label: "" }
    : { category: "", item: item.merchant, location: item.merchant, person: item.logging?.paymentMethods.length === 1 ? item.logging.paymentMethods[0] : "" })
  const discardDraft = useCallback(() => {
    setLogging(""); setReviewAmount(false); setIgnoring(false); setChoosing(false); onScheduleError(item.id, "")
  }, [item.id, onScheduleError])
  useAppWorkStatus({ label: "Bank entry review", dirty: active && Boolean(logging || reviewAmount || ignoring), onDiscard: discardDraft })
  const selected = item.suggestions.find(entry => entry.id === selectedId)
  const shared = selected?.sharedAmount
  const editable = item.status === "needs_review" && !item.readOnly
  const preparingAmount = pending?.operation === "prepare" && pending.reviewIntent === "amount"
  const startReview = (intent: "amount" | "log") => {
    if (item.id < 0) onCommand({ operation: "prepare", id: item.id, version: item.stateVersion ?? item.version,
      reviewIntent: intent, ...(selectedId ? { suggestionId: selectedId } : {}) })
    else if (intent === "amount") setReviewAmount(true)
    else { setLogging("edit"); setReviewAmount(false) }
  }
  const send = (operation: "confirm" | "update_match") => onCommand({ operation, id: item.id, version: item.version, suggestionId: selectedId,
    ...(operation === "update_match" && shared && !("blocked" in shared) ? { sharedAmountToken: shared.token } : {}) })
  const readyToLog = item.amountCents < 0 ? Boolean(fields.source.trim()) : Boolean(fields.category && fields.item.trim() && fields.person)
  const detail = !logging && !reviewAmount && !ignoring && !choosing
  const entryTitle = item.amountCents < 0 ? "Add income" : "Add expense"
  const canLog = editable && item.logging?.allowed
  const canChoose = Boolean(item.suggestions.length && (!selected || item.suggestions.length > 1))
  const heading = ignoring ? "Ignore transaction" : choosing ? "Choose budget entry" : logging === "review" ? "Review new sheet entry" : logging ? entryTitle : reviewAmount ? "Review change" : item.status==="pending"?"Pending charge":["checked","ignored"].includes(item.status)?"Checked transaction":"Review match"
  return <EditorScenes scene={ignoring?"ignore":choosing?"choices":logging==="review"?"entry-review":logging?"entry":reviewAmount?"amount":"match"}>
    <div className="bb-reconcile-choices">
    <header className="bb-reconcile-detail-heading"><h2>{heading}</h2><div className="bb-reconcile-tools">
      {editable && detail && <button type="button" className="bb-reconcile-ignore" disabled={disabled} aria-label="Ignore transaction" onClick={()=>setIgnoring(true)}><EyeOff size={18} aria-hidden="true"/></button>}
    </div></header>
    {choosing ? <>
      <div className="bb-reconcile-choice-source"><ReconcileIcon title={item.merchant} aliases={aliases}/>
        <span><strong>{item.merchant}</strong><small>{dateLabel(item.date)} · {item.accountLabel}</small></span><strong>{money(item.amountCents)}</strong></div>
      <div className="bb-reconcile-candidates">{item.suggestions.map(suggestion => {
        const isSelected = selectedId === suggestion.id
        const Mark = isSelected ? CircleCheck : Circle
        return <button type="button" key={suggestion.id} className="bb-reconcile-choice" aria-pressed={isSelected} disabled={disabled}
          onClick={() => { setSelectedId(suggestion.id); setChoosing(false) }}>
          <span><strong>{suggestion.item}</strong><small>{dateLabel(suggestion.date)} · {suggestion.kind === "schedule" ? "Scheduled payment" : suggestion.category}</small></span>
          <span>{money(suggestion.amountCents)}</span><Mark size={16} aria-hidden="true" />
        </button>
      })}</div>
      <div className="bb-reconcile-form-actions"><button type="button" className="bb-reconcile-action" onClick={() => setChoosing(false)}>Back</button></div>
    </> : ignoring ? <><MatchComparison item={item} selected={selected} aliases={aliases}/>
      <div className="bb-reconcile-form-actions"><button type="button" className="bb-reconcile-action" disabled={disabled} onClick={()=>setIgnoring(false)}>Back</button>
        <SavingButton type="button" className="bb-reconcile-action bb-reconcile-danger" disabled={disabled} saving={pending?.operation==="ignore"}
          onClick={()=>onCommand({operation:"ignore",id:item.id,version:item.stateVersion??item.version})}>Ignore transaction</SavingButton></div></> : <>
    {!logging && <MatchComparison item={item} selected={selected} aliases={aliases}/>}
    {detail && (canChoose || canLog) && <div className="bb-reconcile-entry-actions">
      {canChoose && <button type="button" className="bb-reconcile-action bb-reconcile-outline" disabled={disabled} onClick={() => setChoosing(true)}>
        <ListChecks size={16} aria-hidden="true"/>Choose budget entry</button>}
      {canLog && <SavingButton type="button" className={`bb-reconcile-action ${selected ? "bb-reconcile-outline" : "bb-reconcile-primary"}`} disabled={disabled}
        saving={pending?.operation === "prepare" && pending.reviewIntent === "log"} onClick={() => startReview("log")}>
        <Plus size={16} aria-hidden="true"/>{entryTitle}</SavingButton>}
    </div>}
    {item.status === "pending" && <p className="bb-reconcile-muted">{selected?.amountMismatch ? "Wait for the payment to post before changing the logged amount." : "Tentative match · review after the bank posts it."}</p>}
    {editable && selected && !logging && <div className="bb-reconcile-decision">
      {selected.kind === "schedule" && (!selected.recorded || selected.amountCents !== Math.abs(item.amountCents)) ? item.logging?.allowed === false
        ? <p className="bb-reconcile-muted">Scheduled payment changes are available for the current month.</p>
        : reviewAmount ? <ScheduleAmountReview item={item} suggestion={selected} disabled={disabled} saving={pending?.operation === "update_schedule"} onCommand={onCommand}
          onCancel={() => { onScheduleError(item.id, ""); setReviewAmount(false) }} onRejectAccess={onRejectAccess} active={active} revision={revision} onScheduleError={reportScheduleError} />
        : <SavingButton type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled} saving={preparingAmount} onClick={() => startReview("amount")}>Review payment change</SavingButton>
      : shared && "blocked" in shared ? <p role="status" className="bb-reconcile-muted">{shared.blocked}</p>
      : selected.amountCents !== Math.abs(item.amountCents) || shared?.recovery ? reviewAmount ? <div className="bb-reconcile-confirm" role="group" aria-label="Review amount change">
        <strong>{shared?.recovery ? "Resume" : "Update"} {selected.item}?</strong>
        {shared && !("blocked" in shared) ? <SharedAmountReview plan={shared} /> : <>
          {selected.category === "Payment" && <p>The bank amount is the full bill. Any existing split method is preserved and its shares are recalculated. Existing repayment safeguards still apply.</p>}
          <p>Change its {selected.category === "Payment" ? "full bill" : "sheet"} amount from {money(selected.amountCents)} to {money(item.amountCents)}, then match this bank transaction. Its other details stay the same.</p></>}
        <SavingButton type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled} saving={pending?.operation === "update_match"} onClick={() => send("update_match")}>{shared?.recovery ? "Finish syncing & match" : "Update amount & match"}</SavingButton>
        <button type="button" className="bb-reconcile-action" disabled={disabled} onClick={() => setReviewAmount(false)}>Cancel amount change</button>
      </div> : <SavingButton type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled} saving={preparingAmount} onClick={() => startReview("amount")}>Review amount change</SavingButton>
      : selected.confirmable && <SavingButton type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled} saving={pending?.operation === "confirm"} onClick={() => send("confirm")}>Confirm match</SavingButton>}
    </div>}
    {canLog && logging && <form className="bb-reconcile-log" onSubmit={event => { event.preventDefault(); if (disabled || !readyToLog) return
        if (logging === "edit") setLogging("review")
        else onCommand({ operation: "log", id: item.id, version: item.stateVersion ?? item.version, fields }) }}>
        <p className="bb-reconcile-muted">{money(item.amountCents)} · {dateLabel(item.date)} · {item.amountCents < 0 ? "Income" : "Expense"} sheet</p>
        {logging === "edit" ? Object.entries(fields).map(([field, value]) => <label key={field}>
          {({ category: "Category", item: "Item", location: "Location (optional)", person: "Payment method", source: "Income source", label: "Note (optional)" } as Record<string, string>)[field]}
          {field === "category" || field === "person" ? <select value={value} required disabled={disabled} onChange={event => setFields(previous => ({ ...previous, [field]: event.target.value }))}>
            <option value="">Choose…</option>{(field === "category" ? item.logging!.categories : item.logging!.paymentMethods).map(option => <option key={option} value={option}>{option.replace(/_/g, " ")}</option>)}</select>
          : <input value={value} maxLength={200} required={field === "item" || field === "source"} disabled={disabled} onChange={event => setFields(previous => ({ ...previous, [field]: event.target.value }))} />}
        </label>) : <><dl>{Object.entries(fields).filter(([, value]) => value).map(([field, value]) => <div key={field}><dt>{field === "person" ? "Payment method" : field}</dt><dd>{value.replace(/_/g, " ")}</dd></div>)}</dl>
          <p>This creates one new entry in your budget sheet and matches this bank transaction. Only continue if it is not already recorded.</p>
          <button type="button" className="bb-reconcile-action" disabled={disabled} onClick={() => setLogging("edit")}>Edit entry</button></>}
        <div className="bb-reconcile-form-actions"><SavingButton type="submit" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled || !readyToLog} saving={pending?.operation === "log"}>{logging === "review" ? "Add entry & match" : "Review entry"}</SavingButton>
        <button type="button" className="bb-reconcile-action" disabled={disabled} onClick={() => setLogging("")}>Cancel new entry</button></div>
      </form>}
    {editable && item.logging && !item.logging.allowed && <p className="bb-reconcile-muted">{item.logging.reason}</p>}
    </>}
  </div></EditorScenes>
}

function SharedAmountReview({ plan }: { plan: SharedAmountPlan }) {
  const method = { income: "By income", equal: "50/50", fronted: "Fronted", custom: "Custom" }[plan.method]
  return <>
    <p>{plan.recovery ? "The amount correction is saved. Finish syncing its sheets, then match the full bank transaction." : "Update the full purchase amount and match this bank transaction."}</p>
    <p className="bb-reconcile-muted">Keep {method} split</p>
    <dl className="bb-reconcile-share-review">
      <div><dt>Full purchase</dt><dd>{money(plan.previousGrossCents)} → <strong>{money(plan.grossCents)}</strong></dd></div>
      <div><dt>{plan.payer}’s share</dt><dd>{money(plan.previousPayerShareCents)} → <strong>{money(plan.payerShareCents)}</strong></dd></div>
      <div><dt>{plan.partner}’s share</dt><dd>{money(plan.previousPartnerShareCents)} → <strong>{money(plan.partnerShareCents)}</strong></dd></div>
      <div><dt>Already received · kept</dt><dd>{money(plan.receivedCents)}</dd></div>
      <div><dt>{plan.partner} still owes</dt><dd><strong>{money(plan.remainingCents)}</strong></dd></div>
    </dl>
    <p className="bb-reconcile-muted">This records no additional repayment. Received money stays unchanged.</p>
  </>
}
interface BillSharing {
  method: string; label: string; canChoose: boolean; payer: string; partner: string
  payerShareCents: number; partnerShareCents: number; budgetAmountCents: number; settledCents: number; oldGrossCents: number | null
}
interface ScheduleChange {
  sharing?: BillSharing | null
  version: string; fingerprint: string; name: string; kind: "bill" | "subscription"
  oldAmountCents: number; newAmountCents: number; scheduleAmountCents?: number | null; futureAmountCents?: number | null; description: string; canUpdateFuture: boolean; updateFuture: boolean
}
function ScheduleAmountReview({ item, suggestion, disabled, saving, onCommand, onCancel, onRejectAccess, active, revision, onScheduleError }: {
  item: ReconciliationItem; suggestion: Suggestion; disabled: boolean; saving: boolean; onCommand: (command: Command) => void
  onCancel: () => void; onRejectAccess: (message: string) => void; active: boolean; revision: number
  onScheduleError: (id: number, message: string) => void
}) {
  const [future, setFuture] = useState(false)
  const [splitMethod, setSplitMethod] = useState("income")
  const [plan, setPlan] = useState<ScheduleChange | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState("")
  useAppWorkStatus({ label: "Scheduled payment preview", pending: active && loading })
  useEffect(() => {
    if (!active || !error) return
    onScheduleError(item.id, error)
    return () => onScheduleError(item.id, "")
  }, [active, error, item.id, onScheduleError])
  useEffect(() => {
    if (!active) return
    const abort = new AbortController(); let live = true
    setLoading(true); setError("")
    const query = `version=${encodeURIComponent(item.version)}&suggestionId=${encodeURIComponent(suggestion.id)}&future=${future ? "1" : "0"}&splitMethod=${splitMethod}`
    void request(`${endpoint}/${item.id}/schedule?${query}`, abort).then(value => {
      const change = (value as { change?: ScheduleChange })?.change
      if (!change || !isText(change.version) || !isText(change.fingerprint) || change.fingerprint.length !== 64
        || !isText(change.name) || !isText(change.description, 500) || !["bill", "subscription"].includes(change.kind)
        || !isAmount(change.oldAmountCents) || !isAmount(change.newAmountCents) || change.newAmountCents !== Math.abs(item.amountCents)
        || (change.scheduleAmountCents !== undefined && change.scheduleAmountCents !== null && !isAmount(change.scheduleAmountCents))
        || (change.futureAmountCents !== undefined && change.futureAmountCents !== null && !isAmount(change.futureAmountCents))
        || (change.sharing != null && (!["income", "equal", "fronted", "none"].includes(change.sharing.method)
          || !isText(change.sharing.payer) || !isText(change.sharing.partner) || !isText(change.sharing.label)
          || typeof change.sharing.canChoose !== "boolean"
          || ![change.sharing.payerShareCents, change.sharing.partnerShareCents, change.sharing.budgetAmountCents, change.sharing.settledCents].every(isAmount)
          || change.sharing.payerShareCents + change.sharing.partnerShareCents !== change.newAmountCents))
        || typeof change.canUpdateFuture !== "boolean" || change.updateFuture !== future) throw new Error("Couldn’t read the scheduled payment review.")
      if (live) setPlan(change)
    }).catch(failure => { if (live) {
      if (failure instanceof ReviewRequestError && [401, 403].includes(failure.status)) onRejectAccess(failure.message)
      else setError(failure instanceof Error ? failure.message : "Couldn’t prepare the payment change.")
    } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false; abort.abort() }
  }, [item.id, item.version, suggestion.id, future, splitMethod, onRejectAccess, revision, active])
  return <div className="bb-reconcile-confirm" role="group" aria-label="Review scheduled payment change">
    <strong>Update {suggestion.item}?</strong>
    {loading && <ReportLoading label="Preparing payment change…"/>}
    {plan && !error && <>{plan.sharing ? <>
      <p>Full {plan.name} bill from the bank: <strong>{money(plan.newAmountCents)}</strong>.</p>
      {plan.sharing.oldGrossCents != null && <p>Previously logged full bill: {money(plan.sharing.oldGrossCents)}.</p>}
      {plan.sharing.canChoose ? <label className="bb-reconcile-split">Split this bill<select aria-label="Split this bill" value={splitMethod} disabled={disabled || loading} onChange={event => setSplitMethod(event.target.value)}>
        <option value="income">By income</option><option value="equal">50/50</option><option value="none">No split</option>
      </select></label> : <p>Keep existing split: {plan.sharing.label}.</p>}
      <p>{plan.sharing.payer}’s share: <strong>{money(plan.sharing.payerShareCents)}</strong><br />{plan.sharing.partner}’s share: <strong>{money(plan.sharing.partnerShareCents)}</strong></p>
      <p>Budget payment: {money(plan.oldAmountCents)} → {money(plan.sharing.budgetAmountCents)}. {plan.sharing.method !== "none" && (plan.sharing.settledCents ? `${money(plan.sharing.settledCents)} already received is preserved.` : `The full cash payment stays in your budget until ${plan.sharing.partner}’s repayment is confirmed in Shared.`)}</p>
      <p>Matching this bank transaction does not mark a repayment received.</p>
    </> : <p>Change {plan.name} from {money(plan.oldAmountCents)} to {money(plan.newAmountCents)}, then match this bank transaction.</p>}
      {typeof plan.scheduleAmountCents === "number" && plan.scheduleAmountCents !== plan.oldAmountCents && <p>The schedule currently uses {money(plan.scheduleAmountCents)}. Both the source and schedule will use {money(plan.newAmountCents)}.</p>}
      <p>{plan.description}</p>
      {plan.updateFuture && <p>Future full-bill estimate: {typeof plan.futureAmountCents === "number" ? money(plan.futureAmountCents) : "Not set"} → {money(plan.newAmountCents)}</p>}
      {plan.canUpdateFuture && <label className="bb-reconcile-future"><input type="checkbox" checked={future} disabled={disabled || loading} onChange={event => setFuture(event.target.checked)} />Also update the future bill estimate</label>}
      <SavingButton type="button" className="bb-reconcile-action bb-reconcile-primary" disabled={disabled || loading} saving={saving} onClick={() => onCommand({
        operation: "update_schedule", id: item.id, version: plan.version, suggestionId: suggestion.id, scheduleVersion: plan.fingerprint, updateFuture: future, splitMethod,
      })}>Update scheduled payment &amp; match</SavingButton></>}
    <button type="button" className="bb-reconcile-action" disabled={disabled} onClick={onCancel}>Cancel payment change</button>
  </div>
}
function TransactionRow({ item, open, wide, aliases, onToggle, children, disabled }: { item: ReconciliationItem; open: boolean; wide:boolean; aliases?:Record<string,string>; onToggle: () => void; children: React.ReactNode; disabled?: boolean }) {
  const id = useId()
  return <article className="bb-reconcile-row" data-open={open}>
    <button type="button" className="bb-reconcile-row-toggle" disabled={disabled} aria-expanded={open} aria-controls={wide?undefined:id} onClick={onToggle}>
      <ReconcileIcon title={item.merchant} aliases={aliases}/><span className="bb-reconcile-row-label"><strong>{item.merchant || "Bank transaction"}</strong><small>{dateLabel(item.date)} · {item.accountLabel}</small></span>
      <span className="bb-reconcile-row-amount"><strong>{money(item.amountCents)}</strong><small>{statusLabel(item.status)}</small></span><ChevronDown className="bb-reconcile-chevron" size={16} aria-hidden="true" />
    </button>{!wide && <div id={id}><EditorExpansion open={open}><div className="bb-reconcile-inline">{children}</div></EditorExpansion></div>}
  </article>
}
