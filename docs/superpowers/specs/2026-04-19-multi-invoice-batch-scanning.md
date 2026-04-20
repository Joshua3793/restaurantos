# Multi-Invoice Batch Scanning + Editable Line Items Design

## Goal

Let users drop up to 10 invoice files at once, have each processed as a separate invoice in parallel, review all in a single scrollable page approving one invoice at a time, and edit any scanned field (description, qty, price) so the system learns from OCR mistakes.

## Architecture

### New `InvoiceBatch` table

```prisma
model InvoiceBatch {
  id        String           @id @default(uuid())
  status    String           @default("PROCESSING")  // PROCESSING | REVIEW | DONE
  createdAt DateTime         @default(now())
  sessions  InvoiceSession[]
}
```

### Changes to existing models

```prisma
model InvoiceSession {
  // ... existing fields ...
  batchId   String?       // null = standalone (legacy) session
  batch     InvoiceBatch? @relation(fields: [batchId], references: [id])
}

model InvoiceScanItem {
  // ... existing fields ...
  editedDescription String?   // null = not edited; non-null = user corrected the OCR text
}
```

`editedDescription` preserves the original OCR text in `rawDescription` (used as the learning key at approval time) while letting the UI display and re-match against the corrected text.

### Limit

**10 files per batch.** The upload zone enforces this client-side with a clear counter. Each file = one InvoiceSession = one Claude API call. Ten parallel 120s calls is the safe ceiling without risking Vercel timeouts.

---

## API Routes

### New routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/invoices/batches` | Create a batch, returns `{ batchId }` |
| GET | `/api/invoices/batches/[id]` | Fetch batch with all sessions + scan item counts + file statuses |

### Modified routes

**`POST /api/invoices/sessions`** — accepts optional `batchId` in body, links new session to batch.

**`GET /api/invoices/sessions`** — response includes `batchId` per session so history view can group.

**New: `PATCH /api/invoices/sessions/[id]/scanitems/[itemId]`** — updates editable fields on one scan item:
- `editedDescription String?` — corrected product name
- `rawQty Decimal?` — corrected quantity
- `rawUnitPrice Decimal?` — corrected unit price
- `rawLineTotal Decimal?` — auto-recalculated if not supplied (qty × price)
- Returns the updated scan item (client re-renders the card)

---

## Upload Flow (modified)

1. User drops 1–10 files onto the existing upload zone (counter shows "N / 10").
2. Client calls `POST /api/invoices/batches` → gets `batchId`.
3. For each file: `POST /api/invoices/sessions` (with `batchId`) → creates one session per file.
4. For each session: upload the file to that session (existing UploadThing path or local fallback).
5. Client fires `POST /api/invoices/sessions/[id]/process` for all sessions simultaneously (no await — fire and forget).
6. Client enters **batch polling mode**: every 3s calls `GET /api/invoices/batches/[batchId]` until all sessions are in REVIEW or ERROR.

When only 1 file is dropped, a batch is still created (batchId on session), but the UI behaves exactly as today (no visual change — single invoice review).

---

## Batch Processing View

Replaces the current single-session spinner when batchSize > 1:

```
Scanning 6 invoices...  [████████░░]  4 of 6 complete

  ✓ Sysco                    ⟳ Snow Cap #0093...
  ✓ Gordon Food #117         ✓ Flanagan #2201
  ✓ GFS April 14             ✗ IMG_0308 — OCR error  [Retry]
```

Each row shows: supplier name (from OCR) or filename if not yet extracted, invoice number, status icon. Error sessions show a Retry button that re-calls the process endpoint for that session.

---

## Batch Review UI

Shown when batchId has more than one session and at least one is in REVIEW.

### Sticky progress header

```
┌──────────────────────────────────────────────────────────────┐
│  6 invoices  ·  2 approved  ·  4 pending    [Approve All ↓]  │
└──────────────────────────────────────────────────────────────┘
```

"Approve All" is enabled only when every pending invoice has no LOW or NONE confidence items (all are HIGH/MEDIUM — safe to auto-approve). Otherwise it's disabled with tooltip "Some invoices need manual review."

### Stacked invoice cards

Each card = one InvoiceSession. First pending invoice expands on load; others are collapsed.

**Collapsed card** (approved or not yet opened):
```
┌─── SYSCO  #4821  ·  Apr 14  ·  $2,847.00  ───────── ✓ APPROVED ─┐
│  [Click to expand]                                               │
└──────────────────────────────────────────────────────────────────┘
```

**Expanded card** (pending review):
```
┌─── SNOW CAP  #0093  ·  Apr 15  ·  $614.50  ──────── PENDING ─────┐
│                                                                   │
│  [Full existing review UI: line items, match cards, totals]       │
│  • Editable fields on each scan item (see below)                  │
│                                                                   │
│  Total validation bar                                             │
│                                                                   │
│  [Cancel invoice]          [Approve Invoice →]                    │
└───────────────────────────────────────────────────────────────────┘
```

Approving collapses the card with a green header and auto-scrolls to the next pending invoice (using `element.scrollIntoView({ behavior: 'smooth' })`).

---

## Editable Scan Item Cards

Every scan item in the review UI exposes inline editing for three fields. This replaces the current read-only display of the raw OCR values.

### Description field

The OCR description at the top of each card becomes a text input. Its value is `editedDescription ?? rawDescription`.

- Editing fires debounced PATCH after 500ms idle (updates `editedDescription` in DB).
- After the description changes, client calls the existing ingredient search API (`/api/recipes/search-ingredients?q=<newText>` or the inventory search) to show a live dropdown of matching inventory items — same UX as today's "Override match" flow.
- User picks from dropdown → updates `matchedItemId`, `action`, `newPrice`, `priceDiffPct` (server recalculates on PATCH).

### Qty and unit price fields

Displayed as small number inputs (today they're static text). Editing either fires a PATCH; `rawLineTotal` is auto-recalculated as `qty × unitPrice`.

### Learning from corrections

When the session is approved, `saveMatchRule(rawDescription, inventoryItemId)` is called with the **original OCR text** (`rawDescription`) — not the edited version. This means: next time the OCR produces the same garbled text (e.g. "BROCOLI BUNCH"), the matcher already knows it maps to the Broccoli Crown inventory item. No schema change needed to the learning system — `rawDescription` is already the learning key.

---

## History View

The existing session list gains a "batch" indicator. Sessions that share a batchId are grouped under a collapsible "Batch — Apr 19 (6 invoices)" row with per-session detail rows inside. Standalone sessions (no batchId) appear as today.

---

## Files Created / Modified

### New files
- `src/app/api/invoices/batches/route.ts` — POST create batch, GET list batches
- `src/app/api/invoices/batches/[id]/route.ts` — GET batch status with sessions
- `src/app/api/invoices/sessions/[id]/scanitems/[itemId]/route.ts` — PATCH scan item

### Modified files
- `prisma/schema.prisma` — add InvoiceBatch model, batchId to InvoiceSession, editedDescription to InvoiceScanItem
- `src/app/api/invoices/sessions/route.ts` — accept batchId in POST, include batchId in GET
- `src/app/api/invoices/sessions/[id]/approve/route.ts` — after approving, check if all sessions in batch are approved → update batch status to DONE
- `src/app/invoices/page.tsx` — batch upload flow, batch processing view, batch review UI, editable scan item cards

---

## Out of Scope

- Multi-page invoices in batch mode (user uploads one file per invoice; multi-page single invoices still work in standalone mode as today)
- Merging two files into the same invoice in batch mode
- Auto-grouping by detected invoice number (each file = its own session, always)
