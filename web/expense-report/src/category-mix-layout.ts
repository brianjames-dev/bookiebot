// Geometry for the approved Refined flow. Runs in a dedicated, cancellable
// worker; this module has no page, network, storage, or financial side effects.
import { createContourPathProbe } from "./category-mix-path";
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
type Cost = {
    cost: number;
    total: number;
    detour: number;
    worst: number;
    details: Record<string, {
        length: number;
        excess: number;
    }>;
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
    assignment?: {
        before: number;
        after: number;
        swaps: string[][];
        routedBefore: Cost | null;
        routedAfter: Cost | null;
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
const stemRouteCache = new Map<string, ContourRoute[]>();
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
function roundedRoute(points: Point[], bend: number | number[] = 2.2): string { if (!points.length)
    return ''; let path = 'M' + points[0].join(','); for (let index = 1; index < points.length - 1; index++) {
    const a = points[index - 1], b = points[index], c = points[index + 1], before = Math.hypot(b[0] - a[0], b[1] - a[1]), after = Math.hypot(c[0] - b[0], c[1] - b[1]), r = Math.min(Array.isArray(bend) ? bend[index] ?? 2.2 : bend, before * .46, after * .46), p = [b[0] + (a[0] - b[0]) * r / before, b[1] + (a[1] - b[1]) * r / before], q = [b[0] + (c[0] - b[0]) * r / after, b[1] + (c[1] - b[1]) * r / after];
    path += 'L' + p.join(',') + 'Q' + b.join(',') + ' ' + q.join(',');
} return path + 'L' + points[points.length - 1].join(','); }
function segmentDistance(x: number, y: number, a: Point, b: Point): number { const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy, t = length ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length)) : 0; return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); }
function roundedBoxDistance(x: number, y: number, b: Box): number { const r = b.r || 0, qx = Math.abs(x - b.x - b.w / 2) - b.w / 2 + r, qy = Math.abs(y - b.y - b.h / 2) - b.h / 2 + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; }
function routeStems(scene: ContourScene): ContourRoute[] | null {
    const cacheKey = JSON.stringify([scene.width, scene.height, scene.radius, scene.cy, scene.style.calloutRadius, scene.items.map(item => [item.id, item.x, item.y, item.width, item.height, item.mid])]);
    if (stemRouteCache.has(cacheKey))
        return stemRouteCache.get(cacheKey)!;
    const padding = 3, circlePadding = 2.8, reserveGap = 2.7, portReach = 3.6;
    const step = 2, columns = Math.floor(scene.width / step), rows = Math.floor(scene.height / step), size = columns * rows, base = new Uint8Array(size), sourceGuard = new Uint16Array(size), sources = new Map<string, {
        bit: number;
        anchor: Point;
        outside: Point;
    }>(), rectangles = scene.items.map(item => ({ id: item.id, x: item.x, y: item.y - item.height / 2, w: item.width, h: item.height, r: Math.min(scene.style.calloutRadius, item.width / 2, item.height / 2) }));
    const position = (id: number): Point => [(id % columns + .5) * step, (Math.floor(id / columns) + .5) * step], indexAt = (x: number, y: number) => Math.max(0, Math.min(rows - 1, Math.floor(y / step))) * columns + Math.max(0, Math.min(columns - 1, Math.floor(x / step)));
    scene.items.forEach((item, index) => sources.set(item.id, { bit: 1 << index, anchor: point(scene, scene.radius + 1.2, item.mid), outside: point(scene, scene.radius + 4.4, item.mid) }));
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
    for(const source of sources.values())guard(source.anchor,source.outside,3.5,source.bit)
    for(const target of destinations)guard(target.end,target.outside,1.8,target.bit!)
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
    const orders = [scene.items.slice().sort((a, b) => b.depth - a.depth || a.mid - b.mid), scene.items.slice().sort((a, b) => b.depth - a.depth || b.mid - a.mid), scene.items.slice().sort((a, b) => a.mid - b.mid), scene.items.slice().sort((a, b) => a.depth - b.depth || a.mid - b.mid), scene.items.slice().sort((a, b) => a.depth - b.depth || b.mid - a.mid)];
    let seed = 84721;
    for (let attempt = 0; attempt < 35; attempt++) {
        const shuffled = [...scene.items];
        for (let at = shuffled.length - 1; at > 0; at--) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            const next = seed % (at + 1);
            [shuffled[at], shuffled[next]] = [shuffled[next], shuffled[at]];
        }
        orders.push(shuffled);
    }
    let bestRoutes: ContourRoute[] | null = null, bestScore = Infinity, validPlans = 0;
    function keep(routes: ContourRoute[]) { if (stemRouteCache.size > 128)
        stemRouteCache.clear(); stemRouteCache.set(cacheKey, routes); return routes; }
    for (const order of orders) {
        const used = new Uint8Array(size), routes: ContourRoute[] = [];
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
        for (const item of order) {
            const source = sources.get(item.id)!, start = nearest(source.outside, source.bit);
            let route = search(start, targetsFor(item), source.bit);
            if (!route) {
                failed = true;
                break;
            }
            const points = simplifyRoute([source.anchor, source.outside, ...pull(route.points, source.bit), route.target.outside, route.target.end]);
            routes.push({ id: item.id, edge: route.target.edge, points });
            reserve(points);
        }
        if (!failed) {
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
    return bestRoutes ? keep(bestRoutes) : null;
}
const curveCache = new Map<string, ContourRoute[]>();
function curveStems(scene: ContourScene): ContourRoute[] {
    const routes = scene.routes || [], key = JSON.stringify([scene.style.bend, scene.style.calloutRadius, scene.radius, routes]);
    if (curveCache.has(key))
        return curveCache.get(key)!;
    function sample(d: string): Point[] { probe.setAttribute('d', d); const length = probe.getTotalLength(), points: Point[] = []; for (let at = 0; at < length; at += .65) {
        const p = probe.getPointAtLength(at);
        points.push([p.x, p.y]);
    } const end = probe.getPointAtLength(length); points.push([end.x, end.y]); return points; }
    const curves = routes.map(route => { const d = 'M' + route.points.map(p => p.join(',')).join('L'); return { ...route, d, sampled: sample(d) }; }), boxes = scene.items.map(item => ({ id: item.id, x: item.x, y: item.y - item.height / 2, w: item.width, h: item.height, r: Math.min(scene.style.calloutRadius, item.width / 2, item.height / 2) }));
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
                        if (Math.hypot(x - p[0], y - p[1]) < 1.95)
                            return false;
        } return true; }
        const item = scene.items.find(item => item.id === curve.id)!, a = curve.points[0], z = curve.points[curve.points.length - 1], distance = Math.hypot(z[0] - a[0], z[1] - a[1]), normal = ({ top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] } as Record<string, Point>)[curve.edge], candidates: string[] = [], clean = smoothPoints(curve.points, (a, b) => clear(sample('M' + a.join(',') + 'L' + b.join(',')))), softness = scene.style.bend;
        for (const scale of [1, .78, .56, .34]) {
            const handle = Math.min(distance * .6, softness * 1.6) * scale, first = .65, last = 1.25;
            const ux = Math.sin(item.mid), uy = -Math.cos(item.mid);
            const c1 = [a[0] + ux * handle * first, a[1] + uy * handle * first], c2 = [z[0] + normal[0] * handle * last, z[1] + normal[1] * handle * last];
            candidates.push('M' + a.join(',') + 'C' + c1.join(',') + ' ' + c2.join(',') + ' ' + z.join(','));
        }
        for (const radius of [softness, softness * .65, softness * .35, 3]) {
            candidates.push(roundedRoute(smoothPoints(curve.points), radius));
            candidates.push(roundedRoute(clean, radius));
            candidates.push(roundedRoute(curve.points, radius));
        }
        let accepted = false;
        for (const d of candidates) {
            const points = sample(d);
            if (clear(points)) {
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
                if (clear(points)) {
                    curve.d = d;
                    curve.sampled = points;
                    curve.smoothing = 'adaptive';
                    accepted = true;
                    break;
                }
            }
            if (!accepted) {
                const d = roundedRoute(curve.points, .04), points = sample(d);
                if (clear(points)) {
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
    const result = curves.map(({ sampled, ...curve }) => curve);
    if (curveCache.size > 90)
        curveCache.clear();
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
    const originalPositions = capture(), swaps: string[][] = [];
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
    const seededPositions = capture();
    function routedCost(): Cost | null {
        const routes = routeStems(scene);
        if (!routes)
            return null;
        const curves = curveStems({ ...scene, routes });
        if (curves.some(route => route.smoothing === 'unresolved'))
            return null;
        let total = 0, detour = 0, worst = 0;
        const details: Cost["details"] = {};
        for (const route of curves) {
            probe.setAttribute('d', route.d!);
            const length = probe.getTotalLength(), a = route.points[0], b = route.points[route.points.length - 1], direct = Math.hypot(b[0] - a[0], b[1] - a[1]), excess = Math.max(0, length - direct);
            total += length;
            detour += excess;
            worst = Math.max(worst, excess);
            details[route.id] = { length, excess };
        }
        return { cost: total + detour * 2 + worst, total, detour, worst, details };
    }
    restore(originalPositions);
    const initial = routedCost();
    restore(seededPositions);
    const seeded = routedCost();
    let actual = seeded;
    if (initial && (!seeded || initial.cost < seeded.cost)) {
        restore(originalPositions);
        actual = initial;
        swaps.length = 0;
    }
    if (actual) {
        for (let pass = 0; pass < 5; pass++) {
            if(actual.worst < 6 && actual.detour < scene.items.length * 2.5) break
            const currentPositions = capture(), pairs: {
                a: ContourItem;
                b: ContourItem;
                priority: number;
            }[] = [];
            for (let i = 0; i < scene.items.length; i++)
                for (let j = i + 1; j < scene.items.length; j++) {
                    const a = scene.items[i], b = scene.items[j];
                    if (a.bank === b.bank && Math.abs(a.mid - b.mid) <= 1.25 && Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y - b.y) <= 130)
                        pairs.push({ a, b, priority: (actual.details[a.id]?.excess || 0) + (actual.details[b.id]?.excess || 0) });
                }
            pairs.sort((a, b) => b.priority - a.priority);
            let best: {
                positions: ReturnType<typeof capture>;
                ids: string[];
                value: Cost;
            } | null = null;
            for (const { a, b } of pairs.slice(0, 10)) {
                const pa = position(a), pb = position(b);
                set(a, pb);
                set(b, pa);
                if (valid() || settle(a, b)) {
                    const value = routedCost();
                    if (value && value.cost < actual.cost - 1)
                        best = { positions: capture(), ids: [a.id, b.id], value };
                }
                restore(currentPositions);
                // Accept a verified improvement, then rank again against the
                // new routed paths. Avoid solving every remaining permutation.
                if(best) break
            }
            if (!best)
                break;
            restore(best.positions);
            actual = best.value;
            swaps.push(best.ids);
        }
    }
    scene.assignment = { before, after: score(), swaps, routedBefore: initial, routedAfter: actual };
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
export function refineContourScene(prepared: ContourScene, spacingAttempt = 0): ContourScene {
    const scene = structuredClone(prepared), positions = scene.items.map(item => ({ ...item }));
    for (const strength of [1, .75, .5, .25, 0]) {
        scene.items.forEach((item, index) => Object.assign(item, positions[index]));
        softenPlacement(scene, strength);
        optimizeNeighbors(scene);
        scene.routes = routeStems(scene);
        scene.placementStrength = strength;
        if (scene.routes) {
            scene.curvedRoutes = curveStems(scene);
            break;
        }
    }
    if ((!scene.routes || scene.curvedRoutes?.some(route => route.smoothing === "unresolved")) && spacingAttempt < 3)
        return refineContourScene(prepareContourScene(prepared.items, prepared.width, prepared.height, { ...prepared.style, labelGap: prepared.style.labelGap + 2 }), spacingAttempt + 1);
    return scene;
}
function point(scene: ContourScene, radius: number, angle: number): Point { return [scene.cx + radius * Math.sin(angle), scene.cy - radius * Math.cos(angle)]; }
