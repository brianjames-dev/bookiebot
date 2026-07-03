import * as React from "react"

import { cn } from "../../lib/utils"

function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bb-card", className)} data-slot="card" {...props} />
}

function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bb-card-header", className)} data-slot="card-header" {...props} />
}

function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bb-card-title", className)} data-slot="card-title" {...props} />
}

function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bb-card-description", className)} data-slot="card-description" {...props} />
}

function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bb-card-content", className)} data-slot="card-content" {...props} />
}

export { Card, CardContent, CardDescription, CardHeader, CardTitle }
