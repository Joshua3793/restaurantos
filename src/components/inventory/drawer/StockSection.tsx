'use client'
import { RcAllocationPanel } from '@/components/inventory/RcAllocationPanel'
import { resolveCountUom } from '@/lib/count-uom'
import {
  baseToDisplay, displayStock, formatDay, itemChainDims, unbridgedAdvice,
  type InventoryItem, type MovementType, type StockMovementsResponse,
} from './types'

/** Revenue-center distribution, last count, theoretical stock, the
 *  reconciliation strip and the movement log. Renders bare siblings (a fragment)
 *  inside the shell's view body. */
export function StockSection({
  item, showRcPanel, defaultRcId, canEdit, onPulled, stockMovements,
}: {
  item: InventoryItem
  /** More than one revenue center exists. */
  showRcPanel: boolean
  defaultRcId: string | null
  canEdit: boolean
  onPulled: () => void
  stockMovements: StockMovementsResponse | null
}) {
  return (
    <>
      {/* Revenue-center distribution — elevated: assigning stock to an RC
          is a primary task, so it sits right under the price, above the
          stock log. */}
      {showRcPanel && (
        <RcAllocationPanel
          itemId={item.id}
          stockOnHand={displayStock(item)}
          countUOM={resolveCountUom(itemChainDims(item)) || item.baseUnit}
          defaultRcId={defaultRcId}
          toDisplay={(base) => baseToDisplay(item, base)}
          readOnly={!canEdit}
          onPulled={onPulled}
        />
      )}

      {/* Stock Overview */}
      <div className="space-y-2">
        <div className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em]">Stock</div>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-paper border border-line rounded-[10px] p-3">
            <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">Last count</div>
            <div className="font-mono text-[15px] font-semibold text-ink tabular-nums mt-1">
              {stockMovements
                ? `${stockMovements.lastCount.qty.toFixed(2)} ${stockMovements.lastCount.unit}`
                : '—'}
            </div>
            <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">
              {stockMovements?.lastCount.date
                ? formatDay(stockMovements.lastCount.dayKey, stockMovements.lastCount.date)
                : 'Never counted'}
            </div>
          </div>
          <div className="bg-bg-2 border border-line rounded-[10px] p-3">
            <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">Theoretical stock</div>
            <div className="font-mono text-[15px] font-semibold text-ink tabular-nums mt-1">
              {stockMovements
                ? `${stockMovements.theoretical.qty.toFixed(2)} ${stockMovements.theoretical.unit}`
                : '—'}
            </div>
            <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">Estimated current</div>
          </div>
        </div>

        {/* Reconciliation strip — the drawer's whole promise on one line:
            last count + additions − consumptions = theoretical. Sent as
            server-side totals because the list below shows only the most
            recent dozen movements, so adding up what's on screen would
            never reach the figure printed above it. */}
        {stockMovements?.reconciliation && (() => {
          const r = stockMovements.reconciliation!
          const n = (v: number) => Math.abs(v).toFixed(2)
          return (
            <div className="bg-paper border border-line rounded-[10px] px-3 py-2">
              <div className="flex items-center flex-wrap gap-x-2 gap-y-1 font-mono text-[11.5px] tabular-nums">
                <span className="text-ink-3">{n(r.opening)}</span>
                <span className="text-green">+{n(r.additions)}</span>
                <span className="text-red">−{n(r.consumptions)}</span>
                {r.adjustment !== 0 && (
                  <span className="text-gold">{r.adjustment > 0 ? '+' : '−'}{n(r.adjustment)}</span>
                )}
                <span className="text-ink-4">=</span>
                <span className="font-semibold text-ink">{n(r.theoretical)} {r.unit}</span>
              </div>
              <div className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.04em] mt-1">
                Last count · added · used{r.adjustment !== 0 ? ' · unexplained' : ''} · on hand
              </div>
              {r.adjustment !== 0 && (
                <div className="text-[11px] text-gold-2 mt-1.5 leading-snug">
                  {r.adjustment > 0
                    ? `${n(r.adjustment)} ${r.unit} more was used than this item was ever counted or recorded receiving — stock ran to zero, so production or deliveries are going unlogged.`
                    : `${n(r.adjustment)} ${r.unit} of the opening balance is not backed by a physical count.`}
                </div>
              )}
            </div>
          )
        })()}

        {/* Movement Log */}
        {stockMovements && stockMovements.movements.length > 0 && (
          <div className="space-y-0.5 mt-1">
            {stockMovements.movements.slice(0, 12).map(m => {
              const isPositive = m.qty >= 0
              // A transfer is a theoretical move between RCs — net-zero globally, so
              // it reads as neutral (no +/− framing) in this all-RC drawer view.
              const isTransfer = m.type === 'TRANSFER'
              const typeConfig: Record<MovementType, { label: string; color: string }> = {
                SALE:     { label: 'Sale',        color: 'text-red' },
                WASTAGE:  { label: 'Wastage',     color: 'text-gold' },
                PREP_IN:  { label: 'Prep (used)', color: 'text-blue' },
                PREP_OUT: { label: 'Prep (yield)',color: 'text-green' },
                PURCHASE: { label: 'Purchase',    color: 'text-blue' },
                TRANSFER: { label: 'Transfer',    color: 'text-ink-3' },
              }
              const cfg = typeConfig[m.type] ?? { label: m.type, color: 'text-ink-3' }
              return (
                <div key={m.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-bg text-[12px] transition-colors">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`shrink-0 font-medium ${cfg.color}`}>{cfg.label}</span>
                    <span className="text-ink-4 truncate">{m.description}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2 font-mono tabular-nums">
                    {m.unbridged ? (
                      <span className="font-semibold text-gold-2" title={`Not counted — ${unbridgedAdvice(m.unbridged.unit, item.baseUnit ?? 'each')}`}>
                        {m.unbridged.qty.toFixed(2)} {m.unbridged.unit} · not counted
                      </span>
                    ) : (
                      <span className={`font-semibold ${isTransfer ? 'text-ink-3' : isPositive ? 'text-green' : 'text-red'}`}>
                        {isTransfer ? '' : isPositive ? '+' : ''}{m.qty.toFixed(2)} {m.unit}
                      </span>
                    )}
                    <span className="text-ink-4 w-14 text-right">
                      {formatDay(m.dayKey, m.date)}
                    </span>
                  </div>
                </div>
              )
            })}
            {stockMovements.movements.length > 12 && (
              <div className="font-mono text-[10.5px] text-ink-4 text-center pt-1">
                + {stockMovements.movements.length - 12} earlier movement{stockMovements.movements.length - 12 === 1 ? '' : 's'} since the last count
              </div>
            )}
            {(stockMovements.reconciliation?.unbridgedCount ?? 0) > 0 && (
              <div className="font-mono text-[10.5px] text-gold-2 text-center pt-1">
                {stockMovements.reconciliation!.unbridgedCount} movement{stockMovements.reconciliation!.unbridgedCount === 1 ? '' : 's'} not counted — {(() => {
                  const firstUnbridged = stockMovements.movements.find(m => m.unbridged)
                  return firstUnbridged?.unbridged
                    ? unbridgedAdvice(firstUnbridged.unbridged.unit, item.baseUnit ?? 'each')
                    : 'tell it how much one each weighs (1 each = ? g) in Edit so they count'
                })()}
              </div>
            )}
          </div>
        )}
        {stockMovements && stockMovements.movements.length === 0 && (
          <div className="text-[12px] text-ink-4 text-center py-2">No movements recorded</div>
        )}
      </div>
    </>
  )
}
