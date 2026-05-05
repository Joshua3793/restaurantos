# UOM Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple product structure from count unit by adding `qtyUOM`/`innerQty`/`needsReview` schema fields, fixing three broken utility functions, redesigning the purchase structure form, and running a one-time data migration that repairs 300+ malformed items.

**Architecture:** Three structural paths — weight-based (`qtyUOM` ∈ weight/volume), count→weight (`qtyUOM=each`), count→pack→weight (`qtyUOM=pack`). The `qtyUOM` field disambiguates what the number in "qty per case" means. `innerQty` stores items-per-pack for the 3-level hierarchy. Both `calcPricePerBaseUnit` and `calcConversionFactor` expand from 4 to 6 parameters; all callers are updated.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL · Tailwind CSS

---

## File Map

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `qtyUOM`, `innerQty`, `needsReview` to `InventoryItem` |
| `src/lib/utils.ts` | Lock `PURCHASE_UNITS`, add `QTY_UOMS`, expand 3 function signatures |
| `src/lib/count-uom.ts` | Expand `ItemDims`, rewrite `getCountableUoms`, update 2 conversion fns |
| `src/app/api/inventory/[id]/route.ts` | PUT: validate + pass new fields |
| `src/app/api/inventory/route.ts` | POST: pass new fields |
| `src/app/api/inventory/repair-prices/route.ts` | Pass `qtyUOM`/`innerQty` from DB item |
| `src/app/api/invoices/sessions/route.ts` | Add new fields to matchedItem select, pass to calc |
| `src/app/api/invoices/sessions/[id]/route.ts` | Same |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` | Expand matchedItem type + select, pass new fields |
| `src/app/api/invoices/[id]/process/route.ts` | Pass `qtyUOM`/`innerQty` from fetched item |
| `src/components/invoices/InvoiceDrawer.tsx` | Pass `'each', null` to updated calc calls (3 sites) |
| `src/components/recipes/shared.tsx` | Pass `'each', null` to updated calc calls (2 sites) |
| `src/app/inventory/page.tsx` | EditForm + form UI redesign + needsReview banner |
| `src/components/inventory/InventoryItemDrawer.tsx` | EditForm + form UI redesign |
| `prisma/migrate-uom.ts` | One-time data repair script |

---

## Task 1: Prisma Schema — Add `qtyUOM`, `innerQty`, `needsReview`

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add three fields to `InventoryItem` model**

Open `prisma/schema.prisma`. Find the `InventoryItem` model (around line 66). After the `packUOM` field (line 77), add:

```prisma
  qtyUOM      String   @default("each") // unit of qtyPerPurchaseUnit: kg/g/ml/l/each/pack
  innerQty    Decimal?                  // items per pack — only when qtyUOM = "pack"
  needsReview Boolean  @default(false)  // flagged by migration script for manual review
```

The section around lines 73–80 should now read:
```prisma
  purchaseUnit       String
  qtyPerPurchaseUnit Decimal                  @default(1)
  baseUnit           String                   @default("each")
  packSize           Decimal                  @default(1)
  packUOM            String                   @default("each")
  qtyUOM             String                   @default("each")
  innerQty           Decimal?
  needsReview        Boolean                  @default(false)
  countUOM           String                   @default("each")
  conversionFactor   Decimal                  @default(1)
  pricePerBaseUnit   Decimal                  @default(0)
```

- [ ] **Step 2: Create and apply migration**

```bash
npx prisma migrate dev --name add-qty-uom-inner-qty
```

Expected output ends with: `Your database is now in sync with your schema.`

- [ ] **Step 3: Regenerate Prisma client**

```bash
npx prisma generate
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add qtyUOM, innerQty, needsReview to InventoryItem schema"
```

---

## Task 2: Core Utils — Update `src/lib/utils.ts`

**Files:**
- Modify: `src/lib/utils.ts`

- [ ] **Step 1: Lock `PURCHASE_UNITS` to container types only and add `QTY_UOMS`**

Replace lines 13–16 (the `PURCHASE_UNITS` constant) with:

```typescript
export const PURCHASE_UNITS = [
  'case', 'bag', 'box', 'bottle', 'pack', 'tray',
  'sleeve', 'dozen', 'pallet', 'jug', 'each',
] as const

