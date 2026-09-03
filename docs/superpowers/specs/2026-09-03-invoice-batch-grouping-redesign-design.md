# Invoice photo batches: a first-class object, a safe state machine, a sorter you can leave — design

**Date:** 2026-09-03
**Status:** Approved. Step 1 (state machine + persisted draft + blob cleanup) ships first; steps 2–4 follow as separate PRs.
**Builds on:** `2026-08-14-bulk-invoice-upload-design.md`, `2026-08-15-bulk-grouping-v2-design.md`.

## Problem (audit, 2026-09-03)

The bulk-upload flow (`InvoiceSession.status = 'GROUPING'`, `/peek` → `InvoiceGroupingModal` → `/split`)
works mechanically, but it is modelled as *an invoice that happens to have no data*. Every visible
problem follows from that:

1. **A batch renders as a broken invoice.** Inbox row, History table and the mobile card all print
   `Unknown supplier · Needs grouping · 0 lines · Group`. `sessionToItem` in
   `src/lib/invoices/inbox-items.ts` only knows how to describe an invoice.
2. **Counts disagree with the list.** `queueCount` (`src/app/invoices/page.tsx`) and the KPI
   `awaitingApprovalCount` both skip `GROUPING`, so the header says "1 in queue" while the queue
   lists 2.
3. **No way to discard a batch from inside the session.** The only path is the History tab's ⋯ menu
   (MANAGER-only DELETE). Inbox rows and the whole mobile surface have no delete. The bulk
   `DELETE /api/invoices/sessions` has no auth check at all.
4. **Every edit in the modal is lost on close.** Moves, discards and corrected invoice numbers live in
   component state. Backdrop-tap closes without warning; reopening recomputes the proposal from
   cached `peekMeta`.
5. **PDFs and CSVs are inert on the sorter.** Thumbnails only open the viewer for photo groups; the
   assign sheet only lists photo groups as targets. A wrong PDF cannot be moved or discarded.
6. **Nothing ever deletes an uploaded blob.** Discarded photos and deleted sessions drop DB rows; the
   UploadThing files (`utfs.io/f/…`, `*.ufs.sh/f/…`) and local `/uploads/invoices/…` files stay
   forever. There is no `UTApi` call anywhere in the tree.
7. **A failed peek silently degrades into a wrong scan.** `upload` / `upload-local` set the session to
   `PROCESSING`; `/peek` only parks it in `GROUPING` *after* it succeeds. If the peek times out
   (`maxDuration = 60`) or errors, the 5-minute sweeper flips the session to `ERROR`, the row offers
   *Retry*, and Retry runs full OCR on the whole batch **as one invoice**.
8. **Smaller gaps.** No page reorder inside an invoice (OCR order = upload order). Supplier and date
   on a card are read-only, so an "Unknown supplier" card can't be labelled. The assign sheet doesn't
   say which invoice the photo is currently in. Moving five photos is five open-tap-close cycles. The
   mobile modal is a centred dialog, not the full-height sheet the v1 spec asked for.

## Goal

A batch of photos is its own thing in the inbox, it cannot lose the user's sorting work, it can be
thrown away from wherever the user is looking at it, and no state transition can turn an unsorted
batch into a single-invoice OCR run.

## Decisions

1. **Keep the staging-session architecture.** `InvoiceSession` in `GROUPING` stays the batch holder
   (Option C from v1). A separate `InvoiceBatch` model would still be a whole lifecycle for a
   30-second screen. What changes is that the *rest of the app* learns to recognise a batch.
2. **The draft is server state.** `InvoiceSession.groupingDraft Json?` holds the proposal *and* every
   user edit. The client saves after each mutation; reopening loads the draft, never recomputes.
   Rationale: the sorter is the one screen where the user does manual, unrecoverable work
   (which photo is which invoice) — it must survive a backdrop tap, a phone lock, or a second device.
