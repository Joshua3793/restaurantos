# Create Supplier from Invoice Review — Design

**Date:** 2026-06-10
**Status:** Approved, pending implementation

## Problem

When an invoice is processed for a supplier that does not match any existing
`Supplier` record, the pipeline leaves `InvoiceSession.supplierId = null`. The
review drawer already surfaces this (the yellow `SupplierLinkCard` says
_"'X' isn't linked to a supplier in your directory"_) and offers **Link to
existing** / **Skip**, but there is **no way to create the missing supplier**
from here.

Consequences of the missing record:
- Learning-mode OCR generates `formatNotes` (the invoice's column layout) but
  can only persist them when a `supplierId` exists — so for a brand-new
  supplier the discovered layout is discarded.
- Per-supplier offers (`InventorySupplierPrice`) are stored keyed by the raw
  text name with `supplierId = null`, so the Suppliers page can't attribute
  spend/history to a real record.

## Goal

Let the user create the missing `Supplier` directly from the review drawer, link
it to the session, and adopt any existing data that was stored under that text
name. Going forward, that supplier's invoices process with a real `supplierId`,
so learned `formatNotes` persist.

## Non-goals

- Auto-creating suppliers without a prompt (explicitly rejected — avoids junk
  records from one-off / misread suppliers).
- Backfilling `InventoryItem.supplierId` (items don't carry the OCR supplier
  name) or `InvoiceMatchRule` (no `supplierId` column; keyed by name string).
- Rewording the existing "isn't linked" copy.

## Design

### 1. Frontend — `SupplierLinkCard`
`src/components/invoices/v2/InvoiceReviewDrawer.tsx` (~line 1562)

- Add a third action button **"Create new"** beside "Link to existing" / "Skip".
- Clicking it reveals an inline form, pre-filled from `supplierName`:
  - **Name** — required, editable, defaults to the OCR-detected name.
  - **Contact name, Phone, Email, Order platform** — all optional.
- **Save**:
  1. `POST /api/suppliers` with the form fields plus
     `aliases: [session.supplierName]` (so the raw OCR name matches next time).
  2. On success, push the new supplier into local `allSuppliers` and call the
     existing `handleLinkSupplier(newId)` — which PATCHes the session
     `supplierId`, runs `learnAlias`, and clears the approval gate.
- On failure, show the error inline; keep the form open.

### 2. Backend — backfill in the link step
`src/app/api/invoices/sessions/[id]/route.ts` — the `PATCH supplierId` branch (~line 96)

- After setting `session.supplierId`, backfill `InventorySupplierPrice` rows
  where `supplierId IS NULL AND supplierName === session.supplierName`, setting
  `supplierId` to the linked id.
- Placing the backfill here (not in `POST /api/suppliers`) means **both**
  "Create new" and "Link to existing" adopt orphaned offers under that name —
  one code path, more correct. `learnAlias` already runs in this branch.

### 3. `POST /api/suppliers`
No change. Already accepts `name` + optional fields + `aliases[]`
(`src/app/api/suppliers/route.ts:59`).

## Data flow

```
OCR can't match supplier
  → session.supplierId = null
  → SupplierLinkCard renders "not linked"
  → user clicks "Create new", fills form
  → POST /api/suppliers (name + optional + aliases:[ocrName])
  → handleLinkSupplier(newId) → PATCH session { supplierId }
       ↳ backfill InventorySupplierPrice (supplierId null, name match)
       ↳ learnAlias(newId, ocrName)
  → approval gate clears
Future invoices from this supplier process with a real supplierId
  → learned formatNotes now persist
```

## Verification

- `npm run build` (type-check).
- Manual: process an invoice from an unknown supplier; confirm the card offers
  **Create new**; create one; confirm the session links and the gate clears;
  confirm the supplier appears on the Suppliers page; re-process a similar
  invoice and confirm it matches automatically (alias learned).
