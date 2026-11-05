import type { ContourItem, ContourRoute, ContourScene, Point } from "./category-mix-layout"
import { createContourPathProbe, roundedContourRoute } from "./category-mix-path"

type Slot = { id: number; edge: string; cx: number; y: number; angle: number }
type Connection = { item: ContourItem; slot: Slot; x: number; y: number; alpha: number; points: Point[]; score: number }
type Plan = { score: number; pairs: Connection[] }

// A congested set of roots needs ordered destinations, rather than another
// permutation of greedy grid paths. Match measured cards to a single perimeter
// layer with DP; the ordered polar interpolation cannot topologically cross.
// Actual rounded paths still undergo subpixel clearance checks below.
export function placePerimeterContour(prepared: ContourScene): ContourScene | null {
    if (!prepared.items.length) return null
    const inset = prepared.style.inset, gap = prepared.style.labelGap
    const maxWidth = Math.max(...prepared.items.map(i => i.width)), maxHeight = Math.max(...prepared.items.map(i => i.height))
    const { width, height, cx, cy } = prepared
    const across = width / 2 - inset - maxWidth, above = cy - inset - maxHeight, below = height - inset - maxHeight - cy
    const columns = Math.min(3, Math.floor((width - 2 * inset + gap) / (maxWidth + gap)))
    if (columns < 1 || columns * 2 + 6 < prepared.items.length) return null
    const slots: Slot[] = []
    const add = (edge: string, x: number, y: number) => slots.push({ id: slots.length, edge, cx: x, y, angle: 0 })
    for (let i = 0; i < columns; i++) {
        const x = columns === 1 ? cx : inset + maxWidth / 2 + i * (width - 2 * inset - maxWidth) / (columns - 1)
        add('bottom', x, inset + maxHeight / 2)
        add('top', x, height - inset - maxHeight / 2)
    }
    // Leave corner rays clear of the first/last side cards, including when
    // the fitted ring center is above the middle of the chart host.
    const cornerX = columns === 1 ? 0 : cx - inset - maxWidth / 2
    const firstRay = cornerX ? cy - above * across / cornerX : inset + maxHeight
    const lastRay = cornerX ? cy + below * across / cornerX : height - inset - maxHeight
    const first = Math.max(inset + maxHeight + gap + maxHeight / 2, firstRay + gap + maxHeight / 2)
    const last = Math.min(height - inset - maxHeight - gap - maxHeight / 2, lastRay - gap - maxHeight / 2)
    if (last - first < 2 * (maxHeight + gap)) return null
    for (let i = 0; i < 3; i++) {
        const y = first + i * (last - first) / 2
        add('right', inset + maxWidth / 2, y)
        add('left', width - inset - maxWidth / 2, y)
    }
    const angle = (x: number, y: number) => (Math.atan2(x - cx, cy - y) + Math.PI * 2) % (Math.PI * 2)
    function target(item: { width: number; height: number }, slot: Slot) {
        let x = slot.cx - item.width / 2
        if (slot.edge === 'right') x = inset
        if (slot.edge === 'left') x = width - inset - item.width
        const y = slot.y
        const end: Point = slot.edge === 'right' ? [x + item.width, y] : slot.edge === 'left' ? [x, y] : [x + item.width / 2, y + (slot.edge === 'bottom' ? item.height / 2 : -item.height / 2)]
        return { x, y, end, angle: angle(...end) }
    }
    for (const slot of slots) slot.angle = target({ width: maxWidth, height: maxHeight }, slot).angle
    slots.sort((a, b) => a.angle - b.angle)
    const rows = prepared.items.slice().sort((a, b) => a.mid - b.mid), probe = createContourPathProbe()
    const position = (radius: number, a: number): Point => [cx + radius * Math.sin(a), cy - radius * Math.cos(a)]
    const boundary = (a: number) => 1 / Math.sqrt((Math.sin(a) / across) ** 2 + (Math.cos(a) / (Math.cos(a) >= 0 ? above : below)) ** 2)
    for (const clearance of [6, 10, 14, 18]) {
        const radius = Math.min(prepared.radius, across - clearance, above - clearance, below - clearance)
        if (radius < prepared.style.thickness + 8) continue
        const memo = new Map<string, Connection>(), candidates: Plan[] = []
        function connection(item: ContourItem, slot: Slot, turn: number): Connection {
            const key = `${item.id}/${slot.id}/${turn}`
            const cached = memo.get(key)
            if (cached) return cached
            const t = target(item, slot), beta = t.angle + turn * Math.PI * 2
            const margin = Math.min((item.end - item.start) * .2, 6 / radius), lo = item.start + margin, hi = item.end - margin
            const anchors = item.end - item.start < .15 ? [item.mid] : [Math.max(lo, Math.min(hi, beta)), item.mid, lo, hi]
            let best: Connection | null = null
            for (const alpha of anchors) {
                const points: Point[] = []
                for (let k = 0; k <= 24; k++) {
                    const progress = k / 24, eased = progress ** 3 * (10 + progress * (-15 + 6 * progress))
                    const a = alpha + (beta - alpha) * eased
                    points.push(position(radius + 1.2 + progress * (boundary(a) - radius - 1.2), a))
                }
                points.push(t.end)
                let length = 0
                for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
                const score = length + Math.max(0, 18 - length) ** 2 * 10
                if (!best || score < best.score) best = { item, slot, x: t.x, y: t.y, alpha, points, score }
            }
            memo.set(key, best!)
            return best!
        }
        for (let cut = 0; cut < slots.length; cut++) for (const offset of [-1, 0]) {
            const sequence = [...slots.slice(cut), ...slots.slice(0, cut)]
            const dp: Plan[][][] = Array.from({ length: rows.length + 1 }, () => Array.from({ length: sequence.length + 1 }, () => []))
            dp[0][0] = [{ score: 0, pairs: [] }]
            for (let j = 1; j <= sequence.length; j++) for (let i = 0; i <= Math.min(j, rows.length); i++) {
                const options = dp[i][j - 1].slice()
                if (i) {
                    const slot = sequence[j - 1], turn = offset + (slot.angle < sequence[0].angle ? 1 : 0)
                    const pair = connection(rows[i - 1], slot, turn)
                    for (const prior of dp[i - 1][j - 1]) options.push({ score: prior.score + pair.score, pairs: [...prior.pairs, pair] })
                }
                options.sort((a, b) => a.score - b.score)
                dp[i][j] = options.slice(0, 3)
            }
            candidates.push(...dp[rows.length][sequence.length])
        }
        candidates.sort((a, b) => a.score - b.score)
        const seen = new Set<string>()
        let trials = 0
        for (const candidate of candidates) {
            const identity = candidate.pairs.map(p => p.slot.id).join(',')
            if (seen.has(identity)) continue
            seen.add(identity)
            if (++trials > 12) break
            const scene = structuredClone(prepared)
            scene.radius = radius; scene.inner = Math.max(8, radius - scene.style.thickness)
            const routes: ContourRoute[] = []
            for (const pair of candidate.pairs) {
                Object.assign(scene.items.find(i => i.id === pair.item.id)!, { x: pair.x, y: pair.y, anchorAngle: pair.alpha })
                routes.push({ id: pair.item.id, edge: pair.slot.edge, points: pair.points, d: roundedContourRoute(pair.points, scene.style.bend), smoothing: 'polar' })
            }
            const cells = new Map<string, { id: string; x: number; y: number }[]>()
            let valid = true
            for (const route of routes) {
                probe.setAttribute('d', route.d!)
                const length = probe.getTotalLength()
                if (length < 12) valid = false
                for (let at = 0; at <= length; at += .65) {
                    const p = probe.getPointAtLength(at)
                    if (Math.hypot(p.x - cx, p.y - cy) < radius + .3) valid = false
                    for (const item of scene.items) if (item.id !== route.id) {
                        const r = Math.min(scene.style.calloutRadius, item.height / 2)
                        const qx = Math.abs(p.x - item.x - item.width / 2) - item.width / 2 + r, qy = Math.abs(p.y - item.y) - item.height / 2 + r
                        if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r < .8) valid = false
                    }
                    const x = Math.floor(p.x / 4), y = Math.floor(p.y / 4)
                    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const other of cells.get(`${x + dx},${y + dy}`) ?? []) {
                        if (other.id !== route.id && Math.hypot(p.x - other.x, p.y - other.y) < 1.55) valid = false
                    }
                    const key = `${x},${y}`
                    if (!cells.has(key)) cells.set(key, [])
                    cells.get(key)!.push({ id: route.id, ...p })
                }
            }
            if (!valid) continue
            scene.routes = routes; scene.curvedRoutes = routes
            scene.placement = { before: candidate.score, after: candidate.score, moves: 0, trials }
            return scene
        }
    }
    return null
}