3. **Status is decided by file count at registration, not by the peek.** A session with >1 registered
   file is `GROUPING` from the moment the second file lands. `/peek` may run, fail, or time out
   without changing what the batch *is*. `/process` refuses `GROUPING` (409): only `/split` can turn a
   batch into invoices.
4. **Blob deletion is best-effort and never blocks the row delete.** Orphaned bytes are a cost/privacy
   nuisance; a failed CDN call must not leave a session the user cannot delete. Delete rows first,
   then delete blobs, log failures.
5. **Discard needs no new endpoint.** Session DELETE already exists; step 3 widens who may call it for
   sessions that have no scan items (nothing has been posted to the spine), and adds the entry points.
6. **Design order: reliability first, then representation, then the screen.** Steps 1 → 4 below.

## Data model (additive only)

- `InvoiceSession.groupingDraft Json?` —
  ```ts
  { v: 1,
    groups: Array<{ fileIds: string[]; kind: 'photos'|'pdf'|'csv';
                    supplierName: string|null; invoiceNumber: string|null; invoiceDate: string|null }>,
    unassigned: string[],
    discarded: string[] }
  ```
  Written by `/peek` (initial proposal) and `PUT …/grouping` (every edit). Cleared by `/split`.
  Invariant enforced on read and write: every id belongs to the session, no id appears twice.
  A draft is *reconciled* against the session's current files on load — unknown ids are dropped
  (empty groups collapse), files not mentioned land in `unassigned`.

Migration `20260903000000_add_grouping_draft`: `ALTER TABLE "InvoiceSession" ADD COLUMN IF NOT EXISTS
"groupingDraft" JSONB;` — IF NOT EXISTS, same out-of-band-tolerant pattern as the peek migration.

## State machine (step 1)

```
create ──► UPLOADING ──register 1 file──► PROCESSING ──/process──► REVIEW …
                     └─register ≥2 files─► GROUPING ──/split──► PROCESSING (per invoice) ──► …
                                              ▲   │
                              /peek (any outcome) ┘   └─ DELETE (discard batch)
```

- `upload` / `upload-local`: after inserting, count the session's files; set `GROUPING` when >1,
  else `PROCESSING`. The native scanner's local fallback registers one page per request, so the
  session passes through `PROCESSING` after page 1 and settles in `GROUPING` at page 2 — the client
  only fires `/process` when its own page count is 1, so this is safe.
- `/peek`: parks `>1 file` sessions in `GROUPING` **before** peeking (first write in the handler), so a
  timeout mid-peek leaves a resumable batch, not a `PROCESSING` corpse. Returns the stored draft when
  one exists (reconciled), else computes the proposal, stores it as the draft, returns it. The
  response gains `discarded: string[]`.
- `PUT /api/invoices/sessions/[id]/grouping`: body is a draft; validated + reconciled + stored.
  409 unless the session is `GROUPING`.
- `/split`: unchanged contract; additionally nulls `groupingDraft` on the surviving session and
  deletes the discarded files' blobs after the transaction commits.
- `/process`: 409 when `session.status === 'GROUPING'` ("This batch hasn't been sorted yet").
- The stale sweeper still targets `PROCESSING` only; `GROUPING` never expires (unchanged).

## Blob cleanup (step 1)

`src/lib/invoice-files.ts` gains:

- `blobRefFromUrl(fileUrl)` → `{ kind: 'uploadthing', key } | { kind: 'local', relPath } | null`.
  UploadThing key = path segment after `/f/` on `utfs.io` or `*.ufs.sh` (query stripped). Local =
  `/uploads/invoices/<name>` with a strict single-segment name. `data:` URIs and anything else → null.
- `deleteFileBlobs(files)` — one `UTApi.deleteFiles(keys)` call for all CDN keys, `unlink` for local
  files (confined to `public/uploads/invoices`), everything caught and logged; returns
  `{ deleted, failed }`. `uploadthing/server` is imported dynamically so the pure helper stays
  test-importable.

