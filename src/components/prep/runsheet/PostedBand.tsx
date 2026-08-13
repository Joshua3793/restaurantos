'use client'
// Smart Prep v2 — provenance band above the To Do run sheet: who posted the
// kitchen's list, when, and whether the chef has unposted changes.
import { Check } from 'lucide-react'
import type { PrepPostInfo } from '@/components/prep/types'
import { fmtMins } from '@/lib/prep-runsheet'

export function PostedBand({ post }: { post: PrepPostInfo }) {
  const t = new Date(post.postedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
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