export const QTY_UOMS = ['each', 'pack', 'kg', 'g', 'lb', 'oz', 'l', 'ml'] as const
```

- [ ] **Step 2: Replace `calcPricePerBaseUnit` (lines 50–58) with 6-param version**

```typescript
/** Price per base unit (g, ml, or each) based on purchase structure */
export function calcPricePerBaseUnit(
  purchasePrice: number,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
): number {
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

- [ ] **Step 3: Replace `deriveBaseUnit` (lines 61–68) with 2-param version**

```typescript
/** Derive the base unit (g / ml / each) from qtyUOM and packUOM */
export function deriveBaseUnit(qtyUOM: string, packUOM: string): string {
  const weightUnits = ['g', 'mg', 'kg', 'lb', 'oz']
  const volumeUnits = ['ml', 'l', 'lt', 'fl oz', 'tsp', 'tbsp', 'cup', 'gal']
  if (weightUnits.includes(qtyUOM)) return 'g'
  if (volumeUnits.includes(qtyUOM)) return 'ml'
  if (weightUnits.includes(packUOM)) return 'g'
  if (volumeUnits.includes(packUOM)) return 'ml'
  return 'each'
}
```

- [ ] **Step 4: Replace `calcConversionFactor` (lines 71–83) with 6-param version**

```typescript
/** Conversion factor: how many base units equal 1 counting unit */
export function calcConversionFactor(
  countUOM: string,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
): number {
  if (countUOM in UNIT_CONV) return UNIT_CONV[countUOM]

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  const itemBaseUnits = packSize * getUnitConv(packUOM)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  if (countUOM === 'case' || countUOM === qtyUOM) {
    if (isWeightQty) return qtyPerPurchaseUnit * getUnitConv(qtyUOM)
    return qtyPerPurchaseUnit * packBaseUnits
  }
  if (countUOM === 'pack') return packBaseUnits
  if (countUOM === 'each') return itemBaseUnits > 0 ? itemBaseUnits : 1
  return 1
}
```

- [ ] **Step 5: Verify `src/lib/utils.ts` compiles with no TypeScript errors**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npx tsc --noEmit --project tsconfig.json 2>&1 | grep "utils.ts" | head -20
```

Expected: no output (no errors in utils.ts itself — callers will fail until they're updated).

- [ ] **Step 6: Commit**

```bash
git add src/lib/utils.ts
git commit -m "feat: expand calcPricePerBaseUnit/calcConversionFactor/deriveBaseUnit to new 6-param signatures"
```

---

## Task 3: Count UOM Logic — Update `src/lib/count-uom.ts`

**Files:**
- Modify: `src/lib/count-uom.ts`

- [ ] **Step 1: Expand `ItemDims` interface and add imports**

Replace the import line (line 10) and the `ItemDims` interface (lines 20–27):

```typescript
import { UOM_GROUPS, convertQty, getUnitGroup } from './uom'
import { deriveBaseUnit, getUnitConv } from './utils'
```

```typescript
interface ItemDims {
  baseUnit: string
  purchaseUnit: string
  qtyPerPurchaseUnit: number | { toString(): string }
  qtyUOM?: string | null
  innerQty?: { toString(): string } | number | null
  packSize: number | { toString(): string }
  packUOM: string
  countUOM: string
}
```

- [ ] **Step 2: Replace `getCountableUoms` with structure-derived logic**

Replace the entire `getCountableUoms` function (lines 40–116) with:

```typescript
function buildCaseHint(item: ItemDims): string {
  const qty = Number(item.qtyPerPurchaseUnit)
  const qtyUOM = item.qtyUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']

  if (weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)) {
    const total = qty * getUnitConv(qtyUOM)
    return total >= 1000 && (weightUnits.includes(qtyUOM) ? weightUnits : volumeUnits).includes('kg')
      ? `${total / 1000} kg`
      : `${qty} ${qtyUOM}`
  }
  if (qtyUOM === 'pack' && innerQty != null) {
    if (ps > 0 && pu !== 'each') {
      return `${qty} packs × ${innerQty} × ${ps}${pu}`
    }
    return `${qty} packs × ${innerQty} each`
  }
  if (ps > 0 && pu !== 'each') {
    return `${qty} × ${ps}${pu}`
  }
  return `${qty} each`
}

/**
 * Returns the UOM options a user can choose from when counting an item.
 * Derived from purchase structure — not a hardcoded list.
 */
export function getCountableUoms(item: ItemDims): CountableUom[] {
  const uoms: CountableUom[] = []
  const qtyUOM = item.qtyUOM ?? 'each'
  const base = deriveBaseUnit(qtyUOM, item.packUOM ?? 'each')
  const hasWeight = base === 'g' || base === 'ml'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null
  const hasInnerQty = innerQty != null && innerQty > 0
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const hasItemWeight = hasWeight && ps > 0

  // Purchase unit (case / bag / etc.)
  uoms.push({ label: item.purchaseUnit, toBase: calcConversionFactorForItem(item), hint: buildCaseHint(item) })

  // Pack level (only when qtyUOM = "pack")
  if (qtyUOM === 'pack' && hasInnerQty) {
    const packBaseUnits = innerQty! * ps * getUnitConv(pu)
    const hint = packBaseUnits > 0 ? `${fmtNum(packBaseUnits)} ${base}` : `${innerQty} each`
    uoms.push({ label: 'pack', toBase: packBaseUnits > 0 ? packBaseUnits : innerQty!, hint })
  }

  // Each (individual item)
  if (hasItemWeight) {
    uoms.push({ label: 'each', toBase: ps * getUnitConv(pu), hint: `${ps} ${pu}` })
  } else if (qtyUOM === 'each' || qtyUOM === 'pack') {
    uoms.push({ label: 'each', toBase: 1 })
  }

  // Weight/volume options
  if (base === 'g') {
    uoms.push(
      { label: 'kg', toBase: 1000, hint: '1,000 g' },
      { label: 'g',  toBase: 1 },
      { label: 'lb', toBase: 453.592, hint: '454 g' },
    )
  }
  if (base === 'ml') {
    uoms.push(
      { label: 'l',  toBase: 1000, hint: '1,000 ml' },
      { label: 'ml', toBase: 1 },
    )
  }

  return uoms
}

