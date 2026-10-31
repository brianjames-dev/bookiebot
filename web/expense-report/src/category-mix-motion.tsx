import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react"

// Tune the maximum time between the first and last stem launch here.
export const CATEGORY_CALLOUT_CASCADE_MS = 240
export const CATEGORY_RING_DURATION_MS = 320
export const CATEGORY_RING_REVEAL_MS = 200

// A lightly underdamped settle: fast arrival, about 3% overshoot, exact endpoints.
// Recharts owns this clock, including snapshots when a gesture reverses it.
export function categoryRingSpring(t: number) {
  if (t <= 0 || t >= 1) return Math.max(0, Math.min(1, t))
  return 1 - Math.exp(-9 * t) * (Math.cos(8 * t) + 9 / 8 * Math.sin(8 * t))
}

type RingGeometry = { cx: number; cy: number; innerRadius: number; outerRadius: number }
type CenterStyle = CSSProperties & { "--bb-category-center-number-size": string }

export function categoryCenterStyle({ cx, cy, innerRadius, outerRadius }: RingGeometry): CenterStyle {
  const full = Math.max(0, Math.min(1, (outerRadius - innerRadius - 26) / 22))
  const number = 24 + 6 * full, caption = 11 + full, gap = 4 * full
  return {
    left: cx, top: cy, width: innerRadius * 1.7,
    height: number * 1.1 + caption * 1.5 + gap + 16,
    fontSize: caption, gap, "--bb-category-center-number-size": `${number}px`,
  }
}

// Reuse the geometry that actually paints the first sector. A second CSS clock
// can otherwise move or resize the HTML label before Recharts paints its ring.
export function CategoryRingCenterSync({ geometry, centerRef, children }: {
  geometry: RingGeometry; centerRef: RefObject<HTMLButtonElement | null>; children: ReactNode
}) {
  const { cx, cy, innerRadius, outerRadius } = geometry
  useLayoutEffect(() => {
    const center = centerRef.current
    if (!center) return
    const style = categoryCenterStyle({ cx, cy, innerRadius, outerRadius })
    for (const key of ["left", "top", "width", "height", "fontSize", "gap"] as const) center.style[key] = `${style[key]}px`
    center.style.setProperty("--bb-category-center-number-size", style["--bb-category-center-number-size"])
  }, [centerRef, cx, cy, innerRadius, outerRadius])
  return children
}

export function createCategoryCalloutCascade(ids: string[], windowMs = CATEGORY_CALLOUT_CASCADE_MS, random = Math.random) {
  const order = [...new Set(ids)], span = Number.isFinite(windowMs) ? Math.max(0, windowMs) : CATEGORY_CALLOUT_CASCADE_MS
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  const times = order.map((_, i) => !i ? 0 : i === order.length - 1 ? span : random() * span).sort((a, b) => a - b)
  return new Map(order.map((id, i) => [id, times[i]]))
}

export function useCategoryCalloutFireworks(ref: RefObject<SVGSVGElement | null>, active: boolean, identity: string, onExitComplete?: () => void) {
  const cascade = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const svg = ref.current
    if (!svg) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const nodes = [...svg.querySelectorAll<SVGElement>(".bb-contour-stem, .bb-contour-label")]
    if (active) cascade.current = createCategoryCalloutCascade([...svg.querySelectorAll<SVGElement>(".bb-contour-label")].map(node => node.dataset.category!))
    const delay = cascade.current
    // Batch reads before writes. Cleanup freezes an interrupted animation into
    // inline styles, so reversing starts from the currently painted frame.
    const snapshots = nodes.map(node => {
      const style = getComputedStyle(node)
      return { opacity: style.opacity, transform: style.transform, strokeDashoffset: style.strokeDashoffset }
    })
    const lastVisibleLaunch = Math.max(0, ...nodes.flatMap((node, i) => Number(snapshots[i].opacity) > 0 ? [delay.get(node.dataset.category!) ?? 0] : []))
    svg.style.opacity = active || snapshots.some(frame => Number(frame.opacity) > 0) ? "1" : "0"
    const animations: { node: SVGElement; animation: Animation; stem: boolean }[] = []
    nodes.forEach((node, i) => {
      const stem = node.classList.contains("bb-contour-stem"), from = snapshots[i]
      const hidden = `translate(${node.style.getPropertyValue("--bb-contour-from-x") || "0px"}, ${node.style.getPropertyValue("--bb-contour-from-y") || "0px"}) scale(.01)`
      const to = stem ? { opacity: active ? ".65" : "0", strokeDashoffset: active ? "0" : "1" }
        : { opacity: active ? "1" : "0", transform: active ? "translate(0px, 0px) scale(1)" : hidden }
      Object.assign(node.style, to)
      if (media.matches || (!active && Number(from.opacity) === 0)) return
      const frames: Keyframe[] = stem ? [{ opacity: from.opacity, strokeDashoffset: from.strokeDashoffset }, to]
        : active ? [
          { opacity: from.opacity, transform: Number(from.opacity) === 0 ? hidden : from.transform, offset: 0, easing: "cubic-bezier(.12,.8,.2,1)" },
          { opacity: 1, transform: "translate(0px, 0px) scale(1.055)", offset: .72, easing: "ease-out" },
          to,
        ] : Number(from.opacity) > .95 ? [
          { opacity: from.opacity, transform: from.transform, offset: 0, easing: "ease-out" },
          { opacity: 1, transform: "translate(0px, 0px) scale(1.035)", offset: .16, easing: "cubic-bezier(.55,0,.9,.35)" },
          to,
        ] : [{ opacity: from.opacity, transform: from.transform }, to]
      const animation = node.animate(frames, {
        duration: stem ? 170 : active ? 320 : 200,
        delay: active ? (delay.get(node.dataset.category!) ?? 0) + (stem ? 0 : 110)
          : Math.max(0, lastVisibleLaunch - (delay.get(node.dataset.category!) ?? 0)) + (stem ? 60 : 0),
        easing: stem ? active ? "cubic-bezier(.12,.8,.2,1)" : "cubic-bezier(.8,0,.88,.2)" : "linear", fill: "both",
      })
      animations.push({ node, animation, stem })
    })
    const finish = () => { if (media.matches) for (const { animation } of animations) animation.finish() }
    media.addEventListener("change", finish)
    let disposed = false
    // Keep the compact ring and SVG present until every visible pair retracts.
    // Cancellation rejects finished; an interrupted exit must never grow the ring.
    const complete = () => {
      if (!active && !disposed) { svg.style.opacity = "0"; onExitComplete?.() }
    }
    if (animations.length) Promise.all(animations.map(({ animation }) => animation.finished)).then(complete, () => {})
    else complete()
    return () => {
      disposed = true
      const current = animations.map(({ node, stem }) => {
        if (!node.isConnected) return null
        const style = getComputedStyle(node)
        return stem ? { opacity: style.opacity, strokeDashoffset: style.strokeDashoffset } : { opacity: style.opacity, transform: style.transform }
      })
      animations.forEach(({ node, animation }, i) => { if (current[i]) Object.assign(node.style, current[i]); animation.cancel() })
      media.removeEventListener("change", finish)
    }
  }, [ref, active, identity, onExitComplete])
}
