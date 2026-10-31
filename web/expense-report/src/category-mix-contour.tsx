import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { CATEGORY_CALLOUT_CASCADE_MS, CATEGORY_RING_DURATION_MS, CATEGORY_RING_REVEAL_MS, useCategoryCalloutFireworks } from "./category-mix-motion"
import layoutWorkerUrl from "./category-mix-layout.worker.ts?worker&url"
import { CONTOUR_STYLE, contourLabel, prepareContourScene, type ContourScene } from "./category-mix-layout"
import type { BreakdownItem } from "./types"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
let context: CanvasRenderingContext2D | null | undefined

export function prepareCategoryContour(data: BreakdownItem[], width: number, height: number, fontFamily = typeof document !== "undefined" && document.body ? window.getComputedStyle(document.body).fontFamily : "system-ui, sans-serif") {
  const labelSize = width < 330 ? Math.min(11.5, CONTOUR_STYLE.labelSize) : CONTOUR_STYLE.labelSize
  if (context === undefined) context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d")
  const measure = (text: string, weight: number) => {
    if (!context) return text.length * labelSize * .62
    context.font = `${weight} ${labelSize}px ${fontFamily}`
    return context.measureText(text).width
  }
  return prepareContourScene(data.map(item => {
    const name = contourLabel(item.key, item.label), amountLabel = `${money.format(item.amount)} / ${percent.format(item.percentage)}%`
    // SVG uses tabular figures; canvas measures proportional figures by default.
    // Measure zeroes to reserve the full width of the displayed numeric row.
    return { id: item.key, name, amount: item.amount, amountLabel, width: Math.ceil(Math.max(measure(name, 400), measure(amountLabel.replace(/\d/g, "0"), 500)) + CONTOUR_STYLE.sidePadding * 2) }
  }), width, height)
}

export function useCategoryContour(data: BreakdownItem[], size: {width: number; height: number}, showCallouts = false) {
  const cache = useRef(new Map<string, ContourScene>()).current
  const width = Math.max(240, size.width || 360), height = Math.max(200, size.height || 396)
  const key = JSON.stringify([width, height, data.map(item => [item.key, item.label, item.amount, item.percentage])])
  const prepared = useMemo(() => prepareCategoryContour(data, width, height), [key])
  const [result, setResult] = useState<{key: string; scene: ContourScene} | null>(null)
  const cached = cache.get(key)
  // Each new target gets its own identity, including a reversal back to the
  // last settled view. Its old readiness cannot launch stems during a new morph.
  const committedTarget = useRef({key, showCallouts})
  const motionTarget = useMemo(() => ({key, showCallouts, spring: committedTarget.current.key === key && committedTarget.current.showCallouts !== showCallouts}), [key, showCallouts])
  useLayoutEffect(() => { committedTarget.current = motionTarget }, [motionTarget])
  const [settledTarget, setSettledTarget] = useState(motionTarget)
  useEffect(() => {
    if (settledTarget === motionTarget) return
    // Geometry-only toggles arrive quickly and retain a small spring tail.
    // Data/angle changes still need their original full 520ms settlement.
    const reduced = typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) { setSettledTarget(motionTarget); return }
    const timer = window.setTimeout(() => setSettledTarget(motionTarget), motionTarget.spring ? CATEGORY_RING_REVEAL_MS : 520)
    return () => window.clearTimeout(timer)
  }, [motionTarget])
  useEffect(() => {
    if (cache.has(key) || !size.width || !size.height) return
    let active = true
    // An explicit same-origin asset works in both the installed app and inline
    // shared reports. The hashed name updates with the deployed frontend.
    const filename = layoutWorkerUrl.split("/").pop()!
    let worker: Worker
    try { worker = new Worker(`/app/assets/${filename}`, {type: "module"}) }
    catch { return }
    worker.onmessage = (event: MessageEvent<{scene: ContourScene | null}>) => {
      const scene = event.data.scene
      worker.terminate()
      if (!active || !scene || !scene.routes || scene.curvedRoutes?.some(route => route.smoothing === "unresolved")) return
      if (cache.size >= 24) cache.delete(cache.keys().next().value!)
      cache.set(key, scene)
      setResult({key, scene})
    }
    worker.onerror = () => worker.terminate()
    worker.postMessage(prepared)
    return () => { active = false; worker.terminate() }
  }, [key, prepared, size.width, size.height])
  const scene = cached ?? (result?.key === key ? result.scene : prepared)
  const radius = Math.max(54, Math.min(width, height) / 2 - 36)
  const cy = Math.max(radius, Math.min(height - radius, height / 2 - 16))
  return useMemo(() => ({
    cx: showCallouts ? scene.cx : width / 2, cy: showCallouts ? scene.cy : cy,
    outerRadius: showCallouts ? scene.radius : radius,
    innerRadius: showCallouts ? scene.inner : Math.max(8, radius - 48),
    margin: {top: 0, right: 0, bottom: 0, left: 0}, containerPadding: scene.style.inset,
    showLabels: false, contour: scene, contourKey: key, calloutsReady: settledTarget === motionTarget,
    spring: motionTarget.spring, animationDuration: motionTarget.spring ? CATEGORY_RING_DURATION_MS : 520,
  }), [scene, key, settledTarget, motionTarget, showCallouts])
}