/** Helper: total base units per 1 purchase unit */
function calcConversionFactorForItem(item: ItemDims): number {
  const qtyUOM = item.qtyUOM ?? 'each'
  const qty = Number(item.qtyPerPurchaseUnit)
  const ps  = Number(item.packSize ?? 0)
  const pu  = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  if (weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)) {
    return qty * getUnitConv(qtyUOM)
  }
  if (qtyUOM === 'pack' && innerQty != null) {
    return qty * innerQty * ps * getUnitConv(pu)
  }
  return qty * ps * getUnitConv(pu)
}
```

- [ ] **Step 3: Replace `convertCountQtyToBase` with pack-aware version**

Replace the entire `convertCountQtyToBase` function (lines 122–150) with:

```typescript
/**
 * Convert a quantity entered by the user (in selectedUom) to the item's baseUnit.
 * This is what gets written to stockOnHand.
 */
export function convertCountQtyToBase(
  qty: number,
  selectedUom: string,
  item: ItemDims,
): number {
  const sel = selectedUom.toLowerCase()
  const base = item.baseUnit.toLowerCase()
  if (sel === base) return qty

  const qtyUOM = (item.qtyUOM ?? 'each').toLowerCase()
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  const itemBaseUnits = ps * getUnitConv(pu)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  // Purchase unit
  if (sel === item.purchaseUnit.toLowerCase()) {
    const qtyNum = Number(item.qtyPerPurchaseUnit)
    if (isWeightQty) return qty * qtyNum * getUnitConv(qtyUOM)
    if (qtyUOM === 'pack' && innerQty != null) return qty * qtyNum * packBaseUnits
    return qty * qtyNum * (itemBaseUnits > 0 ? itemBaseUnits : 1)
  }

  // Pack level
  if (sel === 'pack' && qtyUOM === 'pack' && innerQty != null) {
    return qty * packBaseUnits
  }

  // Each
  if (sel === 'each') {
    return itemBaseUnits > 0 ? qty * itemBaseUnits : qty
  }

  // Standard weight/volume conversion (kg, g, lb, ml, l, etc.)
  return convertQty(qty, selectedUom, item.baseUnit)
}
```

- [ ] **Step 4: Replace `convertBaseToCountUom` with pack-aware version**

Replace the entire `convertBaseToCountUom` function (lines 156–181) with:

```typescript
/**
 * Convert a baseUnit quantity to the selectedUom — for displaying expected quantities.
 */
