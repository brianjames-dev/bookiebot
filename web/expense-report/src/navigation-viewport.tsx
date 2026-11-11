import { type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"

// Keep this viewport layer outside the page whose grid/clipping changes on a
// fold. The layer stays mounted; only the dock's transient contact state resets.
export function NavigationViewport({ enabled, landscape, overlay, rail, children }: {
  enabled: boolean
  landscape: boolean
  overlay: number
  rail: number
  children: ReactNode
}) {
  if (!enabled || typeof document === "undefined") return children
  return createPortal(<div className="bb-app-shell bb-navigation-viewport k-ios"
    data-duo-landscape={landscape || undefined}
    style={{ "--bb-duo-overlay": `${overlay}px`, "--bb-duo-right-rail": `${rail}px` } as CSSProperties}>
    {children}
  </div>, document.body)
}
