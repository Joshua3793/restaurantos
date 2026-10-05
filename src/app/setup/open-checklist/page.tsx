'use client'
import { Sunrise } from 'lucide-react'
import { ChecklistSetup } from '../eod-checklist/ChecklistSetup'
import type { ChecklistItem } from '../eod-checklist/editor'

// Stable identity: ChecklistSetup's loader depends on it.
const listItems = (d: unknown) => ((d as { items?: ChecklistItem[] } | null)?.items ?? [])

export default function OpenChecklistPage() {
  return (
    <ChecklistSetup
      apiBase="/api/open-checklist"
      listItems={listItems}
      crumbs={<><Sunrise size={12} /> SETUP / OPENING CHECKLIST</>}
      title="Opening checklist"
      sub={<>What the kitchen does before doors. Cooks tick it on their start page each day; it resets every morning.</>}
      blockerShort="Before doors"
      blockerLabel="Must be done before doors (shows red until ticked)"
    />
  )
}
