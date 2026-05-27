'use client'
import { PageHead } from '@/components/layout/PageHead'

export default function VariancePage() {
  return (
    <div>
      <PageHead
        crumbs={<span>INSIGHTS / VARIANCE</span>}
        title="Variance"
        sub={<>Theoretical vs counted, ranked by $. Heatmap by day &amp; category.</>}
      />
      <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">Phase 7</p>
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink mt-2">Variance insights — coming next</h2>
        <p className="text-[13px] text-ink-3 mt-2 max-w-md mx-auto">
          Heatmap by day &amp; category, ranked $ exception table.
          Click any line → drill into the contributing sales / waste / count entries.
        </p>
      </div>
    </div>
  )
}
