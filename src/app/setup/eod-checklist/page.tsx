'use client'
import { ClipboardCheck } from 'lucide-react'
import { ChecklistSetup } from './ChecklistSetup'

export default function EodChecklistPage() {
  return (
    <ChecklistSetup
      apiBase="/api/eod/checklist"
      crumbs={<><ClipboardCheck size={12} /> SETUP / END-OF-DAY CHECKLIST</>}
      title="End-of-day checklist"
      sub={<>Close-down checklist items per revenue center — used by the End-of-day close flow.</>}
    />
  )
}
