import {useState} from 'react'
import {ChevronDown} from 'lucide-react'

export function CategoryFilterControl<Filter extends string>({
  filter, onFilterChange, filters, label, dismissTrigger,
}: {
  filter: Filter
  onFilterChange: (filter: Filter) => void
  filters: Array<{ value: Filter; label: string }>
  label: string
  dismissTrigger: string
}) {
  const [pointerFocus, setPointerFocus] = useState(false)
  return (
    <div className="bb-category-mix-filter" data-bb-tooltip-dismiss-trigger={dismissTrigger} data-pointer-focus={pointerFocus ? "true" : undefined}>
      <span className="bb-category-filter-label" aria-hidden="true">{filters.find(item => item.value === filter)?.label}</span>
      <select aria-label={label} value={filter}
        onPointerDown={() => setPointerFocus(true)} onKeyDown={() => setPointerFocus(false)} onBlur={() => setPointerFocus(false)}
        onChange={(event) => onFilterChange(event.target.value as Filter)}>
        {filters.map((item) => (
          <option key={item.value} value={item.value}>{item.label}</option>
        ))}
      </select>
      <ChevronDown className="bb-category-filter-chevron" aria-hidden="true" />
    </div>
  )
}
