# Invoice Revenue-Center Split + RC-Aware Purchase Movement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute each invoice line's purchase cost to exactly one revenue center (its own RC, or the invoice's RC), eliminate the clone double-count, decouple the invoice RC from the sidebar filter, and make purchase movement history RC-aware — without changing live stock quantities.

**Architecture:** On approval the system keeps cloning a child "(copy)" session per alternative RC, but now flags the moved lines on the parent (`InvoiceScanItem.splitToSessionId`) so they are excluded from every spend aggregation instead of being double-counted. Every approved-scan-item spend query gains a `splitToSessionId: null` filter. The invoice's RC defaults to the main RC and is editable in the drawer; per-line RC inherits the invoice RC.

**Tech Stack:** Next.js 14 App Router, Prisma + PostgreSQL (Supabase, pgBouncer), TypeScript, React.

**Project constraints (read before starting):**
- **No test suite.** `npm run build` (type-check) is the only automated check. Run it after each task. Behavioral checks are manual or via one-off scripts.
- **node/npm are not on PATH.** Prefix every node command with:
  `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"`
  and pass `dangerouslyDisableSandbox: true` on the Bash call.
- **`prisma migrate dev` is broken** (P3006 shadow drift). Use the diff/db-execute/resolve workaround in Task 1.
- **Prisma Decimal fields serialize as strings** in JSON — wrap with `Number()` before arithmetic.
- Load env for any prisma/script command: `set -a && . ./.env; set +a`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `splitToSessionId` to `InvoiceScanItem` |
| `prisma/migrations/<ts>_add_scanitem_split/migration.sql` | Create | Column + index DDL |
| `src/app/api/invoices/sessions/route.ts` | Modify | Default session RC to main RC |
| `src/components/invoices/InvoiceUploadModal.tsx` | Modify | Stop sending sidebar `activeRcId` as session RC |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` | Modify | Move-not-copy: flag parent lines on clone |
| `src/app/api/insights/cost-chrome/route.ts` | Modify | Exclude split lines (3 aggregates) |
| `src/app/api/insights/revenue-centers/route.ts` | Modify | Exclude split lines |
| `src/app/api/reports/cogs/route.ts` | Modify | Exclude split lines |
| `src/app/api/reports/dashboard/route.ts` | Modify | Exclude split lines |
| `src/app/api/reports/analytics/route.ts` | Modify | Exclude split lines (4 sites) |
| `src/app/api/inventory/[id]/stock-movements/route.ts` | Modify | Exclude split dupes; attach RC to PURCHASE rows |
| `src/components/invoices/v2/context.tsx` | Modify | Add `sessionRcId` to context |
| `src/components/invoices/v2/InvoiceReviewDrawer.tsx` | Modify | Invoice-level RC selector + `sessionRcId` wiring |
| `src/components/invoices/v2/card.tsx` | Modify | Per-line RC default inherits invoice RC |
| `scripts/backfill-split-clones.ts` | Create | Flag parent lines for pre-existing clones |

**Verified exempt (no change — they do not sum approved spend):**
`src/app/api/invoices/kpis/route.ts` (counts unmatched REVIEW items), `src/app/api/invoices/exceptions/route.ts` (lists REVIEW items), `src/app/api/chat/route.ts` (lists recent sessions with `_count`, never sums `rawLineTotal`).

---

## Task 1: Schema — add `splitToSessionId` to `InvoiceScanItem`

**Files:**
- Modify: `prisma/schema.prisma` (`InvoiceScanItem`, ends ~line 378)
- Create: `prisma/migrations/<ts>_add_scanitem_split/migration.sql`

- [ ] **Step 1: Add the field and index to the schema**

In `prisma/schema.prisma`, inside `model InvoiceScanItem`, add the field next to `revenueCenterId` and add an index next to `@@index([matchedItemId])`:

```prisma
  revenueCenterId    String?
  splitToSessionId   String?        // set on a PARENT line moved into an RC clone; null = live/countable
```

and:

```prisma
  @@index([matchedItemId])
  @@index([splitToSessionId])
```

- [ ] **Step 2: Generate the delta SQL by diffing the live DB (no shadow DB)**

Run (single Bash call, `dangerouslyDisableSandbox: true`):

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
set -a && . ./.env; set +a
TS=$(date +%Y%m%d%H%M%S)
mkdir -p "prisma/migrations/${TS}_add_scanitem_split"
npx prisma migrate diff \
  --from-url "$DIRECT_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "prisma/migrations/${TS}_add_scanitem_split/migration.sql"
cat "prisma/migrations/${TS}_add_scanitem_split/migration.sql"
```

