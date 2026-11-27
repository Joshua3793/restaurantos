'use client'
import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Flame, Camera, Thermometer, Flag, ClipboardList, ChevronRight } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import { useRc } from '@/contexts/RevenueCenterContext'
import { canAccess } from '@/lib/route-access'
import { ReportSheet } from '@/components/inbox/ReportSheet'

// Window events the ＋ sheet fires when the job's page is ALREADY open: a
// same-route router.push doesn't remount the page, so its ?param check never
// re-runs. The page listens for these instead.
export const QUICKADD_WASTE = 'quickadd:waste'
export const QUICKADD_INVOICE = 'quickadd:invoice'

// Center-＋ launcher. Each action lands on the job itself, not a list:
// waste opens the Log form (?new=1), capture starts the scanner (?capture=1),
// report opens the same Report sheet as the cook's Today screen.
// `href` doubles as the access check (null = everyone, no page to open).
// `event` (when set) replaces the navigation if you're already on that page.
const ACTIONS = [
  { id: 'waste',   label: 'Log waste',        sub: 'Trim, spoilage, comps',  icon: Flame,         href: '/wastage?new=1',     event: QUICKADD_WASTE,   danger: true },
  { id: 'capture', label: 'Capture invoice',  sub: 'Photo → line items',     icon: Camera,        href: '/invoices?capture=1', event: QUICKADD_INVOICE, danger: false },
  { id: 'temps',   label: 'Log temps',        sub: 'Fridges, freezers, hot', icon: Thermometer,   href: '/temps',             event: null,             danger: false },
  { id: 'report',  label: 'Report something', sub: 'Broken, low, unsafe',    icon: Flag,          href: null,                 event: null,             danger: false },
  { id: 'count',   label: 'Start a count',    sub: 'Jump to a storage area', icon: ClipboardList, href: '/count',             event: null,             danger: false },
] as const
type Action = (typeof ACTIONS)[number]

export function QuickAddSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const { role } = useUser()
  const { activeKind, activeRcId } = useRc()
  const [reportOpen, setReportOpen] = useState(false)
  const report = (
    <ReportSheet
      open={reportOpen}
      onClose={() => setReportOpen(false)}
      rcId={activeKind === 'rc' ? activeRcId : null}
    />
  )
  if (!open) return report
  const run = (a: Action) => {
    onClose()
    if (!a.href) { setReportOpen(true); return }
    if (a.event && a.href.split('?')[0] === pathname) window.dispatchEvent(new CustomEvent(a.event))
    else router.push(a.href)
  }
  // Same table the middleware enforces: never offer a launcher STAFF would
  // only be bounced from (capture -> /invoices is LEAD+).
  const actions = ACTIONS.filter(a => a.href == null || role == null || canAccess(role, a.href.split('?')[0]))
  return (
    <>
    {report}
    <div className="md:hidden fixed inset-0 z-[80] flex items-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full bg-paper rounded-t-2xl shadow-xl pb-safe animate-[slide-up_.25s_ease]">
        <div className="flex justify-center pt-2.5"><div className="w-9 h-[5px] rounded-full bg-line-2" /></div>
        <div className="px-5 pt-3 pb-1 text-[18px] font-semibold tracking-[-0.02em]">Quick add</div>
        <div className="font-mono text-[11px] text-ink-3 px-5 pb-3">LOG SOMETHING FAST</div>
        <div className="px-4 pb-6 flex flex-col gap-2">
          {actions.map(a => {
            const Ico = a.icon
            return (
              <button key={a.id} onClick={() => run(a)} className="flex items-center gap-3 w-full text-left bg-paper border border-line rounded-[13px] px-3.5 py-3">
                <span className={`grid place-items-center w-[42px] h-[42px] rounded-xl shrink-0 ${a.danger ? 'bg-red-soft text-red-text' : 'bg-ink text-gold'}`}>
                  <Ico size={20} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[15.5px] font-semibold tracking-[-0.01em]">{a.label}</span>
                  <span className="block font-mono text-[11px] text-ink-3 mt-0.5">{a.sub}</span>
                </span>
                <ChevronRight size={17} className="text-ink-4" />
              </button>
            )
          })}
        </div>
      </div>
    </div>
    </>
  )
}
