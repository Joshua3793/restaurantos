'use client'
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { DIMENSION_BASE, pricePerBaseUnit, type Dimension } from '@/lib/item-model'
import { SupplierWordingsSection } from './SupplierWordingsSection'
import { QuickCountSheet } from './QuickCountSheet'
import { MergeItemSheet } from './MergeItemSheet'
import { RemeasureSheet } from './RemeasureSheet'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { atLeast } from '@/lib/roles'
import { seesItemMoney, canEditItems } from '@/lib/inventory-redact'
import {
  Header, HeaderBadges, HeaderFacts, PackChainReadout, PriceBlock, BridgesSection,
  CostBasisBlock, StockSection, BoxesSection, HistorySection, ItemEditForm,
  DEFAULT_CHAIN, DEFAULT_PRICING, buildEditForm, chainChanged, chainFromItem, normalizeItem,
  type EditForm, type InventoryItem, type PriceHistoryRow, type StockMovementsResponse,
} from './drawer'

// The item drawer's shell: data loading, edit mode and saving, the sheets, and
// the order of the sections. Each section lives in ./drawer/ and takes explicit props.

interface Props {
  itemId: string
  onClose: () => void
  onUpdated?: (updatedItem?: InventoryItem) => void
  zClassName?: string
  initialEditMode?: boolean
}

// ─── Main component ────────────────────────────────────────────────────────────