Expected: the SQL contains `ALTER TABLE "InvoiceScanItem" ADD COLUMN "splitToSessionId" TEXT;` and a `CREATE INDEX ... "InvoiceScanItem_splitToSessionId_idx" ...`. If it contains unrelated drift, STOP and report — do not apply.

- [ ] **Step 3: Apply the SQL to the live DB**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
set -a && . ./.env; set +a
npx prisma db execute --url "$DIRECT_URL" --file "$(ls -d prisma/migrations/*_add_scanitem_split/migration.sql)"
```

Expected: no error.

- [ ] **Step 4: Record the migration so prod `migrate deploy` skips it, then regenerate the client**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
set -a && . ./.env; set +a
NAME=$(basename "$(ls -d prisma/migrations/*_add_scanitem_split)")
npx prisma migrate resolve --applied "$NAME"
npx prisma generate
```

Expected: "Migration marked as applied" + "Generated Prisma Client".

- [ ] **Step 5: Type-check**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(invoices): add InvoiceScanItem.splitToSessionId for RC split"
```

---

## Task 2: Default the session RC to the main RC; decouple upload from the sidebar

**Files:**
- Modify: `src/app/api/invoices/sessions/route.ts:92-105`
- Modify: `src/components/invoices/InvoiceUploadModal.tsx:76-80`

- [ ] **Step 1: Default session RC to the `isDefault` RevenueCenter when none is provided**

In `src/app/api/invoices/sessions/route.ts`, replace the POST handler body (lines 92-105):

```ts
// POST /api/invoices/sessions — create a new session
export async function POST(req: NextRequest) {
  const { supplierName, supplierId, revenueCenterId } = await req.json().catch(() => ({}))

  // Every invoice gets an RC so it is always visible to per-RC reporting.
  // Sidebar filtering is view-only and must NOT drive the invoice's RC, so we
  // fall back to the main (default) revenue center rather than any client value
  // derived from the active filter.
  let rcId: string | null = revenueCenterId || null
  if (!rcId) {
    const defaultRc = await prisma.revenueCenter.findFirst({
      where: { isDefault: true },
      select: { id: true },
    })
    rcId = defaultRc?.id ?? null
  }

  const session = await prisma.invoiceSession.create({
    data: {
      status: 'UPLOADING',
      supplierName: supplierName || null,
      supplierId: supplierId || null,
      revenueCenterId: rcId,
    },
  })

  return NextResponse.json(session, { status: 201 })
}
```

- [ ] **Step 2: Stop sending the sidebar `activeRcId` from the upload modal**

In `src/components/invoices/InvoiceUploadModal.tsx`, change the session-create call (lines 76-80) so it no longer forwards the sidebar filter:

```ts
      const sessRes = await fetch('/api/invoices/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Invoice RC is decided in review (defaults to the main RC server-side).
        // The sidebar RC is a view filter only and must not set the invoice's RC.
        body: JSON.stringify({}),
      })
```

Leave the `activeRcId` prop in place (still used elsewhere for the modal's display); only the request body changes.

- [ ] **Step 3: Type-check**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/invoices/sessions/route.ts src/components/invoices/InvoiceUploadModal.tsx
git commit -m "feat(invoices): default invoice RC to main RC, decouple from sidebar filter"
```

---

## Task 3: Approve — move-not-copy (flag parent lines on clone)

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts:330-365` (inside the clone loop)

- [ ] **Step 1: Flag the parent lines after copying them into the clone**

In `src/app/api/invoices/sessions/[id]/approve/route.ts`, inside the `for (const [rcId, rcItems] of itemsByRc)` loop, immediately after the `prisma.invoiceScanItem.createMany({ ... })` call that copies items into the clone, add the parent-flagging update. The loop becomes:

```ts
      for (const [rcId, rcItems] of itemsByRc) {
        const clone = await prisma.invoiceSession.create({
          data: {
            status:          'APPROVED',
            supplierName:    session.supplierName,
            supplierId:      session.supplierId,
            invoiceDate:     session.invoiceDate,
            invoiceNumber:   session.invoiceNumber ? `${session.invoiceNumber} (copy)` : null,
            revenueCenterId: rcId,
            parentSessionId: sessionId,
            approvedBy,
            approvedAt:      new Date(),
          },
        })

        await prisma.invoiceScanItem.createMany({
          data: rcItems.map(item => ({
            sessionId:       clone.id,
            rawDescription:  item.rawDescription,
            rawQty:          item.rawQty,
            rawUnit:         item.rawUnit,
            rawUnitPrice:    item.rawUnitPrice,
            rawLineTotal:    item.rawLineTotal,
            matchedItemId:   item.matchedItemId,
            matchConfidence: item.matchConfidence,
            matchScore:      item.matchScore,
            action:          item.action,
            approved:        true,
            newPrice:        item.newPrice,
            previousPrice:   item.previousPrice,
            priceDiffPct:    item.priceDiffPct,
            revenueCenterId: rcId,
            sortOrder:       item.sortOrder,
          })),
        })

        // Move-not-copy: flag the parent's originals so they are excluded from
        // spend aggregation. The clone's copies (splitToSessionId = null) are the
        // canonical home for these lines. Parent keeps the lines for fidelity.
        await prisma.invoiceScanItem.updateMany({
          where: { id: { in: rcItems.map(i => i.id) } },
          data:  { splitToSessionId: clone.id },
        })
      }
