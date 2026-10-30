import type { Point } from "./category-mix-layout";
// Small DOM-free M/L/Q/C sampler. Curves are checked at subpixel spacing in
// the worker, so routing never relies on a browser SVG node or its layout.
export function createContourPathProbe() {
    let points: Point[] = [[0, 0]], distances = [0];
    function setAttribute(_name: string, d: string) {
        const tokens = d.match(/[MLQC]|-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? [];
        points = [];
        distances = [];
        let index = 0, current: Point = [0, 0];
        const point = (): Point => [Number(tokens[index++]), Number(tokens[index++])];
        const add = (p: Point) => {
            const prior = points[points.length - 1];
            distances.push(prior ? distances[distances.length - 1] + Math.hypot(p[0] - prior[0], p[1] - prior[1]) : 0);
            points.push(p);
        };
        while (index < tokens.length) {
            const command = tokens[index++];
            if (command === "M") {
                current = point();
                add(current);
                continue;
            }
            const start = current, a = point(), b = command === "L" ? a : point(), end = command === "C" ? point() : b;
            if (command === "L") {
                add(end);
                current = end;
                continue;
            }
            const length = Math.hypot(a[0] - start[0], a[1] - start[1]) + Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(end[0] - b[0], end[1] - b[1]);
            const steps = Math.max(8, Math.ceil(length / .3));
            for (let step = 1; step <= steps; step++) {
                const t = step / steps, u = 1 - t;
                add(command === "Q"
                    ? [u * u * start[0] + 2 * u * t * a[0] + t * t * end[0], u * u * start[1] + 2 * u * t * a[1] + t * t * end[1]]
                    : [u ** 3 * start[0] + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t ** 3 * end[0], u ** 3 * start[1] + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t ** 3 * end[1]]);
            }
            current = end;
        }
    }
    function getPointAtLength(at: number) {
        let low = 0, high = distances.length - 1;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (distances[mid] < at)
                low = mid + 1;
            else
                high = mid;
        }
        const previous = Math.max(0, low - 1), span = distances[low] - distances[previous], t = span ? Math.max(0, Math.min(1, (at - distances[previous]) / span)) : 0;
        const a = points[previous] ?? [0, 0], b = points[low] ?? a;
        return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
    }
    return { setAttribute, getPointAtLength, getTotalLength: () => distances[distances.length - 1] ?? 0 };
}
