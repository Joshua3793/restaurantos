# Invoice Scanner Accuracy & Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make invoice scanning deterministic-first (supplier item-code matching), make wrong data unable to silently reach `pricePerBaseUnit` (trust gates on approve), and optimize the mobile snap flow (pages go through the image-enhancement OCR path instead of being buried in a PDF).

**Architecture:** Three layers change. (1) The matcher gains a tier-0 deterministic lookup on `(supplierName, supplierItemCode)` learned at approval time, and learned description rules become supplier-scoped. (2) The approve route gains four gates: an atomic status claim, a duplicate-invoice 409, a `pricePerBaseUnit > 0` guard, and explicit user consent before invoice pack formats overwrite inventory. (3) The review drawer gains a "Check this line" decision for low-OCR-confidence / fuzzy-MEDIUM lines, and mobile gains a "View on invoice" jump from any line to its bbox on the image. The native scan pipeline switches from PDF-merge to per-page JPEG upload so phone photos get the sharp enhancement pipeline.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma + PostgreSQL (Supabase, pgBouncer), Tailwind, Anthropic SDK (Claude OCR).

**Verification note:** This project has **no test suite** (per CLAUDE.md). `npm run build` is the automated correctness check — run it after every task. node/npm are **not on the sandbox PATH**: read `~/.claude/projects/-Users-joshua-Desktop-Fergie-s-OS/memory/project_node_toolchain.md` for the toolchain path first, and export it once per shell. **Stop any running dev/preview server before `npm run build`** (build deadlocks if the preview server is running).

---

## Task 1: Schema migration — match-rule item codes, format consent flag, supplier format notes

`prisma migrate dev` is **broken** on this DB (P3006 shadow drift). Use the diff/db-execute/resolve workaround exactly as written below (verified working 2026-06-04).

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_invoice_scanner_accuracy/migration.sql` (generated)

- [ ] **Step 1: Edit `prisma/schema.prisma`**

In `model InvoiceMatchRule` (line ~403), add a column + index after `invoicePackUOM String?`:

```prisma
  supplierItemCode String?

  @@index([supplierName, supplierItemCode])
```

(The `@@index` goes next to the existing `@@unique([rawDescription, supplierName])`.)

In `model InvoiceScanItem` (line ~327), add after `supplierItemCode   String?`:

```prisma
  applyInvoiceFormat Boolean        @default(false) // user consented to writing the invoice's pack format back to the inventory item
```

In `model Supplier`, add:

```prisma
  ocrFormatNotes String? // column-layout notes discovered by learning-mode OCR; injected into future OCR prompts
```

- [ ] **Step 2: Generate, apply, and record the migration (no shadow DB)**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
set -a && . ./.env; set +a
TS=$(date +%Y%m%d%H%M%S)
mkdir -p "prisma/migrations/${TS}_invoice_scanner_accuracy"
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script > "prisma/migrations/${TS}_invoice_scanner_accuracy/migration.sql"
cat "prisma/migrations/${TS}_invoice_scanner_accuracy/migration.sql"   # sanity-check: only ADD COLUMN / CREATE INDEX statements
npx prisma db execute --url "$DIRECT_URL" --file "prisma/migrations/${TS}_invoice_scanner_accuracy/migration.sql"
npx prisma migrate resolve --applied "${TS}_invoice_scanner_accuracy"
npx prisma generate
```