```

- [ ] **Step 2: Type-check**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/invoices/sessions/[id]/approve/route.ts
git commit -m "feat(invoices): flag parent lines moved into RC clones (move-not-copy)"
```

---

## Task 4: Reporting — exclude split lines from every spend aggregation

Each edit adds `splitToSessionId: null` to the `where` of an approved-scan-item query so each line is counted once.

**Files:**
- Modify: `src/app/api/insights/cost-chrome/route.ts` (3 aggregates: ~56, ~71, ~78)
- Modify: `src/app/api/insights/revenue-centers/route.ts:28`
- Modify: `src/app/api/reports/cogs/route.ts:196`
- Modify: `src/app/api/reports/dashboard/route.ts:44`
- Modify: `src/app/api/reports/analytics/route.ts` (4 sites: ~79, ~83, ~341, ~429)

- [ ] **Step 1: cost-chrome — add the filter to all three aggregates**

In `src/app/api/insights/cost-chrome/route.ts`, each of the three `prisma.invoiceScanItem.aggregate` calls has `where: { approved: true, session: { ... } }`. Add `splitToSessionId: null,` to each `where`. They become, respectively:

```ts
    prisma.invoiceScanItem.aggregate({
      where: {
        approved: true,
        splitToSessionId: null,
        session: { approvedAt: { gte: weekStart }, ...purchaseSessionFilter },
      },
      _sum: { rawLineTotal: true },
    }),
```

```ts
    prisma.invoiceScanItem.aggregate({
      where: {
        approved: true,
        splitToSessionId: null,
        session: { approvedAt: { gte: sevenDaysAgo }, ...purchaseSessionFilter },
      },
      _sum: { rawLineTotal: true },
    }),
```

```ts
    prisma.invoiceScanItem.aggregate({
      where: {
        approved: true,
        splitToSessionId: null,
        session: { approvedAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo }, ...purchaseSessionFilter },
      },
      _sum: { rawLineTotal: true },
    }),
```

- [ ] **Step 2: revenue-centers — add the filter to the findMany**

In `src/app/api/insights/revenue-centers/route.ts`, the scan-item `findMany` (line 28):

```ts
    prisma.invoiceScanItem.findMany({
      where: { approved: true, splitToSessionId: null, session: { approvedAt: { gte: weekStart } } },
      select: { rawLineTotal: true, session: { select: { revenueCenterId: true } } },
    }),
```

- [ ] **Step 3: cogs — add the filter to the approved-purchase findMany**

In `src/app/api/reports/cogs/route.ts`, find the `prisma.invoiceScanItem.findMany` whose `where` is `{ approved: true, action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] } }` (~line 196) and add the filter:

```ts
        where: { approved: true, splitToSessionId: null, action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] } },
```

- [ ] **Step 4: dashboard — add the filter to the weekly-purchases aggregate**

In `src/app/api/reports/dashboard/route.ts` (line 44):

```ts
    prisma.invoiceScanItem.aggregate({
      where: { approved: true, splitToSessionId: null, session: { approvedAt: { gte: weekAgo } } },
      _sum: { rawLineTotal: true },
    }),
```

- [ ] **Step 5: analytics — add the filter to all four scan-item queries**

In `src/app/api/reports/analytics/route.ts`, add `splitToSessionId: null,` to the `where` of each of these four queries (the two `aggregate` calls at ~79 and ~83, and the two `findMany` calls at ~341 and ~429). Example for the first aggregate:

