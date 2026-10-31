import { useLayoutEffect, type CSSProperties, type ReactNode, type RefObject } from "react"

// Tune the maximum time between the first and last stem launch here.
export const CATEGORY_CALLOUT_CASCADE_MS = 240

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

export function useCategoryCalloutFireworks(ref: RefObject<SVGSVGElement | null>, active: boolean, identity: string) {
  useLayoutEffect(() => {
    const svg = ref.current
    if (!svg) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const nodes = [...svg.querySelectorAll<SVGElement>(".bb-contour-stem, .bb-contour-label")]
    const delay = active ? createCategoryCalloutCascade([...svg.querySelectorAll<SVGElement>(".bb-contour-label")].map(node => node.dataset.category!)) : new Map<string, number>()
    // Batch reads before writes. Cleanup freezes an interrupted animation into
    // inline styles, so reversing starts from the currently painted frame.
    const snapshots = nodes.map(node => {
      const style = getComputedStyle(node)
      return { opacity: style.opacity, transform: style.transform, strokeDashoffset: style.strokeDashoffset }
    })
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
        ] : [{ opacity: from.opacity, transform: from.transform }, to]
      const animation = node.animate(frames, {
        duration: active ? stem ? 170 : 320 : 160,
        delay: active ? (delay.get(node.dataset.category!) ?? 0) + (stem ? 0 : 110) : 0,
        easing: !active ? "ease-out" : stem ? "cubic-bezier(.12,.8,.2,1)" : "linear", fill: "both",
      })
      animations.push({ node, animation, stem })
    })
    const finish = () => { if (media.matches) for (const { animation } of animations) animation.finish() }
    media.addEventListener("change", finish)
    return () => {
      const current = animations.map(({ node, stem }) => {
        if (!node.isConnected) return null
        const style = getComputedStyle(node)
        return stem ? { opacity: style.opacity, strokeDashoffset: style.strokeDashoffset } : { opacity: style.opacity, transform: style.transform }
      })
      animations.forEach(({ node, animation }, i) => { if (current[i]) Object.assign(node.style, current[i]); animation.cancel() })
      media.removeEventListener("change", finish)
    }
  }, [ref, active, identity])
}
