'use client'
import { PageHead } from '@/components/layout/PageHead'

export default function SignalsPage() {
  return (
    <div>
      <PageHead
        crumbs={<span>INSIGHTS / SIGNALS</span>}
        title="Signals"
        sub={<>&ldquo;What should I do&rdquo; — recommendation cards each ending with a verb.</>}
      />
      <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">Phase 7</p>
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink mt-2">Signals engine — coming next</h2>
        <p className="text-[13px] text-ink-3 mt-2 max-w-md mx-auto">
          Five starter rules: price spikes, recipe drift, count overdue, wastage spikes, menu engineering puzzles.
          Each signal: <i>apply / snooze / dismiss</i>.
        </p>
      </div>
    </div>
  )
}