Expected: diff SQL contains exactly three `ALTER TABLE ... ADD COLUMN` statements and one `CREATE INDEX`. If it contains DROPs of unrelated tables, STOP — the schema file has drifted; do not execute.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles (regenerated client picks up new fields).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(invoices): schema for item-code match rules, format consent, supplier format notes"
```

---

## Task 2: Tier-0 supplier item-code matching + supplier-scoped rule confidence

**Files:**
- Modify: `src/lib/invoice-matcher.ts`

- [ ] **Step 1: Load item-code rules in `matchLineItems`**

In `src/lib/invoice-matcher.ts`, inside `matchLineItems` (after the `learnedRules` try/catch block ending ~line 324), add:

```ts
  // ── Item-code rules: deterministic (supplier, supplierItemCode) → item ────
  // An item code printed on the invoice is supplier-scoped and unambiguous —
  // it beats any text matching. Learned at approval time (saveMatchRule).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let codeRules: any[] = []
  const itemCodes = ocrItems
    .map(i => i.supplierItemCode)
    .filter((c): c is string => !!c)
  if (supplierName && itemCodes.length > 0) {
    try {
      codeRules = await prisma.invoiceMatchRule.findMany({
        where: {
          supplierName,
          supplierItemCode: { in: itemCodes },
        },
        include: {
          inventoryItem: {
            select: {
              id: true,
              itemName: true,
              purchaseUnit: true,
              pricePerBaseUnit: true,
              purchasePrice: true,
              baseUnit: true,
              qtyPerPurchaseUnit: true,
              packSize: true,
              packUOM: true,
            },
          },
        },
        orderBy: { useCount: 'desc' },
      })
    } catch {
      // Column may not exist yet on stale clients — fall through to text matching
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const codeRuleMap = new Map<string, any>()
  for (const rule of codeRules) {
    if (rule.supplierItemCode && !codeRuleMap.has(rule.supplierItemCode)) {
      codeRuleMap.set(rule.supplierItemCode, rule) // first = highest useCount
    }
  }
```

- [ ] **Step 2: Check the code map first in the per-item loop**

Inside the `return ocrItems.map((ocrItem) => {` callback, **before** the `// ── 1. Check learned rules first` block, add:

```ts
    // ── 0. Supplier item-code rule (deterministic — beats all text matching) ─
    const codeRule = ocrItem.supplierItemCode
      ? codeRuleMap.get(ocrItem.supplierItemCode)
      : undefined
    if (codeRule?.inventoryItem) {
      const hasRuleFormat = !!(codeRule.invoicePackQty && codeRule.invoicePackSize)
      const ruleFormat = hasRuleFormat ? {
        packQty:  Number(codeRule.invoicePackQty),
        packSize: Number(codeRule.invoicePackSize),
        packUOM:  codeRule.invoicePackUOM ?? 'each',
      } : parseFormatFromDescription(ocrItem.description)
      return buildMatchResult(
        ocrItem,
        codeRule.inventoryItem as unknown as InventoryItem,
        'HIGH',
        100,
        ruleFormat,
        hasRuleFormat
      )
    }
```

- [ ] **Step 3: Demote cross-supplier generic description rules to MEDIUM**

Replace the body of the `// ── 1. Check learned rules first` block (lines ~344–362). Old:

```ts
    const learned = learnedMap.get(ocrItem.description)
    if (learned?.inventoryItem) {
      const hasLearnedFormat = !!(learned.invoicePackQty && learned.invoicePackSize)
      const learnedFormat = hasLearnedFormat ? {
        packQty: Number(learned.invoicePackQty),
        packSize: Number(learned.invoicePackSize),
        packUOM: learned.invoicePackUOM ?? 'each',
      } : parseFormatFromDescription(ocrItem.description)

      return buildMatchResult(
        ocrItem,
        learned.inventoryItem as unknown as InventoryItem,
        'HIGH',
        100,
        learnedFormat,
        hasLearnedFormat
      )
    }
```

New:

```ts
    const learned = learnedMap.get(ocrItem.description)
    if (learned?.inventoryItem) {
      const hasLearnedFormat = !!(learned.invoicePackQty && learned.invoicePackSize)
      const learnedFormat = hasLearnedFormat ? {
        packQty: Number(learned.invoicePackQty),
        packSize: Number(learned.invoicePackSize),
        packUOM: learned.invoicePackUOM ?? 'each',
      } : parseFormatFromDescription(ocrItem.description)

      // A rule learned under THIS supplier is authoritative. A generic rule
      // (saved when the supplier was unknown, supplierName '') applied to a
      // session with a known supplier is only a hint — surface it as MEDIUM so
      // the trust-check gate (resolution.ts) asks the user to confirm it.
      const supplierSpecific = !supplierName || learned.supplierName === supplierName
      return buildMatchResult(
        ocrItem,
        learned.inventoryItem as unknown as InventoryItem,
        supplierSpecific ? 'HIGH' : 'MEDIUM',
        supplierSpecific ? 100 : 60,
        learnedFormat,
        hasLearnedFormat
      )
    }
```

- [ ] **Step 4: Teach `saveMatchRule` to store item codes**

Replace the `saveMatchRule` function (lines ~412–440) with:

```ts
// Save a learned match rule. Call this when a user confirms (or overrides) a match.
export async function saveMatchRule(
  rawDescription: string,
  inventoryItemId: string,
  supplierName?: string | null,
  format?: { packQty: number; packSize: number; packUOM: string } | null,
  supplierItemCode?: string | null
): Promise<void> {
  await prisma.invoiceMatchRule.upsert({
    where: {
      rawDescription_supplierName: {
        rawDescription,
        supplierName: supplierName || '',
      },
    },
    create: {
      rawDescription,
      supplierName: supplierName || '',
      inventoryItemId,
      supplierItemCode: supplierItemCode ?? null,
      invoicePackQty: format?.packQty ?? null,
      invoicePackSize: format?.packSize ?? null,
      invoicePackUOM: format?.packUOM ?? null,
    },
    update: {
      inventoryItemId,
      useCount: { increment: 1 },
      lastUsed: new Date(),
      ...(supplierItemCode ? { supplierItemCode } : {}),
      ...(format ? { invoicePackQty: format.packQty, invoicePackSize: format.packSize, invoicePackUOM: format.packUOM } : {}),
    },
  })
}
```

- [ ] **Step 5: Build**

Run: `npm run build` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/invoice-matcher.ts
git commit -m "feat(invoices): deterministic supplier item-code matching tier; supplier-scoped rule confidence"
```

---

## Task 3: Approve route — learn item codes + four trust gates

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts`

- [ ] **Step 1: Add `supplierItemCode` and `applyInvoiceFormat` to the inline scanItems type**

In the `doApprove` signature (line 24), inside the `scanItems: Array<{ ... }>` object type, add alongside `matchScore: any`:

```ts
; supplierItemCode: string | null; applyInvoiceFormat: boolean
```

- [ ] **Step 2: Gate format writeback on user consent**

Replace line 48:

```ts
        const useInvoicePack = scanItem.invoicePackSize !== null && scanItem.invoicePackQty !== null
```

with:

```ts
        // Only overwrite the inventory item's stored pack structure when the
        // user explicitly chose "Use invoice format" in the drawer (sets
        // applyInvoiceFormat). A one-off odd shipment must never silently
        // rewrite the item's standard format.
        const useInvoicePack =
          scanItem.applyInvoiceFormat === true &&
          scanItem.invoicePackSize !== null &&
          scanItem.invoicePackQty !== null
```

- [ ] **Step 3: Guard against writing a zero/invalid `pricePerBaseUnit`**

Immediately after the `newPricePerBase` computation block (after line 85, before `// Wrap all writes...`), add:

```ts
        // Never write a zero/NaN price to the spine — a 0 pricePerBaseUnit
        // silently zeroes every recipe cost that reads this item. Leave the
        // line un-approved so it stays visible in the session for follow-up.
        if (!Number.isFinite(newPricePerBase) || newPricePerBase <= 0) {
          console.error(
            `[approve] Skipping price write for "${scanItem.rawDescription}" — computed pricePerBaseUnit=${newPricePerBase}`
          )
          continue
        }
```

- [ ] **Step 4: Pass item codes into `saveMatchRule`**

In the `// ── Save learned match rules` block (lines ~255–270), replace the `saveMatchRule(...)` call:

```ts
          saveMatchRule(
            item.rawDescription,
            item.matchedItemId!,
            session.supplierName,
            item.invoicePackQty ? {
              packQty:  Number(item.invoicePackQty),
              packSize: Number(item.invoicePackSize),
              packUOM:  item.invoicePackUOM ?? 'each',
            } : undefined,
            item.supplierItemCode
          ).catch(() => {})
```

- [ ] **Step 5: Duplicate-invoice gate + atomic status claim in `POST`**

Replace the `POST` body from `const session = await prisma.invoiceSession.findUnique({` (line 306) through the `await prisma.invoiceSession.update({ ... status: 'APPROVING' ... })` block (line 324) with:

```ts
  const body = await req.json().catch(() => ({} as Record<string, unknown>))

  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      scanItems: {
        include: { matchedItem: true },
      },
    },
  })

  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  if (session.status !== 'REVIEW') {
    return NextResponse.json({ error: 'Session is not in REVIEW state' }, { status: 400 })
  }

  // ── Duplicate gate ──────────────────────────────────────────────────────
  // Same supplier + same invoice number already approved → block unless the
  // client re-submits with { force: true } after the user confirms.
  if (body?.force !== true && session.invoiceNumber && session.supplierName) {
    const dup = await prisma.invoiceSession.findFirst({
      where: {
        id:            { not: session.id },
        status:        'APPROVED',
        invoiceNumber: session.invoiceNumber,
        supplierName:  session.supplierName,
      },
      select: { id: true, approvedAt: true },
    })
    if (dup) {
      return NextResponse.json(
        {
          error: `Invoice ${session.invoiceNumber} from ${session.supplierName} was already approved${dup.approvedAt ? ` on ${new Date(dup.approvedAt).toLocaleDateString()}` : ''}. Approving again will apply its price changes a second time.`,
          duplicate: true,
        },
        { status: 409 }
      )
    }
  }

  // ── Atomic status claim ─────────────────────────────────────────────────
  // Compare-and-set REVIEW → APPROVING so a double-tap (or two reviewers) can
  // never run doApprove twice over the same session.
  const claimed = await prisma.invoiceSession.updateMany({
    where: { id: params.id, status: 'REVIEW' },
    data:  { status: 'APPROVING' },
  })
  if (claimed.count === 0) {
    return NextResponse.json({ error: 'Session is already being approved' }, { status: 409 })
  }
```

(The `waitUntil(...)` and final `return NextResponse.json({ ok: true, queued: true })` lines stay unchanged.)

- [ ] **Step 6: Build**

Run: `npm run build` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/invoices/sessions/[id]/approve/route.ts"
git commit -m "feat(invoices): approve trust gates — atomic claim, duplicate 409, price guard, format consent"
```

---

## Task 4: Drawer — duplicate-force confirm + format-consent wiring

**Files:**
- Modify: `src/components/invoices/v2/InvoiceReviewDrawer.tsx:589-607` (handleApprove)
- Modify: `src/components/invoices/v2/card.tsx:404-427` (format mismatch buttons)
- Modify: `src/app/api/invoices/sessions/[id]/route.ts:34-69` (PATCH passthrough)
- Modify: `src/components/invoices/types.ts` (ScanItem field)

- [ ] **Step 1: `handleApprove` retries with force on duplicate 409**

In `InvoiceReviewDrawer.tsx`, replace the `handleApprove` function (lines 589–607) with:

```ts
  const handleApprove = async (force = false) => {
    if (!session) return
    setApproving(true)
    try {
      const res = await fetch(`/api/invoices/sessions/${session.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      })
      const result = await res.json()
      if (res.status === 409 && result.duplicate && !force) {
        const ok = window.confirm(`${result.error}\n\nApprove anyway?`)
        if (ok) { setApproving(false); return handleApprove(true) }
        return
      }
      if (!res.ok) {
        alert(`Approval failed: ${result.error ?? res.statusText}`)
        return
      }
      setApproved(true)
      onApproveOrReject()
      if (result.queued) onClose()
    } catch {
      alert('Network error — please try again.')
    } finally {
      setApproving(false)
    }
  }
```

(The ⌘⏎ keyboard handler and footer button call `handleApprove()` with no args — still valid.)

- [ ] **Step 2: Format buttons set/clear the consent flag**

In `card.tsx`, the "Use invoice format" button (line ~407). Old:

```ts
          onClick={() => updateLine(lineId, { formatMismatch: false })}
```

New:

```ts
          onClick={() => updateLine(lineId, { formatMismatch: false, applyInvoiceFormat: true })}
```

The "Revert to inventory format" button's `updateLine` call (line ~416). Old patch object starts `formatMismatch: false,` — add a line so it reads:

```ts
            updateLine(lineId, {
              formatMismatch: false,
              applyInvoiceFormat: false,
              invoicePackQty:  String(inv.qtyPerPurchaseUnit),
              invoicePackSize: String(inv.packSize),
              invoicePackUOM:  inv.packUOM ?? undefined,
            })
```

- [ ] **Step 3: PATCH route accepts the new fields**

In `src/app/api/invoices/sessions/[id]/route.ts`, inside the `prisma.invoiceScanItem.update` data object (after the `supplierItemCode` line, ~line 68), add:

```ts
        applyInvoiceFormat: body.applyInvoiceFormat !== undefined ? body.applyInvoiceFormat : undefined,
        formatMismatch:     body.formatMismatch     !== undefined ? body.formatMismatch     : undefined,
```

(Check first whether `formatMismatch` is already in the data object — the drawer already PATCHes it via `updateLine`, so it may exist; only add it if missing.)

- [ ] **Step 4: Add the field to the `ScanItem` type**

In `src/components/invoices/types.ts`, find the `ScanItem` interface and add alongside `formatMismatch`:

```ts
  applyInvoiceFormat?: boolean
```

Also confirm `matchConfidence` exists on `ScanItem` (needed by Task 5). If missing, add:

```ts
  matchConfidence?: string // 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
```

- [ ] **Step 5: Build**

Run: `npm run build` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/invoices/v2/InvoiceReviewDrawer.tsx src/components/invoices/v2/card.tsx "src/app/api/invoices/sessions/[id]/route.ts" src/components/invoices/types.ts
git commit -m "feat(invoices): duplicate force-approve confirm; explicit format-writeback consent"
```

---

## Task 5: "Check this line" trust gate for low-confidence OCR and fuzzy-MEDIUM matches

A line is low-trust when Claude marked it `ocrConfidence: 'low'`, or the match was only fuzzy-MEDIUM yet would auto-write a price. These currently sail through approval untouched. Add a decision badge + acknowledgement, mirroring the existing big-price-change pattern exactly.

**Files:**
- Modify: `src/lib/invoice/predicates.ts`
- Modify: `src/lib/invoice/resolution.ts`
- Modify: `src/components/invoices/v2/atoms.tsx:173-180`
- Modify: `src/components/invoices/v2/issues.tsx`
- Modify: `src/components/invoices/v2/context.tsx`
- Modify: `src/components/invoices/v2/card.tsx`
- Modify: `src/components/invoices/v2/InvoiceReviewDrawer.tsx`

- [ ] **Step 1: Predicate**

Append to `src/lib/invoice/predicates.ts`:

```ts
// ── Trust check ───────────────────────────────────────────────────────────────
// True when the line needs an explicit "looks right" confirmation before it
// can write a price: Claude flagged the OCR as low-confidence, or the link is
// only a fuzzy MEDIUM match that would auto-update the price.
export function needsTrustCheck(item: ScanItem): boolean {
  if (item.action === 'SKIP') return false
  if (item.ocrConfidence === 'low') return true
  return (
    item.matchConfidence === 'MEDIUM' &&
    (item.action === 'UPDATE_PRICE' || item.action === 'ADD_SUPPLIER')
  )
}
```

- [ ] **Step 2: Resolution model**

In `src/lib/invoice/resolution.ts`:

Add `needsTrustCheck` to the predicates import (line 7–9):

```ts
import {
  isUnlinked, hasModeMismatch, hasFormatMismatch, hasMathCheck, hasPriceChange,
  needsTrustCheck,
} from './predicates'
```

Extend `ResolveOpts`:

```ts
export interface ResolveOpts {
  /** line ids the user chose to write the detected mode back to the product */
  modeWriteback: boolean
  /** line ids where the user accepted/acknowledged the price change */
  priceAck: boolean
  /** line ids where the user confirmed a low-trust line (low OCR conf / fuzzy match) */
  confAck: boolean
}
```

In `lineIssues`, after the big-price-change push (line ~57), add:

```ts
  // Low-trust line — resolved once the user confirms it looks right.
  if (needsTrustCheck(item)) out.push({ kind: 'conf', resolved: opts.confAck })
```

- [ ] **Step 3: Badge kind**

In `src/components/invoices/v2/atoms.tsx` (line 173):

```ts
export type IssueKind = 'price' | 'mode' | 'sku' | 'supplier' | 'conf'
```

and in `ISSUE_BADGE`:

```ts
  conf:     'bg-gold-soft text-gold-2',
```

- [ ] **Step 4: `ConfIssue` component**

Append to `src/components/invoices/v2/issues.tsx`:

```tsx
// ── ConfIssue ────────────────────────────────────────────────────────────────
// Low-trust line: Claude flagged the OCR as low confidence (ocrNotes says why),
// or the link is only a fuzzy MEDIUM match. One decision: confirm it looks right
// (or the user fixes the line via the existing link/math editors, which they can
// do before confirming).
export function ConfIssue({ item, lineId }: { item: ScanItem; lineId: string }) {
  const ctx = useDrawerContext()
  const acked = ctx.acknowledgedConfLines.has(lineId)
  const reason = item.ocrConfidence === 'low'
    ? `The scanner wasn't sure about this line${item.ocrNotes ? ` — ${item.ocrNotes}` : ''}.`
    : `This was matched to "${item.matchedItem?.itemName ?? 'an item'}" by description similarity only — confirm it's the right product.`
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2.5">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-gold-soft text-gold-2 shrink-0">
          Check line
        </span>
        <span className="text-[12.5px] text-ink-2 leading-[1.45]">{reason}</span>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          disabled={acked}
          onClick={() => ctx.acknowledgeConf(lineId)}
          className={`inline-flex items-center gap-1.5 px-3 py-[7px] text-[12px] font-medium rounded-[7px] transition-colors ${
            acked
              ? 'bg-green-soft text-green-text cursor-default'
              : 'bg-ink text-paper hover:bg-ink-2'
          }`}
        >
          {acked ? 'Confirmed ✓' : 'Looks right'}
        </button>
      </div>
    </div>
  )
}
```

(Match this file's existing imports: it already imports `ScanItem` and `useDrawerContext` for the other issue components — reuse them.)

- [ ] **Step 5: Context shape**

In `src/components/invoices/v2/context.tsx`, add to `DrawerContextValue` after `acknowledgedPriceLines` (line 26):

```ts
  acknowledgedConfLines: Set<string>  // lines where the user confirmed a low-trust line
```

and after `acknowledgePrice` (line 61):

```ts
  // ── Low-trust line confirmation (resolves the conf .issue) ─────────────────
  acknowledgeConf: (id: string) => void
```

- [ ] **Step 6: Drawer state + wiring**

In `InvoiceReviewDrawer.tsx`:

After line 309 (`acknowledgedPriceLines` state):

```ts
  const [acknowledgedConfLines, setAcknowledgedConfLines] = useState<Set<string>>(new Set())
```

Replace `optsFor` (lines 382–385):

```ts
  const optsFor = useCallback(
    (id: string) => ({
      modeWriteback: modeWritebackItems.has(id),
      priceAck:      acknowledgedPriceLines.has(id),
      confAck:       acknowledgedConfLines.has(id),
    }),
    [modeWritebackItems, acknowledgedPriceLines, acknowledgedConfLines],
  )
```

Replace `lineIsAttention` (lines 387–389):

```ts
  const lineIsAttention = useCallback((i: ScanItem) =>
    isUnlinked(i) || hasModeMismatch(i) || hasFormatMismatch(i) || hasMathCheck(i)
    || isBigPriceChange(i) || needsTrustCheck(i),
  [])
```

Add `needsTrustCheck` to the file's import from `@/lib/invoice/predicates`.

After the `acknowledgePrice` callback (lines 584–586):

```ts
  const acknowledgeConf = useCallback((id: string) => {
    setAcknowledgedConfLines(prev => new Set(prev).add(id))
  }, [])
```

In `ctxValue` (line ~696): add `acknowledgedConfLines,` next to `acknowledgedPriceLines,` and `acknowledgeConf,` next to `acknowledgePrice,`; add both to the useMemo dependency array (line ~725).

- [ ] **Step 7: Render in card**

In `card.tsx`:

Near line 43 (other derived flags):

```ts
  const trustCheck = !isSkipped && needsTrustCheck(item)
```

Add `trustCheck` to the `isAttention` expression (line 46):

```ts
  const isAttention = unlinked || modeMismatch || formatMismatch || mathCheck || bigPrice || trustCheck
```

Import `needsTrustCheck` from `@/lib/invoice/predicates` and `ConfIssue` from `./issues` (line 17).

Next to the `PriceIssue` render (line ~257):

```tsx
          {trustCheck && <ConfIssue item={item} lineId={lineId} />}
```

- [ ] **Step 8: Build**

Run: `npm run build` — Expected: PASS. Fix any missed `ResolveOpts` call sites the compiler flags (every `lineUnresolved`/`lineIssues` caller must now pass `confAck`).

- [ ] **Step 9: Commit**

```bash
git add src/lib/invoice/predicates.ts src/lib/invoice/resolution.ts src/components/invoices/v2
git commit -m "feat(invoices): low-trust lines (low OCR conf / fuzzy MEDIUM) require confirmation before approve"
```

---

## Task 6: Native scan uploads enhanced JPEG pages instead of a merged PDF

Today the Capacitor scanner's JPEG pages are merged into a PDF, which (a) bypasses the sharp enhancement pipeline (`rotate/normalize/sharpen`) in `invoice-ocr.ts` — phone photos get *worse* OCR than gallery uploads — and (b) hits the 4 MB local-upload ceiling ("scan fewer pages"). Upload the pages as individual compressed JPEGs: the process route already batches all images into one Claude call, and bbox page indexes map to file order.

**Files:**
- Create: `src/lib/image-compress.ts`
- Modify: `src/components/invoices/InvoiceUploadModal.tsx:60-93`
- Modify: `src/hooks/useNativeScan.ts`

- [ ] **Step 1: Extract the canvas compressor to a shared util**

Create `src/lib/image-compress.ts` with the exact function from `InvoiceUploadModal.tsx:62-93`, exported:

```ts
'use client'

// Compress an image file to ≤1 MB at ≤2000 px using Canvas.
// Non-image files (PDF, CSV) are returned as-is.
export const compressImageFile = (file: File): Promise<File> => {
  if (!file.type.startsWith('image/') || file.size <= 1 * 1024 * 1024) return Promise.resolve(file)
  return new Promise((resolve) => {
    const img = new window.Image()
    const objectUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const MAX_DIM = 2000
      let { width, height } = img
      if (width > MAX_DIM || height > MAX_DIM) {
        const scale = MAX_DIM / Math.max(width, height)
        width  = Math.round(width  * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width  = width
      canvas.height = height
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => {
          if (!blob) { resolve(file); return }
          const name = file.name.replace(/\.[^.]+$/, '.jpg')
          resolve(new File([blob], name, { type: 'image/jpeg' }))
        },
        'image/jpeg',
        0.82,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file) }
    img.src = objectUrl
  })
}
```

In `InvoiceUploadModal.tsx`: delete the local `compressImageFile` (lines 60–93) and add `import { compressImageFile } from '@/lib/image-compress'`.

- [ ] **Step 2: Rewrite `useNativeScan` to upload JPEG pages**

In `src/hooks/useNativeScan.ts`:

Delete `mergePagesToPdf` (lines 21–35) and the pdf-lib import inside it. Add the import:

```ts
import { compressImageFile } from '@/lib/image-compress'
```

Replace step 2 of `triggerScan` (lines 52–56). Old:

```ts
      // 2. Merge pages into a single PDF
      const pdfBlob = await mergePagesToPdf(pages)
      const pdfFile = new File([pdfBlob], `scan_${Date.now()}.pdf`, {
        type: 'application/pdf',
      })
```

New:

```ts
      // 2. Convert pages to compressed JPEG files. Individual images (not a
      // merged PDF) so the server runs them through the sharp enhancement
      // pipeline and one combined multi-image OCR call — and bbox page
      // indexes line up with file order.
      const pageFiles = await Promise.all(pages.map(async (raw, i) => {
        const b64 = raw.replace(/^data:image\/[^;]+;base64,/, '')
        const bytes = base64ToUint8Array(b64)
        const file = new File([new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' })],
          `scan_p${i + 1}.jpg`, { type: 'image/jpeg' })
        return compressImageFile(file)
      }))
```

Replace every later use of `pdfFile`:

- 4a cloud upload: `startUpload(pageFiles)`; the register payload becomes:

```ts
              files: uploaded.map(f => ({
                url: f.url,
                fileName: f.name,
                fileType: 'image/jpeg',
              })),
```

- 4b local fallback:

```ts
      if (!uploadOk) {
        const limitBytes = 4 * 1024 * 1024
        const oversize = pageFiles.find(f => f.size > limitBytes)
        if (oversize) {
          setScanError(
            `A scanned page is too large (${(oversize.size / 1024 / 1024).toFixed(1)} MB) even after compression. Please retake the photo.`
          )
          return
        }
        const fd = new FormData()
        for (const f of pageFiles) fd.append('files', f)
        const localRes = await fetch(`/api/invoices/sessions/${sess.id}/upload-local`, {
          method: 'POST',
          body: fd,
        })
        if (localRes.ok) {
          uploadOk = true
        } else {
          const body = await localRes.json().catch(() => ({}))
          setScanError(body.error ?? `Upload failed (${localRes.status}).`)
          return
        }
      }
```

Do **not** remove `pdf-lib` from package.json without first checking it has no other importers: `grep -rn "pdf-lib" src/ --include='*.ts' --include='*.tsx'` — if `useNativeScan.ts` was the only one, remove the dependency in a separate cleanup commit.

- [ ] **Step 3: Build**

Run: `npm run build` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/image-compress.ts src/components/invoices/InvoiceUploadModal.tsx src/hooks/useNativeScan.ts
git commit -m "feat(invoices): native scan uploads enhanced JPEG pages instead of merged PDF"
```

---

## Task 7: Mobile — "View on invoice" jump from line card to image bbox

Mobile review hides the invoice image behind a tab switch; users verify extracted numbers from memory. Cheap fix using existing machinery: a per-line button that switches to the image tab with that line's bbox highlighted (`activeBboxItemId` + `ImageViewer` highlighting already exist).

**Files:**
- Modify: `src/components/invoices/v2/context.tsx`
- Modify: `src/components/invoices/v2/InvoiceReviewDrawer.tsx`
- Modify: `src/components/invoices/v2/card.tsx`

- [ ] **Step 1: Context callback**

In `context.tsx` `DrawerContextValue`, after `activeBboxItemId` (line 64):

```ts
  /** Mobile: switch the drawer to the image tab with this line's row highlighted. */
  showLineOnImage: (id: string) => void
```

- [ ] **Step 2: Drawer implementation**

In `InvoiceReviewDrawer.tsx`, near the other line callbacks (after `acknowledgeConf` from Task 5):

```ts
  const showLineOnImage = useCallback((id: string) => {
    setActiveBboxItemId(id)
    setMobileTab('image')
  }, [])
```

Add `showLineOnImage,` to `ctxValue` and its dependency array. (`setMobileTab` and `setActiveBboxItemId` are state setters already defined in this component — lines 61 and the bbox state respectively.)

- [ ] **Step 3: Card button (mobile-only, lines with a bbox)**

In `card.tsx`, inside the expanded card content, immediately before the issue components block (the region containing `{bigPrice && <PriceIssue ...>}` at line ~257):

```tsx
          {item.bbox != null && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); ctx.showLineOnImage(lineId) }}
              className="sm:hidden inline-flex items-center gap-1.5 self-start px-3 py-[7px] text-[12px] font-medium rounded-[7px] bg-paper text-ink-2 border border-line hover:border-ink-4 transition-colors"
            >
              View on invoice
            </button>
          )}
```

(`sm:hidden` keeps it mobile-only; desktop already shows the image side-by-side. `ctx` is the drawer context already in scope in this component.)

- [ ] **Step 4: Build, then verify in preview**

Run: `npm run build` — Expected: PASS.

Then start the dev server (preview_start), open `/invoices` at mobile width (preview_resize 390×844), open a REVIEW session, expand a line, tap "View on invoice" — expect the image tab with the row highlighted.

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/v2/context.tsx src/components/invoices/v2/InvoiceReviewDrawer.tsx src/components/invoices/v2/card.tsx
git commit -m "feat(invoices,mobile): per-line 'View on invoice' jump to bbox on image tab"
```

---

## Task 8: Process route resilience — all-failed guard + per-page truncation fallback

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/process/route.ts:129-193`

- [ ] **Step 1: Per-page fallback when the combined image OCR truncates**

Replace the image-files block (lines 129–163) with:

```ts
    if (imageFiles.length > 0) {
      const imagePayloads = await Promise.all(
        imageFiles.map(async (f) => {
          const buf = await loadBuffer(f)
          const ft  = f.fileType.toLowerCase()
          return {
            base64:    buf.toString('base64'),
            mediaType: (ft === 'image/png' ? 'image/png' : ft === 'image/webp' ? 'image/webp' : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp',
          }
        })
      )
      try {
        console.log(`[process] Sending ${imageFiles.length} image(s) in one Claude call`)
        const result = await extractInvoiceFromImages(imagePayloads, session.supplierName, isLearning)
        mergeResult(result, sessionMeta)
        allOcrItems = [...allOcrItems, ...result.lineItems]
        await prisma.invoiceFile.update({
          where: { id: imageFiles[0].id },
          data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(result) },
        })
        if (imageFiles.length > 1) {
          await prisma.invoiceFile.updateMany({
            where: { id: { in: imageFiles.slice(1).map(f => f.id) } },
            data: { ocrStatus: 'COMPLETE' },
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // The combined call can blow the output-token budget on very long
        // invoices. Fall back to OCR-ing each page separately and merging —
        // each page alone fits comfortably in the budget.
        if (imageFiles.length > 1 && /truncated/i.test(msg)) {
          console.warn('[process] Combined image OCR truncated — falling back to per-page OCR')
          const pageResults = await Promise.allSettled(
            imagePayloads.map(p => extractInvoiceFromImages([p], session.supplierName, isLearning))
          )
          let anyOk = false
          for (const [i, r] of pageResults.entries()) {
            if (r.status === 'fulfilled') {
              anyOk = true
              mergeResult(r.value, sessionMeta)
              allOcrItems = [...allOcrItems, ...r.value.lineItems]
              await prisma.invoiceFile.update({
                where: { id: imageFiles[i].id },
                data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(r.value) },
              })
            } else {
              console.error(`[process] Per-page OCR failed for ${imageFiles[i].fileName}:`, r.reason)
              await prisma.invoiceFile.update({
                where: { id: imageFiles[i].id },
                data: { ocrStatus: 'ERROR' },
              })
            }
          }
          if (!anyOk) throw err
        } else {
          console.error('[process] Image OCR failed:', err)
          await prisma.invoiceFile.updateMany({
            where: { id: { in: imageFiles.map(f => f.id) } },
            data: { ocrStatus: 'ERROR' },
          })
          throw err  // re-throw so outer catch sets session to ERROR
        }
      }
    }
```

- [ ] **Step 2: Fail the session when every file failed**

After the `nonImgFiles` block (line 191) and before `console.log(\`[process] Extracted ...\`)`, add:

```ts
    // If nothing was extracted and at least one file errored, this session is
    // an OCR failure — surface ERROR instead of an empty REVIEW screen.
    if (allOcrItems.length === 0) {
      const states = await prisma.invoiceFile.findMany({
        where: { sessionId: params.id },
        select: { ocrStatus: true },
      })
      if (states.some(f => f.ocrStatus === 'ERROR')) {
        throw new Error('Scanning failed for all uploaded files — no line items were extracted. Retry, or re-upload clearer photos.')
      }
    }
```

- [ ] **Step 3: Build**

Run: `npm run build` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/invoices/sessions/[id]/process/route.ts"
git commit -m "fix(invoices): per-page OCR fallback on truncation; ERROR session when all files fail"
```

---

## Task 9: Persist learning-mode format discoveries per supplier

Learning mode makes Claude work out each new supplier's column layout — then throws the discovery away. Persist it on the `Supplier` row and inject it into future prompts, so every supplier converges to hint-quality OCR after a few invoices (not just the 5 hardcoded ones).

**Files:**
- Modify: `src/lib/invoice-ocr.ts`
- Modify: `src/app/api/invoices/sessions/[id]/process/route.ts`

- [ ] **Step 1: OCR returns `formatNotes` in learning mode**

In `src/lib/invoice-ocr.ts`:

In `BASE_PROMPT`'s OUTPUT SCHEMA block, after `"total": number | null,` add:

```
  "formatNotes":     string | null,
```

and immediately after the schema block's closing brace line in the prompt, add the rule:

```
formatNotes: null normally. In LEARNING MODE only, fill it with a compact
(< 600 chars) description of this supplier's invoice layout: the column names
left-to-right, which column is the ANCHOR product code, how pricing mode is
signaled, where the weight column is (if any), the pack-size notation, and any
multi-row item pattern. Write it as instructions for parsing the NEXT invoice
from this supplier.
```

In `buildSystemPrompt`, change the signature and hint resolution (lines 626–647). Old signature:

```ts
function buildSystemPrompt(supplierName?: string | null, learning = false): string {
  const hint = getSupplierHint(supplierName)
```

New:

```ts
function buildSystemPrompt(
  supplierName?: string | null,
  learning = false,
  savedFormatNotes?: string | null
): string {
  // Hardcoded hints win; otherwise fall back to layout notes a previous
  // learning-mode run saved for this supplier.
  const hint = getSupplierHint(supplierName) ||
    (savedFormatNotes
      ? `\nSUPPLIER LAYOUT NOTES (learned from previous invoices of ${supplierName ?? 'this supplier'}):\n${savedFormatNotes}`
      : '')
```

In `OcrResult` add:

```ts
  // Learning-mode only: Claude's own summary of this supplier's column layout
  formatNotes: string | null
```

In `parseOcrResponse`'s return object add:

```ts
    formatNotes:     asStr(parsed.formatNotes),
```

In `extractInvoiceFromCsv`, add `formatNotes: null,` to **both** returned result objects (the empty-lines early return and the final return).

Thread the parameter through the three Claude entry points — change each signature and its `buildSystemPrompt` call:

```ts
export async function extractInvoiceFromImages(
  files: Array<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }>,
  supplierName?: string | null,
  learning = false,
  savedFormatNotes?: string | null
): Promise<OcrResult> {
```

…and inside: `system: buildSystemPrompt(supplierName, learning, savedFormatNotes),`. Repeat identically for `extractInvoiceFromPdf` and `extractInvoiceFromText`.

- [ ] **Step 2: Process route loads + saves the notes**

In `process/route.ts`:

After the `isLearning` computation (line ~89), add:

```ts
  // Layout notes saved by a previous learning-mode run for this supplier.
  let savedFormatNotes: string | null = null
  if (session.supplierId) {
    const sup = await prisma.supplier.findUnique({
      where: { id: session.supplierId },
      select: { ocrFormatNotes: true },
    })
    savedFormatNotes = sup?.ocrFormatNotes ?? null
  }
```

Pass it into both OCR calls:

```ts
        const result = await extractInvoiceFromImages(imagePayloads, session.supplierName, isLearning, savedFormatNotes)
```

```ts
            result = await extractInvoiceFromPdf(buf, session.supplierName, isLearning, savedFormatNotes)
```

(also the per-page fallback call from Task 8: `extractInvoiceFromImages([p], session.supplierName, isLearning, savedFormatNotes)`).

In `mergeResult` (line 349), add:

```ts
  if (meta.formatNotes == null && result.formatNotes != null) meta.formatNotes = result.formatNotes
```

After the final `prisma.invoiceSession.update` that sets `status: 'REVIEW'` (line ~283), add:

```ts
    // Persist learning-mode layout discovery for next time. autoSupplierId is
    // resolved just above; prefer it over the session's original supplierId.
    const formatNotesSupplierId = autoSupplierId ?? session.supplierId
    if (isLearning && sessionMeta.formatNotes && formatNotesSupplierId) {
      await prisma.supplier.update({
        where: { id: formatNotesSupplierId },
        data:  { ocrFormatNotes: sessionMeta.formatNotes.slice(0, 1000) },
      }).catch(() => {}) // non-critical
    }
```

- [ ] **Step 3: Build**

Run: `npm run build` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/invoice-ocr.ts "src/app/api/invoices/sessions/[id]/process/route.ts"
git commit -m "feat(invoices): persist learning-mode supplier layout notes; inject into future OCR prompts"
```

---

## Task 10: Delete dead v1 invoice components

`page.tsx` only loads `v2/InvoiceReviewDrawer`. The 3,708-line v1 `InvoiceDrawer.tsx` and several v1 siblings are dead weight and a constant source of confusion.

**Files:**
- Delete (each only after grep verification): `src/components/invoices/InvoiceDrawer.tsx`, `src/components/invoices/v2/InvoiceDrawerV2.tsx`, `src/components/invoices/InboxView.tsx`, `src/components/invoices/InvoiceList.tsx`, `src/components/invoices/InvoiceKpiStrip.tsx`

- [ ] **Step 1: Verify each candidate is unreferenced**

For each file, run (example for InvoiceDrawer):

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
grep -rn "InvoiceDrawer'" src --include='*.ts' --include='*.tsx' | grep -v 'components/invoices/InvoiceDrawer.tsx'
grep -rn 'from .*InvoiceDrawer\b' src | grep -v ReviewDrawer | grep -v DrawerV2
```

Rules:
- Delete a file **only if** zero imports reference it from outside itself.
- `InvoiceDrawerV2.tsx`: also check for a `?v=2` flag consumer (`grep -rn "v=2\|InvoiceDrawerV2" src`). If something still routes to it, keep it and note that in the commit message.
- If a deleted file was the sole consumer of helpers in `src/lib/invoice/filters.ts`, do **not** delete `filters.ts` — `v2/context.tsx` imports `FilterKey`/`SortMode` from it.

- [ ] **Step 2: Delete the verified files**

```bash
git rm src/components/invoices/InvoiceDrawer.tsx
# plus each other file that passed verification
```

- [ ] **Step 3: Build**

Run: `npm run build` — Expected: PASS (the compiler is the final referee — if it fails on a missing import, restore that file and re-verify).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(invoices): delete dead v1 drawer/inbox/list components"
```

---

## Task 11: End-to-end verification

- [ ] **Step 1: Full build**

Run: `npm run build` — Expected: PASS, all `/api/invoices/*` routes shown as `ƒ (Dynamic)`.

- [ ] **Step 2: Live flow check (preview tools)**

1. Start the dev server (preview_start; restart it if it was already running — required after schema/client changes).
2. Open `/invoices`, upload a sample invoice image (or use an existing REVIEW session).
3. Verify in the drawer: low-confidence/MEDIUM lines show the gold **Check line** badge and block Approve until confirmed; a format-mismatch line's "Use invoice format" choice persists (`applyInvoiceFormat` PATCH visible in preview_network).
4. Approve the session; re-upload the same invoice (same number) and approve again — expect the duplicate confirm dialog.
5. Approve a second invoice from the same supplier containing an item with a supplier item code — in preview_network, confirm the line auto-matched HIGH/100 (code rule) rather than fuzzy.

- [ ] **Step 3: Final commit / handoff**

If any fixes were needed during verification, commit them:

```bash
git add -A && git commit -m "fix(invoices): verification fixes for scanner accuracy work"
```

---

## Explicitly out of scope (decided during planning)

- **Camera capture**: mobile-only via Capacitor native scan — already implemented; only its upload pipeline is optimized (Task 6).
- **Duplicate banner in the drawer**: already exists (`InvoiceReviewDrawer.tsx:783`) — the server-side gate (Task 3) complements it.
- **Line-sum reconciliation banner**: already exists (`reconciliation` / `ReconcileResult`, rendered at `InvoiceReviewDrawer.tsx:801` with a suggested-fix line).
- **Configurable price-alert thresholds**: deferred (YAGNI until alert fatigue is reported).
- **Pre-OCR image-quality check (Haiku pre-flight)**: deferred — Task 6's enhancement pipeline + Task 8's failure surfacing cover most of the value at zero added latency.
