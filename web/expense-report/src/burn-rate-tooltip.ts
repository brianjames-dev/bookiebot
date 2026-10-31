type Point = { x: number; y: number }
type Rect = Point & { width: number; height: number }
type Obstacle = Rect & { occludes?: boolean; preserve?: boolean }

// Keep signed financial amounts in the labels; only visual lengths are clamped.
export function burnRateBalance(spent: number, limit: number) {
  const used = Math.max(0, spent)
  const left = Math.max(0, limit - spent)
  const over = spent > limit
  return { used, left, over, empty: used + left === 0, excess: Math.min(1, Math.max(0, spent - limit) / Math.max(limit, 0.01)) }
}

// The side is relative to the actual curve at the card's center, rather than
// a viewport quadrant or the selected node's y alone on a sloping trend.
export function burnRateTooltipSide(point: Point, tooltip: { width: number; height: number }, samples: Point[]): -1 | 1 {
  const center = { x: point.x + tooltip.width / 2, y: point.y + tooltip.height / 2 }
  const nearest = samples.reduce<Point | undefined>((best, sample) =>
    !best || Math.abs(sample.x - center.x) < Math.abs(best.x - center.x) ? sample : best, undefined)
  return center.y < (nearest?.y ?? center.y) ? -1 : 1
}

export function burnRateTooltipPlacement(
  plot: Rect, tooltip: { width: number; height: number }, samples: Point[],
  selectedX?: number, bounds: Rect = plot, previous?: Point, avoid: Obstacle[] = [], requiredSide?: -1 | 1,
  maxAnchorDistance = Infinity,
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
  const ys = new Set([plot.y - height - 10, plot.y + plot.height + 10, anchor.y - height - 14, anchor.y - height / 2, anchor.y + 14, plot.y, plot.y + plot.height - height, loY, hiY].map(clampY))
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
    let obstruction = 0, occlusion = 0, preserved = 0
    for (const rect of avoid) {
      const area = Math.max(0, Math.min(x + width, rect.x + rect.width + 6) - Math.max(x, rect.x - 6))
        * Math.max(0, Math.min(y + height, rect.y + rect.height + 6) - Math.max(y, rect.y - 6))
      if (rect.occludes) occlusion += area
      else obstruction += area
      if (rect.preserve) preserved += area
    }
    const distance = Math.hypot(anchor.x - Math.max(x, Math.min(x + width, anchor.x)), anchor.y - Math.max(y, Math.min(y + height, anchor.y)))
    const centerDistance = Math.hypot(anchor.x - x - width / 2, anchor.y - y - height / 2)
    // Nearby corners make the attachment legible without forcing a quadrant.
    // An edge remains available where viewport/curve clearance needs it.
    const cornerDistance = Math.hypot(Math.min(Math.abs(anchor.x - x), Math.abs(anchor.x - x - width)), Math.min(Math.abs(anchor.y - y), Math.abs(anchor.y - y - height)))
    // Label padding and overlapping text boxes can otherwise add hundreds of
    // pixels of penalty. Readability is a bounded preference, not an excuse to
    // send a nearby card to the opposite end of the chart.
    const area = Math.max(1, width * height)
    const readability = Math.min(1, obstruction / area) * 50 + Math.min(1, preserved / area) * 50
    return { x, y, distance, hidesPoint, overlaps, obstruction, occlusion, preserved, score: occlusion + overlaps * 30 + readability + distance * 3 + cornerDistance * .5 + centerDistance * .08 }
  }
  const candidates = [...xs].flatMap(x => [...ys].map(y => score({ x, y })))
  const opposite = requiredSide === undefined ? [] : candidates.filter(point => point.distance <= maxAnchorDistance && burnRateTooltipSide(point, tooltip, samples) === requiredSide)
  let pool = opposite.length ? opposite : candidates
  // Fixed controls can hide the popup. Keep it clear of those, the node and the
  // curve, then balance proximity against other labels instead of fleeing to
  // a distant corner just to avoid a small amount of text.
  for (const clear of [(p: typeof candidates[number]) => !p.occlusion,
    (p: typeof candidates[number]) => !p.hidesPoint, (p: typeof candidates[number]) => !p.overlaps]) {
    const safe = pool.filter(clear)
    if (safe.length) pool = safe
  }
  let best = pool.reduce((a, b) => a.score <= b.score ? a : b)
  const retained = previous && score({ x: clampX(previous.x), y: clampY(previous.y) })
  // Do not retain an outside anchor that obscures metrics when a pocket opens.
  if (retained && retained.occlusion <= best.occlusion && !retained.hidesPoint && retained.overlaps <= best.overlaps && retained.preserved <= best.preserved && retained.obstruction <= best.obstruction && retained.score <= best.score + 12) best = retained
  return { x: best.x, y: best.y }
}