export function InventoryItemDrawer({ itemId, onClose, onUpdated, zClassName = 'z-50', initialEditMode = false }: Props) {
  const { revenueCenters, activeRc } = useRc()
  const defaultRcId = revenueCenters.find(rc => rc.isDefault)?.id ?? null
  // Default-deny: `role` is null while /api/me is in flight (same pattern as
  // /app/inventory/page.tsx's canExport) — render nothing until it resolves,
  // never assume MANAGER. Merge's GET (MergedItemsRow) and POST are both
  // requireSession('MANAGER') server-side; this just avoids showing a STAFF
  // user a control (and a 403) they can't use.
  const { role } = useUser()
  const canMerge = role !== null && atLeast(role, 'MANAGER')
  // Same default-deny. STAFF never sees a price (the API nulls them anyway);
  // below MANAGER the drawer is view-only — the item routes refuse the edit
  // server-side, this just keeps the controls out of reach.
  const seesMoney = role !== null && seesItemMoney(role)
  const canEdit = role !== null && canEditItems(role)

  const [item, setItem] = useState<InventoryItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [showQuick, setShowQuick] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeTick, setMergeTick] = useState(0)
  const [remeasureOpen, setRemeasureOpen] = useState(false)
  const [measureTick, setMeasureTick] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editForm, setEditForm] = useState<EditForm>({
    itemName: '', category: '',
    storageAreaId: '', storageAreaName: '',
    dimension: 'COUNT', chain: [...DEFAULT_CHAIN], pricing: { ...DEFAULT_PRICING },
    countUnit: 'each',
    isActive: true, isStocked: true, allergens: [], barcode: null,
    eachMeasureQty: null, eachMeasureUnit: 'g',
    densityGPerMl: null,
  })
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [storageAreas, setStorageAreas] = useState<{ id: string; name: string }[]>([])
  const [priceHistory, setPriceHistory] = useState<PriceHistoryRow[]>([])
  const [stockMovements, setStockMovements] = useState<StockMovementsResponse | null>(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetch(`/api/inventory/${itemId}`).then(r => r.json()),
      fetch('/api/categories').then(r => r.json()),
      fetch('/api/storage-areas').then(r => r.json()),
      // LEAD+ only server-side — a STAFF 403 must land as an empty list, not an error body.
      fetch(`/api/inventory/${itemId}/price-history`).then(r => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`/api/inventory/${itemId}/stock-movements`).then(r => r.json()).catch(() => null),
    ]).then(([fetchedItem, cats, areas, ph, sm]) => {
      const normalized = normalizeItem(fetchedItem)
      setItem(normalized)
      setCategories(cats)
      setStorageAreas(areas)
      setPriceHistory(ph)
      setStockMovements(sm)
      setLoading(false)
    })
  }, [itemId])

  // initialEditMode (the recipe editor's quick-edit) opens straight into the
  // form — once, and only for someone who may edit. Its own effect because the
  // role can resolve after the item does.
  const appliedInitialEdit = useRef(false)
  useEffect(() => {
    if (!initialEditMode || appliedInitialEdit.current || !item || !canEdit) return
    appliedInitialEdit.current = true
    setEditForm(buildEditForm(item))
    setEditMode(true)
  }, [initialEditMode, item, canEdit])

  const openEdit = () => {
    if (!item) return
    setEditForm(buildEditForm(item))
    setEditMode(true)
  }

  // R8 — someone else saved this item since the form loaded: reload the row and
  // rebuild the form from it, staying in edit mode.
  const reloadForEdit = async () => {
    if (!item) return
    const fresh = await fetch(`/api/inventory/${item.id}`).then(r => (r.ok ? r.json() : null)).catch(() => null)
    if (!fresh) return
    const n = normalizeItem(fresh)
    setItem(n)
    setEditForm(buildEditForm(n))
    setEditMode(true)
  }

  /** A save was refused: a clash reloads; anything else shows the server's words. */
  const saveFailed = async (res: Response) => {
    const err = await res.json().catch(() => null)
    if (res.status === 409 && err?.code === 'STALE') {
      alert('Someone saved this item a moment ago. Reloading… Your unsaved edits here were replaced by the latest version.')
      await reloadForEdit()
      return
    }
    alert(err?.error ?? `Save failed (${res.status}). Please try again.`)
  }

  const handleSave = async () => {
    if (!item) return
    // R3/R4 — the measure, pack and price are the item's own only while it has
    // no supplier box and no recipe; they save through the pricing route, after
    // the item edit, naming the version that edit returned. When they change,
    // the count unit rides with them (it may name a pack level the new chain adds,
    // which the item edit — validated against the STORED chain — would refuse).
    const patchPricing = !item.recipe && (item.offerCount ?? 0) === 0 && chainChanged(item, editForm)
    // R1 — the item edit takes these keys and nothing else (no stock, no chain).
    // R6 — a recipe-made item's name, allergens and count unit belong to the
    // recipe: they are not sent at all (the form's count unit is the RESOLVED
    // one, which can differ from the stored value and would read as a change).
    const prep = !!item.recipe
    const body: Record<string, unknown> = {
      ...(prep ? {} : { itemName: editForm.itemName, allergens: editForm.allergens }),
      category: editForm.category,
      storageAreaId: editForm.storageAreaId || null,
      isActive: editForm.isActive,
      isStocked: editForm.isStocked,
      barcode: editForm.barcode,
      ...(prep || patchPricing ? {} : { countUnit: editForm.countUnit }),
      // Count↔weight bridge ("1 each = N g/ml") and the density bridge.
      eachMeasureQty: editForm.eachMeasureQty,
      eachMeasureUnit: editForm.eachMeasureUnit,
      densityGPerMl: editForm.densityGPerMl,
      expectedLastUpdated: item.lastUpdated,
    }
    const put = (dryRun: boolean) => fetch(`/api/inventory/${item.id}${dryRun ? '?dryRun=1' : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    setSaving(true)
    try {
      // R7 — clearing "1 each = ? g" zeroes every recipe that costs this item by
      // weight through it. Ask first, naming them.
      const clearsBridge = item.eachMeasureQty != null && Number(item.eachMeasureQty) > 0
        && !(Number(editForm.eachMeasureQty) > 0)
      if (clearsBridge) {
        const dry = await put(true)
        if (!dry.ok) { await saveFailed(dry); return }
        const { bridgeUsedBy = [] } = (await dry.json()) as { bridgeUsedBy?: { name: string }[] }
        const names = bridgeUsedBy.map(r => r.name)
        const n = names.length
        if (n > 0 && !confirm(`${names.join(', ')} use${n === 1 ? 's' : ''} this item by weight. Without "1 each = ? g" they will cost $0 until fixed. Remove it anyway?`)) return
      }

      const res = await put(false)
      if (!res.ok) { await saveFailed(res); return }
      let updated = await res.json()

      if (patchPricing) {
        const pr = await fetch(`/api/inventory/${item.id}/pricing`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dimension: editForm.dimension,
            packChain: editForm.chain,
            pricing: editForm.pricing,
            countUnit: editForm.countUnit,
            expectedLastUpdated: updated.lastUpdated,
          }),
        })
        if (!pr.ok) {
          // The item edit landed — keep its row (and its new version) so a retry
          // names the right one; the form keeps the price being fixed.
          const kept = normalizeItem({ ...item, ...updated, supplier: updated.supplier, storageArea: updated.storageArea })
          setItem(kept)
          onUpdated?.(kept)
          await saveFailed(pr)
          return
        }
        updated = await pr.json()
      }

      const next = normalizeItem({ ...item, ...updated, supplier: updated.supplier, storageArea: updated.storageArea })
      setItem(next)
      setEditMode(false)
      onUpdated?.(next)
    } finally {
      setSaving(false)
    }
  }

  // The same refetch SupplierOffersSection's onRepriced already performs —
  // shared so a merge (which can move offers, recipe lines, count lines, etc.
  // onto this item) refreshes the drawer the same way a re-price does.
  function refreshItem(): Promise<void> {
    if (!item) return Promise.resolve()
    const p = fetch(`/api/inventory/${item.id}`).then(r => r.json()).then(d => { setItem(normalizeItem(d)) })
    onUpdated?.()
    return p
  }

  // A measure change (or its undo) rewrites the item's measure, pack, price,
  // bridge, stock, supplier boxes and every frozen count/receipt — so besides
  // the shared refetch, the stock panel is re-read (its units changed), the
  // supplier boxes and the undo row re-load (measureTick), and the edit form is
  // brought up to date:
  //  - 'measure' (this user's own apply or undo): only the measure fields are
  //    re-seeded — the rest of an open form is the user's unsaved typing — or
  //    its Save would write the old measure + bridge straight back.
  //  - 'rebuild' (STALE: someone else changed the item first): the whole form is
  //    rebuilt from the fresh row, as reloadForEdit does.
  async function afterRemeasure(mode: 'measure' | 'rebuild' = 'measure'): Promise<void> {
    if (!item) return
    const [fresh, sm] = await Promise.all([
      fetch(`/api/inventory/${item.id}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/inventory/${item.id}/stock-movements`).then(r => (r.ok ? r.json() : null)).catch(() => null),
    ])
    onUpdated?.()
    if (sm) setStockMovements(sm)
    if (fresh) {
      const n = normalizeItem(fresh)
      setItem(n)
      const b = buildEditForm(n)
      if (mode === 'rebuild') setEditForm(b)
      else setEditForm(f => ({
        ...f,
        dimension: b.dimension, chain: b.chain, pricing: b.pricing, countUnit: b.countUnit,
        eachMeasureQty: b.eachMeasureQty, eachMeasureUnit: b.eachMeasureUnit, densityGPerMl: b.densityGPerMl,
      }))
    }
    // After the fresh row lands, so the re-mounted boxes read the new measure.
    setMeasureTick(t => t + 1)
  }

  return (
    <div className={`fixed inset-0 ${zClassName} flex items-end sm:items-stretch sm:justify-end`} onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div
        className="relative bg-bg w-full max-w-[100vw] sm:max-w-md h-[92vh] sm:h-full overflow-y-auto overflow-x-hidden shadow-2xl rounded-t-2xl sm:rounded-none"
        onClick={e => e.stopPropagation()}
      >
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 size={24} className="animate-spin text-line-2" />
          </div>
        ) : !item ? (
          <div className="flex items-center justify-center h-48 text-ink-4 text-sm">Item not found</div>
        ) : (
          <>
            <Header
              item={item}
              editMode={editMode}
              nameValue={editForm.itemName}
              onNameChange={itemName => setEditForm(f => ({ ...f, itemName }))}
              saving={saving}
              onSave={handleSave}
              onCancel={() => setEditMode(false)}
              activeRc={activeRc}
              onCount={() => setShowQuick(true)}
              canMerge={canMerge}
              onMerge={() => setMergeOpen(true)}
              canEdit={canEdit}
              onEdit={openEdit}
              onClose={onClose}
            />

            {editMode ? (
              <ItemEditForm
                item={item}
                editForm={editForm}
                setEditForm={setEditForm}
                categories={categories}
                onCategoriesChange={setCategories}
                storageAreas={storageAreas}
                onStorageAreasChange={setStorageAreas}
                canEdit={canEdit}
                activeRc={activeRc}
                onCount={() => setShowQuick(true)}
                onRemeasure={() => setRemeasureOpen(true)}
              />
            ) : (
              <div className="p-4 space-y-4">
                <HeaderBadges item={item} />

                {(() => {
                  const c = chainFromItem(item)
                  const ci = {
                    dimension: c.dimension, baseUnit: DIMENSION_BASE[c.dimension], packChain: c.chain,
                    pricing: c.pricing, countUnit: c.countUnit,
                    // Bridges — without them a bridged RATE (e.g. $/lb on an `each`
                    // item) reads as $0 here even though it prices fine elsewhere.
                    eachMeasure: item.eachMeasureQty != null
                      ? { qty: Number(item.eachMeasureQty), unit: item.eachMeasureUnit ?? 'g' }
                      : null,
                    densityGPerMl: item.densityGPerMl != null ? Number(item.densityGPerMl) : null,
                  }
                  const ppb = pricePerBaseUnit(ci)
                  return (
                    <div className="grid grid-cols-2 gap-3 text-[13px]">
                      <HeaderFacts item={item} c={c} baseUnit={ci.baseUnit} seesMoney={seesMoney} />
                      <PackChainReadout chain={c.chain} baseUnit={ci.baseUnit} />
                      <PriceBlock item={item} c={c} ci={ci} ppb={ppb} seesMoney={seesMoney} />
                      <BridgesSection canEdit={canEdit} isRecipe={!!item.recipe} onRemeasure={() => setRemeasureOpen(true)} />
                      <CostBasisBlock item={item} baseUnit={ci.baseUnit} last={ppb} seesMoney={seesMoney} />
                    </div>
                  )
                })()}

                <StockSection
                  item={item}
                  showRcPanel={revenueCenters.length > 1}
                  defaultRcId={defaultRcId}
                  canEdit={canEdit}
                  onPulled={() => {
                    fetch(`/api/inventory/${item.id}`).then(r => r.json()).then(setItem)
                    onUpdated?.()
                  }}
                  stockMovements={stockMovements}
                />

                <BoxesSection
                  item={item}
                  seesMoney={seesMoney}
                  canEdit={canEdit}
                  measureTick={measureTick}
                  onRefresh={refreshItem}
                />

                {/* How each supplier writes this item on its invoices (W7) — MANAGER+. */}
                {canEdit && !item.recipe && <SupplierWordingsSection itemId={item.id} refreshKey={mergeTick} />}

                <HistorySection
                  item={item}
                  canMerge={canMerge}
                  canEdit={canEdit}
                  seesMoney={seesMoney}
                  mergeTick={mergeTick}
                  measureTick={measureTick}
                  onMergesChanged={refreshItem}
                  onRemeasureChanged={() => afterRemeasure('measure')}
                  priceHistory={priceHistory}
                />
              </div>
            )}

            {showQuick && (
              <QuickCountSheet
                item={item}
                onClose={() => setShowQuick(false)}
                // Refetch the row: the count moves its stock and its version, so an
                // open edit form saves against the fresh one (the form is kept).
                onDone={async () => { await refreshItem(); setShowQuick(false) }}
              />
            )}

            {mergeOpen && (
              <MergeItemSheet
                survivor={{
                  id: item.id, itemName: item.itemName, baseUnit: item.baseUnit ?? 'each',
                  dimension: item.dimension ?? null, packChain: item.packChain ?? [], countUnit: item.countUnit ?? null,
                  eachMeasureQty: item.eachMeasureQty ?? null, eachMeasureUnit: item.eachMeasureUnit ?? null,
                }}
                rcId={activeRc?.id ?? null}
                rcName={activeRc?.name ?? null}
                onClose={() => setMergeOpen(false)}
                onMerged={() => { setMergeTick(t => t + 1); refreshItem() }}
              />
            )}

            {remeasureOpen && (
              <RemeasureSheet
                item={{
                  id: item.id, itemName: item.itemName,
                  dimension: (item.dimension ?? 'COUNT') as Dimension, baseUnit: item.baseUnit ?? 'each',
                  packChain: item.packChain ?? [], pricing: item.pricing ?? null, countUnit: item.countUnit ?? null,
                  eachMeasureQty: item.eachMeasureQty ?? null, eachMeasureUnit: item.eachMeasureUnit ?? null,
                  densityGPerMl: item.densityGPerMl ?? null,
                  lastUpdated: item.lastUpdated ?? null,
                }}
                onClose={() => setRemeasureOpen(false)}
                onChanged={why => afterRemeasure(why === 'stale' ? 'rebuild' : 'measure')}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
