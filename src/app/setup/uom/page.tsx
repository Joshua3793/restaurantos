'use client'
import { Ruler, ArrowRight } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { UOM_GROUPS } from '@/lib/uom'

export default function UomPage() {
  return (
    <div>
      <PageHead
        crumbs={<><Ruler size={12} /> SETUP / UOM &amp; CONVERSIONS</>}
        title="UOM & conversions"
        sub={<>Unit-of-measure groups the app uses to convert between purchase, recipe, and count units.</>}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {UOM_GROUPS.map(group => (
          <section key={group.label} className="bg-paper border border-line rounded-[12px] overflow-hidden">
            <header className="px-[18px] py-3 border-b border-line bg-bg-2">
              <h2 className="text-[15px] font-semibold tracking-[-0.015em]">{group.label}</h2>
              <p className="font-mono text-[10.5px] text-ink-3 mt-0.5">{group.units.length} units</p>
            </header>
            <div className="divide-y divide-line">
              {group.units.map(u => {
                const isBase = u.toBase === 1
                return (
                  <div key={u.label} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-[18px] py-2.5">
                    <div>
                      <div className="text-[13px] text-ink font-medium tracking-[-0.005em]">{u.label}</div>
                      {isBase && <div className="font-mono text-[10px] uppercase tracking-[0.04em] text-gold-2 mt-0.5">Base unit</div>}
                    </div>
                    <div className="font-mono text-[11px] text-ink-3 inline-flex items-center gap-1">
                      <span>1 {u.label}</span>
                      <ArrowRight size={10} />
                    </div>
                    <div className="font-mono text-[12px] text-ink font-medium tabular-nums">{u.toBase.toLocaleString(undefined, { maximumFractionDigits: 4 })} {group.units[0].label}</div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-5 bg-paper border border-line rounded-[12px] p-5">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] mb-2">Conversion inspector</h3>
        <p className="text-[13px] text-ink-2 leading-[1.5] tracking-[-0.005em]">
          The conversion factor is always relative to the group&apos;s base unit (gram, milliliter, or each).
          Recipe costing reads <span className="font-mono text-gold-2">pricePerBaseUnit</span> from the inventory ledger,
          then multiplies by the unit&apos;s factor — so a recipe calling for 250 ml of olive oil at
          $0.012/ml costs $3.00, while the same oil bought by the case (4 × 3 L) was stored once at the base price.
          Adding a unit needs a code change today; a UI for custom conversions is on the roadmap.
        </p>
      </div>
    </div>
  )
}