```ts
    prisma.invoiceScanItem.aggregate({
      where: { approved: true, splitToSessionId: null, session: { approvedAt: { gte: since } } },
      _sum: { rawLineTotal: true },
    }),
```

second aggregate:

```ts
    prisma.invoiceScanItem.aggregate({
      where: { approved: true, splitToSessionId: null, session: { approvedAt: { gte: prevSince, lt: since } } },
      _sum: { rawLineTotal: true },
    }),
```

the `findMany` at ~341:

```ts
    prisma.invoiceScanItem.findMany({
      where: { approved: true, splitToSessionId: null, session: { approvedAt: { gte: since } } },
```

(leave its `select` unchanged), and the `findMany` at ~429:

```ts
  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      approved: true,
      splitToSessionId: null,
      session: { status: 'APPROVED', approvedAt: { gte: since } },
    },
```

(leave its `select` unchanged).

- [ ] **Step 6: Type-check**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/insights/cost-chrome/route.ts src/app/api/insights/revenue-centers/route.ts src/app/api/reports/cogs/route.ts src/app/api/reports/dashboard/route.ts src/app/api/reports/analytics/route.ts
git commit -m "fix(reports): exclude RC-split parent lines from all spend aggregations"
```

---

## Task 5: Stock-movements — exclude split dupes and attach RC to PURCHASE rows

**Files:**
- Modify: `src/app/api/inventory/[id]/stock-movements/route.ts:7` (row type) and `:75-111` (PURCHASE block)

- [ ] **Step 1: Add an optional `revenueCenterId` to the movement row type**

In `src/app/api/inventory/[id]/stock-movements/route.ts`, find the type/interface for a raw movement row (the object shape pushed as `{ id, date, type, qtyBase, description }`). Add an optional field. If the rows are typed inline, add `revenueCenterId?: string | null` to that type; if there is a named type near line 7 (e.g. `RawMovement`), add it there:

```ts
// add to the movement row type
  revenueCenterId?: string | null
```

- [ ] **Step 2: Exclude split dupes and select the session RC in the PURCHASE query**

In the PURCHASES block (~line 76), update the `findMany` `where` and `select`:

```ts
  const scanItems = await prisma.invoiceScanItem.findMany({
    where: {
      matchedItemId: itemId,
      approved: true,
      splitToSessionId: null,
      session: { status: 'APPROVED', approvedAt: { gte: since } },
      rawQty: { not: null },
    },
    select: {
      id: true, rawQty: true, rawUnit: true,
      session: { select: { supplierName: true, invoiceDate: true, invoiceNumber: true, approvedAt: true, revenueCenterId: true } },
    },
  })
```

(Keep whatever other fields the existing `select` already lists — the additions are `splitToSessionId: null` in `where` and `revenueCenterId: true` in the session `select`. Do not remove existing fields.)

- [ ] **Step 3: Attach the RC to each PURCHASE row**

In the loop that builds purchase rows (~line 88-111), add `revenueCenterId` to the pushed object:

```ts
    raw.push({
      id: si.id,
      date,
      type: 'PURCHASE',
      qtyBase: baseUnits,
      description: `${supplier}${invNum}`,
      revenueCenterId: si.session.revenueCenterId ?? null,
    })
```

- [ ] **Step 4: Type-check**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -5
```

Expected: build succeeds. (If TS complains that other `raw.push` sites lack `revenueCenterId`, that confirms the field must be optional — verify Step 1 used `?:`.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/inventory/[id]/stock-movements/route.ts
git commit -m "feat(inventory): RC-aware purchase movements; exclude RC-split dupes"
```

---

## Task 6: Invoice-level RC selector in the drawer + per-line RC inherits invoice RC

**Files:**
- Modify: `src/components/invoices/v2/context.tsx:18` (interface) — add `sessionRcId`
- Modify: `src/components/invoices/v2/InvoiceReviewDrawer.tsx` — provide `sessionRcId`, add `handleSessionRcChange`, render the header selector
- Modify: `src/components/invoices/v2/card.tsx:97` — default per-line RC to the invoice RC

- [ ] **Step 1: Add `sessionRcId` to the context interface**

In `src/components/invoices/v2/context.tsx`, add to `DrawerContextValue` right after `sessionSupplierId` (line 18):

```ts
  /** Canonical supplier id when the session resolved one — the reliable offer join. */
  sessionSupplierId: string | null
  /** The invoice's (session-level) revenue center id — the default for unset lines. */
  sessionRcId: string | null
```

- [ ] **Step 2: Populate `sessionRcId` in the context value**

In `src/components/invoices/v2/InvoiceReviewDrawer.tsx`, in the `ctxValue` object (line 764-768), add the field next to the supplier fields:

```ts
    sessionSupplierName: session?.supplierName ?? null,
    sessionSupplierId: session?.supplierId ?? null,
    sessionRcId: session?.revenueCenterId ?? null,
```

(The `useMemo` dependency array already includes `session`, so no dependency change is needed.)

- [ ] **Step 3: Add the session-RC change handler in the drawer**

In `src/components/invoices/v2/InvoiceReviewDrawer.tsx`, add this callback next to `handleLinkSupplier` (~line 271). It optimistically updates the local session then persists via the existing PATCH route:

```ts
  const handleSessionRcChange = useCallback(async (rcId: string) => {
    if (!session) return
    setSession(prev => (prev ? { ...prev, revenueCenterId: rcId } : prev))
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revenueCenterId: rcId }),
    })
  }, [session])