export function convertBaseToCountUom(
  baseQty: number,
  selectedUom: string,
  item: ItemDims,
): number {
  const sel = selectedUom.toLowerCase()
  const base = item.baseUnit.toLowerCase()
  if (sel === base) return baseQty

  const qtyUOM = (item.qtyUOM ?? 'each').toLowerCase()
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  const itemBaseUnits = ps * getUnitConv(pu)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  // Purchase unit
  if (sel === item.purchaseUnit.toLowerCase()) {
    const qtyNum = Number(item.qtyPerPurchaseUnit)
    if (isWeightQty) {
      const purchaseBaseUnits = qtyNum * getUnitConv(qtyUOM)
      return purchaseBaseUnits > 0 ? baseQty / purchaseBaseUnits : 0
    }
    if (qtyUOM === 'pack' && innerQty != null) {
      const purchaseBaseUnits = qtyNum * packBaseUnits
      return purchaseBaseUnits > 0 ? baseQty / purchaseBaseUnits : 0
    }
    const purchaseBaseUnits = qtyNum * (itemBaseUnits > 0 ? itemBaseUnits : 1)
    return purchaseBaseUnits > 0 ? baseQty / purchaseBaseUnits : 0
  }

  // Pack level
  if (sel === 'pack' && qtyUOM === 'pack' && innerQty != null) {
    return packBaseUnits > 0 ? baseQty / packBaseUnits : 0
  }

  // Each
  if (sel === 'each') {
    return itemBaseUnits > 0 ? baseQty / itemBaseUnits : baseQty
  }

  // Standard weight/volume
  return convertQty(baseQty, item.baseUnit, selectedUom)
}
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/count-uom.ts
git commit -m "feat: rewrite count-uom to derive UOM options from qtyUOM/innerQty structure"
```

---

## Task 4: Inventory API Routes — Pass New Fields

**Files:**
- Modify: `src/app/api/inventory/[id]/route.ts`
- Modify: `src/app/api/inventory/route.ts`
- Modify: `src/app/api/inventory/repair-prices/route.ts`

- [ ] **Step 1: Update `src/app/api/inventory/[id]/route.ts` PUT handler**

Replace the entire PUT function with:

```typescript
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const {
    purchasePrice, qtyPerPurchaseUnit, packSize, packUOM, countUOM,
    qtyUOM, innerQty, needsReview,
    supplierId, storageAreaId,
    supplier, storageArea, invoiceLineItems, recipeIngredients, recipe,
    ...rest
  } = body

  // Validate qtyUOM
  const validQtyUoms = ['each', 'pack', 'kg', 'g', 'lb', 'oz', 'l', 'ml']
  if (qtyUOM && !validQtyUoms.includes(qtyUOM)) {
    return NextResponse.json({ error: `Invalid qtyUOM: ${qtyUOM}` }, { status: 400 })
  }
  if (innerQty !== null && innerQty !== undefined && Number(innerQty) <= 0) {
    return NextResponse.json({ error: 'innerQty must be > 0' }, { status: 400 })
  }

  const before = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    select: { allergens: true },
  })

  const pp   = parseFloat(purchasePrice)
  const qty  = parseFloat(qtyPerPurchaseUnit)
  const ps   = parseFloat(packSize  ?? '1')
  const pu   = packUOM  ?? 'each'
  const cu   = countUOM ?? 'each'
  const qu   = qtyUOM   ?? 'each'
  const iq   = innerQty != null ? Number(innerQty) : null

  const pricePerBaseUnit = calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu)
  const conversionFactor = calcConversionFactor(cu, qty, qu, iq, ps, pu)
  const baseUnit         = deriveBaseUnit(qu, pu)

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
      needsReview: false, // always clear on explicit save
      conversionFactor,
      pricePerBaseUnit,
      baseUnit,
      lastUpdated: new Date(),
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
    },
  })

  const linkedRecipe = await prisma.recipe.findFirst({
    where: { inventoryItemId: params.id, type: 'PREP' },
    select: { id: true },
  })
  if (linkedRecipe) {
    await syncPrepToInventory(linkedRecipe.id)
  }

  const newAllergens: string[] = rest.allergens ?? before?.allergens ?? []
  const allergensChanged =
    JSON.stringify([...(before?.allergens ?? [])].sort()) !==
    JSON.stringify([...newAllergens].sort())

  if (allergensChanged) {
    const affectedRecipes = await prisma.recipe.findMany({
      where: {
        type: 'PREP',
        inventoryItemId: { not: null },
        ingredients: { some: { inventoryItemId: params.id } },
      },
      select: { id: true },
    })
    await Promise.all(affectedRecipes.map(r => syncPrepToInventory(r.id)))
  }

  const updated = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    include: { supplier: true, storageArea: true },
  })
  return NextResponse.json(updated)
}
```

- [ ] **Step 2: Update `src/app/api/inventory/route.ts` POST handler**

In the POST function (around line 98), replace the destructuring and calc calls:

```typescript
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { purchasePrice, qtyPerPurchaseUnit, packSize, packUOM, countUOM, qtyUOM, innerQty, supplierId, storageAreaId, ...rest } = body
  const pp  = parseFloat(purchasePrice)
  const qty = parseFloat(qtyPerPurchaseUnit)
  const ps  = parseFloat(packSize  ?? '1')
  const pu  = packUOM  ?? 'each'
  const cu  = countUOM ?? 'each'
  const qu  = qtyUOM   ?? 'each'
  const iq  = innerQty != null ? Number(innerQty) : null
  const pricePerBaseUnit = calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu)
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
      conversionFactor,
      pricePerBaseUnit,
      baseUnit,
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
    },
  })
  return NextResponse.json(item, { status: 201 })
}
```

Note: preserve the existing GET function above POST unchanged.

- [ ] **Step 3: Update `src/app/api/inventory/repair-prices/route.ts`**

Add `qtyUOM` and `innerQty` to the select and pass to `calcPricePerBaseUnit`:

```typescript
export async function POST() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      itemName: true,
      purchasePrice: true,
      qtyPerPurchaseUnit: true,
      qtyUOM: true,
      innerQty: true,
      packSize: true,
      packUOM: true,
      pricePerBaseUnit: true,
    },
  })

  let fixed = 0
  let skipped = 0
  const changes: Array<{ id: string; name: string; old: number; new: number }> = []

  for (const item of items) {
    const correct = calcPricePerBaseUnit(
      Number(item.purchasePrice),
      Number(item.qtyPerPurchaseUnit),
      item.qtyUOM ?? 'each',
      item.innerQty != null ? Number(item.innerQty) : null,
      Number(item.packSize),
      item.packUOM,
    )

    const current = Number(item.pricePerBaseUnit)
    const diff = Math.abs(correct - current)
    const relErr = current > 0 ? diff / current : diff

    if (relErr > 0.0001) {
      changes.push({ id: item.id, name: item.itemName, old: current, new: correct })
      await prisma.inventoryItem.update({
        where: { id: item.id },
        data: { pricePerBaseUnit: correct },
      })
      fixed++
    } else {
      skipped++
    }
  }

  return NextResponse.json({ total: items.length, fixed, skipped, changes })
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inventory/[id]/route.ts src/app/api/inventory/route.ts src/app/api/inventory/repair-prices/route.ts
git commit -m "feat: pass qtyUOM/innerQty through inventory API routes"
```

---

## Task 5: Invoice API Routes — Update Callers

**Files:**
- Modify: `src/app/api/invoices/sessions/route.ts`
- Modify: `src/app/api/invoices/sessions/[id]/route.ts`
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts`
- Modify: `src/app/api/invoices/[id]/process/route.ts`

- [ ] **Step 1: Update `src/app/api/invoices/sessions/route.ts` DELETE handler**

In the DELETE handler (around line 48), update the matchedItem select to include `qtyUOM` and `innerQty`, then pass them to `calcPricePerBaseUnit`. Replace the scanItems select block and the update call:

```typescript
scanItems: {
  where: { action: 'UPDATE_PRICE', approved: true },
  select: {
    matchedItemId: true, previousPrice: true,
    matchedItem: { select: { id: true, qtyPerPurchaseUnit: true, qtyUOM: true, innerQty: true, packSize: true, packUOM: true } },
  },
},
```

And the `pricePerBaseUnit` calculation (line 63):
```typescript
pricePerBaseUnit: calcPricePerBaseUnit(
  prevPrice,
  Number(scanItem.matchedItem.qtyPerPurchaseUnit),
  scanItem.matchedItem.qtyUOM ?? 'each',
  scanItem.matchedItem.innerQty != null ? Number(scanItem.matchedItem.innerQty) : null,
  Number(scanItem.matchedItem.packSize),
  scanItem.matchedItem.packUOM ?? 'each',
),
```

