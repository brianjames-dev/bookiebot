import { type AnimationInterpolateFn, type BarRectangleItem, type BarShapeProps, type PieSectorDataItem, type PieSectorShapeProps } from "recharts"

type PieGeometry = Pick<PieSectorDataItem, "startAngle" | "endAngle">
type BarGeometry = Pick<BarRectangleItem, "x" | "y" | "width" | "height">
export type AnimatedPieSector = PieSectorShapeProps & { animationGeometry?: PieGeometry }
type AnimatedBarRectangle = BarRectangleItem & { animationGeometry?: BarGeometry }

const interpolate = (from: number, to: number, progress: number) => Math.round((from + (to - from) * progress) * 10000) / 10000 + 0

// Recharts' public interpolation/shape APIs let us keep the original motion
// while retaining target coordinates as stable SVG identity. Only the shape
// reads animationGeometry. Save that geometry in returned items so an interrupted
// animation resumes from its visible position instead of its previous target.
// https://recharts.github.io/en-US/guide/animations/
export const stablePieAnimation: AnimationInterpolateFn<PieSectorDataItem, "centric" | "radial"> = (items, progress) => {
  if (!items) return []
  let angle = items.find(item => item.status !== "removed")?.next.startAngle ?? 0
  return items.flatMap((item, index) => {
    if (item.status === "removed") return []
    const next = item.next
    const previous = item.status === "matched" ? (item.prev as AnimatedPieSector).animationGeometry ?? item.prev : null
    const span = interpolate(previous ? previous.endAngle - previous.startAngle : 0, next.endAngle - next.startAngle, progress)
    const padding = index > 0 ? next.paddingAngle ?? 0 : 0
    const startAngle = angle + padding
    angle = angle + span + padding
    return [{ ...next, animationGeometry: { startAngle, endAngle: angle } }]
  })
}

export const stableBarAnimation: AnimationInterpolateFn<BarRectangleItem, "horizontal" | "vertical"> = (items, progress, layout) => {
  if (!items) return []
  return items.flatMap(item => {
    if (progress === 1) return item.status === "removed" ? [] : [item.next]
    const next = item.status === "removed" ? item.prev : item.next
    const previous = item.status === "added" ? null : (item.prev as AnimatedBarRectangle).animationGeometry ?? item.prev
    let geometry: BarGeometry
    if (item.status === "removed" && previous) {
      geometry = layout === "horizontal"
        ? { ...previous, height: interpolate(previous.height, 0, progress), y: interpolate(previous.y, previous.y + previous.height, progress) }
        : { ...previous, width: interpolate(previous.width, 0, progress) }
    } else if (previous) {
      geometry = { x: interpolate(previous.x, next.x, progress), y: interpolate(previous.y, next.y, progress),
        width: interpolate(previous.width, next.width, progress), height: interpolate(previous.height, next.height, progress) }
    } else {
      geometry = layout === "horizontal"
        ? { x: next.x, width: next.width, height: interpolate(0, next.height, progress), y: interpolate(next.stackedBarStart, next.y, progress) }
        : { y: next.y, height: next.height, width: interpolate(0, next.width, progress), x: interpolate(next.stackedBarStart, next.x, progress) }
    }
    return [{ ...next, animationGeometry: geometry }]
  })
}

export function stableBarShape(props: unknown) {
  const rectangle = props as BarShapeProps & AnimatedBarRectangle & { "data-recharts-item-index"?: number; "data-recharts-item-id"?: string }
  const { x, y, width, height } = rectangle.animationGeometry ?? rectangle
  if (![x, y, width, height].every(Number.isFinite) || !width || !height) return null
  const corner = Array.isArray(rectangle.radius) ? rectangle.radius[0] : rectangle.radius ?? 0
  const radius = Math.min(corner, Math.abs(width) / 2, Math.abs(height) / 2)
  // Daily Spending has the same radius on every corner. A native rect
  // preserves that shape without per-frame path construction or shape hooks.
  return <rect className="recharts-rectangle" x={Math.min(x, x + width)} y={Math.min(y, y + height)}
    width={Math.abs(width)} height={Math.abs(height)} rx={radius} ry={radius}
    fill={rectangle.fill} stroke={rectangle.stroke} strokeWidth={rectangle.strokeWidth}
    data-recharts-item-index={rectangle["data-recharts-item-index"]} data-recharts-item-id={rectangle["data-recharts-item-id"]} />
}

type SectorGeometry = Pick<PieSectorShapeProps, "cx" | "cy" | "innerRadius" | "outerRadius" | "startAngle" | "endAngle">
const roundCoordinate = (value: number) => Math.round(value * 10000) / 10000 + 0

export function pieSectorPath({ cx, cy, innerRadius, outerRadius, startAngle, endAngle }: SectorGeometry) {
  if (outerRadius < innerRadius || startAngle === endAngle) return ""
  const delta = Math.sign(endAngle - startAngle) * Math.min(Math.abs(endAngle - startAngle), 359.999)
  const end = startAngle + delta
  const radians = -Math.PI / 180
  const startCos = Math.cos(radians * startAngle), startSin = Math.sin(radians * startAngle)
  const endCos = Math.cos(radians * end), endSin = Math.sin(radians * end)
  const point = (radius: number, cos: number, sin: number) => `${roundCoordinate(cx + radius * cos)},${roundCoordinate(cy + radius * sin)}`
  const large = +(Math.abs(delta) > 180), sweep = +(startAngle > end)
  let path = `M${point(outerRadius, startCos, startSin)}A${roundCoordinate(outerRadius)},${roundCoordinate(outerRadius)},0,${large},${sweep},${point(outerRadius, endCos, endSin)}`
  path += innerRadius > 0
    ? `L${point(innerRadius, endCos, endSin)}A${roundCoordinate(innerRadius)},${roundCoordinate(innerRadius)},0,${large},${1 - sweep},${point(innerRadius, startCos, startSin)}Z`
    : `L${roundCoordinate(cx)},${roundCoordinate(cy)}Z`
  return path
}

// This chart uses square-ended annular sectors. Reuse the unit vectors for
// inner/outer points and pass only the chart's SVG/interaction properties.
export function StablePieSector(props: SectorGeometry & Pick<PieSectorShapeProps,
  "fill" | "stroke" | "tabIndex" | "role" | "aria-label" | "aria-hidden" | "onClick" | "onKeyDown" |
  "data-recharts-item-index" | "data-recharts-item-id">) {
  const d = pieSectorPath(props)
  if (!d) return null
  return <path className="recharts-sector" d={d} fill={props.fill} stroke={props.stroke}
    tabIndex={props.tabIndex} role={props.role} aria-label={props["aria-label"]} aria-hidden={props["aria-hidden"]}
    onClick={props.onClick} onKeyDown={props.onKeyDown}
    data-recharts-item-index={props["data-recharts-item-index"]} data-recharts-item-id={props["data-recharts-item-id"]} />
}
