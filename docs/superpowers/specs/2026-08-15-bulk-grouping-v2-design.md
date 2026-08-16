# Bulk grouping v2: structure-first grouping, readable peeks, photo viewer — design

**Date:** 2026-08-15
**Status:** Approved (conversation, 2026-08-15)
**Extends:** `2026-08-14-bulk-invoice-upload-design.md` (shipped in PR #96)

## Problem (observed on a real batch, 2026-08-14)

A 10-photo Sysco batch produced ~7 distinct invoice numbers for what were 2–3
real invoices (extra digits, transpositions), plus dates off by decades and one
supplier truncation ("ISCO"). Root causes: the peek image is a full page
downscaled to ~1568px (a dot-matrix invoice number is ~40px), Haiku guesses
under those conditions, and the v1 grouping key is the invoice number — so one
bad digit splits or merges invoices. Separately, thumbnails on the confirm
screen are too small to identify a photo, and tapping one jumps straight to a
move picker without ever showing the photo.

## Changes

### 1. Structure-first grouping (digits demoted to a hint)

`quickExtractMeta` returns a richer schema (all old fields kept):

```
pageType:           'first_page' | 'continuation' | 'unknown'
supplierConfidence: 'high' | 'low'
numberConfidence:   'high' | 'low'
```

Grouping rules (`proposeGroups`):
- A **low-confidence invoice number is treated as absent** — it can never
  create or join a group. Only `numberConfidence: 'high'` numbers participate.
- `first_page` **always starts a new group**, unless a high-confidence number
  matches an existing group (retake of the same first page) — then merge.
- `continuation` **always joins the immediately preceding photo group** when
  the supplier is compatible (matches, or either side unreadable — backfill
  the group's supplier when the group's was null). A continuation after a
  supplier switch starts a new group.
- `pageType` absent/`unknown` → exactly the v1 algorithm (all v1 tests must
  keep passing unchanged; absent `numberConfidence` defaults to `high`).
- **No fuzzy digit matching, ever**: same-supplier invoices are often
  sequential, so edit-distance merging would merge real neighbors.

### 2. Peek that can actually read the header

- Model: **Sonnet** (same model id as full OCR), no extended thinking,
  max_tokens ≈ 300. Cost ≈ 1–1.5¢/photo (vs 0.2¢), still ~50× cheaper than
  the full OCR it gates.
- Input: **two images of the same photo** — the full page (existing
  compression) plus a **top-40% crop at high resolution** (the header strip
  gets ~2.5× the effective pixels). Crop is EXIF-uprighted first.
- Prompt forbids guessing: "transcribe EXACTLY the digits you can clearly
  read; if any digit is uncertain, set numberConfidence low."
- Peek route canonicalizes each peeked supplier name against the `Supplier`
  table (`matchSupplierByName` → canonical `Supplier.name`) before grouping,
  so "ISCO"/"Sysco Inc." collapse. Raw name is what gets cached in peekMeta;
  canonicalization happens per peek call.

### 3. Photo viewer on the confirm screen

- Thumbnails get bigger (`h-28`).
- Tapping a photo opens a **full-screen viewer** (image `object-contain`, up
  to ~70dvh) with the move actions inside it: one button per other photo
  group, "New invoice", Close. The old blind action-sheet picker is replaced
  by this viewer — you see what you're assigning. PDFs/CSVs stay non-tappable.

### 4. Peek cache versioning

Stored `peekMeta` gains `v: 2` (`PEEK_VERSION` exported from the OCR lib).
The peek route re-peeks any file whose cached meta is missing, errored, **or
has `v !== PEEK_VERSION`** — so all pre-v2 cached misreads get re-read once
with the new pipeline. CSV placeholder metas are stored with the current
version to stay cached.

## Compatibility

- `QuickMeta` gains fields; existing consumers (process route's session-label
  quick peek) read only the old three fields — unaffected.
- `PeekMeta` new fields are optional; the lib defaults preserve v1 behavior,
  and the peek route's version bump guarantees v2 metas in practice.
- No schema/DB changes. No API shape changes beyond additive JSON fields.

## Out of scope (unchanged from v1 or deliberate)

- Client-side capture compression tuning (native scanner).
- Rotation-aware peek (re-peeking sideways photos upright).
- Drag-and-drop; editing card metadata on the confirm screen.
- Reusing cached peekMeta for the process route's session label (existing
  follow-up).

## v2.1 amendment (2026-08-15, user-requested): discard + editable number

- **Discard a photo** (double-shots, blurry retakes): the viewer sheet gains a
  red "Discard this photo" action. Discarded photos collect in a dimmed strip
  (tap to restore → lands in *unassigned*, forcing deliberate placement).
  `split` accepts `discardFileIds: string[]`; validation becomes "every file
  in exactly one group OR the discard list"; discarded `InvoiceFile` rows are
  deleted inside the split transaction.
- **Editable invoice number**: each group card's number is a tap-to-edit chip
  (commit on Enter/blur; empty ⇒ null). The corrected value flows into the
  session prefill via the existing split body.
- **Corrections outrank OCR**: the process route previously let the full OCR
  overwrite `invoiceNumber`. For sessions from the grouping flow (detected by
  files carrying `peekMeta` — single-invoice uploads never have it), the
  session's number — human-confirmed, possibly hand-corrected — now wins;
  OCR only fills the gap when the card had no number. Supplier and date keep
  OCR-wins semantics.
- This supersedes the v2 out-of-scope line "editing card metadata on the
  confirm screen" for the invoice-number field only.

## Testing

- Grouping lib: all 14 v1 tests unchanged + new tests for: continuation joins
  despite a wrong/low-conf number; first_page splits despite identical
  supplier and null numbers; low-conf number never merges; high-conf number
  still merges non-adjacent; continuation supplier-switch starts a group;
  backfill via continuation; unknown pageType ≡ v1 behavior.
- `npm run build`, `npx tsc --noEmit`, eslint on touched components.
- Browser E2E: batch → confirm screen → open viewer → assign from viewer →
  scan; verify re-peek of v1-cached files on resume.