export function CategoryContourCallouts({scene, data, ready, visible, onInspect, onExitComplete}: {scene: ContourScene; data: BreakdownItem[]; ready: boolean; visible: boolean; onInspect: (item: BreakdownItem) => void; onExitComplete?: () => void}) {
  const ref = useRef<SVGSVGElement>(null)
  const active = visible && ready && Boolean(scene.routes)
  useCategoryCalloutFireworks(ref, active, JSON.stringify(scene.items.map(item => item.id)), onExitComplete)
  const colors = new Map(data.map(item => [item.key, item.color]))
  return (
    <svg ref={ref} className="bb-contour-callouts" viewBox={`0 0 ${scene.width} ${scene.height}`} width={scene.width} height={scene.height} aria-hidden={!active} data-visible={visible} data-ready={ready && Boolean(scene.routes)} data-cascade-window={CATEGORY_CALLOUT_CASCADE_MS}>
      {scene.curvedRoutes?.map(route => <path key={route.id} className="bb-contour-stem" pathLength={1} data-category={route.id} data-anchor={route.edge} d={route.d} stroke={colors.get(route.id)} />)}
      {scene.routes ? scene.items.map(item => {
        const top = item.y - item.height / 2, x = item.x + item.width / 2
        const route = scene.routes?.find(route => route.id === item.id), end = route?.points[route.points.length - 1]
        const target = data.find(row => row.key === item.id)!
        const [amount, share] = item.amountLabel.split(" / ")
        const distance = Math.max(1, Math.hypot(scene.cx - x, scene.cy - item.y))
        return <g key={item.id} className="bb-contour-label" data-category={item.id} role="button" tabIndex={active ? 0 : -1}
          style={{ transformOrigin: `${x}px ${item.y}px`, "--bb-contour-from-x": `${(scene.cx - x) / distance * 10}px`, "--bb-contour-from-y": `${(scene.cy - item.y) / distance * 10}px` } as CSSProperties}
          aria-label={`Inspect ${target.label}, ${money.format(target.amount)}, ${percent.format(target.percentage)}% of ring`}
          onFocus={event => { event.currentTarget.getAnimations().forEach(animation => animation.finish()) }}
          onClick={() => onInspect(target)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onInspect(target) } }}>
          <rect x={item.x} y={top} width={item.width} height={item.height} rx={Math.min(scene.style.calloutRadius, item.height / 2)} />
          <text className="bb-contour-name" textAnchor="middle" x={x} y={top + item.padding + scene.style.labelSize} fontSize={scene.style.labelSize} fill={item.id === "left" ? undefined : colors.get(item.id)}>{item.name}</text>
          <text className="bb-contour-amount" textAnchor="middle" x={x} y={top + item.padding + 2 * item.lineHeight - 1} fontSize={item.valueSize}><tspan>{amount}</tspan><tspan className="bb-contour-percent">{` / ${share}`}</tspan></text>
          {end ? <circle cx={end[0]} cy={end[1]} r={1.6} fill={colors.get(item.id)} /> : null}
        </g>
      }) : null}
    </svg>
  )
}
