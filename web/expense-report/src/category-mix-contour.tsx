import { useEffect, useMemo, useRef, useState } from "react"
import layoutWorkerUrl from "./category-mix-layout.worker.ts?worker&url"
import { CONTOUR_STYLE, contourLabel, prepareContourScene, type ContourScene } from "./category-mix-layout"
import type { BreakdownItem } from "./types"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
let context: CanvasRenderingContext2D | null | undefined

export function prepareCategoryContour(data: BreakdownItem[], width: number, height: number, fontFamily = "Inter, ui-sans-serif, system-ui, sans-serif") {
  const labelSize = width < 330 ? 11.5 : CONTOUR_STYLE.labelSize
  if (context === undefined) context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d")
  const measure = (text: string, weight: number) => {
    if (!context) return text.length * labelSize * .62
    context.font = `${weight} ${labelSize}px ${fontFamily}`
    return context.measureText(text).width
  }
  return prepareContourScene(data.map(item => {
    const name = contourLabel(item.key, item.label), amountLabel = money.format(item.amount)
    return { id: item.key, name, amount: item.amount, amountLabel, width: Math.ceil(Math.max(measure(name, 400), measure(amountLabel, 500)) + CONTOUR_STYLE.sidePadding * 2) }
  }), width, height)
}

export function useCategoryContour(data: BreakdownItem[], size: {width: number; height: number}) {
  const cache = useRef(new Map<string, ContourScene>()).current
  const width = Math.max(240, size.width || 360), height = Math.max(200, size.height || 396)
  const key = JSON.stringify([width, height, data.map(item => [item.key, item.label, item.amount])])
  const prepared = useMemo(() => prepareCategoryContour(data, width, height), [key])
  const [result, setResult] = useState<{key: string; scene: ContourScene} | null>(null)
  const cached = cache.get(key)
  const [settledKey, setSettledKey] = useState(key)
  useEffect(() => {
    if (settledKey === key) return
    // Callouts describe final slice angles. Let the existing 520ms sector
    // morph finish before revealing them, including instant cache hits.
    const reduced = typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) { setSettledKey(key); return }
    const timer = window.setTimeout(() => setSettledKey(key), 520)
    return () => window.clearTimeout(timer)
  }, [key])
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
  return useMemo(() => ({
    cx: scene.cx, cy: scene.cy, outerRadius: scene.radius, innerRadius: scene.inner,
    margin: {top: 0, right: 0, bottom: 0, left: 0}, containerPadding: scene.style.inset,
    showLabels: false, contour: scene, contourKey: key, calloutsReady: settledKey === key,
  }), [scene, key, settledKey])
}

export function CategoryContourCallouts({scene, data, ready}: {scene: ContourScene; data: BreakdownItem[]; ready: boolean}) {
  const colors = new Map(data.map(item => [item.key, item.color]))
  return (
    <svg className="bb-contour-callouts" viewBox={`0 0 ${scene.width} ${scene.height}`} width={scene.width} height={scene.height} aria-hidden="true" data-ready={ready && Boolean(scene.routes)}>
      {ready ? scene.curvedRoutes?.map(route => <path key={route.id} className="bb-contour-stem" data-category={route.id} data-anchor={route.edge} d={route.d} stroke={colors.get(route.id)} />) : null}
      {ready && scene.routes ? scene.items.map(item => {
        const top = item.y - item.height / 2, x = item.x + item.width / 2
        const route = scene.routes?.find(route => route.id === item.id), end = route?.points[route.points.length - 1]
        return <g key={item.id} className="bb-contour-label" data-category={item.id}>
          <rect x={item.x} y={top} width={item.width} height={item.height} rx={Math.min(scene.style.calloutRadius, item.height / 2)} />
          <text className="bb-contour-name" textAnchor="middle" x={x} y={top + item.padding + scene.style.labelSize} fontSize={scene.style.labelSize} fill={item.id === "left" ? undefined : colors.get(item.id)}>{item.name}</text>
          <text className="bb-contour-amount" textAnchor="middle" x={x} y={top + item.padding + 2 * item.lineHeight - 1} fontSize={item.valueSize}>{item.amountLabel}</text>
          {end ? <circle cx={end[0]} cy={end[1]} r={1.6} fill={colors.get(item.id)} /> : null}
        </g>
      }) : null}
    </svg>
  )
}