- [ ] **Step 2: Update `src/app/api/invoices/sessions/[id]/route.ts` (price revert)**

Find the price-revert block around line 137. Add `qtyUOM: true, innerQty: true` to the `matchedItem` select (find it in the include/select chain before this block). Then update the `calcPricePerBaseUnit` call at line 137:

```typescript
const pricePerBaseUnit = calcPricePerBaseUnit(
  prevPrice,
  Number(scanItem.matchedItem.qtyPerPurchaseUnit),
  scanItem.matchedItem.qtyUOM ?? 'each',
  scanItem.matchedItem.innerQty != null ? Number(scanItem.matchedItem.innerQty) : null,
  Number(scanItem.matchedItem.packSize),
  scanItem.matchedItem.packUOM ?? 'each',
)
```

- [ ] **Step 3: Update `src/app/api/invoices/sessions/[id]/approve/route.ts`**

In the large inline type annotation on the `doApprove` function (around line 17), add `qtyUOM: string | null; innerQty: any` to the `matchedItem` type. Find:
```typescript
matchedItem: { id: string; qtyPerPurchaseUnit: any; packSize: any; packUOM: string | null }
```
Replace with:
```typescript
matchedItem: { id: string; qtyPerPurchaseUnit: any; qtyUOM: string | null; innerQty: any; packSize: any; packUOM: string | null }
```

Also find the Prisma query that selects `matchedItem` (around line 17 inside `doApprove`) — add `qtyUOM: true, innerQty: true` to that select. Look for where the session and its scanItems are fetched (search for `matchedItem: {` near the beginning of `doApprove`).

Then at line 52, update `calcPricePerBaseUnit` for the UPDATE_PRICE path:
```typescript
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
```

At line 128 (CREATE_NEW path), pass `'each', null` since new item data from the invoice form doesn't include structural fields:
```typescript
const newPricePerBase = Number(newData.pricePerBaseUnit) ||
  calcPricePerBaseUnit(newPurchasePrice, newPackQty, 'each', null, newPackSize, newPackUOM)
```

- [ ] **Step 4: Update `src/app/api/invoices/[id]/process/route.ts`**

The `item` is fetched with `include: { inventoryItem: true }` so it has all fields. At line 20, update:

```typescript
const newPPBU = calcPricePerBaseUnit(
  newPurchasePrice,
  qty,
  item.qtyUOM ?? 'each',
  item.innerQty != null ? Number(item.innerQty) : null,
  packSize,
  packUOM,
)
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/invoices/sessions/route.ts src/app/api/invoices/sessions/[id]/route.ts src/app/api/invoices/sessions/[id]/approve/route.ts src/app/api/invoices/[id]/process/route.ts
git commit -m "feat: update invoice routes to pass qtyUOM/innerQty to calc functions"
```

---

## Task 6: Component Callers — InvoiceDrawer and recipes/shared

**Files:**
- Modify: `src/components/invoices/InvoiceDrawer.tsx`
- Modify: `src/components/recipes/shared.tsx`

- [ ] **Step 1: Update InvoiceDrawer.tsx (3 call sites)**

Find line 965:
```typescript
const ppbu = calcPricePerBaseUnit(pp, qty, ps, form.packUOM)
const cf   = calcConversionFactor(form.countUOM, qty, ps, form.packUOM)
const bu   = deriveBaseUnit(form.packUOM)
```
Replace with:
```typescript
const ppbu = calcPricePerBaseUnit(pp, qty, 'each', null, ps, form.packUOM)
const cf   = calcConversionFactor(form.countUOM, qty, 'each', null, ps, form.packUOM)
const bu   = deriveBaseUnit('each', form.packUOM)
```

Find line 1268:
```typescript
const bu   = deriveBaseUnit(form.packUOM)
const ppbu = calcPricePerBaseUnit(pp, qty, ps, form.packUOM)
```
Replace with:
```typescript
const bu   = deriveBaseUnit('each', form.packUOM)
const ppbu = calcPricePerBaseUnit(pp, qty, 'each', null, ps, form.packUOM)
```

Find line 1291:
```typescript
conversionFactor:   calcConversionFactor(form.countUOM, qty, ps, form.packUOM),
```
Replace with:
```typescript
conversionFactor:   calcConversionFactor(form.countUOM, qty, 'each', null, ps, form.packUOM),
```

- [ ] **Step 2: Update recipes/shared.tsx (2 call sites)**

Find line 536:
```typescript
: calcPricePerBaseUnit(pp, qty, ps, pu)
```
Replace with:
```typescript
: calcPricePerBaseUnit(pp, qty, 'each', null, ps, pu)
```

Find line 537:
```typescript
const bu   = isPrep ? (item?.baseUnit ?? 'each') : deriveBaseUnit(pu)
```
Replace with:
```typescript
const bu   = isPrep ? (item?.baseUnit ?? 'each') : deriveBaseUnit('each', pu)
```

- [ ] **Step 3: Commit**

```bash
git add src/components/invoices/InvoiceDrawer.tsx src/components/recipes/shared.tsx
git commit -m "feat: update InvoiceDrawer and recipes/shared to new calc function signatures"
```

---

