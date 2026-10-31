import type { ReactNode } from "react"

// Keep both silhouettes mounted so selection can reverse from its painted
// opacity rather than replacing the SVG in the middle of an interaction.
export function GlassIcon({ selected, outline, solid }: { selected: boolean; outline: ReactNode; solid: ReactNode }) {
  return <span className="bb-glass-icon" data-selected={selected} aria-hidden="true">
    <span className="bb-glass-icon-outline">{outline}</span>
    <span className="bb-glass-icon-solid">{solid}</span>
  </span>
}
