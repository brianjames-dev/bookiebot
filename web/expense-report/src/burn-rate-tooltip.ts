type Point = { x: number; y: number }
type Rect = Point & { width: number; height: number }

// Keep signed financial amounts in the labels; only visual lengths are clamped.
export function burnRateBalance(spent: number, limit: number) {
  const used = Math.max(0, spent)
  const left = Math.max(0, limit - spent)
  const over = spent > limit
  return { used, left, over, empty: used + left === 0, excess: Math.min(1, Math.max(0, spent - limit) / Math.max(limit, 0.01)) }
}

export function burnRateTooltipPlacement(
  plot: Rect, tooltip: { width: number; height: number }, samples: Point[],
  selectedX?: number, bounds: Rect = plot, previous?: Point, avoid: Rect[] = [],
) {
  const { width, height } = tooltip
  const loX = bounds.x, loY = bounds.y
  const hiX = Math.max(loX, bounds.x + bounds.width - width)
  const hiY = Math.max(loY, bounds.y + bounds.height - height)
  const clampX = (x: number) => Math.max(loX, Math.min(hiX, x))
  const clampY = (y: number) => Math.max(loY, Math.min(hiY, y))
  // Axis tooltip coordinates carry the pointer's y, not the selected line's y.
  const selected = selectedX === undefined ? undefined : samples.reduce<Point | undefined>((best, point) =>
    !best || Math.abs(point.x - selectedX) < Math.abs(best.x - selectedX) ? point : best, undefined)
  const anchor = selected ?? { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 }
  const xs = new Set([anchor.x - width / 2, anchor.x - width - 14, anchor.x + 14, plot.x, plot.x + plot.width - width, loX, hiX].map(clampX))
  const ys = new Set([plot.y - height - 10, plot.y + plot.height + 10, anchor.y - height - 14, anchor.y + 14, plot.y, plot.y + plot.height - height, loY, hiY].map(clampY))
  // Search the available space, not only corners or positions outside the plot.
  // A bounded grid finds pockets between bends; exact edges retain snug fits.
  for (let x = loX; x < hiX; x += 20) xs.add(x)
  for (let y = loY; y < hiY; y += 16) ys.add(y)
  for (const rect of avoid) {
    xs.add(clampX(rect.x - width - 6)); xs.add(clampX(rect.x + rect.width + 6))
    ys.add(clampY(rect.y - height - 6)); ys.add(clampY(rect.y + rect.height + 6))
  }
  const score = ({ x, y }: Point) => {
    const hidesPoint = anchor.x > x - 12 && anchor.x < x + width + 12 && anchor.y > y - 12 && anchor.y < y + height + 12
    let overlaps = 0
    for (const p of samples) if (p.x > x - 8 && p.x < x + width + 8 && p.y > y - 8 && p.y < y + height + 8) overlaps++
    const obstruction = avoid.reduce((area, rect) => area
      + Math.max(0, Math.min(x + width, rect.x + rect.width + 6) - Math.max(x, rect.x - 6))
      * Math.max(0, Math.min(y + height, rect.y + rect.height + 6) - Math.max(y, rect.y - 6)), 0)
    const distance = Math.hypot(anchor.x - Math.max(x, Math.min(x + width, anchor.x)), anchor.y - Math.max(y, Math.min(y + height, anchor.y)))
    const centerDistance = Math.hypot(anchor.x - x - width / 2, anchor.y - y - height / 2)
    return { x, y, hidesPoint, overlaps, obstruction, score: overlaps * 30 + obstruction * .1 + distance + centerDistance * .12 }
  }
  const candidates = [...xs].flatMap(x => [...ys].map(y => score({ x, y })))
  let pool = candidates
  // Prefer a clear node, a clear curve, then clear metrics/axes. Once those are
  // safe, nearby empty plot space is just as useful as space above or below it.
  for (const clear of [(p: typeof candidates[number]) => !p.hidesPoint,
    (p: typeof candidates[number]) => !p.overlaps, (p: typeof candidates[number]) => !p.obstruction]) {
    const safe = pool.filter(clear)
    if (safe.length) pool = safe
  }
  let best = pool.reduce((a, b) => a.score <= b.score ? a : b)
  const retained = previous && score({ x: clampX(previous.x), y: clampY(previous.y) })
  // Do not retain an outside anchor that obscures metrics when a pocket opens.
  if (retained && !retained.hidesPoint && retained.overlaps <= best.overlaps && retained.obstruction <= best.obstruction && retained.score <= best.score + 12) best = retained
  return { x: best.x, y: best.y }
}

const sampleCache = new WeakMap<SVGPathElement, { key: string; samples: Point[] }>()
const placementCache = new WeakMap<HTMLElement, Point>()

export function positionBurnRateTooltip(portal: HTMLElement, node: HTMLElement, selectedX?: number) {
  const host = portal.parentElement
  const chart = host?.querySelector<HTMLElement>(".recharts-wrapper")
  const path = chart?.querySelector<SVGPathElement>(".recharts-line-curve")
  const clip = chart?.querySelector<SVGRectElement>("clipPath rect")
  const matrix = path?.getCTM()
  if (!host || !chart || !path || !clip || !matrix) return
  const bounds = chart.getBoundingClientRect()
  const pageElement = host.closest<HTMLElement>(".bb-burn-rate-page")
  const page = pageElement?.getBoundingClientRect() ?? bounds
  const viewport = window.visualViewport
  const left = Math.max(page.left + 8, (viewport?.offsetLeft ?? 0) + 8)
  const top = Math.max(page.top + 8, (viewport?.offsetTop ?? 0) + 8)
  const right = Math.min(page.right - 8, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - 8)
  const bottom = Math.min(page.bottom - 8, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8)
  const avoid = [
    ...(pageElement?.querySelectorAll(".bb-chart-page-header, .bb-chart-page-footer") ?? []),
    ...chart.querySelectorAll(".recharts-xAxis, .recharts-yAxis"),
  ].map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height)
    .map(rect => ({ x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height }))
  const key = [path.getAttribute("d"), bounds.width, bounds.height, matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].join("|")
  let cached = sampleCache.get(path)
  if (cached?.key !== key) {
    const samples: Point[] = []
    const length = path.getTotalLength()
    // Chart-local coordinates work inside scrolling pages and WebKit frames.
    for (let at = 0; at < length; at += 3) samples.push(path.getPointAtLength(at).matrixTransform(matrix))
    samples.push(path.getPointAtLength(length).matrixTransform(matrix))
    cached = { key, samples }
    sampleCache.set(path, cached)
  }
  const next = burnRateTooltipPlacement(
    { x: clip.x.baseVal.value, y: clip.y.baseVal.value, width: clip.width.baseVal.value, height: clip.height.baseVal.value },
    // Layout dimensions do not shrink while the exit frame scales/fades.
    { width: node.offsetWidth, height: node.offsetHeight }, cached.samples, selectedX,
    { x: left - bounds.left, y: top - bounds.top, width: right - left, height: bottom - top }, placementCache.get(host), avoid,
  )
  placementCache.set(host, next)
  portal.style.transform = `translate(${next.x}px, ${next.y}px)`
  portal.dataset.positionedDay = node.dataset.inspectedDay
}
