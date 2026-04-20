# Multi-Invoice Batch Scanning + Editable Line Items Design

## Goal

Let users drop up to 10 invoice files at once — even when multiple photos belong to the same physical invoice — have the system automatically group them by invoice number and supplier, process each group as one invoice in parallel, then present all invoices in a single scrollable review page where each can be approved independently. Users can also edit any scanned field (description, qty, price) so the system learns from OCR mistakes.

## Architecture

### New `InvoiceBatch` table

```prisma
model InvoiceBatch {
  id        String           @id @default(uuid())
  status    String           @default("ANALYZING")
  // ANALYZING → GROUPING → PROCESSING → REVIEW → DONE
  createdAt DateTime         @default(now())
  files     InvoiceBatchFile[]
  sessions  InvoiceSession[]
}
```

### New `InvoiceBatchFile` table

Holds uploaded files before they are assigned to a session (during the ANALYZING phase).

```prisma
model InvoiceBatchFile {
  id              String       @id @default(uuid())
  batchId         String
  batch           InvoiceBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  fileName        String
  fileType        String
  fileUrl         String       // UploadThing CDN URL or base64 data-URI
  // Filled in after metadata scan:
  detectedInvoiceNumber String?
  detectedSupplierName  String?
  metaStatus      String       @default("PENDING")  // PENDING | COMPLETE | ERROR
  createdAt       DateTime     @default(now())
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
  editedDescription String?
  // null = not edited; non-null = user corrected the OCR text.
  // rawDescription always holds original OCR output — used as the learning key at approval.
}
```

### Limit

**10 files per batch.** Enforced client-side with a visible counter ("3 / 10 files"). The metadata scan fires 10 parallel lightweight Claude calls (fast, ~5s each) and the full OCR fires up to 10 parallel full calls. This is the safe ceiling for Vercel's 120s timeout.

---

## Two-Phase Processing

### Phase 1 — Metadata scan (new)

**Purpose:** Identify which files belong to the same physical invoice before any full OCR runs.

**Trigger:** `POST /api/invoices/batches/[id]/analyze`

For each `InvoiceBatchFile` in the batch, fire a parallel lightweight Claude call with a minimal prompt:

```
Extract only the invoice number and supplier name from this document.
Return JSON: { "invoiceNumber": "..." | null, "supplierName": "..." | null }
Do not extract line items.
```

Each result is stored back on `InvoiceBatchFile` (`detectedInvoiceNumber`, `detectedSupplierName`, `metaStatus: COMPLETE`).

Files that return an error get `metaStatus: ERROR` and are treated as their own invoice group.

**Grouping logic** (runs server-side after all metadata results are in):

```
groupKey = (detectedInvoiceNumber ?? fileId) + "|" + (detectedSupplierName ?? "")
```

Files with the same groupKey → same session. Files with no detectable invoice number → each gets their own session (groupKey = fileId).

Example: 10 photos → 3 invoice groups → 3 sessions created, with 3, 4, and 3 files respectively.

### Phase 2 — Full OCR per session (existing, unchanged)

For each session created in Phase 1, fire `POST /api/invoices/sessions/[id]/process`. This is the existing process endpoint — it batches all image files in the session into one Claude call and runs the full line-item extraction + inventory matching. No changes to this endpoint.

---

## API Routes

### New routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/invoices/batches` | Create batch, returns `{ batchId }` |
| POST | `/api/invoices/batches/[id]/files` | Upload files into batch (before session assignment) |
| POST | `/api/invoices/batches/[id]/analyze` | Run Phase 1 metadata scan + grouping → creates sessions |
| GET | `/api/invoices/batches/[id]` | Batch status: sessions list, per-session file statuses, counts |
| PATCH | `/api/invoices/sessions/[id]/scanitems/[itemId]` | Edit scan item fields |

### Modified routes

**`POST /api/invoices/sessions`** — accepts optional `batchId`, links session to batch.

**`GET /api/invoices/sessions`** — response includes `batchId` per session.

**`POST /api/invoices/sessions/[id]/approve`** — after approving, if session has a batchId, check whether all sibling sessions are now APPROVED; if so, set `InvoiceBatch.status = DONE`.

---

## Upload Flow (full sequence)

1. User drops 1–10 files onto the upload zone (counter: "N / 10").
2. Client calls `POST /api/invoices/batches` → receives `{ batchId }`.
3. Client uploads all files to `POST /api/invoices/batches/[batchId]/files` (UploadThing or local fallback). All files stored as `InvoiceBatchFile` rows.
4. Client calls `POST /api/invoices/batches/[batchId]/analyze` — server runs Phase 1 (metadata scan + grouping), creates sessions, assigns files. Returns `{ sessions: [{ id, fileCount }] }`.
5. Client fires `POST /api/invoices/sessions/[id]/process` for all sessions in parallel (fire-and-forget).
6. Client enters **batch polling mode**: every 3s calls `GET /api/invoices/batches/[batchId]` until all sessions are REVIEW or ERROR.

When only 1 file is dropped, a batch is still created but Phase 1 produces exactly 1 session, so the UI falls through to the existing single-invoice review with no visible change to the user.

---

## Batch Processing View

