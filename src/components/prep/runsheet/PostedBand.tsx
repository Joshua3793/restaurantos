'use client'
// Smart Prep v2 — provenance band above the To Do run sheet: who posted the
// kitchen's list, when, and whether the chef has unposted changes.
import { Check } from 'lucide-react'
import type { PrepPostInfo } from '@/components/prep/types'
import { fmtMins } from '@/lib/prep-runsheet'
import { prepDayKey } from '@/lib/prep-day'

// The list is posted at the end of a shift for the next day and its unfinished
// jobs carry over, so the band has to say WHICH day's list this is — "11:47 PM"
// alone reads as "posted tonight" on a list posted two nights ago.
function whenLabel(postedAt: string, listDate?: string): string {
  const t = new Date(postedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  // `listDate` is a date-only marker at UTC midnight — read the date off it. Run
  // it through the restaurant clock instead and it lands on the previous evening.
  const day = listDate ? listDate.slice(0, 10) : null
  if (!day || day === prepDayKey()) return t
  const yesterday = prepDayKey(new Date(Date.now() - 86_400_000))
  if (day === yesterday) return `${t} yesterday`
  // 'YYYY-MM-DD' is the restaurant day; render it as a date without re-deriving
  // a timezone from it (midday avoids the UTC-parse day shift).
  return `${t} ${new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

export function PostedBand({ post }: { post: PrepPostInfo }) {
  const t = whenLabel(post.postedAt, post.listDate)
  return (
    <div className="flex items-center gap-2.5 bg-ink text-paper rounded-xl px-4 py-2.5 mb-2.5">
      <span className="w-6 h-6 rounded-[7px] bg-[#27272a] grid place-items-center shrink-0"><Check size={13} className="text-green" /></span>
      <span className="text-[13px] font-semibold whitespace-nowrap">Posted list</span>
      <span className="font-mono text-[10px] text-ink-4 truncate">
        {t} · {post.postedByName} · {post.itemCount} item{post.itemCount !== 1 ? 's' : ''} · {fmtMins(post.activeMinutes)} hands-on
      </span>
      <span className="flex-1" />
      {post.dirty && (
        <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] bg-gold-soft text-gold-2 px-2 py-0.5 rounded-full whitespace-nowrap">
          Chef has unposted changes
        </span>
      )}
    </div>
  )
}