## Task 7: Inventory Page UI — Form Redesign + `needsReview` Banner

**Files:**
- Modify: `src/app/inventory/page.tsx`

- [ ] **Step 1: Update imports and `InventoryItem` type**

Find the import from `@/lib/utils` (line 4). Add `QTY_UOMS` to the import list.

Find the `InventoryItem` interface (around lines 25–35). Add:
```typescript
  qtyUOM?: string | null
  innerQty?: number | string | null
  needsReview?: boolean | null
```

- [ ] **Step 2: Update `EditForm` interface (around line 45)**

Add two fields after `packUOM`:
```typescript
  qtyUOM: string
  innerQty: string
```

- [ ] **Step 3: Update initial `editForm` state (around lines 77–78)**

Add:
```typescript
  qtyUOM: 'each', innerQty: '',
```

- [ ] **Step 4: Update `editForm` state in the large `useState` call (around lines 225–228)**

Add:
```typescript
  qtyUOM: 'each', innerQty: '',
```

- [ ] **Step 5: Update the item-populate call (around lines 1392–1407) where `selected` is assigned to `editForm`**

Add:
```typescript
qtyUOM: selected.qtyUOM ?? 'each',
innerQty: selected.innerQty != null ? String(selected.innerQty) : '',
```

Also add to the second nested object (the `InventoryItem`-typed one):
```typescript
qtyUOM: selected.qtyUOM ?? 'each',
innerQty: selected.innerQty != null ? Number(selected.innerQty) : undefined,
```

- [ ] **Step 6: Update `handleSave` PUT body (around lines 497–510)**

Add:
```typescript
qtyUOM: editForm.qtyUOM,
innerQty: editForm.innerQty ? parseFloat(editForm.innerQty) : null,
```

- [ ] **Step 7: Update auto-calculated preview block (around lines 1600–1615)**

Replace the existing calc lines:
```typescript
const bu   = isPrep ? (selected?.baseUnit ?? deriveBaseUnit(pu)) : deriveBaseUnit(pu)
const ppbu = isPrep
  ? parseFloat(String(selected?.pricePerBaseUnit ?? 0))
  : calcPricePerBaseUnit(pp, qty, ps, pu)
const cf = isPrep
  ? parseFloat(String(selected?.conversionFactor ?? 1))
  : calcConversionFactor(cu, qty, ps, pu)
```
With:
```typescript
const qu  = editForm.qtyUOM ?? 'each'
const iq  = editForm.innerQty ? parseFloat(editForm.innerQty) : null
const bu  = isPrep ? (selected?.baseUnit ?? deriveBaseUnit(qu, pu)) : deriveBaseUnit(qu, pu)
const ppbu = isPrep
  ? parseFloat(String(selected?.pricePerBaseUnit ?? 0))
  : calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu)
const cf = isPrep
  ? parseFloat(String(selected?.conversionFactor ?? 1))
  : calcConversionFactor(cu, qty, qu, iq, ps, pu)
```

- [ ] **Step 8: Replace the Purchase Structure form section (lines 1510–1543)**

Find the `<div className="grid grid-cols-2 gap-3">` that contains Purchase Unit, Qty per Case, Pack Size, Pack UOM, Purchase Price. Replace the entire block (from the opening `<div className="grid grid-cols-2 gap-3">` through its closing `</div>` before the Stock + Count fields comment) with:

```tsx
{/* Purchase Structure */}
<div className="space-y-3">
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
        <select value={editForm.qtyUOM} onChange={e => setEditForm(f => ({ ...f, qtyUOM: e.target.value, innerQty: e.target.value === 'pack' ? f.innerQty : '' }))}
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
            <input type="number" step="any" min="0" value={editForm.packSize === '1' ? '' : editForm.packSize}
              onChange={e => setEditForm(f => ({ ...f, packSize: e.target.value || '1' }))}
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

  {/* Purchase Price */}
  <div>
    <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Price ($)</label>
    <input type="number" step="any" value={editForm.purchasePrice}
      onChange={e => setEditForm(f => ({ ...f, purchasePrice: e.target.value }))}
      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold" />
  </div>
</div>
```

- [ ] **Step 9: Add `needsReview` banner above the inventory list**

Find a good location near the top of the returned JSX (after the page header / filter bar). Add before the items table/list:

```tsx
{/* needsReview banner */}
{items.some(i => i.needsReview) && (
  <div className="mx-4 mb-3 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
    <span className="text-base">⚠</span>
    <div className="flex-1">
      <span className="font-semibold">{items.filter(i => i.needsReview).length} items need purchase structure review</span>
      {' '}— their data couldn't be auto-repaired during migration.{' '}
      <button
        className="underline font-medium"
        onClick={() => setFilter(f => ({ ...f, needsReview: !f.needsReview }))}
      >
        {filter.needsReview ? 'Show all' : 'Show items'}
      </button>
    </div>
  </div>
)}
```

Note: if the page's filter state doesn't have a `needsReview` key, add `needsReview: false` to the filter state type and initial value, and add `...(filter.needsReview ? { needsReview: true } : {})` to the API query params.

Alternatively (simpler): just filter the visible items client-side. Find where `items` is filtered for display and add:
```typescript
.filter(i => !filterNeedsReview || i.needsReview)
```
with a `const [filterNeedsReview, setFilterNeedsReview] = useState(false)` at the top of the component.

- [ ] **Step 10: Commit**

