'use client'
import { X, Pencil, Loader2, ClipboardCheck, GitMerge } from 'lucide-react'
import { canonicalUom } from '@/lib/uom'
import { CategoryBadge } from '@/components/CategoryBadge'
import { StockStatus } from '@/components/StockStatus'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import { displayStock, type InventoryItem, type ItemChainForm } from './types'

// ─── Sticky header: name, storage area, actions ──────────────────────────────

export function Header({
  item, editMode, nameValue, onNameChange, saving, onSave, onCancel,
  activeRc, onCount, canMerge, onMerge, canEdit, onEdit, onClose,
}: {
  item: InventoryItem
  editMode: boolean
  /** The edit form's name (edit mode only). */
  nameValue: string
  onNameChange: (name: string) => void
  saving: boolean
  onSave: () => void
  onCancel: () => void
  activeRc: RevenueCenter | null
  onCount: () => void
  canMerge: boolean
  onMerge: () => void
  canEdit: boolean
  onEdit: () => void
  onClose: () => void
}) {
  return (
    <div
      className="sticky top-0 z-10 bg-paper border-b border-line p-5 flex items-center justify-between gap-2"
      style={{ paddingTop: 'calc(1.25rem + env(safe-area-inset-top, 0px))' }}
    >
      <div className="flex-1 min-w-0">
        {editMode ? (
          <input
            value={nameValue}
            onChange={e => onNameChange(e.target.value)}
            disabled={!!item.recipe}
            title={item.recipe ? `Named by the recipe ${item.recipe.name}` : undefined}
            className="w-full font-semibold text-ink border border-line rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gold disabled:bg-bg disabled:text-ink-3"
          />
        ) : (
          <h2 className="font-medium text-ink text-[19px] leading-[1.15] tracking-[-0.02em] truncate">{item.itemName}</h2>
        )}
        {item.storageArea && !editMode && <p className="font-mono text-[10.5px] text-ink-4 uppercase tracking-[0.02em] mt-0.5">{item.storageArea.name}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {editMode ? (
          <>
            <button
              onClick={onSave}
              disabled={saving}
              className="px-3 py-1.5 bg-ink text-paper text-[12px] font-medium rounded-[8px] hover:bg-ink-2 disabled:opacity-50 flex items-center gap-1 transition-colors"
            >
              {saving && <Loader2 size={10} className="animate-spin" />}
              Save
            </button>
            <button onClick={onCancel} className="px-3 py-1.5 border border-line text-[12px] font-medium text-ink-2 rounded-[8px] hover:border-ink-3 transition-colors">Cancel</button>
          </>
        ) : (
          <>
            <button
              onClick={onCount}
              aria-label="Count"
              disabled={!activeRc}
              title={activeRc ? `Quick count (${activeRc.name})` : 'Pick a revenue center to quick-count'}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-line text-[12px] font-medium text-ink-2 rounded-[8px] hover:border-ink-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ClipboardCheck size={12} /><span className="hidden sm:inline">Count</span>
            </button>
            {/* Merge a duplicate into this one (MANAGER+, non-PREP only).
                canMerge default-denies while role is loading and for
                STAFF/LEAD; the merge routes still enforce
                requireSession('MANAGER') server-side regardless. */}
            {canMerge && !item.recipe && (
              <button
                onClick={onMerge}
                title="Merge a duplicate item into this one"
                className="flex items-center gap-1.5 px-3 py-1.5 border border-line text-[12px] font-medium text-ink-2 rounded-[8px] hover:border-ink-3 transition-colors"
              >
                <GitMerge size={12} /> Merge
              </button>
            )}
            {canEdit && (
              <button
                onClick={onEdit}
                aria-label="Edit"
                title="Edit"
                className="flex items-center gap-1.5 px-3 py-1.5 border border-line text-[12px] font-medium text-ink-2 rounded-[8px] hover:border-ink-3 transition-colors"
              >
                <Pencil size={12} /><span className="hidden sm:inline">Edit</span>
              </button>
            )}
          </>
        )}
        <button onClick={onClose} aria-label="Close" className="w-8 h-8 grid place-items-center rounded-[8px] border border-line text-ink-3 hover:border-ink-4 hover:text-ink-2 transition-colors bg-paper"><X size={16} /></button>
      </div>
    </div>
  )
}

// ─── Badges row: category, stock status, allergens, active ───────────────────

export function HeaderBadges({ item }: { item: InventoryItem }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <CategoryBadge category={item.category} />
      <StockStatus stock={displayStock(item)} />
      {item.allergens && item.allergens.length > 0 && item.allergens.map(a => (
        <span key={a} className="px-2 py-0.5 rounded-full text-[11px] bg-gold-soft text-gold-2 font-medium">⚠ {a}</span>
      ))}
      {item.isActive
        ? <span className="px-2 py-0.5 rounded-full text-[11px] bg-green-soft text-green-text font-medium">Active</span>
        : <span className="px-2 py-0.5 rounded-full text-[11px] bg-bg-2 text-ink-4 font-medium">Inactive</span>
      }
    </div>
  )
}

// ─── Fact tiles (the first cells of the view grid) ───────────────────────────

/** Supplier, storage area, recipe, dimension, pricing mode, count unit, barcode —
 *  rendered as bare grid cells (a fragment) inside the shell's two-column grid. */
export function HeaderFacts({ item, c, baseUnit, seesMoney }: {
  item: InventoryItem
  c: ItemChainForm
  baseUnit: string
  seesMoney: boolean
}) {
  const dimLabel = c.dimension === 'MASS' ? 'Weight' : c.dimension === 'VOLUME' ? 'Volume' : 'Count'
  const rows: [string, string][] = item.recipe ? [
    ['Supplier',      item.supplier?.name || '—'],
    ['Storage area',  item.storageArea?.name || '—'],
    ['Linked recipe', item.recipe.name],
    ['Dimension',     `${dimLabel} · ${baseUnit}`],
    ['Count unit',    c.countUnit],
  ] : [
    ['Supplier',       item.supplier?.name || '—'],
    ['Storage area',   item.storageArea?.name || '—'],
    ['Dimension',      `${dimLabel} · ${baseUnit}`],
    ...(seesMoney ? [['Pricing', c.pricing.mode === 'RATE' ? `Rate · per ${canonicalUom(c.pricing.rateUnit)}` : 'Per pack'] as [string, string]] : []),
    ['Count unit',     c.countUnit],
    ...(item.barcode ? [['Barcode', item.barcode] as [string, string]] : []),
  ]
  return (
    <>
      {rows.map(([label, value]) => (
        <div key={label} className="bg-paper border border-line rounded-[10px] p-3">
          <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">{label}</div>
          <div className="font-medium text-ink mt-1 tracking-[-0.005em]">{value}</div>
        </div>
      ))}
    </>
  )
}
