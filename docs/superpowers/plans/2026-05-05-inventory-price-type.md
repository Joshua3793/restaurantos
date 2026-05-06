# Inventory Price Type (CASE vs UOM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `priceType` (CASE | UOM) to inventory items so produce/meat priced by weight use the correct base-price formula everywhere — in the inventory UI, API routes, and invoice approve.

**Architecture:** One new `priceType String @default("CASE")` field on `InventoryItem`. `calcPricePerBaseUnit` gains an optional `priceType` param — existing call sites are unaffected. The invoice approve route reads `rawPriceType` from scan items to determine what to write. All UI surfaces (inventory drawer + invoice item editor) show a Per Case / Per UOM toggle with matching field visibility.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL · Tailwind CSS · Lucide icons

---

## File Map

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `priceType String @default("CASE")` to `InventoryItem` |
| `src/lib/utils.ts` | Add optional `priceType` param to `calcPricePerBaseUnit` |
| `src/app/api/inventory/route.ts` | POST: read + pass `priceType` |
| `src/app/api/inventory/[id]/route.ts` | PUT: read + pass `priceType` |
| `src/app/api/invoices/sessions/[id]/route.ts` | GET: add `priceType`, `qtyUOM`, `innerQty` to matchedItem select |
| `src/app/api/invoices/sessions/[id]/scanitems/route.ts` | POST: same matchedItem select additions |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` | Branch on `rawPriceType`; write `priceType` to inventory |
| `src/components/invoices/types.ts` | Add `priceType`, `qtyUOM`, `innerQty` to `InventoryMatch` |
| `src/components/inventory/InventoryItemDrawer.tsx` | Add priceType toggle + UOM field visibility |
| `src/components/invoices/InvoiceDrawer.tsx` | CREATE_NEW form: priceType toggle + field visibility; matched view: priceType label |

---

## Task 1: Prisma Schema Migration

**Files:**
- Modify: `prisma/schema.prisma` (line 81 — after `needsReview`)

- [ ] **Step 1: Add `priceType` field to `InventoryItem` in schema.prisma**

  Open `prisma/schema.prisma`. Find the `InventoryItem` model. After the `needsReview` line (currently line 80), add:

  ```prisma
  priceType          String                   @default("CASE")
  ```

  The block should now read:

  ```prisma
  needsReview        Boolean                  @default(false)
  priceType          String                   @default("CASE")
  countUOM           String                   @default("each")
  ```

- [ ] **Step 2: Run migration**

  ```bash
  npx prisma migrate dev --name add-inventory-price-type
  ```

  Expected: new migration file created, database updated. No errors.

- [ ] **Step 3: Regenerate Prisma client**

  ```bash
  npx prisma generate
  ```

  Expected: client regenerated successfully.

- [ ] **Step 4: Verify build passes**

  ```bash
  npm run build
  ```

  Expected: build succeeds, no TypeScript errors.

- [ ] **Step 5: Commit**

  ```bash
  git add prisma/schema.prisma prisma/migrations/
  git commit -m "feat: add priceType field to InventoryItem schema"
  ```

---

## Task 2: Update `calcPricePerBaseUnit` for UOM Path

**Files:**
- Modify: `src/lib/utils.ts` (lines 52–73)

- [ ] **Step 1: Add `priceType` parameter and UOM branch**

  In `src/lib/utils.ts`, replace the entire `calcPricePerBaseUnit` function (lines 52–73) with:

  ```ts
  /** Price per base unit (g, ml, or each) based on purchase structure */
  export function calcPricePerBaseUnit(
    purchasePrice: number,
    qtyPerPurchaseUnit: number,
    qtyUOM: string,
    innerQty: number | null,
    packSize: number,
    packUOM: string,
    priceType: 'CASE' | 'UOM' = 'CASE',
  ): number {
    if (priceType === 'UOM') {
      const conv = getUnitConv(packUOM)
      return conv > 0 ? purchasePrice / conv : 0
    }
    const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
    const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
    const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

    let divisor: number
    if (isWeightQty) {
      divisor = qtyPerPurchaseUnit * getUnitConv(qtyUOM)
    } else if (qtyUOM === 'pack' && innerQty != null) {
      divisor = qtyPerPurchaseUnit * innerQty * packSize * getUnitConv(packUOM)
    } else {
      divisor = qtyPerPurchaseUnit * packSize * getUnitConv(packUOM)
    }
    return divisor > 0 ? purchasePrice / divisor : 0
  }
  ```

- [ ] **Step 2: Verify build — no TypeScript errors at existing call sites**

  ```bash
  npm run build
  ```

  Expected: build succeeds. All existing callers use the default `'CASE'` and are unaffected.

- [ ] **Step 3: Commit**

  ```bash
  git add src/lib/utils.ts
  git commit -m "feat: add priceType param to calcPricePerBaseUnit with UOM path"
  ```

---

## Task 3: Update Inventory API Routes

**Files:**
- Modify: `src/app/api/inventory/route.ts` (POST handler, lines 98–130)
- Modify: `src/app/api/inventory/[id]/route.ts` (PUT handler, lines 21–115)

- [ ] **Step 1: Update the POST handler in `src/app/api/inventory/route.ts`**

  Replace the POST handler body (lines 98–130) with:

  ```ts
  export async function POST(req: NextRequest) {
    const body = await req.json()
    const { purchasePrice, qtyPerPurchaseUnit, packSize, packUOM, countUOM, qtyUOM, innerQty, priceType, supplierId, storageAreaId, ...rest } = body
    const pp  = parseFloat(purchasePrice)
    const qty = parseFloat(qtyPerPurchaseUnit)
    const ps  = parseFloat(packSize  ?? '1')
    const pu  = packUOM  ?? 'each'
    const cu  = countUOM ?? 'each'
    const qu  = qtyUOM ?? 'each'
    const iq  = innerQty != null ? Number(innerQty) : null
    const pt: 'CASE' | 'UOM' = priceType === 'UOM' ? 'UOM' : 'CASE'
    const pricePerBaseUnit = calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu, pt)
    const conversionFactor = calcConversionFactor(cu, qty, qu, iq, ps, pu)
    const baseUnit         = deriveBaseUnit(qu, pu)
    const item = await prisma.inventoryItem.create({
      data: {
        ...rest,
        purchasePrice: pp,
        qtyPerPurchaseUnit: qty,
        packSize: ps,
        packUOM: pu,
        countUOM: cu,
        qtyUOM: qu,
        innerQty: iq,
        priceType: pt,
        conversionFactor,
        pricePerBaseUnit,
        baseUnit,
        supplierId: supplierId || null,
        storageAreaId: storageAreaId || null,
      },
      include: { supplier: true, storageArea: true },
    })
    return NextResponse.json(item, { status: 201 })
  }
  ```

- [ ] **Step 2: Update the PUT handler in `src/app/api/inventory/[id]/route.ts`**

  In the PUT handler, find the destructuring line (line 22) and add `priceType` to the destructured fields:

  ```ts
  const {
    purchasePrice, qtyPerPurchaseUnit, packSize, packUOM, countUOM,
    qtyUOM, innerQty, needsReview, priceType,
    supplierId, storageAreaId,
    supplier, storageArea, invoiceLineItems, recipeIngredients, recipe,
    ...rest
  } = body
  ```

  Then find the three derived-value lines (around line 55) and add `pt` after them:

  ```ts
  const pp  = parseFloat(purchasePrice)  || 0
  const qty = parseFloat(qtyPerPurchaseUnit) || 1
  const ps  = parseFloat(packSize)  || 1
  const pu  = packUOM  ?? 'each'
  const cu  = countUOM ?? 'each'
  const qu  = qtyUOM ?? 'each'
  const iq  = innerQty != null ? Number(innerQty) : null
  const pt: 'CASE' | 'UOM' = priceType === 'UOM' ? 'UOM' : 'CASE'
  const pricePerBaseUnit = calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu, pt)
  const conversionFactor = calcConversionFactor(cu, qty, qu, iq, ps, pu)
  const baseUnit         = deriveBaseUnit(qu, pu)
  ```

  Then add `priceType: pt` to the `prisma.inventoryItem.update` data object (inside the `data: { ... }` block):

  ```ts
  await prisma.inventoryItem.update({
    where: { id: params.id },
    data: {
      ...rest,
      purchasePrice: pp,
      qtyPerPurchaseUnit: qty,
      packSize: ps,
      packUOM: pu,
      countUOM: cu,
      qtyUOM: qu,
      innerQty: iq,
      priceType: pt,
      needsReview: false,
      conversionFactor,
      pricePerBaseUnit,
      baseUnit,
      lastUpdated: new Date(),
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
    },
  })
  ```

- [ ] **Step 3: Verify build**

  ```bash
  npm run build
  ```

  Expected: build succeeds.

- [ ] **Step 4: Commit**

  ```bash
  git add src/app/api/inventory/route.ts src/app/api/inventory/[id]/route.ts
  git commit -m "feat: pass priceType through inventory POST and PUT routes"
  ```

---

## Task 4: Update InventoryItemDrawer UI

**Files:**
- Modify: `src/components/inventory/InventoryItemDrawer.tsx`

This task adds the Per Case / Per UOM toggle and adjusts field visibility in the edit form. Three locations to change: (A) form state type + initialization, (B) item-to-form population, (C) the save body, and (D) the purchase structure JSX.

- [ ] **Step 1: Add `priceType` to the form state initialization (around line 186)**

  Find the block that sets the default empty form (starts with `qtyPerPurchaseUnit: '1', purchasePrice: '0'`). Add `priceType: 'CASE'` to it:

  ```ts
  qtyPerPurchaseUnit: '1', purchasePrice: '0',
  packSize: '', packUOM: 'each', countUOM: 'each',
  qtyUOM: 'each', innerQty: '',
  priceType: 'CASE',
  ```

- [ ] **Step 2: Populate `priceType` when an item is loaded into edit form (around line 230)**

  Find where the form is populated from the item (the block that sets `qtyPerPurchaseUnit: String(item.qtyPerPurchaseUnit)` etc.). Add:

  ```ts
  priceType: (item as any).priceType ?? 'CASE',
  ```

- [ ] **Step 3: Add `priceType` to the save request body (around line 256)**

  Find the `body: JSON.stringify({ ... })` in the save handler. Add `priceType: editForm.priceType` alongside the other purchase fields:

  ```ts
  body: JSON.stringify({
    itemName: editForm.itemName,
    category: editForm.category,
    supplierId: editForm.supplierId || null,
    storageAreaId: editForm.storageAreaId || null,
    purchaseUnit: editForm.purchaseUnit,
    qtyPerPurchaseUnit: editForm.qtyPerPurchaseUnit,
    purchasePrice: editForm.purchasePrice,
    packSize: editForm.packSize,
    packUOM: editForm.packUOM,
    countUOM: editForm.countUOM,
    qtyUOM: editForm.qtyUOM,
    innerQty: editForm.innerQty ? parseFloat(editForm.innerQty) : null,
    priceType: editForm.priceType,
    stockOnHand: convertCountQtyToBase(/* ... existing args unchanged ... */),
    isActive: editForm.isActive,
    allergens: editForm.allergens,
    barcode: editForm.barcode,
  }),
  ```

- [ ] **Step 4: Add priceType toggle and update purchase structure JSX**

  Find the `{/* Purchase structure */}` section (around line 427). Replace the opening of that section so that:
  1. A Per Case / Per UOM toggle appears first
  2. The Qty/Unit row and conditional pack/weight sections are only shown when `editForm.priceType !== 'UOM'`
  3. When `priceType === 'UOM'`, a standalone "Price Unit" select for packUOM is shown
  4. The Purchase Price label changes based on priceType

  Replace the purchase structure section (`{!item.recipe && ( ... )}` block) with:

  ```tsx
  {!item.recipe && (
    <div className="space-y-3">
      {/* Price Type toggle */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Price Type</label>
        <div className="flex gap-2 p-1 bg-gray-100 rounded-xl">
          {(['CASE', 'UOM'] as const).map(pt => (
            <button
              key={pt}
              type="button"
              onClick={() => setEditForm(f => ({ ...f, priceType: pt }))}
              className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                editForm.priceType === pt
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {pt === 'CASE' ? 'Per Case' : 'Per UOM'}
            </button>
          ))}
        </div>
      </div>

      {/* CASE fields: Purchase Unit + Qty/Unit */}
      {editForm.priceType === 'CASE' && (
        <>
          {/* Row 1: Purchase Unit + Qty/Unit pair */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Unit</label>
              <select value={editForm.purchaseUnit} onChange={e => setEditForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold bg-white">
                {PURCHASE_UNITS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Qty per {editForm.purchaseUnit}</label>
              <div className="flex">
                <input type="number" step="any" value={editForm.qtyPerPurchaseUnit}
                  onChange={e => setEditForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                  className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                <select value={editForm.qtyUOM} onChange={e => setEditForm(f => {
                    const newQtyUOM = e.target.value
                    const opts = getCountableUoms({ baseUnit: deriveBaseUnit(newQtyUOM, f.packUOM), purchaseUnit: f.purchaseUnit, qtyPerPurchaseUnit: parseFloat(f.qtyPerPurchaseUnit) || 1, qtyUOM: newQtyUOM, innerQty: f.innerQty ? parseFloat(f.innerQty) : null, packSize: parseFloat(f.packSize) || 1, packUOM: f.packUOM, countUOM: f.countUOM }).map(u => u.label)
                    return { ...f, qtyUOM: newQtyUOM, innerQty: newQtyUOM === 'pack' ? f.innerQty : '', countUOM: opts.includes(f.countUOM) ? f.countUOM : opts[0] }
                  })}
                  className="border border-gray-200 rounded-r-lg px-2 py-2 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gold">
                  {QTY_UOMS.map(u => <option key={u}>{u}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Conditional: pack breakdown when qtyUOM = pack */}
          {editForm.qtyUOM === 'pack' && (
            <div className="ml-3 pl-3 border-l-2 border-amber-300 space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Items per Pack</label>
                  <div className="flex">
                    <input type="number" step="any" min="1" value={editForm.innerQty}
                      onChange={e => setEditForm(f => ({ ...f, innerQty: e.target.value }))}
                      className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                    <span className="border border-gray-200 rounded-r-lg px-3 py-2 text-sm text-gray-500 bg-gray-50">each</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Weight per Item
                    <span className="ml-1 text-[10px] font-semibold bg-gray-100 text-gray-400 rounded px-1 py-0.5 normal-case tracking-normal">optional</span>
                  </label>
                  <div className="flex">
                    <input type="number" step="any" min="0" value={editForm.packSize}
                      onChange={e => setEditForm(f => ({ ...f, packSize: e.target.value }))}
                      placeholder="e.g. 100"
                      className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                    <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                      className="border border-gray-200 rounded-r-lg px-2 py-2 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gold">
                      {(['g', 'kg', 'ml', 'l', 'lb', 'oz']).map(u => <option key={u}>{u}</option>)}
                    </select>
                  </div>
                  <p className="text-[10px] text-amber-700 bg-amber-50 rounded px-2 py-1 mt-1">Leave blank → price per each. Fill in → price per g, usable in recipes by weight.</p>
                </div>
              </div>
            </div>
          )}

          {/* Conditional: weight per item when qtyUOM = each */}
          {editForm.qtyUOM === 'each' && (
            <div className="ml-3 pl-3 border-l-2 border-amber-300">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Weight per Each
                <span className="ml-1 text-[10px] font-semibold bg-gray-100 text-gray-400 rounded px-1 py-0.5 normal-case tracking-normal">optional</span>
              </label>
              <div className="flex">
                <input type="number" step="any" min="0" value={editForm.packSize === '1' ? '' : editForm.packSize}
                  onChange={e => setEditForm(f => ({ ...f, packSize: e.target.value || '1' }))}
                  placeholder="e.g. 290"
                  className="w-full border border-gray-200 rounded-l-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold border-r-0" />
                <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
                  className="border border-gray-200 rounded-r-lg px-2 py-2 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gold">
                  {(['g', 'kg', 'ml', 'l', 'lb', 'oz']).map(u => <option key={u}>{u}</option>)}
                </select>
              </div>
              <p className="text-[10px] text-amber-700 bg-amber-50 rounded px-2 py-1 mt-1">Leave blank → price per each. Fill in → price per g, usable in recipes by weight.</p>
            </div>
          )}

          {/* Generated description label */}
          {(() => {
            const desc = buildPurchaseDescription(
              editForm.purchaseUnit,
              parseFloat(editForm.qtyPerPurchaseUnit) || 0,
              editForm.qtyUOM,
              editForm.innerQty ? parseFloat(editForm.innerQty) : null,
              parseFloat(editForm.packSize) || 1,
              editForm.packUOM,
            )
            return (
              <p className="text-xs text-gray-400 italic">= {desc}</p>
            )
          })()}
        </>
      )}

      {/* UOM fields: just packUOM (the rate unit) */}
      {editForm.priceType === 'UOM' && (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Price Unit</label>
          <select value={editForm.packUOM} onChange={e => setEditForm(f => ({ ...f, packUOM: e.target.value }))}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold bg-white">
            {(['kg', 'g', 'lb', 'oz', 'l', 'ml']).map(u => <option key={u}>{u}</option>)}
          </select>
          <p className="text-[10px] text-gray-400 mt-1">The unit the supplier quotes a rate per (e.g. kg = price per kg).</p>
        </div>
      )}

      {/* Purchase Price */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          {editForm.priceType === 'UOM' ? `Price / ${editForm.packUOM} ($)` : 'Purchase Price ($)'}
        </label>
        <input type="number" step="any" value={editForm.purchasePrice}
          onChange={e => setEditForm(f => ({ ...f, purchasePrice: e.target.value }))}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold" />
      </div>
    </div>
  )}
  ```

- [ ] **Step 5: Update the auto-calculated preview to use priceType**

  Find the auto-calculated preview section (around line 596). Change the `ppbu` calculation line:

  ```ts
  const ppbu = isPrep
    ? parseFloat(String(item.pricePerBaseUnit ?? 0))
    : calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu, editForm.priceType === 'UOM' ? 'UOM' : 'CASE')
  ```

- [ ] **Step 6: Verify build**

  ```bash
  npm run build
  ```

  Expected: build succeeds. If TypeScript complains about `item.priceType` not existing on the type, the cast `(item as any).priceType` in Step 2 is correct — `priceType` is now in the Prisma schema so the API will return it, but the local TS interface may not yet reflect it (that's fixed in Task 6).

- [ ] **Step 7: Commit**

  ```bash
  git add src/components/inventory/InventoryItemDrawer.tsx
  git commit -m "feat: add priceType toggle and UOM field visibility to InventoryItemDrawer"
  ```

---

## Task 5: Update Invoice Approve Route

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts`

- [ ] **Step 1: Add `rawPriceType` to the `doApprove` function's scanItems type signature**

  Find the `doApprove` function signature (line 14). The second parameter's `scanItems` array type needs `rawPriceType` added. Locate the inline type for scan items and add `rawPriceType: string | null` to the list:

  ```ts
  async function doApprove(
    sessionId: string,
    approvedBy: string,
    session: {
      id: string
      revenueCenterId: string | null
      supplierName: string | null
      supplierId: string | null
      invoiceDate: string | null
      invoiceNumber: string | null
      scanItems: Array<{
        id: string
        action: string
        matchedItemId: string | null
        matchedItem: { id: string; qtyPerPurchaseUnit: any; qtyUOM: string | null; innerQty: any; packSize: any; packUOM: string | null } | null
        newPrice: any
        previousPrice: any
        priceDiffPct: any
        rawDescription: string
        rawQty: any
        rawUnit: string | null
        rawUnitPrice: any
        rawLineTotal: any
        invoicePackQty: any
        invoicePackSize: any
        invoicePackUOM: string | null
        totalQty: any
        totalQtyUOM: string | null
        rawPriceType: string | null
        revenueCenterId: string | null
        sortOrder: number
        newItemData: string | null
        matchConfidence: any
        matchScore: any
      }>
    }
  ): Promise<void> {
  ```

- [ ] **Step 2: Replace the `UPDATE_PRICE` / `ADD_SUPPLIER` price calculation block**

  Find the block starting at line 39 that calculates `newPricePerBase` (inside the `if (scanItem.action === 'UPDATE_PRICE' || ...)` branch). Replace the entire `let newPricePerBase: number` block:

  ```ts
  const rawPriceType = scanItem.rawPriceType ?? 'CASE'

  let newPricePerBase: number
  if (rawPriceType === 'UOM') {
    // purchasePrice is a rate (e.g. $9.90/kg) — pricePerBaseUnit = rate ÷ unit conv
    const uomConv = getUnitConv(packUOM)
    newPricePerBase = uomConv > 0 ? newPurchasePrice / uomConv : 0
  } else if (rawPriceType === 'PKG') {
    // PKG: price is per individual pack — convert to per-case equivalent first
    const perCasePrice = newPurchasePrice * packSize
    const iqNum = item.innerQty != null ? Number(item.innerQty) : null
    newPricePerBase = calcPricePerBaseUnit(
      perCasePrice,
      packQty,
      useInvoicePack ? 'each' : (item.qtyUOM ?? 'each'),
      useInvoicePack ? null : iqNum,
      packSize,
      packUOM,
    )
  } else {
    // CASE (default): existing logic
    if (scanItem.totalQty !== null && scanItem.totalQty !== undefined && Number(scanItem.totalQty) > 0) {
      const tqUOM = scanItem.totalQtyUOM ?? packUOM
      const conv  = getUnitConv(tqUOM)
      newPricePerBase = conv > 0 ? newPurchasePrice / (Number(scanItem.totalQty) * conv) : 0
    } else {
      const iqNum = item.innerQty != null ? Number(item.innerQty) : null
      newPricePerBase = calcPricePerBaseUnit(
        newPurchasePrice,
        packQty,
        useInvoicePack ? 'each' : (item.qtyUOM ?? 'each'),
        useInvoicePack ? null : iqNum,
        packSize,
        packUOM,
      )
    }
  }
  ```

- [ ] **Step 3: Write `priceType` to the inventory item on UPDATE_PRICE / ADD_SUPPLIER**

  Find the `prisma.inventoryItem.update` inside the transaction ops (around line 70). Add `priceType` to the data:

  ```ts
  prisma.inventoryItem.update({
    where: { id: scanItem.matchedItemId },
    data: {
      purchasePrice:    newPurchasePrice,
      pricePerBaseUnit: newPricePerBase,
      priceType:        rawPriceType === 'UOM' ? 'UOM' : 'CASE',
      lastUpdated:      new Date(),
      ...(useInvoicePack ? { qtyPerPurchaseUnit: packQty, packSize, packUOM } : {}),
    },
  }),
  ```

- [ ] **Step 4: Handle `priceType` in the CREATE_NEW branch**

  Find the `CREATE_NEW` block (around line 129). Add `priceType` extraction from `newData` and pass it to `calcPricePerBaseUnit` and the `prisma.inventoryItem.create` call:

  ```ts
  if (scanItem.action === 'CREATE_NEW') {
    const newData = scanItem.newItemData ? JSON.parse(scanItem.newItemData) : {}
    const newPurchasePrice = Number(newData.purchasePrice) || Number(scanItem.newPrice) || 0
    const newPackQty  = Number(newData.qtyPerPurchaseUnit) || 1
    const newPackSize = Number(newData.packSize) || 1
    const newPackUOM  = newData.packUOM || 'each'
    const newPriceType: 'CASE' | 'UOM' = newData.priceType === 'UOM' ? 'UOM' : 'CASE'
    const newPricePerBase = Number(newData.pricePerBaseUnit) ||
      calcPricePerBaseUnit(newPurchasePrice, newPackQty, 'each', null, newPackSize, newPackUOM, newPriceType)
    const created = await prisma.inventoryItem.create({
      data: {
        itemName:           newData.itemName || scanItem.rawDescription,
        category:           newData.category || 'DRY',
        purchaseUnit:       newData.purchaseUnit || scanItem.rawUnit || 'each',
        qtyPerPurchaseUnit: newPackQty,
        purchasePrice:      newPurchasePrice,
        baseUnit:           newData.baseUnit || newPackUOM,
        packSize:           newPackSize,
        packUOM:            newPackUOM,
        priceType:          newPriceType,
        conversionFactor:   Number(newData.conversionFactor) || 1,
        pricePerBaseUnit:   newPricePerBase,
        supplierId:         session.supplierId || null,
      },
    })
    updatedItemIds.push(created.id)
    await prisma.invoiceScanItem.update({
      where: { id: scanItem.id },
      data: { matchedItemId: created.id, approved: true },
    })
  }
  ```

- [ ] **Step 5: Verify build**

  ```bash
  npm run build
  ```

  Expected: build succeeds.

- [ ] **Step 6: Commit**

  ```bash
  git add src/app/api/invoices/sessions/[id]/approve/route.ts
  git commit -m "feat: use rawPriceType in approve route; write priceType to inventory items"
  ```

---

## Task 6: Update Invoice Scanner Types and API Selects

**Files:**
- Modify: `src/components/invoices/types.ts`
- Modify: `src/app/api/invoices/sessions/[id]/route.ts` (GET matchedItem select)
- Modify: `src/app/api/invoices/sessions/[id]/scanitems/route.ts` (POST matchedItem select)

- [ ] **Step 1: Add `priceType`, `qtyUOM`, `innerQty` to `InventoryMatch` in `src/components/invoices/types.ts`**

  Find the `InventoryMatch` interface (lines 13–23). Replace it with:

  ```ts
  export interface InventoryMatch {
    id: string
    itemName: string
    purchaseUnit: string
    pricePerBaseUnit: string
    purchasePrice: string
    qtyPerPurchaseUnit: string
    packSize: string
    packUOM: string
    baseUnit: string
    priceType: string
    qtyUOM: string
    innerQty: string | null
  }
  ```

- [ ] **Step 2: Update the matchedItem select in the session GET route**

  In `src/app/api/invoices/sessions/[id]/route.ts`, find the inline select for `matchedItem` (line 13). Add the three new fields:

  ```ts
  matchedItem: {
    select: {
      id: true, itemName: true, purchaseUnit: true,
      pricePerBaseUnit: true, purchasePrice: true,
      qtyPerPurchaseUnit: true, packSize: true, packUOM: true, baseUnit: true,
      priceType: true, qtyUOM: true, innerQty: true,
    }
  },
  ```

- [ ] **Step 3: Update the matchedItem select in the scanitems POST route**

  In `src/app/api/invoices/sessions/[id]/scanitems/route.ts`, find the `matchedItem: { select: { ... } }` block (around line 39). Add the three new fields:

  ```ts
  matchedItem: {
    select: {
      id: true, itemName: true, purchaseUnit: true,
      pricePerBaseUnit: true, purchasePrice: true,
      qtyPerPurchaseUnit: true, packSize: true, packUOM: true, baseUnit: true,
      priceType: true, qtyUOM: true, innerQty: true,
    },
  },
  ```

- [ ] **Step 4: Verify build**

  ```bash
  npm run build
  ```

  Expected: build succeeds. TypeScript will now know `matchedItem.priceType` exists.

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/invoices/types.ts src/app/api/invoices/sessions/[id]/route.ts src/app/api/invoices/sessions/[id]/scanitems/route.ts
  git commit -m "feat: add priceType, qtyUOM, innerQty to InventoryMatch type and API selects"
  ```

---

## Task 7: Update InvoiceDrawer Item Editor

**Files:**
- Modify: `src/components/invoices/InvoiceDrawer.tsx`

The `ScanItemEditor` component handles both CREATE_NEW (full form) and matched items (read-only + price display). This task:
- Adds priceType to the CREATE_NEW form state + toggle + field visibility
- Updates the matched item view to show priceType label and adjust price labels

- [ ] **Step 1: Add `priceType` to the CREATE_NEW form state in `ScanItemEditor` (around line 951)**

  Find the `useState` that initializes the `form` object in `ScanItemEditor`. Add `priceType`:

  ```ts
  const [form, setForm] = useState({
    itemName:           String(existing?.itemName ?? item.rawDescription),
    category:           String(existing?.category ?? 'DRY'),
    purchaseUnit:       String(existing?.purchaseUnit ?? (item.rawUnit || 'case')),
    qtyPerPurchaseUnit: String(existing?.qtyPerPurchaseUnit ?? hints.qty),
    packSize:           String(existing?.packSize ?? hints.packSize),
    packUOM:            String(existing?.packUOM ?? hints.packUOM),
    purchasePrice:      String(existing?.purchasePrice ?? (item.newPrice !== null ? Number(item.newPrice) : '')),
    countUOM:           String(existing?.countUOM ?? hints.packUOM),
    priceType:          String(existing?.priceType ?? 'CASE'),
  })
  ```

- [ ] **Step 2: Update the derived values below the form state to use priceType**

  Find the `ppbu` calculation (line ~965). Update it to pass `priceType`:

  ```ts
  const pp   = parseFloat(form.purchasePrice) || 0
  const qty  = parseFloat(form.qtyPerPurchaseUnit) || 1
  const ps   = parseFloat(form.packSize) || 1
  const pt   = form.priceType === 'UOM' ? 'UOM' : 'CASE' as const
  const ppbu = calcPricePerBaseUnit(pp, qty, 'each', null, ps, form.packUOM, pt)
  const cf   = calcConversionFactor(form.countUOM, qty, 'each', null, ps, form.packUOM)
  const bu   = deriveBaseUnit('each', form.packUOM)
  ```

- [ ] **Step 3: Replace the CREATE_NEW Purchase Structure section with priceType-aware version**

  Find `{/* Purchase structure */}` inside the `isNew` branch (around line 1023). Replace the purchase structure `<div>` block (from the `<label>Purchase Structure</label>` down through the closing `</div>` of the grid, ending before the auto-calculated preview) with:

  ```tsx
  {/* Purchase structure */}
  <div>
    <label className="block text-xs font-medium text-gray-600 mb-2">Purchase Structure</label>

    {/* Price Type toggle */}
    <div className="mb-3">
      <div className="flex gap-2 p-1 bg-gray-100 rounded-xl">
        {(['CASE', 'UOM'] as const).map(pt => (
          <button
            key={pt}
            type="button"
            onClick={() => setForm(f => ({ ...f, priceType: pt }))}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
              form.priceType === pt
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {pt === 'CASE' ? 'Per Case' : 'Per UOM'}
          </button>
        ))}
      </div>
    </div>

    {form.priceType === 'CASE' && (
      <>
        <p className="text-[11px] text-gray-400 mb-2">
          Example: Meadow Milk 4/4L → Purchase Unit = <em>case</em>, Qty per case = <em>4</em>, Pack size = <em>4</em>, Pack UOM = <em>L</em>
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Purchase Unit</label>
            <input
              value={form.purchaseUnit}
              onChange={e => setForm(f => ({ ...f, purchaseUnit: e.target.value }))}
              placeholder="case, bag, box…"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Qty per case</label>
            <input
              type="number" step="any" min="0"
              value={form.qtyPerPurchaseUnit}
              onChange={e => setForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Pack Size</label>
            <input
              type="number" step="any" min="0"
              value={form.packSize}
              onChange={e => setForm(f => ({ ...f, packSize: e.target.value }))}
              placeholder="4, 500, 1…"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Pack UOM</label>
            <select
              value={form.packUOM}
              onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
            >
              {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Purchase Price ($)</label>
            <input
              type="number" step="any"
              value={form.purchasePrice}
              onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Count UOM</label>
            <select
              value={form.countUOM}
              onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
            >
              {COUNT_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
      </>
    )}

    {form.priceType === 'UOM' && (
      <div className="space-y-3">
        <p className="text-[11px] text-gray-400">
          Priced by rate (e.g. $/kg). Enter the unit the supplier quotes per.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Price Unit</label>
            <select
              value={form.packUOM}
              onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
            >
              {(['kg', 'g', 'lb', 'oz', 'l', 'ml']).map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Price / {form.packUOM} ($)</label>
            <input
              type="number" step="any"
              value={form.purchasePrice}
              onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Count UOM</label>
            <select
              value={form.countUOM}
              onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gold"
            >
              {COUNT_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
      </div>
    )}
  </div>
  ```

- [ ] **Step 4: Include `priceType` in the `onSave` call for CREATE_NEW (footer button)**

  Find the footer Save button's `onClick` for the CREATE_NEW case (around line 1179). The `newItemData` object passed to `onSave` needs `priceType`:

  ```ts
  onSave({
    newItemData: {
      itemName:           form.itemName,
      category:           form.category,
      purchaseUnit:       form.purchaseUnit,
      qtyPerPurchaseUnit: parseFloat(form.qtyPerPurchaseUnit) || 1,
      packSize:           parseFloat(form.packSize) || 1,
      packUOM:            form.packUOM,
      purchasePrice:      parseFloat(form.purchasePrice) || 0,
      countUOM:           form.countUOM,
      priceType:          form.priceType,
      baseUnit:           bu,
      pricePerBaseUnit:   ppbu,
      conversionFactor:   cf,
    },
  })
  ```

- [ ] **Step 5: Update the matched item view to show priceType label**

  Find the matched item read-only section (the `!isNew` branch, around line 1120). In the info grid that shows "Purchase Unit" and "Current Price", add a row for Price Type:

  ```tsx
  <div className="bg-gray-50 rounded-xl p-4 space-y-3">
    <div className="grid grid-cols-2 gap-3 text-sm">
      <div>
        <p className="text-xs text-gray-400">Purchase Unit</p>
        <p className="font-medium text-gray-900">{item.matchedItem.purchaseUnit}</p>
      </div>
      <div>
        <p className="text-xs text-gray-400">Price Type</p>
        <p className="font-medium text-gray-900">
          {item.matchedItem.priceType === 'UOM'
            ? `Per ${item.matchedItem.packUOM}`
            : 'Per Case'}
        </p>
      </div>
      <div>
        <p className="text-xs text-gray-400">
          {item.matchedItem.priceType === 'UOM'
            ? `Current Price / ${item.matchedItem.packUOM}`
            : 'Current Price'}
        </p>
        <p className="font-medium text-gray-900">{formatCurrency(Number(item.matchedItem.purchasePrice))}</p>
      </div>
      <div>
        <p className="text-xs text-gray-400">Price / Base Unit</p>
        <p className="font-medium text-gray-900">{formatCurrency(Number(item.matchedItem.pricePerBaseUnit))}</p>
      </div>
    </div>
  </div>
  ```

- [ ] **Step 6: Verify build**

  ```bash
  npm run build
  ```

  Expected: build succeeds, no TypeScript errors.

- [ ] **Step 7: Commit**

  ```bash
  git add src/components/invoices/InvoiceDrawer.tsx
  git commit -m "feat: add priceType toggle and field alignment to InvoiceDrawer item editor"
  ```

---

## Self-Review Checklist (for implementer)

After all tasks are complete, verify:

- [ ] `npm run build` passes clean
- [ ] Existing CASE items: create/edit an item with qtyUOM=each and priceType=CASE — verify `pricePerBaseUnit` is unchanged from before
- [ ] New UOM item: create an item, set priceType=UOM, packUOM=kg, purchasePrice=9.90 — verify `pricePerBaseUnit` = 0.0099 (9.90/1000)
- [ ] Approve a UOM invoice scan item: verify inventory item's `priceType` is updated to 'UOM' and `purchasePrice` stores the rate
- [ ] Approve a PKG invoice scan item: verify inventory item's `priceType` stays 'CASE'
- [ ] CREATE_NEW with priceType=UOM in scanner: verify item is created correctly with priceType='UOM'
