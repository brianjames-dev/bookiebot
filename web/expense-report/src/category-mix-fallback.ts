import type { ContourItem, ContourRoute, ContourScene, Point } from './category-mix-layout';
import { createContourPathProbe } from './category-mix-path';
type Slot = {
    id: number;
    cx: number;
    y: number;
    angle: number;
};
type Connection = {
    key: string;
    handle: number;
    d: string;
    item: ContourItem;
    slot: Slot;
    x: number;
    y: number;
    alpha: number;
    points: Point[];
    edge: string;
    score: number;
};
type Plan = {
    score: number;
    pairs: Connection[];
};
// A single outer layer forces crowded slices to distant cards and long arcs.
// Match cards to several depths of free space, retaining circular order and
// checking path/card compatibility while building bounded DP alternatives.
export function placeCompactContour(prepared: ContourScene): ContourScene | null {
    if (!prepared.items.length)
        return null;
    const { width, height, cx, cy } = prepared, { inset, labelGap: gap } = prepared.style;
    const maxWidth = Math.max(...prepared.items.map(i => i.width)), maxHeight = Math.max(...prepared.items.map(i => i.height));
    const cols = Math.min(4, Math.floor((width - 2 * inset + gap) / (Math.min(...prepared.items.map(i => i.width)) + gap))), rows = Math.floor((height - 2 * inset + gap) / (maxHeight + gap));
    const angle = (x: number, y: number) => (Math.atan2(x - cx, cy - y) + Math.PI * 2) % (Math.PI * 2);
    const probe = createContourPathProbe(), items = prepared.items.slice().sort((a, b) => a.mid - b.mid);
    const fitted = Math.min(prepared.radius, width / 2 - inset - maxWidth - 8, cy - inset - maxHeight - 8, height - inset - maxHeight - cy - 8);
    for (const radius of [...new Set([prepared.radius, prepared.radius - 4, prepared.radius - 8, fitted])].sort((a, b) => b - a)) {
        if (radius < prepared.style.thickness + 8)
            continue;
        const slots: Slot[] = [];
        for (let iy = 0; iy < rows; iy++)
            for (let ix = 0; ix < cols; ix++) {
                const x = cols === 1 ? cx : inset + maxWidth / 2 + ix * (width - 2 * inset - maxWidth) / (cols - 1), y = rows === 1 ? height / 2 : inset + maxHeight / 2 + iy * (height - 2 * inset - maxHeight) / (rows - 1);
                const nx = Math.max(Math.abs(x - cx) - maxWidth / 2, 0), ny = Math.max(Math.abs(y - cy) - maxHeight / 2, 0);
                if (Math.hypot(nx, ny) >= radius + 8)
                    slots.push({ id: slots.length, cx: x, y, angle: angle(x, y) });
            }
        if (slots.length < items.length)
            continue;
        slots.sort((a, b) => a.angle - b.angle);
        const memo = new Map<string, Connection[]>(), plans: Plan[] = [];
        function connection(item: ContourItem, slot: Slot, turn: number): Connection[] {
            const key = `${item.id}/${slot.id}/${turn}`;
            if (memo.has(key))
                return memo.get(key)!;
            const beta = slot.angle + turn * Math.PI * 2, margin = Math.min((item.end - item.start) * .2, 6 / radius), lo = item.start + margin, hi = item.end - margin;
            const anchors = item.end - item.start < .15 ? [item.mid] : [Math.max(lo, Math.min(hi, beta)), item.mid, lo, hi];
            const choices: Connection[] = [];
            for (const alpha of anchors) {
                if (Math.abs(beta - alpha) > Math.PI / 2)
                    continue;
                const start: Point = [cx + (radius + 1.2) * Math.sin(alpha), cy - (radius + 1.2) * Math.cos(alpha)], x = slot.cx - item.width / 2, y = slot.y;
                const corner = Math.min(prepared.style.calloutRadius, item.height / 2, item.width / 2), insetX = Math.min(item.width / 2, Math.max(9, corner + 1)), insetY = Math.min(item.height / 2, Math.max(7, corner + 1));
                const px = Math.max(x + insetX, Math.min(x + item.width - insetX, start[0])), py = Math.max(y - item.height / 2 + insetY, Math.min(y + item.height / 2 - insetY, start[1]));
                const ports: {
                    end: Point;
                    normal: Point;
                    edge: string;
                }[] = [{ end: [px, y - item.height / 2], normal: [0, -1], edge: 'top' }, { end: [px, y + item.height / 2], normal: [0, 1], edge: 'bottom' }, { end: [x, py], normal: [-1, 0], edge: 'left' }, { end: [x + item.width, py], normal: [1, 0], edge: 'right' }];
                for (const { end, normal, edge } of ports)
                    for (const factor of [.3, 1, 2]) {
                        const distance = Math.hypot(end[0] - start[0], end[1] - start[1]), h = Math.min(18, distance * .35), c1: Point = [start[0] + Math.sin(alpha) * h * factor, start[1] - Math.cos(alpha) * h * factor], c2: Point = [end[0] + normal[0] * h, end[1] + normal[1] * h];
                        const points: Point[] = [];
                        let valid = true, length = 0;
                        for (let k = 0; k <= 24; k++) {
                            const t = k / 24, u = 1 - t, p: Point = [u * u * u * start[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0], u * u * u * start[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1]];
                            if (Math.hypot(p[0] - cx, p[1] - cy) < radius + .5)
                                valid = false;
                            const qx = Math.abs(p[0] - slot.cx) - item.width / 2 + corner, qy = Math.abs(p[1] - y) - item.height / 2 + corner;
                            if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner < -.15)
                                valid = false;
                            if (k)
                                length += Math.hypot(p[0] - points[k - 1][0], p[1] - points[k - 1][1]);
                            points.push(p);
                        }
                        if (!valid || length < 18)
                            continue;
                        const score = length + Math.max(0, length - distance) * 3 + Math.max(0, length - 120) ** 2 * .04 + Math.abs(beta - alpha) * 12;
                        choices.push({ key: `${key}/${alpha}/${edge}/${factor}`, handle: h * factor, d: 'M' + start.join(',') + 'C' + c1.join(',') + ' ' + c2.join(',') + ' ' + end.join(','), item, slot, x, y, alpha, points, edge, score });
                    }
            }
            choices.sort((a, b) => a.score - b.score);
            const selected: Connection[] = [];
            for (const choice of choices)
                if (selected.every(other => Math.abs(other.alpha - choice.alpha) > .04 || other.edge !== choice.edge || Math.abs(other.handle - choice.handle) > 6)) {
                    selected.push(choice);
                    if (selected.length === 4)
                        break;
                }
            memo.set(key, selected);
            return selected;
        }
        // Cache incompatible pairs too. A partial plan is useful only when its
        // cards and paths leave room for all the connections already assigned.
        const compatibility = new Map<string, boolean>();
        function compatible(a: Connection, b: Connection): boolean {
            const key = JSON.stringify([a.key, b.key].sort());
            if (compatibility.has(key))
                return compatibility.get(key)!;
            if (a.x < b.x + b.item.width + gap && a.x + a.item.width > b.x - gap && a.y - a.item.height / 2 < b.y + b.item.height / 2 + gap && a.y + a.item.height / 2 > b.y - b.item.height / 2 - gap) {
                compatibility.set(key, false);
                return false;
            }
            const distance = (p: Point, q: Connection) => { const r = Math.min(prepared.style.calloutRadius, q.item.height / 2), qx = Math.abs(p[0] - q.x - q.item.width / 2) - q.item.width / 2 + r, qy = Math.abs(p[1] - q.y) - q.item.height / 2 + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
            let valid = a.points.every(p => distance(p, b) >= 1.2) && b.points.every(p => distance(p, a) >= 1.2);
            const pointDistance = (p: Point, a: Point, b: Point) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
            for (let i = 1; valid && i < a.points.length; i++)
                for (let j = 1; valid && j < b.points.length; j++) {
                    const p = a.points[i - 1], q = a.points[i], r = b.points[j - 1], s = b.points[j];
                    if (Math.min(p[0], q[0]) - 1.65 > Math.max(r[0], s[0]) || Math.max(p[0], q[0]) + 1.65 < Math.min(r[0], s[0]) || Math.min(p[1], q[1]) - 1.65 > Math.max(r[1], s[1]) || Math.max(p[1], q[1]) + 1.65 < Math.min(r[1], s[1]))
                        continue;
                    const cross = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
                    if (cross(p, q, r) * cross(p, q, s) <= 0 && cross(r, s, p) * cross(r, s, q) <= 0 || Math.min(pointDistance(p, r, s), pointDistance(q, r, s), pointDistance(r, p, q), pointDistance(s, p, q)) < 1.65)
                        valid = false;
                }
            compatibility.set(key, valid);
            return valid;
        }
        for (let cut = 0; cut < slots.length; cut++)
            for (const offset of [-1, 0]) {
                const seq = [...slots.slice(cut), ...slots.slice(0, cut)], dp: Plan[][][] = Array.from({ length: items.length + 1 }, () => Array.from({ length: seq.length + 1 }, () => []));
                dp[0][0] = [{ score: 0, pairs: [] }];
                for (let j = 1; j <= seq.length; j++)
                    for (let i = 0; i <= Math.min(j, items.length); i++) {
                        const options = dp[i][j - 1].slice();
                        if (i) {
                            const slot = seq[j - 1];
                            for (const pair of connection(items[i - 1], slot, offset + (slot.angle < seq[0].angle ? 1 : 0)))
                                for (const prior of dp[i - 1][j - 1])
                                    if (prior.pairs.every(other => compatible(pair, other)))
                                        options.push({ score: prior.score + pair.score, pairs: [...prior.pairs, pair] });
                        }
                        // Keep destination diversity: otherwise nearly identical handle variants
                        // consume the whole beam and prune the placements needed by later cards.
                        options.sort((a, b) => a.score - b.score);
                        const groups = new Map<string, number>(), kept: Plan[] = [];
                        for (const option of options) {
                            const identity = option.pairs.map(p => p.slot.id).join(','), n = groups.get(identity) ?? 0;
                            if (n >= 2)
                                continue;
                            groups.set(identity, n + 1);
                            kept.push(option);
                            if (kept.length === 12)
                                break;
                        }
                        dp[i][j] = kept;
                    }
                plans.push(...dp[items.length][seq.length]);
            }
        plans.sort((a, b) => a.score - b.score);
        const seen = new Set<string>();
        let trials = 0;
        for (const plan of plans) {
            const key = JSON.stringify(plan.pairs.map(p => p.key));
            if (seen.has(key))
                continue;
            seen.add(key);
            if (++trials > 48)
                break;
            const scene = structuredClone(prepared);
            scene.radius = radius;
            scene.inner = radius - scene.style.thickness;
            const routes: ContourRoute[] = [];
            for (const p of plan.pairs) {
                Object.assign(scene.items.find(i => i.id === p.item.id)!, { x: p.x, y: p.y, bank: p.y < cy ? 'top' : 'bottom', anchorAngle: p.alpha });
                routes.push({ id: p.item.id, edge: p.edge, points: p.points, d: p.d, smoothing: 'local' });
            }
            // The planning polylines are estimates. Validate the actual cubic paths
            // at subpixel spacing before exposing the complete scene to the chart.
            const cells = new Map<string, {
                id: string;
                x: number;
                y: number;
            }[]>();
            let valid = true;
            for (const route of routes) {
                probe.setAttribute('d', route.d!);
                const length = probe.getTotalLength();
                if (!Number.isFinite(length) || length < 18) {
                    valid = false;
                    break;
                }
                for (let step = 0, count = Math.ceil(length / .65); step <= count; step++) {
                    const p = probe.getPointAtLength(step * length / count);
                    if (Math.hypot(p.x - cx, p.y - cy) < radius + .3) {
                        valid = false;
                        break;
                    }
                    for (const item of scene.items) {
                        const r = Math.min(scene.style.calloutRadius, item.height / 2), qx = Math.abs(p.x - item.x - item.width / 2) - item.width / 2 + r, qy = Math.abs(p.y - item.y) - item.height / 2 + r;
                        if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r < (item.id === route.id ? -.15 : .8)) {
                            valid = false;
                            break;
                        }
                    }
                    if (!valid)
                        break;
                    const x = Math.floor(p.x / 4), y = Math.floor(p.y / 4);
                    for (let dx = -1; dx <= 1; dx++)
                        for (let dy = -1; dy <= 1; dy++)
                            for (const q of cells.get(`${x + dx},${y + dy}`) ?? [])
                                if (q.id !== route.id && Math.hypot(p.x - q.x, p.y - q.y) < 1.55)
                                    valid = false;
                    if (!valid)
                        break;
                    const key = `${x},${y}`;
                    if (!cells.has(key))
                        cells.set(key, []);
                    cells.get(key)!.push({ id: route.id, ...p });
                }
                if (!valid)
                    break;
            }
            if (valid) {
                scene.routes = routes;
                scene.curvedRoutes = routes;
                scene.placement = { before: plan.score, after: plan.score, moves: 0, trials };
                return scene;
            }
        }
    }
    return null;
}