Shown when the batch has more than 1 session and status is PROCESSING:

```
Analyzing & scanning 10 files...  [████████░░]  2 of 3 invoices complete

  ✓ Sysco  #4821  (3 photos)      ⟳ Snow Cap #0093  (4 photos)...
  ✓ Gordon Food  #117  (3 photos) 
```

Each row: supplier name + invoice number (from metadata), file count in group, status icon. Error sessions show a [Retry] button that re-calls the process endpoint for that session only.

---

## Batch Review UI

Shown when batch has >1 session and at least one is REVIEW.

### Sticky progress header

```
┌──────────────────────────────────────────────────────────────────┐
│  3 invoices  ·  1 approved  ·  2 pending      [Approve All →]    │
└──────────────────────────────────────────────────────────────────┘
```

"Approve All" is enabled only when every pending invoice has no LOW or NONE confidence items. Otherwise disabled with tooltip "Some invoices need manual review."

### Stacked invoice cards

Each card = one InvoiceSession. First pending invoice auto-expands; others start collapsed.

**Collapsed (approved):**
```
┌─── SYSCO  #4821  ·  Apr 14  ·  $2,847.00  ─────────── ✓ APPROVED ─┐
│  [Click to expand]                                                 │
└────────────────────────────────────────────────────────────────────┘
```

**Expanded (pending):**
```
┌─── SNOW CAP  #0093  ·  Apr 15  ·  $614.50  ─────────── PENDING ────┐
│                                                                    │
│  [Full existing review UI — line items, match cards, total bar]    │
│  [Editable description / qty / price on each scan item]            │
│                                                                    │
│  [Cancel invoice]                    [Approve Invoice →]           │
└────────────────────────────────────────────────────────────────────┘
```

Approving collapses the card with a green ✓ header and `scrollIntoView({ behavior: 'smooth' })` to the next pending invoice.

---

## Editable Scan Item Cards

Every scan item exposes three editable fields inline. Replaces the current read-only display of OCR values.

### Description field

The OCR description becomes a text input showing `editedDescription ?? rawDescription`.

- On change: debounced PATCH to `/scanitems/[itemId]` after 500ms idle, saves `editedDescription`.
- Simultaneously: live inventory search dropdown appears (reuses existing `/api/inventory/search?q=` endpoint), same interaction as today's "Override match" panel.
- Picking a result from the dropdown: updates `matchedItemId`, `action`, `newPrice`, `priceDiffPct` (server recalculates in the PATCH response).

### Qty and unit price fields

Rendered as small inline number inputs instead of static text. On change, PATCH fires and `rawLineTotal` is recalculated server-side as `qty × unitPrice`.

### Learning from corrections

On approval, `saveMatchRule(rawDescription, inventoryItemId)` uses the **original OCR text** (`rawDescription`). Next time the OCR produces the same garbled output, the matcher finds the confirmed inventory item automatically. `editedDescription` is only used to drive the live search — it is never saved as the learning key.

---

## History View

The session list groups sessions that share a `batchId` under a single expandable row:

```
▶  Batch · Apr 19  (3 invoices · $6,063.50 total)   APPROVED
   ↳ Sysco #4821 · $2,847.00 · Apr 14                APPROVED
   ↳ Snow Cap #0093 · $614.50 · Apr 15               APPROVED
   ↳ Gordon Food #117 · $3,102.00 · Apr 13           APPROVED

   Invoice · Apr 18  ·  Flanagan #2201  ·  $1,200.00  APPROVED
```

Standalone sessions (no batchId or batchId with only 1 session) appear as today.

---

## Fallback: when auto-grouping fails

If Phase 1 (metadata scan) produces a result that looks wrong (e.g. all 10 files land in 1 group, or each file becomes its own group when they clearly belong together), the user can re-split or re-merge sessions from the review UI via a "Re-group" action. This is out of scope for v1 — if auto-grouping fails badly, the user can approve the sessions as-is and re-upload any missed items manually. A manual grouping flow is defined as a potential v2.

---

## Files Created / Modified

### New files
- `src/app/api/invoices/batches/route.ts` — POST create batch
- `src/app/api/invoices/batches/[id]/route.ts` — GET batch with sessions
- `src/app/api/invoices/batches/[id]/files/route.ts` — POST upload files to batch
- `src/app/api/invoices/batches/[id]/analyze/route.ts` — POST run metadata scan + grouping
- `src/app/api/invoices/sessions/[id]/scanitems/[itemId]/route.ts` — PATCH scan item fields

### Modified files
- `prisma/schema.prisma` — InvoiceBatch, InvoiceBatchFile models; batchId on InvoiceSession; editedDescription on InvoiceScanItem
- `src/app/api/invoices/sessions/route.ts` — accept batchId in POST; include batchId in GET
- `src/app/api/invoices/sessions/[id]/upload/route.ts` — accept sessionId from batch-created sessions
- `src/app/api/invoices/sessions/[id]/upload-local/route.ts` — same
- `src/app/api/invoices/sessions/[id]/approve/route.ts` — update batch status to DONE when all sibling sessions approved
- `src/app/invoices/page.tsx` — batch upload flow, Phase 1 progress view, batch processing view, batch review UI, editable scan item cards, grouped history view
