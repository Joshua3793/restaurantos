'use client'
import { useRouter } from 'next/navigation'
import { Flame, Camera, Barcode, ClipboardList, ChevronRight } from 'lucide-react'

// Center-＋ launcher. Until later phases land, actions route to the closest
// existing screen (waste→/wastage, capture→/invoices, scan→/inventory, count→/count).
const ACTIONS = [
  { id: 'waste',   label: 'Log waste',       sub: 'Trim, spoilage, comps',  icon: Flame,         href: '/wastage',  danger: true },
  { id: 'capture', label: 'Capture invoice', sub: 'Photo → line items',     icon: Camera,        href: '/invoices', danger: false },
  { id: 'scan',    label: 'Scan an item',    sub: 'Barcode lookup',         icon: Barcode,       href: '/inventory', danger: false },
  { id: 'count',   label: 'Start a count',   sub: 'Jump to a storage area', icon: ClipboardList, href: '/count',    danger: false },
] as const

export function QuickAddSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  if (!open) return null
  const run = (href: string) => { onClose(); router.push(href) }
  return (
    <div className="md:hidden fixed inset-0 z-[80] flex items-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full bg-paper rounded-t-2xl shadow-xl pb-safe animate-[slide-up_.25s_ease]">
        <div className="flex justify-center pt-2.5"><div className="w-9 h-[5px] rounded-full bg-line-2" /></div>
        <div className="px-5 pt-3 pb-1 text-[18px] font-semibold tracking-[-0.02em]">Quick add</div>
        <div className="font-mono text-[11px] text-ink-3 px-5 pb-3">LOG SOMETHING FAST</div>
        <div className="px-4 pb-6 flex flex-col gap-2">
          {ACTIONS.map(a => {
            const Ico = a.icon
            return (
              <button key={a.id} onClick={() => run(a.href)} className="flex items-center gap-3 w-full text-left bg-paper border border-line rounded-[13px] px-3.5 py-3">
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
  )
}
