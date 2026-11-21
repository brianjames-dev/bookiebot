import type { ReactNode } from "react"
import { ArrowDownLeft, ArrowUpRight } from "lucide-react"
import { splitMoney } from "./transaction-split-model"

export function RepaymentDirectionIcon({ incoming }: { incoming: boolean }) {
  const Icon = incoming ? ArrowUpRight : ArrowDownLeft
  return <Icon aria-hidden="true"/>
}

/** The same allocation bar, initials and shares in Transactions and Shared. */
export function RepaymentAllocation({ payerName, partnerName, payerCents, partnerCents, incoming, method, locked = false, renderAmount = splitMoney }: {
  payerName: string; partnerName: string; payerCents: number; partnerCents: number; incoming: boolean; method: ReactNode
  renderAmount?: (cents: number, side: string) => ReactNode
  locked?: boolean
}) {
  const yourShare = incoming ? payerCents : partnerCents, otherShare = incoming ? partnerCents : payerCents
  return <section className="rp-allocation" aria-label="Purchase allocation"><div className="rp-split-heading"><span>Purchase split</span><span>{method}</span></div>
    <div className="rp-split-track" role="img" aria-label={`${payerName}'s share ${splitMoney(payerCents)}; ${partnerName}'s share ${splitMoney(partnerCents)}`}>
      <span data-person="you" style={{ flex: yourShare, display: yourShare || locked ? "block" : "none" }}/><span data-person="partner" style={{ flex: otherShare, display: otherShare || locked ? "block" : "none" }}/>
    </div>
    <div className="rp-shares">{[[incoming ? payerName : partnerName, yourShare, "you"], [incoming ? partnerName : payerName, otherShare, "partner"]].map(([name, amount, side]) => <div className="rp-share" key={side}>
      <span className="rp-avatar" data-person={side} aria-hidden="true">{String(name)[0]}</span><div><span>{name}{side === "you" ? " (You)" : ""}</span><strong>{renderAmount(Number(amount), String(side))}</strong></div>
    </div>)}</div>
  </section>
}
