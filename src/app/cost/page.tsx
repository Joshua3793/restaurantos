'use client'
import { PageHead } from '@/components/layout/PageHead'

export default function CostPage() {
  return (
    <div>
      <PageHead
        crumbs={<span>INSIGHTS / COST</span>}
        title="Cost"
        sub={<>Food-cost % trend, top drivers, recipe drift — every row ends with a verb.</>}
      />
      <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">Phase 7</p>
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink mt-2">Cost insights — coming next</h2>
        <p className="text-[13px] text-ink-3 mt-2 max-w-md mx-auto">
          Food-cost % trend chart, top drivers table, recipe drift table with verb-CTAs on every row.
          The cost chrome at the top already reads from the same spine.
        </p>
      </div>
    </div>
  )
}