Call sites: `/split` (discards), `DELETE …/sessions/[id]`, `DELETE …/sessions` (bulk). The bulk
route also gains the `requireSession('MANAGER')` guard the single-id route already has.

## UI

### Step 1 — sorter keeps its state
`InvoiceGroupingModal` loads `groups / unassigned / discarded` from `/peek` and PUTs the whole
draft after every mutation (move, discard, restore, number edit, "scan as one"). Saves are
serialised (one in flight, latest pending wins) so out-of-order responses can't resurrect an older
draft. The header's ✕ is labelled "Keep for later" and is now honest.

### Step 2 — the batch is an inbox object
`InboxItem.kind` gains `'batch'`. Row copy: **Photo batch** · `N photos` · `M invoices found` (from
the draft's group count when present) · age. Badge **Unsorted**, CTA **Sort photos**, stacked-pages
icon, ink/blue tone so it never competes with the gold "Needs review" rows (money waiting).
`queueCount` and the header include batches; the KPI tile gets a separate "N unsorted" line rather
than folding batches into *awaiting approval*. History table shows the same batch row. Mobile card
follows the same copy.

### Step 3 — discard from where you are
- Sorter header: ⋯ menu → **Discard batch** → confirm sheet ("Delete 4 photos? Nothing has been
  scanned.") → DELETE → close.
- Inbox row / mobile card overflow: **Discard batch** with the same confirm.
- Auth: DELETE on a session with zero `scanItems` is allowed for any invoice writer; sessions that
  have been scanned keep the MANAGER gate.

### Step 4 — the sorter
Each invoice is a full-width row: numbered page strip (long-press drag to reorder within the row;
order persists to the draft and drives OCR page order), supplier chip opening the supplier picker,
editable number and date, and "add pages". Multi-select pages by tap → bottom toolbar *Move to /
New invoice / Discard*. PDFs and CSVs are rows like any other; the mover refuses to merge a PDF into
a photo row. Assign sheet names the photo's current invoice. Per-photo peek progress instead of one
spinner. Mobile: full-height sheet, confirm pinned to the bottom.

## Build order

| Step | PR | Scope |
|---|---|---|
| 1 | this | `groupingDraft` column + `PUT …/grouping`; status-by-count in upload routes; peek parks first + returns draft; process 409 on GROUPING; blob cleanup on split/delete; bulk DELETE auth; modal saves draft |
| 2 | next | batch inbox object across InboxViewV2 / InvoiceListV2 / InboxInvoiceCard; counts + KPI |
| 3 | next | discard batch from sorter + rows; DELETE gate by scan-item count |
| 4 | last | sorter restructure (rows, multi-select, reorder, editable supplier/date, PDF parity, mobile sheet) |

## Testing

- **Unit (vitest):** `invoice-grouping-draft` — `draftFromProposal`, `parseDraft` (shape, unknown id,
  duplicate id), `reconcileDraft` (drops unknown, collapses empty groups, surfaces missing ids as
  unassigned, keeps discarded). `invoice-files` — `blobRefFromUrl` for utfs.io, ufs.sh (with query),
  local path, traversal attempt, data URI, foreign host.
- **Build:** `npm run build` in an isolated worktree.
- **Browser:** open the parked batch → move a photo → close → reopen: the move survives. Discard a
  photo → confirm → the row is gone and the CDN key is deleted (`preview_logs`). POST `/process` on
  a GROUPING session → 409.

## Out of scope (deliberate)

- Auto-expiry of abandoned batches (still none; a batch is cheap to keep and costly to lose).
- Merging PDFs with photos.
- Re-peeking after a manual move (the draft is the truth once the user has touched it).
- Fixing the unauthenticated `/process` and `/upload*` routes (separate auth-sweep task; noted here
  so it isn't forgotten).
