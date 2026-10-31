type Point = { x: number; y: number }
type Rect = Point & { width: number; height: number }

// Keep signed financial amounts in the labels; only visual lengths are clamped.
export function burnRateBalance(spent: number, limit: number) {
  const used = Math.max(0, spent)
  const left = Math.max(0, limit - spent)
  const over = spent > limit
  return { used, left, over, empty: used + left === 0, excess: Math.min(1, Math.max(0, spent - limit) / Math.max(limit, 0.01)) }
}

export function burnRateTooltipCorner(
  plot: Rect, tooltip: { width: number; height: number }, samples: Point[],
  selectedX?: number, previousCorner?: number,
) {
  const { width, height } = tooltip
  const loX = plot.x + 3, loY = plot.y + 3
  const hiX = Math.max(loX, plot.x + plot.width - width - 3)
  const hiY = Math.max(loY, plot.y + plot.height - height - 3)
  // Axis tooltip coordinates carry the pointer's y, not the selected line's y.
  const selected = selectedX === undefined ? undefined : samples.reduce<Point | undefined>((best, point) =>
    !best || Math.abs(point.x - selectedX) < Math.abs(best.x - selectedX) ? point : best, undefined)
  const candidates = [loX, hiX].flatMap(x => [loY, hiY].map(y => {
    const overlaps = samples.filter(p => p.x > x - 10 && p.x < x + width + 10 && p.y > y - 10 && p.y < y + height + 10).length
    const hidesPoint = Boolean(selected && selected.x > x - 8 && selected.x < x + width + 8 && selected.y > y - 8 && selected.y < y + height + 8)
    return { x, y, hidesPoint, score: overlaps * 1000 + (hidesPoint ? 10000000 : 0) + (y - loY) * 0.01 + (x - loX) * 0.001 }
  }))
  let best = candidates.reduce((a, b) => a.score <= b.score ? a : b)
  const previous = previousCorner === undefined ? undefined : candidates[previousCorner]
  // Near-tied corners should not oscillate as the selected day changes.
  if (previous && !previous.hidesPoint && previous.score <= best.score + 3000) best = previous
  return { x: best.x, y: best.y, corner: candidates.indexOf(best) }
}

const sampleCache = new WeakMap<SVGPathElement, { key: string; samples: Point[] }>()
const cornerCache = new WeakMap<HTMLElement, number>()

export function positionBurnRateTooltip(portal: HTMLElement, node: HTMLElement, selectedX?: number) {
  const host = portal.parentElement
  const chart = host?.querySelector<HTMLElement>(".recharts-wrapper")
  const path = chart?.querySelector<SVGPathElement>(".recharts-line-curve")
  const clip = chart?.querySelector<SVGRectElement>("clipPath rect")
  const matrix = path?.getCTM()
  if (!host || !chart || !path || !clip || !matrix) return
  const bounds = chart.getBoundingClientRect()
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
  const next = burnRateTooltipCorner(
    { x: clip.x.baseVal.value, y: clip.y.baseVal.value, width: clip.width.baseVal.value, height: clip.height.baseVal.value },
    node.getBoundingClientRect(), cached.samples, selectedX, cornerCache.get(host),
  )
  cornerCache.set(host, next.corner)
  portal.style.transform = `translate(${next.x}px, ${next.y}px)`
  portal.dataset.positionedDay = node.dataset.inspectedDay
}
