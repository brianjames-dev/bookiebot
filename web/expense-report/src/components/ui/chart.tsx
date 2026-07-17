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
const ChartInteractionContext = React.createContext(0)
const TOOLTIP_LAST_TRANSFORM_ATTRIBUTE = "data-bb-last-transform"

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
  const [interactionRevision, setInteractionRevision] = React.useState(0)

  const handlePointerDownCapture = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return
    }
    setInteractionRevision((revision) => revision + 1)
  }, [])

  return (
    <ChartContext.Provider value={config}>
      <ChartInteractionContext.Provider value={interactionRevision}>
        <div
          id={resolvedId}
          className={cn("bb-chart-container", className)}
          data-chart={resolvedId}
          onPointerDownCapture={handlePointerDownCapture}
        >
          <ChartStyle id={resolvedId} config={config} />
          {children}
        </div>
      </ChartInteractionContext.Provider>
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

  if (!active || !rows.length) {
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

type ChartTooltipProps = React.ComponentProps<typeof RechartsPrimitive.Tooltip> & {
  dismissDelay?: number
}

type ChartTooltipRenderProps = {
  active?: boolean
  payload?: unknown[]
  label?: unknown
  [key: string]: unknown
}

function ChartTooltipAutoDismissContent({
  content,
  dismissDelay,
  active,
  payload,
  label,
  ...props
}: {
  content: React.ReactElement<ChartTooltipRenderProps>
  dismissDelay: number
} & ChartTooltipRenderProps) {
  const interactionRevision = React.useContext(ChartInteractionContext)
  const [phase, setPhase] = React.useState<"hidden" | "visible" | "dismissing">("hidden")
  const signature = React.useMemo(() => chartTooltipSignature(label, payload), [label, payload])
  const frameRef = React.useRef<HTMLDivElement | null>(null)
  const wrapperRef = React.useRef<HTMLDivElement | null>(null)

  React.useLayoutEffect(() => {
    const renderedWrapper = frameRef.current?.parentElement
    const wrapper = renderedWrapper instanceof HTMLDivElement ? renderedWrapper : wrapperRef.current
    if (!wrapper) {
      return
    }
    wrapperRef.current = wrapper

    const currentTransform = wrapper.style.transform.trim()
    if (active) {
      if (currentTransform && currentTransform !== "none") {
        wrapper.setAttribute(TOOLTIP_LAST_TRANSFORM_ATTRIBUTE, currentTransform)
      }
      return
    }

    const lastTransform = wrapper.getAttribute(TOOLTIP_LAST_TRANSFORM_ATTRIBUTE)
    if (lastTransform && (!currentTransform || currentTransform === "none")) {
      // Recharts drops transform when the pointer briefly leaves a data point.
      // Retaining the last anchor prevents the next tooltip from animating out of (0, 0).
      wrapper.style.transform = lastTransform
    }
  })

  React.useEffect(() => {
    if (!active) {
      setPhase("hidden")
      return undefined
    }

    setPhase("visible")
    const dismissTimer = window.setTimeout(() => {
      setPhase("dismissing")
    }, dismissDelay)
    const hideTimer = window.setTimeout(() => {
      setPhase("hidden")
    }, dismissDelay + 180)

    return () => {
      window.clearTimeout(dismissTimer)
      window.clearTimeout(hideTimer)
    }
  }, [active, dismissDelay, interactionRevision, signature])

  if (!active || phase === "hidden") {
    return null
  }

  return (
    <div
      ref={frameRef}
      className={cn("bb-chart-tooltip-frame", phase === "dismissing" && "bb-chart-tooltip-frame-dismissing")}
    >
      {React.cloneElement(content, {
        ...props,
        active,
        payload,
        label,
      })}
    </div>
  )
}

function chartTooltipSignature(label: unknown, payload: unknown[] | undefined) {
  const payloadSignature = Array.isArray(payload)
    ? payload
        .map((item) => {
          if (!item || typeof item !== "object") {
            return String(item ?? "")
          }
          const row = item as Record<string, unknown>
          const rowPayload = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {}
          return [
            row.dataKey,
            row.name,
            row.value,
            row.color,
            rowPayload.label,
            rowPayload.day,
            rowPayload.amount,
          ]
            .map((value) => String(value ?? ""))
            .join(":")
        })
        .join("|")
    : ""
  return `${String(label ?? "")}:${payloadSignature}`
}

function ChartTooltip({
  isAnimationActive = true,
  animationDuration = 180,
  animationEasing = "ease-out",
  content,
  dismissDelay = 5000,
  wrapperStyle,
  ...props
}: ChartTooltipProps) {
  const tooltipContent = React.isValidElement<ChartTooltipRenderProps>(content) ? (
    <ChartTooltipAutoDismissContent content={content} dismissDelay={dismissDelay} />
  ) : (
    content
  )

  return (
    <RechartsPrimitive.Tooltip
      {...props}
      content={tooltipContent}
      isAnimationActive={isAnimationActive}
      animationDuration={animationDuration}
      animationEasing={animationEasing}
      wrapperStyle={{
        outline: "none",
        transition: "transform 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease-out, visibility 140ms ease-out",
        ...wrapperStyle,
      }}
    />
  )
}

export { ChartContainer, ChartTooltip, ChartTooltipContent }
