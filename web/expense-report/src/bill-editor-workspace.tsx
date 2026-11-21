import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { EditorExpansion } from "./transaction-editor-workspace"

type Entry = { id: string; order: number; isNew: boolean; node: ReactNode }
type Props = {
  billId: string; open: boolean; order: number; isNew: boolean; locked: boolean; children: ReactNode
  onClosed?: () => void; onAnchorsChange?: (ids: string[]) => void; editorLabel?: string
}

function BillEditorEntry({ entry, open, locked, onClosed, editorLabel }: {
  entry: Entry; open: boolean; locked: boolean; onClosed: () => void; editorLabel: string
}) {
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => { if (open) setReady(true) }, [open])

  return <section className="bb-bills-editor" aria-label={editorLabel} aria-hidden={!open}
    data-bill-slot={entry.id} data-new={entry.isNew} data-open={open} inert={!open || locked} style={{ order: entry.order }}>
    <EditorExpansion open={open && ready} onCollapsed={onClosed}>{entry.node}</EditorExpansion>
  </section>
}

/** Retain each outgoing row through its collapse, including concurrent opens. */
export function BillEditorWorkspace({ billId, open, order, isNew, locked, children, onClosed, onAnchorsChange, editorLabel = "Bill editor" }: Props) {
  const records = useRef(new Map<string, Entry>()), active = useRef<string | null>(null), root = useRef<HTMLDivElement>(null)
  const [, redraw] = useState(0)
  active.current = open ? billId : null
  if (open) records.current.set(billId, { id: billId, order, isNew, node: children })

  const remove = (id: string) => {
    if (active.current === id || !records.current.delete(id)) return
    redraw(value => value + 1)
    if (!records.current.size) onClosed?.()
  }
  useLayoutEffect(() => {
    const list = root.current?.closest(".bb-bills")
    for (const row of list?.querySelectorAll<HTMLElement>(".bb-bills-row[data-bill-id]") ?? []) {
      row.dataset.editorAnchor = String(records.current.has(row.dataset.billId!))
    }
    onAnchorsChange?.([...records.current.keys()])
  })
  return <div className="bb-bill-editor-workspace" ref={root}>
    {[...records.current.values()].map(entry => <BillEditorEntry key={entry.id} entry={entry}
      open={open && entry.id === billId} locked={locked} editorLabel={editorLabel} onClosed={() => remove(entry.id)} />)}
  </div>
}
