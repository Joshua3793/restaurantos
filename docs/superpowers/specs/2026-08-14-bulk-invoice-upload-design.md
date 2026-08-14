# Bulk invoice upload with auto-grouping — design

**Date:** 2026-08-14
**Status:** Approved for planning

## Problem

Today each invoice must be uploaded as its own session: the user picks the photos
for ONE invoice, a session is created, and all files in it are treated as pages of
that single invoice. A manager who has just photographed a stack of 6–10 invoices
must repeat the upload flow once per invoice.

## Goal

Let the user upload many photos at once. A cheap per-photo metadata pass
(`quickExtractMeta`, Haiku) proposes how the photos split into invoices; the user
confirms (and fixes) the grouping on one screen; then each confirmed invoice runs
through the existing, unchanged per-session OCR → match → review → approve pipeline.

## Decisions made (with rationale)

1. **One unified upload flow.** Every upload goes through the same path. A single
   file short-circuits (no peek, no grouping screen — byte-for-byte today's flow).
   Multiple files always show the confirm-grouping screen, even when the peek says
   it is all one invoice (one card, one tap) — this catches "I thought it was one
   invoice but it was two".
2. **Each PDF/CSV is always its own invoice.** Only photos participate in grouping.
   PDFs are still peeked so their card shows supplier/number/date; CSVs get a
   generic card. Never merged with photos or each other.
3. **Full OCR starts only after the user confirms the grouping.** No tokens are
   ever spent on a wrong grouping.
4. **Both web and the native scanner flow are in scope.** All logic is server-side;
   the confirm screen is responsive, so any client that uploads multiple files to a
   session gets the same behavior.
5. **Architecture: staging session (Option C).** The batch is held by a normal
   `InvoiceSession` in a new `'GROUPING'` status. Chosen over a stateless
   client-held batch (breaks the base64 local-upload fallback, not refresh-safe)
   and over a new `InvoiceBatch` model (a whole lifecycle for a 30-second screen).
   The existing upload/upload-local routes are session-scoped and work unchanged.

## Data model (additive only)

- `InvoiceSession.status` gains the value `'GROUPING'` (plain String column — no
  enum migration).
- `InvoiceSession.updatedAt DateTime @default(now()) @updatedAt` — the
  stale-PROCESSING sweeper (sessions list route) switches from `createdAt` to
  `updatedAt`. Rationale: after grouping, the original staging session is
  routinely >5 min old when its OCR starts (slow confirm, or resumed later);
  sweeping on `createdAt` would flip it to ERROR mid-OCR. `updatedAt` is bumped
  by the split's own status write, so the 5-minute clock starts when OCR does.
- `InvoiceFile.peekMeta Json?` — caches the quick-peek result per file:
  `{ supplierName: string|null, invoiceDate: string|null, invoiceNumber: string|null, error?: string }`.
  Cached so retries never re-pay Haiku for an already-peeked file.

No new tables, no new foreign keys.

## Grouping algorithm — pure lib `src/lib/invoice-grouping.ts`

Input: the session's files in `createdAt` order (= capture order), each with
`peekMeta` and file type. Output: ordered groups + per-file placement reason.

- **Group key** = normalized supplier name + normalized invoice number.
  Invoice-number normalization: uppercase, strip spaces/dashes/leading zeros.
  Supplier normalization: lowercase/trim (canonical supplier resolution against
  the `Supplier` table happens later, at split, via the existing
  `matchSupplierByName`).
- **Continuation-page heuristic:** a photo with a null invoice number joins the
  immediately preceding group when its supplier matches the group's, or when its
  supplier is also null. This places "page 3 shows only line items" photos
  correctly whenever photos were captured in order.
- **PDF/CSV isolation:** each is emitted as its own group regardless of metadata.
- **Unassigned bucket:** photos whose peek errored AND that have no preceding
  group to join are returned in an `unassigned` list for manual placement.
- **Order invariant:** files keep capture (`createdAt`) order within every group.
  The process route orders by `createdAt asc` and `bbox.page` indexes into that
  order — moving files between sessions must never reorder them.

Pure function; unit-tested in `src/lib/__tests__/` (vitest, runs in `npm test`).

## API

Two new endpoints; everything else untouched. Both call `requireSession()` and
`export const dynamic = 'force-dynamic'`.

### `POST /api/invoices/sessions/[id]/peek`

1. Load the session's files (`createdAt asc`).
2. For files without `peekMeta`: run `quickExtractMeta` in parallel
   (`Promise.allSettled` — one unreadable photo never blocks the batch). Persist
   results (including `{error}` on failure) to `peekMeta`.
3. Compute the proposed grouping via the lib.
4. If the session has more than one file, set `status: 'GROUPING'`.
5. Return `{ groups, unassigned }`.

Idempotent (peekMeta cache). `maxDuration = 60`.

### `POST /api/invoices/sessions/[id]/split`

Body: `{ groups: [{ fileIds: string[], supplierName?, invoiceNumber?, invoiceDate? }] }`.

1. Validate: session exists and is in `GROUPING`/`UPLOADING`; every file of the
   session appears in exactly one group; every group is non-empty. 400 otherwise.
2. Group 1 stays in the current session; each additional group gets a fresh
   session (status `UPLOADING`, copying `revenueCenterId`), and its files'
   `sessionId` re-pointed (move, not copy — same pattern as the RC split).
3. Pre-fill each session's `supplierName` / `invoiceNumber` / `invoiceDate` from
   the confirmed card values. Full OCR still refines these later exactly as today
   (the process route prefers OCR-extracted values).
4. Set all resulting sessions to `status: 'PROCESSING'` — the client fires
   `process` for each immediately, the pills read correctly during OCR, and a
   serverless kill is rescued by the (now `updatedAt`-based) sweeper → ERROR →
   retry, exactly like today's single-invoice flow.
5. Return `{ sessionIds: string[] }` in group order.

The client then fires the existing `POST .../process` once per returned id,
fire-and-forget, exactly like today's single-session flow. Each process call is
its own serverless invocation, so the 300s `maxDuration` budget stays per-invoice.

## UI

- **Upload modal (`InvoiceUploadModal`):** unchanged file picking + upload. After
  upload: 1 file → fire process and close (today's flow). >1 file → call `peek`
  and swap the modal body to the grouping screen (wider on desktop, full-height
  sheet on mobile, following the app's responsive patterns).
- **Grouping screen (new component, `src/components/invoices/`):** one card per
  proposed invoice — header `supplier · invoice # · date`, photo thumbnails in
  order (`fileUrl` renders directly for both CDN URLs and data URIs). Unassigned
  strip pinned on top when present. Footer button: “Scan N invoice(s)”.
- **Moving photos:** tap a thumbnail → “Move to…” picker (existing group / new
  invoice). Same interaction on desktop and mobile; no drag-and-drop in v1.
- **Resume:** sessions in `GROUPING` render in the invoice list as a “Finish
  grouping” card that reopens the grouping screen with the server-computed
  proposal (recomputed from cached peekMeta — instant).
- **Fallback:** if peek fails entirely (e.g. no API key), warn and continue as
  one invoice (today's behavior).

## Error handling

- Per-file peek failure → `peekMeta.error`, file goes to the unassigned bucket.
- Split validation failure → 400 with message; the screen re-fetches the proposal.
- OCR failure after split → existing per-session ERROR + retry machinery.
- Close/abandon mid-grouping → session stays `GROUPING`; resumable or deletable
  from the list. The stale-session sweeper (which only targets `PROCESSING`)
  ignores it.
- Session DELETE already cascades files; no change needed for GROUPING sessions.

## Cost

Added cost is one Haiku call per photo (~1,600 image input tokens + ~100 output):
well under a cent per photo, ~2¢ per 10-photo batch. The expensive full OCR is
per-invoice and unchanged in count.

## Testing

- **Unit (vitest):** grouping lib — key normalization, continuation heuristic,
  PDF/CSV isolation, unassigned bucket, order preservation, single-group batch.
- **Build:** `npm run build`.
- **Browser:** full flow against the dev server — multi-photo batch → grouping
  screen → move a photo → confirm → parallel OCR → review screens.

## Out of scope (deliberate)

- Drag-and-drop on the grouping screen.
- Merging multiple PDFs into one invoice.
- Editing supplier/number/date on the grouping card (the review screen already
  owns metadata editing).
- Optimistic OCR start before confirm.
- Auto-expiry of abandoned GROUPING sessions.