```bash
git add src/app/inventory/page.tsx
git commit -m "feat: redesign purchase structure form with qtyUOM/innerQty, add needsReview banner"
```

---

## Task 8: InventoryItemDrawer UI — Form Redesign

**Files:**
- Modify: `src/components/inventory/InventoryItemDrawer.tsx`

Apply the same EditForm additions and form UI replacement from Task 7, mirrored for the drawer. The drawer has the same purchase structure grid at lines 374–408 and the same preview block at lines 464–490.

- [ ] **Step 1: Update imports**

Add `QTY_UOMS` to the import from `@/lib/utils` (line 7).

- [ ] **Step 2: Update `InventoryItem` interface (around line 38)**

Add:
```typescript
  qtyUOM?: string | null
  innerQty?: number | string | null
  needsReview?: boolean | null
```

- [ ] **Step 3: Update `EditForm` interface (around line 50)**

Add after `packUOM`:
```typescript
  qtyUOM: string
  innerQty: string
```

- [ ] **Step 4: Update initial state (around line 143)**

Add:
```typescript
  qtyUOM: 'each', innerQty: '',
```

- [ ] **Step 5: Update `openEdit` function (around lines 179–195)**

Add:
```typescript
qtyUOM: item.qtyUOM ?? 'each',
innerQty: item.innerQty != null ? String(item.innerQty) : '',
```

Also update the `convertCountQtyToBase` call where it builds an item dims object — add `qtyUOM` and `innerQty`:
```typescript
stockOnHand: convertCountQtyToBase(parseFloat(editForm.stockOnHand) || 0, editForm.countUOM, {
  ...
  qtyUOM: editForm.qtyUOM,
  innerQty: editForm.innerQty ? parseFloat(editForm.innerQty) : null,
}),
```

- [ ] **Step 6: Update `handleSave` PUT body (around line 211)**

Add:
```typescript
qtyUOM: editForm.qtyUOM,
innerQty: editForm.innerQty ? parseFloat(editForm.innerQty) : null,
```

- [ ] **Step 7: Update `convertCountQtyToBase` item dims objects in the drawer**

There are two places in the drawer where item dims objects are built for `convertCountQtyToBase`/`convertBaseToCountUom` (around lines 120–126 and 217–222). Add `qtyUOM` and `innerQty` to each:

Around line 121 (for displaying stock):
```typescript
return convertBaseToCountUom(Number(item.stockOnHand), item.countUOM ?? 'each', {
  baseUnit: item.baseUnit ?? 'each',
  purchaseUnit: item.purchaseUnit,
  qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit),
  qtyUOM: item.qtyUOM ?? 'each',
  innerQty: item.innerQty != null ? Number(item.innerQty) : null,
  packSize: Number(item.packSize ?? 1),
  packUOM: item.packUOM ?? 'each',
  countUOM: item.countUOM ?? 'each',
})
```

- [ ] **Step 8: Update the auto-calculated preview block (around lines 464–480)**

Replace:
```typescript
const bu  = isPrep ? (item.baseUnit ?? deriveBaseUnit(pu)) : deriveBaseUnit(pu)
const ppbu = isPrep
  ? parseFloat(String(item.pricePerBaseUnit ?? 0))
  : calcPricePerBaseUnit(pp, qty, ps, pu)
const cf = isPrep
  ? parseFloat(String(item.conversionFactor ?? 1))
  : calcConversionFactor(cu, qty, ps, pu)
```
With:
```typescript
const qu  = editForm.qtyUOM ?? 'each'
const iq  = editForm.innerQty ? parseFloat(editForm.innerQty) : null
const bu  = isPrep ? (item.baseUnit ?? deriveBaseUnit(qu, pu)) : deriveBaseUnit(qu, pu)
const ppbu = isPrep
  ? parseFloat(String(item.pricePerBaseUnit ?? 0))
  : calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu)
const cf = isPrep
  ? parseFloat(String(item.conversionFactor ?? 1))
  : calcConversionFactor(cu, qty, qu, iq, ps, pu)
```

- [ ] **Step 9: Replace the purchase structure form section (lines 374–408)**

Replace the `<div className="grid grid-cols-2 gap-3">` block (containing Purchase Unit, Qty per Case, Pack Size, Pack UOM, Purchase Price) with the same new form JSX from Task 7 Step 8. The JSX is identical — just `editForm` and `setEditForm` are already available in this component.

- [ ] **Step 10: Commit**

```bash
git add src/components/inventory/InventoryItemDrawer.tsx
git commit -m "feat: redesign InventoryItemDrawer purchase structure form with qtyUOM/innerQty"
```

---

## Task 9: Data Migration Script

**Files:**
- Create: `prisma/migrate-uom.ts`

- [ ] **Step 1: Write the migration script**

