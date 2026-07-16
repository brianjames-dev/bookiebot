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
const DISMISS_CHART_TOOLTIPS_EVENT = "bookiebot-dismiss-chart-tooltips"

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
      <div id={resolvedId} className={cn("bb-chart-container", className)} data-chart={resolvedId} data-graph-surface="true">
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

  if (!active || !rows.length) {
    return null
  }

  return (
    <div className="bb-chart-tooltip bb-touch-tooltip-content" key={signature}>
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
  trigger = "click",
  isAnimationActive = false,
  wrapperStyle,
  ...props
}: ChartTooltipProps) {
  const [resetKey, setResetKey] = React.useState(0)

  React.useEffect(() => {
    const handleDismiss = () => setResetKey((current) => current + 1)
    window.addEventListener(DISMISS_CHART_TOOLTIPS_EVENT, handleDismiss)
    return () => window.removeEventListener(DISMISS_CHART_TOOLTIPS_EVENT, handleDismiss)
  }, [])

  return (
    <RechartsPrimitive.Tooltip
      key={resetKey}
      {...props}
      trigger={trigger}
      isAnimationActive={isAnimationActive}
      allowEscapeViewBox={{ x: true, y: true }}
      wrapperStyle={{
        outline: "none",
        transition: "opacity 160ms ease, transform 160ms ease, visibility 160ms ease",
        ...wrapperStyle,
      }}
    />
  )
}

function dismissChartTooltips() {
  if (typeof window === "undefined") {
    return
  }
  window.dispatchEvent(new Event(DISMISS_CHART_TOOLTIPS_EVENT))
}

export { ChartContainer, ChartTooltip, ChartTooltipContent, dismissChartTooltips }
