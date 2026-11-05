// Geometry for the approved Refined flow. Runs in a dedicated, cancellable
// worker; this module has no page, network, storage, or financial side effects.
import { createContourPathProbe, roundedContourRoute as roundedRoute } from "./category-mix-path";
import { placePerimeterContour } from "./category-mix-fallback";
export type Point = [
    number,
    number
];
export type ContourStyle = {
    diameter: number;
    thickness: number;
    centerSize: number;
    labelSize: number;
    labelGap: number;
    inset: number;
    stemOpacity: number;
    bend: number;
    calloutRadius: number;
    sidePadding: number;
    drift: number;
};
export type ContourInput = {
    id: string;
    name: string;
    amount: number;
    amountLabel: string;
    width: number;
};
export type ContourItem = ContourInput & {
    index: number;
    start: number;
    end: number;
    mid: number;
    anchorAngle?: number;
    lineHeight: number;
    valueSize: number;
    padding: number;
    lines: string[];
    height: number;
    x: number;
    y: number;
    column: number;
    columnCount: number;
    bank: string;
    depth: number;
    baseX: number;
    baseY: number;
    wantX: number;
    wantY: number;
};
type Box = {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    r: number;
};
type Port = {
    edge: string;
    end: Point;
    outside: Point;
    bit?: number;
};
export type ContourRoute = {
    id: string;
    edge: string;
    points: Point[];
    d?: string;
    sampled?: Point[];
    smoothing?: string;
};
export type ContourScene = {
    style: ContourStyle;
    width: number;
    height: number;
    radius: number;
    inner: number;
    cx: number;
    cy: number;
    items: ContourItem[];
    routes: ContourRoute[] | null;
    curvedRoutes?: ContourRoute[];
    placementStrength?: number;
    placement?: {before: number; after: number; moves: number; trials: number};
    assignment?: {
        before: number;
        after: number;
        swaps: string[][];
    };
};
export const CONTOUR_STYLE: ContourStyle = { diameter: 219, thickness: 26, centerSize: 24, labelSize: 11, labelGap: 6, inset: 8, stemOpacity: .65, bend: 10, calloutRadius: 18, sidePadding: 6, drift: 36 };
export const CONTOUR_PADDING_ANGLE = .7;
export function contourLabel(key: string, label: string): string {
    const names: Record<string, string> = { need: "Other needs", need_expenses: "Other needs", bills_utilities: "Bills & utils", needs: "Other needs", grocery: "Groceries", bills: "Bills & utils", utilities: "Bills & utils", needs_subscriptions: "Subs (Needs)", wants_subscriptions: "Wants subs", food: "Eating out", espp: "SpaceX ESPP" };
    if (key.startsWith("coverage-"))
        return label.replace(" overspend coverage", " coverage");
    if (/subscriptions/i.test(label))
        return /needs/i.test(key + " " + label) ? "Subs (Needs)" : "Wants subs";
    return names[key] ?? label;
}
const probe = createContourPathProbe();
// Negative plans matter too: neighboring placement candidates often revisit
// the same blocked geometry. Never repeat that full search in this worker.
const stemRouteCache = new Map<string, ContourRoute[] | null>();
function simplifyRoute(points: Point[]): Point[] { const clean: Point[] = []; for (const point of points) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) > .05)
        clean.push(point);
} const result: Point[] = []; for (const point of clean) {
    while (result.length >= 2) {
        const a = result[result.length - 2], b = result[result.length - 1], cross = (b[0] - a[0]) * (point[1] - b[1]) - (b[1] - a[1]) * (point[0] - b[0]);
        if (Math.abs(cross) > .02)
            break;
        result.pop();
    }
    result.push(point);
} return result; }
function segmentDistance(x: number, y: number, a: Point, b: Point): number { const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy, t = length ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length)) : 0; return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); }
function roundedBoxDistance(x: number, y: number, b: Box): number { const r = b.r || 0, qx = Math.abs(x - b.x - b.w / 2) - b.w / 2 + r, qy = Math.abs(y - b.y - b.h / 2) - b.h / 2 + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; }
function routeStems(scene: ContourScene, dense = false, fixed: ContourRoute[] = []): ContourRoute[] | null {
    const cacheKey = JSON.stringify([dense, fixed.map(route => [route.id, route.d]), scene.width, scene.height, scene.radius, scene.cx, scene.cy, scene.style.bend, scene.style.calloutRadius, scene.items.map(item => [item.id, item.x, item.y, item.width, item.height, item.bank, item.depth, item.anchorAngle ?? item.mid])]);
    if (stemRouteCache.has(cacheKey)) {
        const cached = stemRouteCache.get(cacheKey) ?? null;
        stemRouteCache.delete(cacheKey); stemRouteCache.set(cacheKey, cached);
        return cached;
    }
    const padding = 3, circlePadding = 2.8, reserveGap = dense ? 1 : 2.7, portReach = 3.6;
    const step = 2, columns = Math.floor(scene.width / step), rows = Math.floor(scene.height / step), size = columns * rows, base = new Uint8Array(size), sourceGuard = new Uint16Array(size), sources = new Map<string, {
        bit: number;
        anchor: Point;
        outside: Point;
    }>(), rectangles = scene.items.map(item => ({ id: item.id, x: item.x, y: item.y - item.height / 2, w: item.width, h: item.height, r: Math.min(scene.style.calloutRadius, item.width / 2, item.height / 2) }));
    const position = (id: number): Point => [(id % columns + .5) * step, (Math.floor(id / columns) + .5) * step], indexAt = (x: number, y: number) => Math.max(0, Math.min(rows - 1, Math.floor(y / step))) * columns + Math.max(0, Math.min(columns - 1, Math.floor(x / step)));
    scene.items.forEach((item, index) => sources.set(item.id, { bit: 1 << index, anchor: point(scene, scene.radius + 1.2, item.anchorAngle ?? item.mid), outside: point(scene, scene.radius + 4.4, item.anchorAngle ?? item.mid) }));
    const destinations = scene.items.flatMap(item => targetsFor(item).map(port => ({ ...port, bit: sources.get(item.id)!.bit })));
    // Rasterize only each obstacle's own bounds. Scanning every label and
    // every port at every chart pixel made the draft's optimizer expensive.
    for (let id = 0; id < size; id++) {
        const [x,y] = position(id)
        if (x < 1.5 || x > scene.width - 1.5 || y < 1.5 || y > scene.height - 1.5 || (x-scene.cx)**2+(y-scene.cy)**2 < (scene.radius+circlePadding)**2) base[id]=1
    }
    function visitBounds(x0:number,y0:number,x1:number,y1:number,visit:(id:number,x:number,y:number)=>void) {
        const left=Math.max(0,Math.floor(x0/step)),right=Math.min(columns-1,Math.ceil(x1/step)),top=Math.max(0,Math.floor(y0/step)),bottom=Math.min(rows-1,Math.ceil(y1/step))
        for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){const id=y*columns+x;if(!base[id])visit(id,(x+.5)*step,(y+.5)*step)}
    }
    for(const box of rectangles)visitBounds(box.x-padding,box.y-padding,box.x+box.w+padding,box.y+box.h+padding,(id,x,y)=>{if(roundedBoxDistance(x,y,box)<padding)base[id]=1})
    function guard(a:Point,b:Point,r:number,bit:number){visitBounds(Math.min(a[0],b[0])-r,Math.min(a[1],b[1])-r,Math.max(a[0],b[0])+r,Math.max(a[1],b[1])+r,(id,x,y)=>{if(segmentDistance(x,y,a,b)<r)sourceGuard[id]|=bit})}
    for(const source of sources.values())guard(source.anchor,source.outside,dense ? 1 : 3.5,source.bit)
    // Unused candidate ports are not obstacles. Reserve actual routes below;
    // guarding every possible port can seal the only corridor to another card.
    if(!dense)for(const target of destinations)guard(target.end,target.outside,1.8,target.bit!)
    if([...sources.values()].some(source => sourceGuard[indexAt(...source.outside)] & ~source.bit)) return keep(null);
    function ports(item: ContourItem, sidePorts: boolean): Port[] {
        const box = rectangles.find(box => box.id === item.id)!, source = sources.get(item.id)!.anchor, top = item.bank === 'top', candidates: Port[] = [];
        function add(edge: string, x: number, y: number, nx: number, ny: number) { if (!candidates.some(port => Math.abs(port.end[0] - x) + Math.abs(port.end[1] - y) < 1))
            candidates.push({ edge, end: [x, y], outside: [x + nx * portReach, y + ny * portReach] }); }
        const radius = Math.min(scene.style.calloutRadius, box.h / 2, box.w / 2), inset = Math.max(9, radius + 1);
        if (!sidePorts) {
            const y = top ? box.y + box.h : box.y, normal = top ? 1 : -1;
            for (const value of [source[0], box.x + box.w * .5, box.x + box.w * .28, box.x + box.w * .72]) {
                const x = Math.max(box.x + inset, Math.min(box.x + box.w - inset, value));
                add(top ? 'bottom' : 'top', x, y, 0, normal);
            }
        }
        else {
            const insetY = Math.min(box.h / 2, Math.max(7, radius + 1)), y = Math.max(box.y + insetY, Math.min(box.y + box.h - insetY, source[1]));
            for (const edge of source[0] < box.x + box.w / 2 ? ['left', 'right'] : ['right', 'left']) {
                const left = edge === 'left';
                for (const value of [y, box.y + box.h / 2])
                    add(edge, left ? box.x : box.x + box.w, value, left ? -1 : 1, 0);
            }
        }
        return candidates;
    }
    function targetsFor(item: ContourItem): Port[] {
        const dx=sources.get(item.id)!.anchor[0]-(item.x+item.width/2)
        return [...ports(item,false),...ports(item,true).filter(port=>port.edge===(dx<0?'left':'right'))]
    }
    const movable = scene.items.filter(item => !fixed.some(route => route.id === item.id));
    const orders = [movable.slice().sort((a, b) => b.depth - a.depth || a.mid - b.mid), movable.slice().sort((a, b) => b.depth - a.depth || b.mid - a.mid), movable.slice().sort((a, b) => a.mid - b.mid), movable.slice().sort((a, b) => a.depth - b.depth || a.mid - b.mid), movable.slice().sort((a, b) => a.depth - b.depth || b.mid - a.mid)].slice(0, movable.length === 1 ? 1 : 5);
    let seed = 84721;
    // Prefer another measured placement over exhaustively shuffling a blocked
    // one. The deterministic orders plus twelve alternatives retain variety
    // without spending seconds on an impossible narrow corridor.
    for (let attempt = 0; attempt < (movable.length > 1 ? 12 : 0); attempt++) {
        const shuffled = [...movable];
        for (let at = shuffled.length - 1; at > 0; at--) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            const next = seed % (at + 1);
            [shuffled[at], shuffled[next]] = [shuffled[next], shuffled[at]];
        }
        orders.push(shuffled);
    }
    let bestRoutes: ContourRoute[] | null = null, bestScore = Infinity, validPlans = 0;
    function keep(routes: ContourRoute[] | null) { if (stemRouteCache.size >= 128)
        stemRouteCache.delete(stemRouteCache.keys().next().value!); stemRouteCache.set(cacheKey, routes); return routes; }
    const visitedOrders = new Set<string>();
    // Identical ordered prefixes have identical reserved paths and obstacles.
    // Reuse their next path (including failure) instead of repeating A* for
    // every permutation. This memo lives only for this geometry/clearance.
    const prefixPlans = new Map<string, ContourRoute | null>();
    for (const order of orders) {
        const identity = order.map(item => item.id).join("\u0000");
        if (visitedOrders.has(identity)) continue;
        visitedOrders.add(identity);
        const used = new Uint8Array(size), routes: ContourRoute[] = [...fixed];
        let failed = false;
        function free(id: number, bit: number) { return id >= 0 && id < size && !base[id] && !used[id] && !(sourceGuard[id] & ~bit); }
        function canConnect(a: Point, b: Point, bit: number) { const length = Math.hypot(b[0] - a[0], b[1] - a[1]), count = Math.ceil(length / .6); for (let i = 0; i <= count; i++) {
            const t = count ? i / count : 0, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
            if (x < 1.5 || x > scene.width - 1.5 || y < 1.5 || y > scene.height - 1.5 || Math.hypot(x - scene.cx, y - scene.cy) < scene.radius + circlePadding + .1)
                return false;
            for (const box of rectangles)
                if (roundedBoxDistance(x, y, box) < padding)
                    return false;
            const id = indexAt(x, y);
            if (used[id] || (sourceGuard[id] & ~bit))
                return false;
        } return true; }
        function pull(points: Point[], bit: number): Point[] { const result = [points[0]]; let start = 0; while (start < points.length - 1) {
            let end = points.length - 1;
            while (end > start + 1 && !canConnect(points[start], points[end], bit))
                end--;
            result.push(points[end]);
            start = end;
        } return result; }
        function nearest(point: Point, bit: number) { const center = indexAt(...point), cx = center % columns, cy = Math.floor(center / columns); let best = -1, distance = Infinity; for (let y = Math.max(0, cy - 3); y <= Math.min(rows - 1, cy + 3); y++)
            for (let x = Math.max(0, cx - 3); x <= Math.min(columns - 1, cx + 3); x++) {
                const id = y * columns + x;
                if (!free(id, bit))
                    continue;
                const p = position(id), value = Math.hypot(p[0] - point[0], p[1] - point[1]);
                if (value < distance && canConnect(p, point, bit)) {
                    best = id;
                    distance = value;
                }
            } return best; }
        function search(start: number, targets: Port[], bit: number): {
            points: Point[];
            target: Port;
        } | null {
            const goals = new Map<number, Port>();
            for (const target of targets) {
                const goal = nearest(target.outside, bit);
                if (goal >= 0 && !goals.has(goal))
                    goals.set(goal, target);
            }
            if (start < 0 || !goals.size)
                return null;
            // Most connections have line of sight. Reserve those directly;
            // use the grid only when a card, the ring, or another stem blocks it.
            const startPoint = position(start)
            let direct: {goal: number; port: Port; distance: number} | null = null
            for(const [goal,port] of goals) {
                const end=position(goal),distance=Math.hypot(end[0]-startPoint[0],end[1]-startPoint[1])
                if((!direct || distance<direct.distance) && canConnect(startPoint,end,bit)) direct={goal,port,distance}
            }
            if(direct) return {points:[startPoint,position(direct.goal)],target:direct.port}
            const goalPoints = [...goals.keys()].map(position), score = new Float32Array(size), parent = new Int32Array(size), closed = new Uint8Array(size), heap: Point[] = [];
            score.fill(Infinity);
            parent.fill(-1);
            const estimate = (id: number) => { const p = position(id); let distance=Infinity;for(const g of goalPoints)distance=Math.min(distance,(g[0]-p[0])**2+(g[1]-p[1])**2);return Math.sqrt(distance)/step; };
            function push(id: number, cost: number) { let index = heap.length; heap.push([id, cost]); while (index) {
                const before = (index - 1) >> 1;
                if (heap[before][1] <= cost)
                    break;
                heap[index] = heap[before];
                index = before;
            } heap[index] = [id, cost]; }
            function pop() { const first = heap[0], last = heap.pop()!; if (heap.length) {
                let index = 0;
                while (index * 2 + 1 < heap.length) {
                    let child = index * 2 + 1;
                    if (child + 1 < heap.length && heap[child + 1][1] < heap[child][1])
                        child++;
                    if (heap[child][1] >= last[1])
                        break;
                    heap[index] = heap[child];
                    index = child;
                }
                heap[index] = last;
            } return first[0]; }
            score[start] = 0;
            push(start, estimate(start));
            while (heap.length) {
                const current = pop();
                if (closed[current])
                    continue;
                if (goals.has(current)) {
                    const ids = [];
                    let id = current;
                    while (id >= 0) {
                        ids.push(id);
                        id = parent[id];
                    }
                    return { points: ids.reverse().map(position), target: goals.get(current)! };
                }
                closed[current] = 1;
                const x = current % columns, y = Math.floor(current / columns);
                for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= columns || ny < 0 || ny >= rows)
                        continue;
                    const next = ny * columns + nx;
                    if (closed[next] || !free(next, bit))
                        continue;
                    if (dx && dy && (!free(y * columns + nx, bit) || !free(ny * columns + x, bit)))
                        continue;
                    let turn = 0;
                    if (parent[current] >= 0) {
                        const previous = parent[current];
                        if (current % columns - previous % columns !== dx || Math.floor(current / columns) - Math.floor(previous / columns) !== dy)
                            turn = .2;
                    }
                    const cost = score[current] + (dx && dy ? Math.SQRT2 : 1) + turn;
                    if (cost < score[next]) {
                        score[next] = cost;
                        parent[next] = current;
                        push(next, cost + estimate(next));
                    }
                }
            }
            return null;
        }
        function reserve(points: Point[]) { for (let i = 1; i < points.length; i++) {
            const a = points[i - 1], b = points[i], x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - 3) / step)), x1 = Math.min(columns - 1, Math.ceil((Math.max(a[0], b[0]) + 3) / step)), y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - 3) / step)), y1 = Math.min(rows - 1, Math.ceil((Math.max(a[1], b[1]) + 3) / step));
            for (let y = y0; y <= y1; y++)
                for (let x = x0; x <= x1; x++) {
                    const id = y * columns + x, p = position(id);
                    if (segmentDistance(p[0], p[1], a, b) < reserveGap)
                        used[id] = 1;
                }
        } }
        for (const route of fixed) {
            probe.setAttribute('d', route.d!);
            const points: Point[] = [], length = probe.getTotalLength();
            for (let at = 0; at < length; at += .65) { const p = probe.getPointAtLength(at); points.push([p.x, p.y]); }
            const end = probe.getPointAtLength(length); points.push([end.x, end.y]); reserve(points);
        }
        const prefix: string[] = [];
        for (const item of order) {
            prefix.push(item.id);
            const key = JSON.stringify(prefix);
            let plan = prefixPlans.get(key);
            if (!prefixPlans.has(key)) {
                const source = sources.get(item.id)!, start = nearest(source.outside, source.bit);
                const route = search(start, targetsFor(item), source.bit);
                plan = route ? {id: item.id, edge: route.target.edge, points: simplifyRoute([source.anchor, source.outside, ...pull(route.points, source.bit), route.target.outside, route.target.end])} : null;
                prefixPlans.set(key, plan);
            }
            if (!plan) {
                failed = true;
                break;
            }
            routes.push(plan);
            reserve(plan.points);
        }
        if (!failed) {
            if (dense && curveStems({ ...scene, routes }, true).some(route => route.smoothing === 'unresolved')) continue;
            let total = 0, stretch = 0;
            for (const route of routes) {
                let length = 0;
                for (let index = 1; index < route.points.length; index++)
                    length += Math.hypot(route.points[index][0] - route.points[index - 1][0], route.points[index][1] - route.points[index - 1][1]);
                const a = route.points[0], b = route.points[route.points.length - 1];
                stretch = Math.max(stretch, length / Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])));
                total += length + route.points.length * 5;
            }
            const score = total + stretch * 20;
            if (score < bestScore) {
                bestScore = score;
                bestRoutes = routes;
            }
            validPlans++;
            if (stretch < 1.65 || validPlans >= 5)
                return keep(bestRoutes!);
        }
    }
    return keep(bestRoutes);
}
const curveCache = new Map<string, ContourRoute[]>();
function curveStems(scene: ContourScene, dense = false): ContourRoute[] {
    const routes = scene.routes || [], key = JSON.stringify([dense, scene.style.bend, scene.style.calloutRadius, scene.radius, scene.cx, scene.cy, scene.items.map(item => [item.id, item.x, item.y, item.width, item.height]), routes]);
    if (curveCache.has(key)) {
        const cached = curveCache.get(key)!;
        curveCache.delete(key); curveCache.set(key, cached);
        return cached;
    }
    function sample(d: string): Point[] { probe.setAttribute('d', d); const length = probe.getTotalLength(), points: Point[] = []; for (let at = 0; at < length; at += .65) {
        const p = probe.getPointAtLength(at);
        points.push([p.x, p.y]);
    } const end = probe.getPointAtLength(length); points.push([end.x, end.y]); return points; }
    const curves = routes.map(route => { const d = route.d ?? ('M' + route.points.map(p => p.join(',')).join('L')); return { ...route, d, sampled: sample(d) }; }), boxes = scene.items.map(item => ({ id: item.id, x: item.x, y: item.y - item.height / 2, w: item.width, h: item.height, r: Math.min(scene.style.calloutRadius, item.width / 2, item.height / 2) }));
    function smoothPoints(points: Point[], allowed: (a: Point, b: Point) => boolean = () => true): Point[] { const result: Point[] = points.map(p => [p[0], p[1]]); let changed = true; while (changed) {
        changed = false;
        for (let i = 1; i < result.length - 1; i++) {
            const a = result[i - 1], b = result[i], c = result[i + 1];
            if ((Math.hypot(b[0] - a[0], b[1] - a[1]) < 5 || Math.hypot(c[0] - b[0], c[1] - b[1]) < 5 || segmentDistance(b[0], b[1], a, c) < 1) && allowed(a, c)) {
                result.splice(i, 1);
                changed = true;
                break;
            }
        }
    } return result; }
    for (const curve of curves) {
        if (curve.smoothing && curve.smoothing !== 'unresolved') continue;
        const cells = new Map<string, Point[]>(), cellKey = (x: number, y: number) => x + ',' + y;
        for (const other of curves)
            if (other !== curve)
                for (const p of other.sampled) {
                    const k = cellKey(Math.floor(p[0] / 4), Math.floor(p[1] / 4));
                    if (!cells.has(k))
                        cells.set(k, []);
                    cells.get(k)!.push(p);
                }
        function clear(points: Point[]) { for (const [x, y] of points) {
            if (x < 1 || x > scene.width - 1 || y < 1 || y > scene.height - 1 || Math.hypot(x - scene.cx, y - scene.cy) < scene.radius + .45)
                return false;
            for (const b of boxes) {
                const margin = b.id === curve.id ? -.15 : 1.1;
                if (roundedBoxDistance(x, y, b) < margin)
                    return false;
            }
            const gx = Math.floor(x / 4), gy = Math.floor(y / 4);
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++)
                    for (const p of cells.get(cellKey(gx + dx, gy + dy)) || [])
                        // During construction, other routes still include raw
                        // grid corners. Judge the final curves together below.
                        if (Math.hypot(x - p[0], y - p[1]) < (dense ? .4 : 1.95))
                            return false;
        } return true; }
        const item = scene.items.find(item => item.id === curve.id)!, a = curve.points[0], z = curve.points[curve.points.length - 1], distance = Math.hypot(z[0] - a[0], z[1] - a[1]), normal = ({ top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] } as Record<string, Point>)[curve.edge], candidates: string[] = [], clean = smoothPoints(curve.points, (a, b) => clear(sample('M' + a.join(',') + 'L' + b.join(',')))), softness = scene.style.bend;
        for (const scale of [1, .78, .56, .34]) {
            const handle = Math.min(distance * .6, softness * 1.6) * scale, first = .65, last = 1.25;
            const ux = Math.sin(item.anchorAngle ?? item.mid), uy = -Math.cos(item.anchorAngle ?? item.mid);
            const c1 = [a[0] + ux * handle * first, a[1] + uy * handle * first], c2 = [z[0] + normal[0] * handle * last, z[1] + normal[1] * handle * last];
            candidates.push('M' + a.join(',') + 'C' + c1.join(',') + ' ' + c2.join(',') + ' ' + z.join(','));
        }
        // A clear direct connection still gets a gentle bow. Its radial cubic
        // can be blocked by a neighbor even when this shorter curve fits.
        for (const scale of [1, .5, .2, .05]) for (const sign of [-1, 1]) {
            const bend = Math.min(6, distance * .15) * scale * sign;
            const control: Point = [(a[0] + z[0]) / 2 - (z[1] - a[1]) / Math.max(1, distance) * bend, (a[1] + z[1]) / 2 + (z[0] - a[0]) / Math.max(1, distance) * bend];
            candidates.push('M' + a.join(',') + 'Q' + control.join(',') + ' ' + z.join(','));
        }
        for (const radius of [softness, softness * .65, softness * .35, 3]) {
            candidates.push(roundedRoute(smoothPoints(curve.points), radius));
            candidates.push(roundedRoute(clean, radius));
            candidates.push(roundedRoute(curve.points, radius));
        }
        let accepted = false;
        for (const d of candidates) {
            const points = sample(d);
            if (/[CQ]/.test(d) && clear(points)) {
                curve.d = d;
                curve.sampled = points;
                curve.smoothing = d.includes('C') ? 'cubic' : 'rounded';
                accepted = true;
                break;
            }
        }
        if (!accepted) {
            const bends = Array(clean.length).fill(0);
            for (let index = 1; index < clean.length - 1; index++) {
                const a = clean[index - 1], b = clean[index], c = clean[index + 1], before = Math.hypot(b[0] - a[0], b[1] - a[1]), after = Math.hypot(c[0] - b[0], c[1] - b[1]), maximum = Math.min(softness, before * .46, after * .46);
                for (const fraction of [1, .8, .6, .4, .25, .12, .05, .01]) {
                    const r = maximum * fraction, p = [b[0] + (a[0] - b[0]) * r / before, b[1] + (a[1] - b[1]) * r / before], q = [b[0] + (c[0] - b[0]) * r / after, b[1] + (c[1] - b[1]) * r / after], d = 'M' + p.join(',') + 'Q' + b.join(',') + ' ' + q.join(',');
                    if (clear(sample(d))) {
                        bends[index] = r;
                        break;
                    }
                }
                if (!bends[index])
                    bends[index] = Math.min(.05, maximum);
            }
            for (const scale of [1, .8, .6, .4, .2, .05]) {
                const d = roundedRoute(clean, bends.map(value => value * scale)), points = sample(d);
                if (/[CQ]/.test(d) && clear(points)) {
                    curve.d = d;
                    curve.sampled = points;
                    curve.smoothing = 'adaptive';
                    accepted = true;
                    break;
                }
            }
            if (!accepted) {
                const d = roundedRoute(curve.points, .04), points = sample(d);
                if (/[CQ]/.test(d) && clear(points)) {
                    curve.d = d;
                    curve.sampled = points;
                    curve.smoothing = 'adaptive';
                    accepted = true;
                }
            }
        }
        if (!accepted)
            curve.smoothing = 'unresolved';
    }
    if (dense) {
        const cells = new Map<string, {point: Point; curve: typeof curves[number]}[]>();
        for (const curve of curves) for (const p of curve.sampled) {
            const x = Math.floor(p[0] / 4), y = Math.floor(p[1] / 4);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                for (const other of cells.get(`${x + dx},${y + dy}`) ?? []) {
                    if (other.curve !== curve && Math.hypot(p[0] - other.point[0], p[1] - other.point[1]) < 1.55)
                        curve.smoothing = other.curve.smoothing = 'unresolved';
                }
            }
            const key = `${x},${y}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key)!.push({point: p, curve});
        }
    }
    const result = curves.map(({ sampled, ...curve }) => curve);
    if (curveCache.size >= 90)
        curveCache.delete(curveCache.keys().next().value!);
    curveCache.set(key, result);
    return result;
}
function softenPlacement(scene: ContourScene, strength: number) {
    const movement = scene.style.drift * strength;
    if (!movement)
        return;
    const gap = scene.style.labelGap, hash = (text: string) => [...text].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 17), clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    for (const item of scene.items) {
        const anchor = point(scene, scene.radius + 8, item.mid), code = hash(item.id), noise = (code % 101) / 50 - 1, direction = item.bank === 'top' ? 1 : -1, outer = item.depth > 0, amount = outer ? .22 + .62 * Math.abs(Math.sin(item.mid)) : .6 + 1.45 * Math.abs(Math.sin(item.mid));
        item.baseX = item.x;
        item.baseY = item.y;
        item.wantX = clamp(item.x + item.width / 2 + (anchor[0] - item.x - item.width / 2) * .14 + (noise * movement * .18), scene.style.inset + item.width / 2, scene.width - scene.style.inset - item.width / 2);
        item.wantY = clamp(item.y + direction * movement * amount + noise * movement * .24, item.height / 2 + scene.style.inset, scene.height - item.height / 2 - scene.style.inset);
    }
    function fits(item: ContourItem, x: number, y: number) {
        const left = x - item.width / 2, right = x + item.width / 2, top = y - item.height / 2, bottom = y + item.height / 2;
        if (left < scene.style.inset || right > scene.width - scene.style.inset || top < scene.style.inset || bottom > scene.height - scene.style.inset)
            return false;
        const nearestX = Math.max(left, Math.min(right, scene.cx)), nearestY = Math.max(top, Math.min(bottom, scene.cy)), breathing = 8 + (hash(item.id) % 5) * 1.2;
        if (Math.hypot(nearestX - scene.cx, nearestY - scene.cy) < scene.radius + breathing)
            return false;
        if (item.bank === 'top' && bottom > scene.cy - scene.radius * .3 || item.bank === 'bottom' && top < scene.cy + scene.radius * .3)
            return false;
        for (const other of scene.items) {
            if (other === item)
                continue;
            if (left < other.x + other.width + gap && right > other.x - gap && top < other.y + other.height / 2 + gap && bottom > other.y - other.height / 2 - gap)
                return false;
            if (other.bank === item.bank && other.column === item.column && Math.abs(other.baseY - item.baseY) > 1) {
                const order = Math.sign(item.baseY - other.baseY);
                if ((y - other.y) * order < (item.height + other.height) / 2 + gap)
                    return false;
            }
        }
        return true;
    }
    const order = scene.items.slice().sort((a, b) => a.depth - b.depth || a.mid - b.mid);
    for (let pass = 0; pass < 3; pass++)
        for (const item of order) {
            const x = item.x + item.width / 2, y = item.y;
            for (let step = 24; step > 0; step--) {
                const fraction = step / 24, candidateX = x + (item.wantX - x) * fraction, candidateY = y + (item.wantY - y) * fraction;
                if (fits(item, candidateX, candidateY)) {
                    item.x = candidateX - item.width / 2;
                    item.y = candidateY;
                    break;
                }
            }
        }
}
function optimizeNeighbors(scene: ContourScene) {
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value)), position = (item: ContourItem) => ({ cx: item.x + item.width / 2, y: item.y, column: item.column, columnCount: item.columnCount, depth: item.depth }), set = (item: ContourItem, slot: {
        cx: number;
        y: number;
        column: number;
        columnCount: number;
        depth: number;
    }) => { item.x = clamp(slot.cx, scene.style.inset + item.width / 2, scene.width - scene.style.inset - item.width / 2) - item.width / 2; item.y = slot.y; item.column = slot.column; item.columnCount = slot.columnCount; item.depth = slot.depth; };
    function valid() { for (let i = 0; i < scene.items.length; i++) {
        const a = scene.items[i], left = a.x, right = a.x + a.width, top = a.y - a.height / 2, bottom = a.y + a.height / 2, px = clamp(scene.cx, left, right), py = clamp(scene.cy, top, bottom);
        if (left < scene.style.inset - .01 || right > scene.width - scene.style.inset + .01 || Math.hypot(px - scene.cx, py - scene.cy) < scene.radius + 7.5)
            return false;
        for (let j = i + 1; j < scene.items.length; j++) {
            const b = scene.items[j], gap = scene.style.labelGap - .1;
            if (left < b.x + b.width + gap && right > b.x - gap && top < b.y + b.height / 2 + gap && bottom > b.y - b.height / 2 - gap)
                return false;
        }
    } return true; }
    function score() { let result = 0; for (const item of scene.items) {
        const source = point(scene, scene.radius + 2, item.mid), top = item.y - item.height / 2, end = [clamp(source[0], item.x, item.x + item.width), clamp(source[1], top, top + item.height)], length = Math.hypot(source[0] - end[0], source[1] - end[1]);
        result += length;
        for (let at = 1; at < 16; at++) {
            const t = at / 16, x = source[0] + (end[0] - source[0]) * t, y = source[1] + (end[1] - source[1]) * t;
            if (Math.hypot(x - scene.cx, y - scene.cy) < scene.radius + .5) {
                result += 100;
                break;
            }
        }
        for (const other of scene.items) {
            if (other === item)
                continue;
            for (let at = 1; at < 24; at++) {
                const t = at / 24, x = source[0] + (end[0] - source[0]) * t, y = source[1] + (end[1] - source[1]) * t;
                if (x > other.x - 3 && x < other.x + other.width + 3 && y > other.y - other.height / 2 - 3 && y < other.y + other.height / 2 + 3) {
                    result += Math.min(other.width, other.height) + 20;
                    break;
                }
            }
        }
    } for (let i = 0; i < scene.items.length; i++)
        for (let j = i + 1; j < scene.items.length; j++) {
            const a = scene.items[i], b = scene.items[j];
            if (a.bank !== b.bank)
                continue;
            const delta = Math.atan2(Math.sin(b.mid - a.mid), Math.cos(b.mid - a.mid));
            if (Math.abs(delta) > 1.25)
                continue;
            const aa = Math.atan2(a.x + a.width / 2 - scene.cx, scene.cy - a.y), ba = Math.atan2(b.x + b.width / 2 - scene.cx, scene.cy - b.y), target = Math.atan2(Math.sin(ba - aa), Math.cos(ba - aa));
            if (delta * target < -.0001)
                result += 80;
        } return result; }
    const capture = () => scene.items.map(position), restore = (positions: ReturnType<typeof position>[]) => scene.items.forEach((item, index) => set(item, positions[index])), offsets: Point[] = [];
    for (let dx = -12; dx <= 12; dx += 3)
        for (let dy = -12; dy <= 12; dy += 3)
            offsets.push([dx, dy]);
    offsets.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
    function fitsOne(item: ContourItem) { const left = item.x, right = item.x + item.width, top = item.y - item.height / 2, bottom = item.y + item.height / 2, px = clamp(scene.cx, left, right), py = clamp(scene.cy, top, bottom); if (left < scene.style.inset - .01 || right > scene.width - scene.style.inset + .01 || top < scene.style.inset - .01 || bottom > scene.height - scene.style.inset + .01 || Math.hypot(px - scene.cx, py - scene.cy) < scene.radius + 7.5)
        return false; for (const other of scene.items) {
        if (item === other)
            continue;
        const gap = scene.style.labelGap - .1;
        if (left < other.x + other.width + gap && right > other.x - gap && top < other.y + other.height / 2 + gap && bottom > other.y - other.height / 2 - gap)
            return false;
    } return true; }
    function settle(a: ContourItem, b: ContourItem) { const order = [...scene.items.filter(item => item !== a && item !== b), a, b]; for (let pass = 0; pass < 3; pass++) {
        for (const item of order) {
            if (fitsOne(item))
                continue;
            const start = position(item);
            let found = false;
            for (const [dx, dy] of offsets) {
                set(item, { ...start, cx: start.cx + dx, y: start.y + dy });
                if (fitsOne(item)) {
                    found = true;
                    break;
                }
            }
            if (!found)
                set(item, start);
        }
        if (valid())
            return true;
    } return false; }
    const swaps: string[][] = [];
    const before = score();
    let current = before;
    for (let pass = 0; pass < 5; pass++) {
        let best: {
            positions: ReturnType<typeof capture>;
            ids: string[];
        } | null = null, bestScore = current - 2;
        for (let i = 0; i < scene.items.length; i++)
            for (let j = i + 1; j < scene.items.length; j++) {
                const a = scene.items[i], b = scene.items[j];
                if (a.bank !== b.bank || Math.abs(a.mid - b.mid) > 1.25 || Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y - b.y) > 115)
                    continue;
                const original = capture(), pa = position(a), pb = position(b);
                set(a, pb);
                set(b, pa);
                if (valid() || settle(a, b)) {
                    const value = score();
                    if (value < bestScore) {
                        bestScore = value;
                        best = { positions: capture(), ids: [a.id, b.id] };
                    }
                }
                restore(original);
            }
        if (!best)
            break;
        restore(best.positions);
        swaps.push(best.ids);
        current = bestScore;
    }
    scene.assignment = { before, after: score(), swaps };
}

export function prepareContourScene(data: ContourInput[], width: number, height: number, overrides: Partial<ContourStyle> = {}): ContourScene {
    const style = { ...CONTOUR_STYLE, ...overrides };
    if (width < 330)
        style.labelSize = Math.min(style.labelSize, 11.5);
    // Diameter is a limit; fit the selected composition within the chart stage.
    const lineHeight = style.labelSize + 1, cx = width / 2;
    let cy = height / 2, radius = style.diameter / 2, angle = 0;
    const selected = data.filter(item => Number.isFinite(item.amount) && item.amount > 0), total = selected.reduce((sum, item) => sum + item.amount, 0);
    const gap = selected.length > 1 ? CONTOUR_PADDING_ANGLE * Math.PI / 180 : 0, sweep = Math.PI * 2 - gap * selected.length;
    const items: ContourItem[] = selected.map((item, index) => {
        if (index)
            angle += gap;
        const start = angle;
        angle += item.amount / total * sweep;
        return { ...item, index, start, end: angle, mid: (start + angle) / 2, lineHeight, valueSize: style.labelSize, padding: 4, lines: [item.name], height: 2 * lineHeight + 8, x: 0, y: 0, column: 0, columnCount: 0, bank: 'top', depth: 0, baseX: 0, baseY: 0, wantX: 0, wantY: 0 };
    });
    const air = 10, available = width - 2 * style.inset;
    const banks = [{ name: 'top', items: items.filter(item => Math.cos(item.mid) >= -.03) }, { name: 'bottom', items: items.filter(item => Math.cos(item.mid) < -.03) }].map(bank => {
        bank.items.sort((a, b) => Math.sin(a.mid) - Math.sin(b.mid));
        const count = bank.items.length;
        let columns = 0, rows = 0, columnWidths: number[] = [];
        for (let candidate = Math.min(4, count); candidate >= 1; candidate--) {
            const rowCount = Math.ceil(count / candidate);
            if (Math.ceil(count / rowCount) !== candidate)
                continue;
            const widths = Array(candidate).fill(0);
            bank.items.forEach((item, index) => { const column = Math.floor(index / rowCount); widths[column] = Math.max(widths[column], item.width); });
            if (widths.reduce((a, b) => a + b, 0) + (candidate - 1) * style.labelGap <= available) {
                columns = candidate;
                rows = rowCount;
                columnWidths = widths;
                break;
            }
        }
        const rowHeight = count ? Math.max(...bank.items.map(item => item.height)) : 0, height = rows * rowHeight + Math.max(0, rows - 1) * style.labelGap;
        const combined = columnWidths.reduce((a, b) => a + b, 0), columnGap = columns > 1 ? (available - combined) / (columns - 1) : 0;
        let left = columns === 1 ? cx - combined / 2 : style.inset;
        const columnStarts = columnWidths.map(value => { const start = left; left += value + columnGap; return start; });
        return { ...bank, columns, rows, columnWidths, rowHeight, height, columnStarts };
    });
    const top = banks[0], bottom = banks[1], free = Math.max(60, height - 2 * style.inset - top.height - bottom.height - 2 * air);
    radius = Math.min(radius, free / 2, (width - 2 * style.inset) / 2);
    cy = style.inset + top.height + air + free / 2;
    for (const bank of banks) {
        const y = bank.name === 'top' ? style.inset : height - style.inset - bank.height;
        bank.items.forEach((item, index) => { const column = Math.floor(index / Math.max(1, bank.rows)), offset = index % Math.max(1, bank.rows), left = column < (bank.columns - 1) / 2, row = bank.name === 'top' ? (left ? offset : bank.rows - 1 - offset) : (left ? bank.rows - 1 - offset : offset); item.x = bank.columnStarts[column] + (bank.columnWidths[column] - item.width) / 2; item.y = y + row * (bank.rowHeight + style.labelGap) + item.height / 2; item.column = column; item.columnCount = bank.columns; item.bank = bank.name; item.depth = bank.name === 'top' ? bank.rows - 1 - row : row; });
    }
    return { style, width, height, radius, inner: Math.max(8, radius - style.thickness), cx, cy, items, routes: null };
}
// Search actual free space, independent of the seed's top/bottom banks. Grid
// candidates are ranked cheaply, then accepted only against complete routes.
// An attachment may slide within its slice; its financial angles never move.
function optimizeFreePlacement(scene: ContourScene, seedOnly = false): ContourScene {
    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
    const shortPenalty = (length: number) => Math.max(0, 24 - length) * 1.5 + Math.max(0, 18 - length) ** 2 * 4;
    function cost(routes: ContourRoute[]) {
        let total = 0, worst = 0;
        const details = new Map<string, number>();
        for (const route of routes) {
            probe.setAttribute('d', route.d!);
            const length = probe.getTotalLength(), a = route.points[0], b = route.points[route.points.length - 1];
            const excess = Math.max(0, length - Math.hypot(b[0] - a[0], b[1] - a[1]));
            const value = length + excess * 2 + shortPenalty(length);
            details.set(route.id, value); total += value; worst = Math.max(worst, excess);
        }
        return {total: total + worst, details};
    }
    function anchor(item: ContourItem, x: number, y: number) {
        // Keep thin adjacent slices centered; pulling each attachment toward
        // its nearest edge can collapse the separation between their stems.
        if (item.end - item.start < .15) return item.mid;
        const angle = Math.atan2(x + item.width / 2 - scene.cx, scene.cy - y);
        const margin = Math.min((item.end - item.start) * .2, 6 / scene.radius);
        const lo = item.start + margin, hi = item.end - margin;
        return [angle - Math.PI * 2, angle, angle + Math.PI * 2]
            .map(value => ({angle: clamp(value, lo, hi), delta: Math.abs(value - clamp(value, lo, hi))}))
            .sort((a, b) => a.delta - b.delta)[0].angle;
    }
    function candidate(item: ContourItem, x: number, y: number, angleOverride?: number, ceiling = Infinity) {
        const top = y - item.height / 2, bottom = y + item.height / 2, gap = scene.style.labelGap;
        const px = clamp(scene.cx, x, x + item.width), py = clamp(scene.cy, top, bottom);
        if (Math.hypot(px - scene.cx, py - scene.cy) < scene.radius + 8) return null;
        for (const other of scene.items) if (other !== item && x < other.x + other.width + gap && x + item.width > other.x - gap && top < other.y + other.height / 2 + gap && bottom > other.y - other.height / 2 - gap) return null;
        const angle = angleOverride ?? anchor(item, x, y), start = point(scene, scene.radius + 1.2, angle);
        const end: Point = [clamp(start[0], x, x + item.width), clamp(start[1], top, bottom)];
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
        let score = length + shortPenalty(length);
        // Obstacle penalties only increase this lower bound. Skip expensive
        // sampling when even a completely clear stem cannot improve the plan.
        if (score >= ceiling) return null;
        for (let step = 1; step < 16; step++) {
            const t = step / 16, px = start[0] + (end[0] - start[0]) * t, py = start[1] + (end[1] - start[1]) * t;
            if (Math.hypot(px - scene.cx, py - scene.cy) < scene.radius + .5) { score += 160; break; }
        }
        for (const other of scene.items) if (other !== item) {
            const box = {id: other.id, x: other.x, y: other.y - other.height / 2, w: other.width, h: other.height, r: Math.min(scene.style.calloutRadius, other.height / 2)};
            for (let step = 1; step < 16; step++) {
                const t = step / 16;
                if (roundedBoxDistance(start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t, box) < 3) { score += 80; break; }
            }
        }
        return {item, x, y, angle, score};
    }
    // Move obviously distant cards before solving any obstacle graph. This
    // shares the exact candidate geometry with the routed refinement below,
    // without repeatedly routing every possible neighbor swap first.
    if (seedOnly) {
        for (let pass = 0; pass < 12; pass++) {
            let best: NonNullable<ReturnType<typeof candidate>> | null = null, improvement = 3;
            for (const item of scene.items) {
                const current = candidate(item, item.x, item.y, item.anchorAngle ?? item.mid)?.score ?? 1000;
                const consider = (x: number, y: number) => {
                    const value = candidate(item, x, y, undefined, current - improvement);
                    if (value && current - value.score > improvement) { best = value; improvement = current - value.score; }
                };
                consider(item.x, item.y);
                for (let y = scene.style.inset + item.height / 2; y <= scene.height - scene.style.inset - item.height / 2; y += 12)
                    for (let x = scene.style.inset; x <= scene.width - scene.style.inset - item.width; x += 12) consider(x, y);
            }
            // TS cannot narrow a value assigned by the local candidate visitor.
            const selected = best as NonNullable<ReturnType<typeof candidate>> | null;
            if (!selected) break;
            Object.assign(selected.item, {x: selected.x, y: selected.y, bank: selected.y < scene.cy ? 'top' : 'bottom', anchorAngle: selected.angle});
        }
        return scene;
    }
    let actual = cost(scene.curvedRoutes!), trials = 0, moves = 0;
    const before = actual.total;
    for (let pass = 0; pass < 6 && trials < 24; pass++) {
        const proposals: NonNullable<ReturnType<typeof candidate>>[] = [];
        for (const item of scene.items) {
            const choices: typeof proposals = [], inset = scene.style.inset;
            const attached = candidate(item, item.x, item.y, undefined, (actual.details.get(item.id) ?? 0) - 3);
            if (attached && attached.score < (actual.details.get(item.id) ?? 0) - 3) choices.push(attached);
            for (let y = inset + item.height / 2; y <= scene.height - inset - item.height / 2; y += 12)
                for (let x = inset; x <= scene.width - inset - item.width; x += 12) {
                    const value = candidate(item, x, y, undefined, (actual.details.get(item.id) ?? 0) - 3);
                    if (value && value.score < (actual.details.get(item.id) ?? 0) - 3) choices.push(value);
                }
            choices.sort((a, b) => a.score - b.score);
            const selected: typeof proposals = [];
            for (const value of choices) if (selected.every(other => Math.hypot(value.x - other.x, value.y - other.y) >= 24)) {
                selected.push(value); proposals.push(value); if (selected.length === 3) break;
            }
        }
        proposals.sort((a, b) => ((actual.details.get(b.item.id) ?? 0) - b.score) - ((actual.details.get(a.item.id) ?? 0) - a.score));
        let improved = false;
        for (const value of proposals) {
            if (trials >= 24) break;
            trials++;
            const item = value.item, old = {x: item.x, y: item.y, bank: item.bank, anchorAngle: item.anchorAngle};
            Object.assign(item, {x: value.x, y: value.y, bank: value.y < scene.cy ? 'top' : 'bottom', anchorAngle: value.angle});
            const fixed = scene.curvedRoutes!.filter(route => route.id !== item.id);
            const box = {id: item.id, x: item.x, y: item.y - item.height / 2, w: item.width, h: item.height, r: Math.min(scene.style.calloutRadius, item.height / 2)};
            const clear = fixed.every(route => {
                probe.setAttribute('d', route.d!);
                for (let at = 0; at <= probe.getTotalLength(); at += .65) {
                    const p = probe.getPointAtLength(at);
                    if (roundedBoxDistance(p.x, p.y, box) < 1.1) return false;
                }
                return true;
            });
            const routes = clear ? routeStems(scene, true, fixed) : null, curves = routes ? curveStems({...scene, routes}, true) : null;
            if (curves && curves.every(route => route.smoothing !== 'unresolved')) {
                const next = cost(curves);
                probe.setAttribute('d', curves.find(route => route.id === item.id)!.d!);
                if (probe.getTotalLength() >= 18 && next.total < actual.total - 3) {
                    scene.routes = routes; scene.curvedRoutes = curves; actual = next; improved = true; moves++; break;
                }
            }
            Object.assign(item, old);
        }
        if (!improved) break;
    }
    scene.placement = {before, after: actual.total, moves, trials};
    return scene;
}

export function refineContourScene(prepared: ContourScene): ContourScene {
    let last = structuredClone(prepared), fallbackTried = false;
    const roots = prepared.items.map(item => point(prepared, prepared.radius + 1.2, item.mid));
    // Below the two-pixel planning grid, independent roots can alias into one
    // corridor. Try the ordered continuous fallback before repeated grid work.
    const crowded = roots.some((a, i) => roots.slice(i + 1).some(b => Math.hypot(a[0] - b[0], a[1] - b[1]) < 2));
    for (const extra of [0, 2, 4, 6]) for (const strength of [1, .5, 0]) for (const neighbors of [false, true]) {
        const scene = extra === 0 ? structuredClone(prepared) : prepareContourScene(prepared.items, prepared.width, prepared.height, {...prepared.style, labelGap: prepared.style.labelGap + extra});
        softenPlacement(scene, strength);
        if (neighbors) optimizeNeighbors(scene);
        optimizeFreePlacement(scene, true);
        scene.placementStrength = strength;
        for (const dense of [false, true]) {
            scene.routes = routeStems(scene, dense);
            if (scene.routes) {
                scene.curvedRoutes = curveStems(scene, dense);
                if (scene.curvedRoutes.every(route => route.smoothing !== 'unresolved')) return optimizeFreePlacement(scene);
            }
        }
        if (crowded && extra === 0 && strength === 1 && !neighbors) {
            fallbackTried = true;
            const fallback = placePerimeterContour(prepared);
            if (fallback) return fallback;
        }
        last = scene;
    }
    return fallbackTried ? last : placePerimeterContour(prepared) ?? last;
}

function point(scene: ContourScene, radius: number, angle: number): Point { return [scene.cx + radius * Math.sin(angle), scene.cy - radius * Math.cos(angle)]; }
