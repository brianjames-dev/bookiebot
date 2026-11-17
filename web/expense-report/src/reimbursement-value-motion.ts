import { useEffect, useRef, useState } from "react"
import type { LedgerAllocation } from "./reimbursement-ledger"
import { transactionMotion } from "./transaction-inline-editor"
import type { ChangePlan } from "./transaction-value-motion"
import { splitMoney } from "./transaction-split-model"

export const reimbursementMethod = (item: LedgerAllocation) => item.method === "income" ? "By income" : item.method === "equal" ? "50/50" : item.method === "fronted" ? "Fronted" : "Custom split"
export const reimbursementMotionKey = (id: string) => `shared:${id}:`
function values(item: LedgerAllocation, incoming: boolean) {
  const key = reimbursementMotionKey(item.id)
  return { [key + "remaining"]: splitMoney(item.outstandingCents || item.partnerShareCents), [key + "you"]: splitMoney(incoming ? item.payerShareCents : item.partnerShareCents),
    [key + "partner"]: splitMoney(incoming ? item.partnerShareCents : item.payerShareCents), [key + "method"]: reimbursementMethod(item) }
}

/** Return to details first, then use Transactions' actual rolls/strikes. */
export function useReimbursementValueMotion(item: LedgerAllocation, open: boolean, incoming: boolean) {
  const [shown, setShown] = useState(item), previous = useRef(item), [plan, setPlan] = useState<ChangePlan | null>(null)
  const sequence = useRef(0)
  useEffect(() => {
    const before = previous.current
    // A post-save/foreground read of this same revision must not interrupt
    // feedback already rolling on screen.
    if (before.id === item.id && before.version === item.version) {
      previous.current = item; setShown(item)
      if (!open) setPlan(null)
      return
    }
    const changedSplit = before.payerShareCents !== item.payerShareCents || before.partnerShareCents !== item.partnerShareCents || before.method !== item.method
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    const apply = () => {
      previous.current = item; setShown(item)
      setPlan(open && changedSplit && !reduced ? { token: ++sequence.current, from: values(before, incoming), to: values(item, incoming),
        fromColors: {}, toColors: {}, timing: transactionMotion, promises: new Set() } : null)
    }
    if (!open || !changedSplit || reduced) { apply(); return }
    const timer = window.setTimeout(apply, transactionMotion.duration + 220)
    return () => window.clearTimeout(timer)
  }, [item, open, incoming])
  useEffect(() => {
    if (!plan) return
    let live = true
    const frame = requestAnimationFrame(() => { void (async () => {
      for (;;) { const work = [...plan.promises]; await Promise.allSettled(work); if (!live) return
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        if ([...plan.promises].every(promise => work.includes(promise))) break
      }
      if (live) setPlan(null)
    })() })
    return () => { live = false; cancelAnimationFrame(frame) }
  }, [plan])
  return { shown, plan }
}
