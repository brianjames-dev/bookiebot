import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { amountAppearanceKey, DEFAULT_AMOUNT_APPEARANCE, loadRaisedCents, saveRaisedCents } from "./amount-typography"
import { FittedAmount } from "./components/ui/fitted-amount"

type AppearanceContext = { raisedCents: boolean; toggle: () => void }
const AmountAppearanceContext = createContext<AppearanceContext | null>(null)

function AmountAppearanceProvider({owner, enabled, children}: {owner: string; enabled: boolean; children: ReactNode}) {
  const key = amountAppearanceKey(owner)
  const initial = useMemo(() => enabled ? loadRaisedCents(owner) : true, [key, enabled])
  const [choices, setChoices] = useState<Record<string, boolean>>({})
  const raisedCents = choices[key] ?? initial
  useEffect(() => {
    if (!enabled) return
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setChoices(current => ({...current, [key]: loadRaisedCents(owner)}))
    }
    window.addEventListener("storage", changed)
    return () => window.removeEventListener("storage", changed)
  }, [key, enabled])
  const context = useMemo(() => ({ raisedCents, toggle() {
    const updated = !raisedCents
    setChoices(current => ({...current, [key]: updated}))
    if (enabled) saveRaisedCents(owner, updated)
  } }), [raisedCents, key, enabled])
  return <AmountAppearanceContext.Provider value={context}>{children}</AmountAppearanceContext.Provider>
}

/** App chrome and report share one preference, including while the report month remounts. */
export function AmountAppearanceBoundary({owner, enabled = true, children}: {owner: string; enabled?: boolean; children: ReactNode}) {
  const existing = useContext(AmountAppearanceContext)
  return existing ? children : <AmountAppearanceProvider owner={owner} enabled={enabled}>{children}</AmountAppearanceProvider>
}

export function MetricAmount({children, className, intrinsic = false}: {children: string; className: string; intrinsic?: boolean}) {
  const context = useContext(AmountAppearanceContext)
  return <FittedAmount className={className} intrinsic={intrinsic} appearance={(context?.raisedCents ?? true) ? DEFAULT_AMOUNT_APPEARANCE : undefined}>{children}</FittedAmount>
}

export function AmountAppearanceSettings() {
  const context = useContext(AmountAppearanceContext)
  if (!context) return null
  return <div className="bb-setting-row"><span>Raised cents</span><button type="button" className="bb-setting-switch" role="switch" aria-label="Raised cents" aria-checked={context.raisedCents} onClick={context.toggle}><span /></button></div>
}
