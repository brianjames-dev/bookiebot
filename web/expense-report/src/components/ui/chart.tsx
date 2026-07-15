import * as React from "react"
import * as RechartsPrimitive from "recharts"

import { cn } from "../../lib/utils"

export type ChartConfig = Record<
  string,
  {
    label: string
    color: string
  }
>

const ChartContext = React.createContext<ChartConfig | null>(null)

function ChartContainer({
  id,
  className,
  config,
  children,
}: React.HTMLAttributes<HTMLDivElement> & {
  config: ChartConfig
  children: React.ReactNode
}) {
  const chartId = React.useId()
  const resolvedId = `chart-${id || chartId.replace(/:/g, "")}`

  return (
    <ChartContext.Provider value={config}>
      <div id={resolvedId} className={cn("bb-chart-container", className)} data-chart={resolvedId}>
        <ChartStyle id={resolvedId} config={config} />
        {children}
      </div>
    </ChartContext.Provider>
  )
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorConfig = Object.entries(config).filter(([, item]) => item.color)
  if (!colorConfig.length) {
    return null
  }

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: colorConfig
          .map(([key, item]) => `[data-chart=${id}] { --color-${key}: ${item.color}; }`)
          .join("\n"),
      }}
    />
  )
}

type ChartTooltipPayload = {
  name?: string | number
  value?: string | number | null
  color?: string
}

const TOUCH_TOOLTIP_DISMISS_MS = 3000

function useTouchTooltipVisibility(active?: boolean, signature?: string) {
  const [isTouchPointer, setIsTouchPointer] = React.useState(false)
  const [visible, setVisible] = React.useState(Boolean(active))

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return undefined
    }

    const media = window.matchMedia("(hover: none), (pointer: coarse)")
    const handleChange = () => setIsTouchPointer(media.matches)
    handleChange()
    if (media.addEventListener) {
      media.addEventListener("change", handleChange)
      return () => media.removeEventListener("change", handleChange)
    }
    media.addListener(handleChange)
    return () => media.removeListener(handleChange)
  }, [])

  React.useEffect(() => {
    if (!active) {
      setVisible(false)
      return undefined
    }

    setVisible(true)
    if (!isTouchPointer) {
      return undefined
    }

    const timeout = window.setTimeout(() => {
      setVisible(false)
    }, TOUCH_TOOLTIP_DISMISS_MS)
    return () => window.clearTimeout(timeout)
  }, [active, isTouchPointer, signature])

  return Boolean(active && visible)
}

function ChartTooltipContent({
  active,
  payload,
}: {
  active?: boolean
  payload?: ChartTooltipPayload[]
}) {
  const rows = (payload ?? []).reduce<ChartTooltipPayload[]>((dedupedRows, item) => {
    if (item.value === null || item.value === undefined) {
      return dedupedRows
    }
    const alreadyShown = dedupedRows.some((row) => row.name === item.name && row.value === item.value && row.color === item.color)
    if (!alreadyShown) {
      dedupedRows.push(item)
    }
    return dedupedRows
  }, [])
  const signature = rows.map((item) => `${item.name ?? ""}:${item.value ?? ""}:${item.color ?? ""}`).join("|")
  const visible = useTouchTooltipVisibility(active, signature)

  if (!visible || !rows.length) {
    return null
  }

  return (
    <div className="bb-chart-tooltip bb-touch-tooltip-content">
      {rows.map((item: ChartTooltipPayload, index) => (
        <div className="bb-chart-tooltip-row" key={`${item.name}-${item.value}-${index}`}>
          <span className="bb-chart-tooltip-dot" style={{ background: item.color }} />
          <span>{item.name}</span>
          <strong>{formatMoney(Number(item.value || 0))}</strong>
        </div>
      ))}
    </div>
  )
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value)
}

type ChartTooltipProps = React.ComponentProps<typeof RechartsPrimitive.Tooltip>

function ChartTooltip({
  isAnimationActive = false,
  wrapperStyle,
  ...props
}: ChartTooltipProps) {
  return (
    <RechartsPrimitive.Tooltip
      {...props}
      isAnimationActive={isAnimationActive}
      wrapperStyle={{
        outline: "none",
        transition: "none",
        ...wrapperStyle,
      }}
    />
  )
}

export { ChartContainer, ChartTooltip, ChartTooltipContent }
export { useTouchTooltipVisibility }