```typescript
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const PURCHASE_UNITS = new Set([
  'case', 'bag', 'box', 'bottle', 'pack', 'tray',
  'sleeve', 'dozen', 'pallet', 'jug', 'each',
])

const WEIGHT_VOL_UNITS: Record<string, string> = {
  kg: 'kg', g: 'g', lb: 'lb', oz: 'oz', l: 'l', ml: 'ml',
}

// Maps e.g. "20 each" → { qty: 20, unit: 'each' }, "2 kg" → { qty: 2, unit: 'kg' }
function parseEmbeddedQty(s: string): { qty: number; unit: string; container: string | null } | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s+(\w+)$/)
  if (!m) return null
  const qty = parseFloat(m[1])
  const unit = m[2].toLowerCase()
  if (isNaN(qty)) return null
  return { qty, unit, container: null }
}

async function main() {
  const items = await prisma.inventoryItem.findMany({
    select: {
      id: true, itemName: true,
      purchaseUnit: true, qtyPerPurchaseUnit: true,
      packSize: true, packUOM: true, qtyUOM: true,
    },
  })

  let fixed = 0
  let flagged = 0

  for (const item of items) {
    const pu = item.purchaseUnit?.trim() ?? ''
    let update: Record<string, unknown> = {}
    let needsReview = false

    // Rule 1: purchaseUnit matches "N unit" pattern (e.g. "20 each", "2 kg")
    const parsed = parseEmbeddedQty(pu)
    if (parsed) {
      const { qty, unit } = parsed
      const canonicalUnit = WEIGHT_VOL_UNITS[unit] ?? (unit === 'each' || unit === 'pack' ? unit : null)
      if (canonicalUnit) {
        update.qtyPerPurchaseUnit = qty
        update.qtyUOM = canonicalUnit
        // The purchaseUnit was something like "20 each" with no container word
        // Default the container to "case" as it's the most common
        update.purchaseUnit = 'case'
      } else {
        needsReview = true
      }
    }
    // Rule 2: purchaseUnit is itself a weight/volume unit
    else if (WEIGHT_VOL_UNITS[pu.toLowerCase()]) {
      update.qtyUOM = WEIGHT_VOL_UNITS[pu.toLowerCase()]
      update.purchaseUnit = 'bag'
    }
    // Rule 3: purchaseUnit is valid, qtyUOM not yet set (defaults to "each")
    else if (PURCHASE_UNITS.has(pu.toLowerCase())) {
      // Already valid — qtyUOM default "each" is correct in most cases
      // If packUOM is a weight/volume, qtyUOM = "each" is the right structural choice
      // No change needed — the default is already correct
      fixed++ // counted as fixed (it was already valid)
      continue
    }
    // Rule 4: unresolvable
    else {
      needsReview = true
    }

    if (needsReview) {
      await prisma.inventoryItem.update({
        where: { id: item.id },
        data: { needsReview: true },
      })
      flagged++
      console.log(`  ⚠ ${item.itemName} (purchaseUnit="${item.purchaseUnit}") — flagged for review`)
    } else {
      await prisma.inventoryItem.update({
        where: { id: item.id },
        data: update,
      })
      fixed++
      console.log(`  ✓ ${item.itemName}: purchaseUnit="${item.purchaseUnit}" → ${JSON.stringify(update)}`)
    }
  }

  console.log(`\nMigration complete: Fixed: ${fixed} · Flagged for review: ${flagged}`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Run the script**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/migrate-uom.ts
```

Expected output ends with: `Migration complete: Fixed: N · Flagged for review: M`

- [ ] **Step 3: Verify the results in Prisma Studio (optional sanity check)**

```bash
npx prisma studio
```

Check a few items: Baguette should now have `purchaseUnit=case, qtyUOM=each`. Items with `needsReview=true` should appear in the inventory banner.

- [ ] **Step 4: Delete the script (one-time tool)**

```bash
rm prisma/migrate-uom.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: run and remove one-time UOM data migration script"
```

---

## Task 10: Build Verification

**Files:** None (verification only)

- [ ] **Step 1: Run the production build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -30
```

Expected: build succeeds with no TypeScript errors. Any remaining red underlines in the IDE should match zero build errors.

- [ ] **Step 2: Spot-check the running app**

Start dev server: `npm run dev`

Navigate to `/inventory`. Open any non-recipe item → Edit. Verify:
- Purchase Unit dropdown no longer shows kg, g, lb, oz, l, ml
- "Qty per [unit]" label updates based on purchase unit
- Selecting `qtyUOM=pack` shows the indented "Items per Pack" + "Weight per Item (optional)" fields
- Selecting `qtyUOM=kg` (weight-based) shows no extra fields
- Auto-calculated preview updates correctly

Check that Baguette now shows `1 each = 290 g` (after migration ran).

Check that any `needsReview=true` items show the amber banner.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: UOM overhaul complete — qtyUOM/innerQty structure, new purchase form, data migration"
```

---

## Spec Coverage Checklist

| Spec section | Covered by |
|---|---|
| Schema: `qtyUOM`, `innerQty`, `needsReview` | Task 1 |
| `PURCHASE_UNITS` locked to container types | Task 2 |
| `QTY_UOMS` export | Task 2 |
| `deriveBaseUnit(qtyUOM, packUOM)` | Task 2 |
| `calcPricePerBaseUnit` 6-param | Task 2 |
| `calcConversionFactor` 6-param | Task 2 |
| `getCountableUoms` structure-derived | Task 3 |
| `convertCountQtyToBase` pack-aware | Task 3 |
| `convertBaseToCountUom` pack-aware | Task 3 |
| PUT validation `qtyUOM` ∈ `QTY_UOMS` | Task 4 |
| PUT `needsReview: false` on save | Task 4 |
| All API caller updates | Tasks 4–5 |
| All component caller updates | Task 6 |
| Form UI: 3 structural paths | Tasks 7–8 |
| `needsReview` banner | Task 7 |
| Migration script 4 rules | Task 9 |
| Build verification | Task 10 |