```

- [ ] **Step 4: Pass revenue centers + handler into `InvoiceHeader`**

In `src/components/invoices/v2/InvoiceReviewDrawer.tsx`, update the `<InvoiceHeader ... />` render (line 844-850):

```tsx
            <InvoiceHeader
              session={session}
              revenueCenters={revenueCenters}
              onRcChange={handleSessionRcChange}
              onClose={onClose}
              queuePos={queuePos}
              onPrev={navPrev}
              onNext={navNext}
            />
```

- [ ] **Step 5: Render the selector inside `InvoiceHeader`**

In `src/components/invoices/v2/InvoiceReviewDrawer.tsx`, extend the `InvoiceHeader` prop signature (line 40-52) and render a compact RC selector under the supplier title. Update the signature:

```tsx
function InvoiceHeader({
  session,
  revenueCenters,
  onRcChange,
  onClose,
  queuePos,
  onPrev,
  onNext,
}: {
  session: Session
  revenueCenters: RevenueCenter[]
  onRcChange: (rcId: string) => void
  onClose: () => void
  queuePos: { idx: number; total: number }
  onPrev?: () => void
  onNext?: () => void
}) {
```

Then add the selector inside the title block, immediately after the `metaParts` `<div>` closes (after line 94, still inside the `<div className="min-w-0">`):

```tsx
          <div className="mt-2">
            <select
              value={session.revenueCenterId ?? ''}
              onChange={e => onRcChange(e.target.value)}
              aria-label="Invoice revenue center"
              className="font-mono text-[11px] text-ink-3 bg-bg border border-line rounded px-1.5 py-[3px] hover:bg-bg-2 focus:outline-none focus:ring-1 focus:ring-gold/40 cursor-pointer"
            >
              {revenueCenters.map(r => (
                <option key={r.id} value={r.id}>{r.name}{r.isDefault ? ' (default)' : ''}</option>
              ))}
            </select>
          </div>
```

(`RevenueCenter` is already imported at the top of this file; `Session` is already in scope.)

- [ ] **Step 6: Per-line RC default inherits the invoice RC**

In `src/components/invoices/v2/card.tsx`, change `defaultRcId` (line 97) so an unset line falls back to the invoice RC first, then the global default:

```ts
  const defaultRcId = ctx.sessionRcId ?? ctx.revenueCenters.find(r => r.isDefault)?.id ?? ''
```

(The dropdown already uses `value={item.revenueCenterId ?? defaultRcId}`, so no further change there.)

- [ ] **Step 7: Type-check**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/components/invoices/v2/context.tsx src/components/invoices/v2/InvoiceReviewDrawer.tsx src/components/invoices/v2/card.tsx
git commit -m "feat(invoices): invoice-level RC selector in drawer; per-line RC inherits invoice RC"
```

---

## Task 7: Backfill — flag parent lines for pre-existing "(copy)" clones

Existing clones were created copy-not-move, so their parents still hold live duplicates. This one-time script flags those parent lines.

**Files:**
- Create: `scripts/backfill-split-clones.ts`

- [ ] **Step 1: Write the backfill script with a dry-run default**

Create `scripts/backfill-split-clones.ts`:

```ts
/**
 * One-off: retroactively apply move-not-copy to invoice RC clones created before
 * the splitToSessionId flag existed. For each clone session (parentSessionId set),
 * flag the PARENT's scan items whose revenueCenterId matches the clone's RC by
 * setting splitToSessionId = <clone.id>, so they are excluded from spend
 * aggregation (the clone's copies remain the canonical home).
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Run: ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-split-clones.ts [--apply]
 */
import { prisma } from '../src/lib/prisma'

async function main() {
  const apply = process.argv.includes('--apply')

  const clones = await prisma.invoiceSession.findMany({
    where: { parentSessionId: { not: null }, revenueCenterId: { not: null } },
    select: { id: true, parentSessionId: true, revenueCenterId: true, invoiceNumber: true },
  })

  console.log(`Found ${clones.length} clone session(s).`)
  let totalFlagged = 0

  for (const clone of clones) {
    const where = {
      sessionId: clone.parentSessionId!,
      revenueCenterId: clone.revenueCenterId!,
      splitToSessionId: null,
    }
    const count = await prisma.invoiceScanItem.count({ where })
    if (count === 0) continue
    totalFlagged += count
    console.log(`  clone ${clone.invoiceNumber ?? clone.id}: ${count} parent line(s) → split`)
    if (apply) {
      await prisma.invoiceScanItem.updateMany({
        where,
        data: { splitToSessionId: clone.id },
      })
    }
  }

  console.log(
    apply
      ? `Applied: flagged ${totalFlagged} parent line(s).`
      : `Dry-run: would flag ${totalFlagged} parent line(s). Re-run with --apply to write.`,
  )
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
```

- [ ] **Step 2: Run the dry-run**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
set -a && . ./.env; set +a
npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-split-clones.ts 2>&1 | tail -30
```

Expected: prints the clone count and "would flag N parent line(s)". Sanity-check N looks plausible (≈ the number of cross-RC lines across historical invoices). If N is 0, there were no historical clones — that's fine.

- [ ] **Step 3: Apply the backfill**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
set -a && . ./.env; set +a
npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-split-clones.ts --apply 2>&1 | tail -30
```

Expected: "Applied: flagged N parent line(s)." (same N as the dry-run).

- [ ] **Step 4: Commit the script**

```bash
git add scripts/backfill-split-clones.ts
git commit -m "chore(invoices): backfill splitToSessionId for pre-existing RC clones (applied)"
```

---

## Task 8: Full verification (build + manual end-to-end)

**Files:** none (verification only)

- [ ] **Step 1: Full type-check**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -15
```

Expected: build succeeds; no route shows as `○ (Static)` that should be `ƒ (Dynamic)`.

- [ ] **Step 2: Restart the preview dev server** (the build clobbers `.next`; see memory `project_node_toolchain`)

Use `preview_stop` then `preview_start` with config "RestaurantOS (Next.js)".

- [ ] **Step 3: Manual end-to-end (via preview tools)**

1. Filter the sidebar to a **non-default** RC, then upload an invoice. Open it in the drawer and confirm the **invoice RC selector defaults to the main RC** (not the sidebar's filter).
2. Set the invoice RC to one center (e.g. Cafe). On two of five lines, set the per-line RC to a different center (e.g. Catering). Confirm the other three lines show the invoice RC by default.
3. Approve. In the invoice list, confirm a "(copy)" session exists for Catering and the parent still shows all five lines.
4. Hit `/api/insights/revenue-centers` (or the RC dashboard) and confirm Cafe = the three lines' spend, Catering = the two lines' spend, and the unfiltered "All revenues" total equals the full invoice total (each line once — no double-count).
5. Open the inventory item from line 1 and confirm its purchase movement carries the Catering `revenueCenterId`.

- [ ] **Step 4: Final commit if any verification fixes were needed** (otherwise skip)

```bash
git add -A && git commit -m "test(invoices): verify RC split end-to-end"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §1 data model → Task 1. §2 invoice RC default + decouple + drawer selector + per-line inherit → Tasks 2, 6. §3 move-not-copy → Task 3. §4 reporting exclusions → Task 4 (every listed consumer; kpis/exceptions/chat verified exempt with rationale in File Structure). §5 RC-aware movement → Task 5. §6 backfill → Task 7. §7 testing → Task 8. No gaps.
- **Type consistency:** new field `splitToSessionId` (String?) used identically in schema, approve `updateMany`, all reporting `where`s, stock-movements, and the backfill. Context field `sessionRcId` defined in `context.tsx` and consumed in `card.tsx`; `InvoiceHeader` prop additions (`revenueCenters`, `onRcChange`) match the render site. `handleSessionRcChange` signature `(rcId: string) => void` matches `onRcChange`.
- **Placeholder scan:** none — every code step shows complete code; every command shows expected output.