const sampleCache = new WeakMap<SVGPathElement, { key: string; samples: Point[] }>()
type Placement = { portal: HTMLElement; day: string | undefined; geometry: string; point: Point; flipped: boolean; view: string; clearance: number; hidden: boolean }
const SCROLL_CLEARANCE = 32
// A mounted inspection owns its scroll budget. New nodes/days/layouts start
// fresh; ordinary scrolling must not turn the card into a fixed viewport HUD.
const placementCache = new WeakMap<HTMLElement, Placement>()

export function burnRateTooltipOccluders(document: Document) {
  return [...document.querySelectorAll<HTMLElement>(".bb-bottom-navigation:not([hidden]) .bb-navigation-pane, .bb-shell-header-actions button")]
    .filter(element => element.getBoundingClientRect().width && element.getBoundingClientRect().height)
}

export function burnRateTooltipObstacles(page: HTMLElement | null, chart: HTMLElement) {
  const rects: (Pick<DOMRect, "left" | "top" | "width" | "height"> & { preserve?: boolean })[] = []
  const protect = (element: Element) => {
    const { left, top, width, height } = element.getBoundingClientRect()
    rects.push({ left, top, width, height, preserve: true })
  }
  if (page) {
    const document = page.ownerDocument
    const range = document.createRange()
    for (const section of page.querySelectorAll(".bb-chart-page-header, .bb-chart-page-footer")) {
      // Block only painted text, not the empty area of a full-width grid row.
      const texts = document.createTreeWalker(section, NodeFilter.SHOW_TEXT)
      let text: Node | null
      while ((text = texts.nextNode())) {
        if (!text.textContent?.trim()) continue
        range.selectNodeContents(text)
        rects.push(...range.getClientRects())
      }
      for (const graphic of section.querySelectorAll("button, .bb-burn-balance-rail, .bb-burn-legend, .bb-category-pressure-track")) protect(graphic)
    }
  }
  for (const tick of chart.querySelectorAll(".recharts-cartesian-axis-tick-value")) protect(tick)
  return rects.filter(rect => rect.width && rect.height)
}

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
  const fixed = burnRateTooltipOccluders(host.ownerDocument).map(element => element.getBoundingClientRect())
  const occluders: Obstacle[] = fixed.map(rect => ({ x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height, occludes: true }))
  const obstacles = (): Obstacle[] => [...burnRateTooltipObstacles(pageElement, chart)
    .map(rect => ({ x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height, preserve: rect.preserve })), ...occluders]
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
  const tooltip = { width: node.offsetWidth, height: node.offsetHeight }
  const plot = { x: clip.x.baseVal.value, y: clip.y.baseVal.value, width: clip.width.baseVal.value, height: clip.height.baseVal.value }
  const visible = { x: left - bounds.left, y: top - bounds.top, width: right - left, height: bottom - top }
  // Horizontal alignment can settle after SVG resize. It is a real layout
  // change; vertical document scrolling is deliberately absent from this key.
  const geometry = `${key}|${bounds.left}|${tooltip.width}|${tooltip.height}`
  const day = node.dataset.inspectedDay
  let placement = placementCache.get(node)
  let positionChanged = false
  const occluded = (point: Point) => occluders.some(rect => point.x < rect.x + rect.width + 6 && point.x + tooltip.width > rect.x - 6 && point.y < rect.y + rect.height + 6 && point.y + tooltip.height > rect.y - 6)
  const inside = (point: Point) => point.x >= visible.x && point.y >= visible.y && point.x + tooltip.width <= visible.x + visible.width && point.y + tooltip.height <= visible.y + visible.height
  // Page edges move with the card. Only the viewport/floating controls can
  // approach it during scrolling; begin the exit before they actually cover it.
  const clearance = (point: Point) => Math.min(
    bounds.top + point.y - (viewport?.offsetTop ?? 0) - 8,
    (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - bounds.top - point.y - tooltip.height - 8,
    ...occluders.map(rect => Math.max(rect.x - point.x - tooltip.width, point.x - rect.x - rect.width, rect.y - point.y - tooltip.height, point.y - rect.y - rect.height) - 6),
  )
  const view = [visible.x, visible.y, visible.width, visible.height, ...occluders.flatMap(rect => [rect.x, rect.y, rect.width, rect.height])].join("|")
  const anchor = selectedX === undefined ? undefined : cached.samples.reduce<Point | undefined>((best, point) =>
    !best || Math.abs(point.x - selectedX) < Math.abs(best.x - selectedX) ? point : best, undefined)
  const distance = (point: Point) => anchor ? Math.hypot(anchor.x - Math.max(point.x, Math.min(point.x + tooltip.width, anchor.x)), anchor.y - Math.max(point.y, Math.min(point.y + tooltip.height, anchor.y))) : Infinity
  if (!placement || placement.portal !== portal || placement.day !== day || placement.geometry !== geometry) {
    const point = burnRateTooltipPlacement(plot, tooltip, cached.samples, selectedX, visible, undefined, obstacles())
    placement = { portal, day, geometry, point, flipped: false, view, clearance: clearance(point), hidden: !inside(point) || occluded(point) }
    placementCache.set(node, placement)
    positionChanged = true
  } else if (placement.view !== view) {
    const remaining = clearance(placement.point)
    const approaching = remaining < SCROLL_CLEARANCE && remaining < placement.clearance
    // No relocation may chase a node that has already scrolled out of view.
    const nodeVisible = anchor && anchor.x >= visible.x && anchor.x <= visible.x + visible.width && anchor.y >= visible.y && anchor.y <= visible.y + visible.height
      && !occluders.some(rect => anchor.x >= rect.x - 6 && anchor.x <= rect.x + rect.width + 6 && anchor.y >= rect.y - 6 && anchor.y <= rect.y + rect.height + 6)
    if (!placement.flipped && nodeVisible && (approaching || placement.hidden || distance(placement.point) > 24)) {
      const side = burnRateTooltipSide(placement.point, tooltip, cached.samples)
      const maxDistance = Math.max(32, tooltip.height / 2)
      // Search nearby candidates themselves, rather than rejecting a distant
      // winner after it has displaced a perfectly useful nearby opposite pocket.
      const next = burnRateTooltipPlacement(plot, tooltip, cached.samples, selectedX, visible, undefined, obstacles(), side === -1 ? 1 : -1, maxDistance)
      const coversNode = anchor.x > next.x - 12 && anchor.x < next.x + tooltip.width + 12 && anchor.y > next.y - 12 && anchor.y < next.y + tooltip.height + 12
      const coversCurve = cached.samples.some(point => point.x > next.x - 8 && point.x < next.x + tooltip.width + 8 && point.y > next.y - 8 && point.y < next.y + tooltip.height + 8)
      if ((approaching || placement.hidden || distance(next) + 24 < distance(placement.point)) && inside(next) && !occluded(next) && !coversNode && !coversCurve && distance(next) <= maxDistance && burnRateTooltipSide(next, tooltip, cached.samples) !== side) {
        placement.point = next
        placement.flipped = true
        positionChanged = true
      }
    }
    const current = clearance(placement.point)
    if (positionChanged || current >= SCROLL_CLEARANCE) placement.hidden = false
    else if (approaching || current < 0) placement.hidden = true
    placement.clearance = current
    placement.view = view
  }
  // Once its one opposite-side move is used, keep this exact chart-local
  // anchor. It scrolls away naturally; fixed controls can hide, never repel it.
  const hidden = String(placement.hidden)
  if (portal.dataset.scrollHidden !== hidden) portal.dataset.scrollHidden = hidden
  // Do not compare serialized CSS floats: browser rounding can otherwise
  // turn the same anchor into a redundant style write on every scroll event.
  if (positionChanged) portal.style.transform = `translate(${placement.point.x}px, ${placement.point.y}px)`
  if (portal.dataset.positionedDay !== day) portal.dataset.positionedDay = day
}
