# Bulk Invoice Upload with Auto-Grouping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user upload many invoice photos at once; a cheap Haiku peek proposes how they split into invoices; the user confirms on one screen; each confirmed invoice runs through the existing unchanged per-session OCR pipeline.

**Architecture:** Staging-session pattern (Option C of the spec). The batch is a normal `InvoiceSession` in a new `'GROUPING'` status; the existing session-scoped upload routes work unchanged. Two new endpoints: `peek` (runs `quickExtractMeta` per file, caches to `InvoiceFile.peekMeta`, returns a proposed grouping) and `split` (moves files into one session per confirmed group, then the client fires the existing `process` per session).

**Tech Stack:** Next.js 14 App Router, Prisma + PostgreSQL (Supabase), Anthropic SDK (`quickExtractMeta` already exists), Tailwind (flat tokens), vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-bulk-invoice-upload-design.md` — read it first.

## Global Constraints

- Import prisma ONLY from `src/lib/prisma.ts` (singleton).
- Every new API route: `requireSession()` guard with the try/catch `AuthError` pattern, and `export const dynamic = 'force-dynamic'`.
- Tailwind: flat tokens only (`bg-gold-soft`, `text-ink-3`) — numbered classes like `bg-red-500` are BROKEN in this project.
- React: define sub-components at module scope, never inside a component body (remount/focus-loss bug).
- Prisma `migrate dev` is BROKEN on this DB (shadow-DB drift, P3006). Use the diff → db execute → resolve workaround (exact commands in Task 1).
- `npm run build` in the main checkout gives bogus failures while `next dev` runs — build from an isolated worktree (symlink `node_modules` and `.env`) or stop the dev server first.
- File order invariant: `bbox.page` indexes into the session's files ordered by `createdAt asc`. Moving files between sessions must never touch `createdAt`.
- Commit after every task; run `npm test` (fast, <1s) whenever the grouping lib changes.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (modify) | `InvoiceFile.peekMeta Json?`, `InvoiceSession.updatedAt` |
| `src/lib/invoice-grouping.ts` (create) | Pure grouping algorithm + normalizers + `fileKind` — no DB, no API |
| `src/lib/__tests__/invoice-grouping.test.ts` (create) | Unit tests for the lib |
| `src/lib/invoice-files.ts` (create) | `loadBuffer` shared by process + peek routes |
| `src/app/api/invoices/sessions/[id]/peek/route.ts` (create) | Peek endpoint |
| `src/app/api/invoices/sessions/[id]/split/route.ts` (create) | Split endpoint |
| `src/app/api/invoices/sessions/[id]/process/route.ts` (modify) | Use shared `loadBuffer` (mechanical) |
| `src/app/api/invoices/sessions/route.ts` (modify) | Sweeper: `createdAt` → `updatedAt` |
| `src/components/invoices/types.ts` (modify) | `SessionStatus` gains `'GROUPING'` |
| `src/components/invoices/InvoiceGroupingModal.tsx` (create) | Confirm-grouping screen (fetches peek, tap-to-move, confirm → split + process) |
| `src/components/invoices/InvoiceUploadModal.tsx` (modify) | >1 file → hand off to grouping instead of processing |
| `src/hooks/useNativeScan.ts` (modify) | >1 page → hand off to grouping |
| `src/app/invoices/page.tsx` (modify) | `groupingSessionId` state, open-session router, render grouping modal |
| `src/components/invoices/InvoiceListV2.tsx` (modify) | GROUPING badge + sort order + row is openable |
| `src/components/invoices/InboxViewV2.tsx` (modify) | GROUPING label/tint + card is openable |

---

### Task 1: Schema — `peekMeta`, `updatedAt`, sweeper fix

**Files:**
- Modify: `prisma/schema.prisma` (models `InvoiceSession` ~line 368, `InvoiceFile` ~line 410)
- Create: `prisma/migrations/<ts>_add_grouping_columns/migration.sql`
- Modify: `src/app/api/invoices/sessions/route.ts:24`

**Interfaces:**
- Produces: `InvoiceFile.peekMeta: Json?` (read/written by Task 4 peek route), `InvoiceSession.updatedAt: DateTime` (maintained by Prisma `@updatedAt`).

**Why `updatedAt`:** the stale-session sweeper flips `PROCESSING` sessions older than 5 min (by `createdAt`) to `ERROR`. After grouping, the ORIGINAL staging session is routinely >5 min old when its OCR finally starts (user dawdled on the confirm screen, or resumed next day) — with `createdAt` it would be insta-swept mid-OCR. Sweeping on `updatedAt` (bumped by every status write) preserves the recovery behavior without the false positive.

- [ ] **Step 1: Edit schema**

In `model InvoiceSession`, after `createdAt DateTime @default(now())` add:

```prisma
  // Last write to this session. The stale-PROCESSING sweeper keys off this
  // (NOT createdAt) so a session that sat in GROUPING for an hour isn't
  // insta-flagged as timed out the moment its OCR starts.
  updatedAt       DateTime          @default(now()) @updatedAt
```

In `model InvoiceFile`, after `ocrRawJson String?` add:

```prisma
  // Quick-peek metadata cache: { supplierName, invoiceDate, invoiceNumber, error? }.
  // Written once by /peek (Haiku); cached so retries never re-pay for a peeked file.
  peekMeta   Json?
```

- [ ] **Step 2: Create + apply the migration (shadow-DB workaround)**

```bash
set -a; . ./.env; set +a
MIG="$(date +%Y%m%d%H%M%S)_add_grouping_columns"
mkdir -p "prisma/migrations/$MIG"
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script > "prisma/migrations/$MIG/migration.sql"
cat "prisma/migrations/$MIG/migration.sql"
```

Expected SQL (verify before applying — must be ONLY these two additive statements):

```sql
ALTER TABLE "InvoiceSession" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "InvoiceFile" ADD COLUMN "peekMeta" JSONB;
```

If the diff contains ANYTHING else, STOP — the schema drifted; do not apply (memory: never full-schema migrate diff).

```bash
npx prisma db execute --url "$DIRECT_URL" --file "prisma/migrations/$MIG/migration.sql"
npx prisma migrate resolve --applied "$MIG"
npx prisma generate
```

- [ ] **Step 3: Sweeper — sweep on updatedAt**

In `src/app/api/invoices/sessions/route.ts`, change the updateMany condition (line ~24):

```ts
    where: { AND: [scopeWhere, { status: 'PROCESSING', updatedAt: { lt: staleThreshold } }] },
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit 2>/dev/null || npm run build` (worktree/stopped-dev-server rule applies)
Expected: compiles; no references break (`updatedAt`/`peekMeta` are additive).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/app/api/invoices/sessions/route.ts
git commit -m "feat(invoices): add peekMeta + updatedAt columns; sweep stale sessions on activity"
```

---

### Task 2: Grouping lib (TDD)

**Files:**
- Create: `src/lib/invoice-grouping.ts`
- Test: `src/lib/__tests__/invoice-grouping.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 4, 6):

```ts
export interface PeekMeta { supplierName: string | null; invoiceDate: string | null; invoiceNumber: string | null; error?: string }
export interface GroupingFile { id: string; fileName: string; fileType: string; peekMeta: PeekMeta | null }
export type GroupKind = 'photos' | 'pdf' | 'csv'
export interface ProposedGroup { fileIds: string[]; kind: GroupKind; supplierName: string | null; invoiceNumber: string | null; invoiceDate: string | null }
export interface GroupingProposal { groups: ProposedGroup[]; unassigned: string[] }
export function fileKind(fileType: string, fileName: string): 'photo' | 'pdf' | 'csv'
export function normalizeInvoiceNumber(v: string | null): string | null
export function normalizeSupplierName(v: string | null): string | null
export function proposeGroups(files: GroupingFile[]): GroupingProposal
```

- [ ] **Step 1: Write the failing tests**

`src/lib/__tests__/invoice-grouping.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  proposeGroups,
  normalizeInvoiceNumber,
  normalizeSupplierName,
  fileKind,
  type GroupingFile,
  type PeekMeta,
} from '@/lib/invoice-grouping'

let n = 0
function photo(meta: Partial<PeekMeta> | null, error?: string): GroupingFile {
  n++
  const peekMeta: PeekMeta | null = meta === null && !error
    ? null
    : {
        supplierName: meta?.supplierName ?? null,
        invoiceDate: meta?.invoiceDate ?? null,
        invoiceNumber: meta?.invoiceNumber ?? null,
        ...(error ? { error } : {}),
      }
  return { id: `f${n}`, fileName: `p${n}.jpg`, fileType: 'image/jpeg', peekMeta }
}
function pdf(meta: Partial<PeekMeta> | null): GroupingFile {
  n++
  return {
    id: `f${n}`, fileName: `doc${n}.pdf`, fileType: 'application/pdf',
    peekMeta: meta ? { supplierName: meta.supplierName ?? null, invoiceDate: meta.invoiceDate ?? null, invoiceNumber: meta.invoiceNumber ?? null } : null,
  }
}
function csv(): GroupingFile {
  n++
  return { id: `f${n}`, fileName: `export${n}.csv`, fileType: 'text/csv', peekMeta: null }
}

describe('normalizers', () => {
  it('invoice numbers: case, separators, leading zeros collapse', () => {
    expect(normalizeInvoiceNumber('INV-00123')).toBe('INV00123')
    expect(normalizeInvoiceNumber('inv 00123')).toBe('INV00123')
    expect(normalizeInvoiceNumber('00123')).toBe('123')
    expect(normalizeInvoiceNumber('  ')).toBeNull()
    expect(normalizeInvoiceNumber(null)).toBeNull()
  })
  it('supplier names: case/whitespace collapse', () => {
    expect(normalizeSupplierName('  Sysco   Canada ')).toBe('sysco canada')
    expect(normalizeSupplierName('')).toBeNull()
    expect(normalizeSupplierName(null)).toBeNull()
  })
  it('fileKind classifies by type then extension', () => {
    expect(fileKind('image/jpeg', 'a.jpg')).toBe('photo')
    expect(fileKind('application/pdf', 'a.pdf')).toBe('pdf')
    expect(fileKind('application/octet-stream', 'a.pdf')).toBe('pdf')
    expect(fileKind('text/csv', 'a.csv')).toBe('csv')
    expect(fileKind('application/octet-stream', 'a.csv')).toBe('csv')
  })
})

describe('proposeGroups', () => {
  it('same supplier+number merge; different numbers split', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      photo({ supplierName: 'Sysco', invoiceNumber: 'A2' }),
    ]
    const { groups, unassigned } = proposeGroups(files)
    expect(groups.map(g => g.fileIds.length)).toEqual([2, 1])
    expect(unassigned).toEqual([])
  })

  it('continuation: null number joins preceding group when supplier matches or is null', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      photo({ supplierName: 'Sysco', invoiceNumber: null }),
      photo({ supplierName: null, invoiceNumber: null }),
    ]
    const { groups } = proposeGroups(files)
    expect(groups).toHaveLength(1)
    expect(groups[0].fileIds).toHaveLength(3)
  })

  it('supplier switch with null number starts a NEW group', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      photo({ supplierName: 'GFS', invoiceNumber: null }),
    ]
    const { groups } = proposeGroups(files)
    expect(groups).toHaveLength(2)
    expect(groups[1].supplierName).toBe('GFS')
    expect(groups[1].invoiceNumber).toBeNull()
  })

  it('non-adjacent same-number photos still merge, order preserved within group', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }), // f?_a
      photo({ supplierName: 'GFS', invoiceNumber: 'B9' }),
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }), // f?_c
    ]
    const { groups } = proposeGroups(files)
    expect(groups).toHaveLength(2)
    expect(groups[0].fileIds).toEqual([files[0].id, files[2].id])
  })

  it('number match with a null supplier on one side still merges and backfills', () => {
    const files = [
      photo({ supplierName: null, invoiceNumber: 'A1' }),
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1', invoiceDate: '2026-08-14' }),
    ]
    const { groups } = proposeGroups(files)
    expect(groups).toHaveLength(1)
    expect(groups[0].supplierName).toBe('Sysco')
    expect(groups[0].invoiceDate).toBe('2026-08-14')
  })

  it('PDF and CSV are always their own group, even with matching metadata', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      pdf({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      csv(),
    ]
    const { groups } = proposeGroups(files)
    expect(groups).toHaveLength(3)
    expect(groups.map(g => g.kind)).toEqual(['photos', 'pdf', 'csv'])
  })

  it('errored peek joins the preceding group (behaves as all-null continuation)', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      photo(null, 'Claude returned an empty response'),
    ]
    const { groups, unassigned } = proposeGroups(files)
    expect(groups).toHaveLength(1)
    expect(groups[0].fileIds).toHaveLength(2)
    expect(unassigned).toEqual([])
  })

  it('errored peek with NO preceding group goes to unassigned', () => {
    const files = [
      photo(null, 'unreadable'),
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
    ]
    const { groups, unassigned } = proposeGroups(files)
    expect(unassigned).toEqual([files[0].id])
    expect(groups).toHaveLength(1)
  })

  it('all-null (non-errored) first photo starts an unknown group rather than unassigned', () => {
    const files = [photo({ supplierName: null, invoiceNumber: null })]
    const { groups, unassigned } = proposeGroups(files)
    expect(groups).toHaveLength(1)
    expect(unassigned).toEqual([])
  })

  it('single photo → single group', () => {
    const { groups } = proposeGroups([photo({ supplierName: 'Sysco', invoiceNumber: 'A1' })])
    expect(groups).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/__tests__/invoice-grouping.test.ts`
Expected: FAIL — cannot resolve `@/lib/invoice-grouping`.

- [ ] **Step 3: Implement the lib**

`src/lib/invoice-grouping.ts`:

```ts
// Pure grouping logic for bulk invoice upload: given per-file quick-peek
// metadata, propose how a batch of uploaded files splits into invoices.
// No DB, no API — unit-tested in src/lib/__tests__/invoice-grouping.test.ts.
// Design: docs/superpowers/specs/2026-08-14-bulk-invoice-upload-design.md

export interface PeekMeta {
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  error?: string
}

export interface GroupingFile {
  id: string
  fileName: string
  fileType: string
  peekMeta: PeekMeta | null
}

export type GroupKind = 'photos' | 'pdf' | 'csv'

export interface ProposedGroup {
  fileIds: string[]
  kind: GroupKind
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
}

export interface GroupingProposal {
  groups: ProposedGroup[]
  unassigned: string[]
}

export function fileKind(fileType: string, fileName: string): 'photo' | 'pdf' | 'csv' {
  const ft = fileType.toLowerCase()
  const fn = fileName.toLowerCase()
  if (ft === 'text/csv' || fn.endsWith('.csv')) return 'csv'
  if (ft === 'application/pdf' || fn.endsWith('.pdf')) return 'pdf'
  return 'photo'
}

// Uppercase, drop separators, collapse leading zeros: "INV-00123" == "inv 00123".
export function normalizeInvoiceNumber(v: string | null): string | null {
  if (!v) return null
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '')
  return s.length ? s : null
}

export function normalizeSupplierName(v: string | null): string | null {
  if (!v) return null
  const s = v.toLowerCase().replace(/\s+/g, ' ').trim()
  return s.length ? s : null
}

interface PhotoGroupRec { idx: number; nSup: string | null; nNum: string | null }

export function proposeGroups(files: GroupingFile[]): GroupingProposal {
  const groups: ProposedGroup[] = []
  const unassigned: string[] = []
  const photoGroups: PhotoGroupRec[] = []
  // The most recent photo group, for the continuation-page heuristic. PDFs and
  // CSVs deliberately do NOT reset it: photos remain "adjacent" across them.
  let lastPhoto: PhotoGroupRec | null = null

  const newPhotoGroup = (f: GroupingFile, meta: PeekMeta | null, nSup: string | null, nNum: string | null) => {
    const idx = groups.push({
      fileIds: [f.id],
      kind: 'photos',
      supplierName: meta?.supplierName ?? null,
      invoiceNumber: meta?.invoiceNumber ?? null,
      invoiceDate: meta?.invoiceDate ?? null,
    }) - 1
    const rec: PhotoGroupRec = { idx, nSup, nNum }
    photoGroups.push(rec)
    lastPhoto = rec
  }

  for (const f of files) {
    const kind = fileKind(f.fileType, f.fileName)

    if (kind === 'csv') {
      groups.push({ fileIds: [f.id], kind: 'csv', supplierName: null, invoiceNumber: null, invoiceDate: null })
      continue
    }

    const meta = f.peekMeta && !f.peekMeta.error ? f.peekMeta : null

    if (kind === 'pdf') {
      groups.push({
        fileIds: [f.id],
        kind: 'pdf',
        supplierName: meta?.supplierName ?? null,
        invoiceNumber: meta?.invoiceNumber ?? null,
        invoiceDate: meta?.invoiceDate ?? null,
      })
      continue
    }

    // Photo. An errored (or missing) peek behaves as all-null metadata.
    const errored = !f.peekMeta || f.peekMeta.error != null
    const nSup = normalizeSupplierName(meta?.supplierName ?? null)
    const nNum = normalizeInvoiceNumber(meta?.invoiceNumber ?? null)

    if (nNum !== null) {
      // Same invoice number (compatible supplier) → same invoice, adjacency not required.
      const hit = photoGroups.find(p =>
        p.nNum === nNum && (p.nSup === nSup || p.nSup === null || nSup === null)
      )
      if (hit) {
        const g = groups[hit.idx]
        g.fileIds.push(f.id)
        if (g.supplierName == null && meta?.supplierName) { g.supplierName = meta.supplierName; hit.nSup = nSup }
        if (g.invoiceDate == null && meta?.invoiceDate) g.invoiceDate = meta.invoiceDate
        lastPhoto = hit
      } else {
        newPhotoGroup(f, meta, nSup, nNum)
      }
      continue
    }

    // No invoice number — continuation heuristic: join the preceding photo
    // group when this photo's supplier matches it, or is itself unreadable.
    if (lastPhoto && (nSup === null || nSup === lastPhoto.nSup)) {
      groups[lastPhoto.idx].fileIds.push(f.id)
      continue
    }

    if (nSup !== null) {
      // Supplier read but number wasn't, and it doesn't continue the previous
      // invoice → treat as a new invoice from that supplier.
      newPhotoGroup(f, meta, nSup, null)
      continue
    }

    if (!errored) {
      // Metadata genuinely all-null (peek succeeded, invoice just unreadable)
      // and nothing precedes it → its own "unknown invoice" card.
      newPhotoGroup(f, null, null, null)
      continue
    }

    // Peek errored and there is no preceding group to join.
    unassigned.push(f.id)
  }

  return { groups, unassigned }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/__tests__/invoice-grouping.test.ts`
Expected: all PASS. Then `npm test` — full suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice-grouping.ts src/lib/__tests__/invoice-grouping.test.ts
git commit -m "feat(invoices): pure grouping lib for bulk upload (peek-metadata → proposed invoices)"
```

---

### Task 3: Shared `loadBuffer` lib

**Files:**
- Create: `src/lib/invoice-files.ts`
- Modify: `src/app/api/invoices/sessions/[id]/process/route.ts` (delete local `loadBuffer` at ~line 461, import instead)

**Interfaces:**
- Produces: `loadBuffer(file: { fileUrl: string; fileName: string }): Promise<Buffer>` (consumed by process + peek routes).

- [ ] **Step 1: Create the lib**

`src/lib/invoice-files.ts`:

```ts
// Loads an InvoiceFile's bytes whether it lives on the CDN (https URL) or in
// the DB via the local-upload fallback (data: URI).
export async function loadBuffer(file: { fileUrl: string; fileName: string }): Promise<Buffer> {
  if (file.fileUrl.startsWith('data:')) {
    const comma = file.fileUrl.indexOf(',')
    return Buffer.from(file.fileUrl.slice(comma + 1), 'base64')
  }
  const res = await fetch(file.fileUrl)
  if (!res.ok) throw new Error(`Failed to fetch ${file.fileName}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
```

- [ ] **Step 2: Point the process route at it**

In `src/app/api/invoices/sessions/[id]/process/route.ts`: add `import { loadBuffer } from '@/lib/invoice-files'` and DELETE the local `loadBuffer` function (the `// loadBuffer defined at module scope — see bottom of file` comment at ~line 129 should now read `// loadBuffer imported from src/lib/invoice-files`). Body is byte-identical to the lib version.

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit` (or build). Expected: clean.

```bash
git add src/lib/invoice-files.ts "src/app/api/invoices/sessions/[id]/process/route.ts"
git commit -m "refactor(invoices): extract loadBuffer to shared lib"
```

---

### Task 4: Peek endpoint

**Files:**
- Create: `src/app/api/invoices/sessions/[id]/peek/route.ts`

**Interfaces:**
- Consumes: `quickExtractMeta` (`src/lib/invoice-ocr.ts`), `proposeGroups`/`fileKind`/`PeekMeta`/`GroupingFile` (Task 2), `loadBuffer` (Task 3).
- Produces (consumed by the grouping modal, Task 6):
  `POST /api/invoices/sessions/[id]/peek` → `200 { sessionId: string, files: Array<{id, fileName, fileType, fileUrl}>, groups: ProposedGroup[], unassigned: string[] }` | `404` | `409` (already past grouping) | `400` (no files).

- [ ] **Step 1: Write the route**

`src/app/api/invoices/sessions/[id]/peek/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { quickExtractMeta } from '@/lib/invoice-ocr'
import { loadBuffer } from '@/lib/invoice-files'
import { proposeGroups, fileKind, type GroupingFile, type PeekMeta } from '@/lib/invoice-grouping'

export const dynamic = 'force-dynamic'
// 10 parallel Haiku calls finish in ~5s; 60s leaves room for slow CDN fetches.
export const maxDuration = 60

// POST /api/invoices/sessions/[id]/peek — quick-peek every file, cache the
// metadata on InvoiceFile.peekMeta, and return a proposed invoice grouping.
// Idempotent: files with cached peekMeta are never re-peeked.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      files: {
        select: { id: true, fileName: true, fileType: true, fileUrl: true, peekMeta: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  // UPLOADING = files still registering; PROCESSING = upload routes set this on
  // registration; GROUPING = a resumed batch. Anything later means OCR already ran.
  if (!['UPLOADING', 'PROCESSING', 'GROUPING'].includes(session.status)) {
    return NextResponse.json(
      { error: `Session is ${session.status} — grouping is only available before scanning` },
      { status: 409 },
    )
  }
  if (session.files.length === 0) {
    return NextResponse.json({ error: 'No files uploaded' }, { status: 400 })
  }

  // Peek uncached, non-CSV files in parallel. allSettled: one unreadable
  // photo must never block the batch — it lands in the unassigned bucket.
  const needPeek = session.files.filter(
    f => f.peekMeta == null && fileKind(f.fileType, f.fileName) !== 'csv',
  )
  const results = await Promise.allSettled(
    needPeek.map(async f => quickExtractMeta(await loadBuffer(f), f.fileType, f.fileName)),
  )

  const freshMeta = new Map<string, PeekMeta>()
  for (const [i, r] of results.entries()) {
    freshMeta.set(needPeek[i].id, r.status === 'fulfilled'
      ? { supplierName: r.value.supplierName, invoiceDate: r.value.invoiceDate, invoiceNumber: r.value.invoiceNumber }
      : {
          supplierName: null, invoiceDate: null, invoiceNumber: null,
          error: (r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 300),
        })
  }
  // CSVs get an empty (non-null) peekMeta so the cache marks them handled.
  for (const f of session.files) {
    if (f.peekMeta == null && fileKind(f.fileType, f.fileName) === 'csv') {
      freshMeta.set(f.id, { supplierName: null, invoiceDate: null, invoiceNumber: null })
    }
  }
  await Promise.all(
    [...freshMeta.entries()].map(([id, meta]) =>
      prisma.invoiceFile.update({ where: { id }, data: { peekMeta: meta as object } }),
    ),
  )

  const groupingFiles: GroupingFile[] = session.files.map(f => ({
    id: f.id,
    fileName: f.fileName,
    fileType: f.fileType,
    peekMeta: freshMeta.get(f.id) ?? (f.peekMeta as unknown as PeekMeta | null),
  }))
  const proposal = proposeGroups(groupingFiles)

  // >1 file → park in GROUPING (protects it from the PROCESSING sweeper and
  // renders a resumable "Needs grouping" card). Single file never enters GROUPING.
  if (session.files.length > 1 && session.status !== 'GROUPING') {
    await prisma.invoiceSession.update({ where: { id: params.id }, data: { status: 'GROUPING' } })
  }

  return NextResponse.json({
    sessionId: session.id,
    files: session.files.map(f => ({ id: f.id, fileName: f.fileName, fileType: f.fileType, fileUrl: f.fileUrl })),
    groups: proposal.groups,
    unassigned: proposal.unassigned,
  })
}
```

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit`. Expected: clean. (Build output later must show this route as `ƒ (Dynamic)` — it has a mutating handler.)

```bash
git add "src/app/api/invoices/sessions/[id]/peek/route.ts"
git commit -m "feat(invoices): peek endpoint — per-file quick meta + proposed grouping"
```

---

### Task 5: Split endpoint

**Files:**
- Create: `src/app/api/invoices/sessions/[id]/split/route.ts`

**Interfaces:**
- Produces (consumed by the grouping modal, Task 6):
  `POST /api/invoices/sessions/[id]/split` body `{ groups: Array<{ fileIds: string[], supplierName?: string|null, invoiceNumber?: string|null, invoiceDate?: string|null }> }` → `200 { sessionIds: string[] }` (group order; index 0 = original session) | `400` (bad cover) | `404` | `409` (already scanned).

- [ ] **Step 1: Write the route**

`src/app/api/invoices/sessions/[id]/split/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

interface SplitGroup {
  fileIds: string[]
  supplierName?: string | null
  invoiceNumber?: string | null
  invoiceDate?: string | null
}

// POST /api/invoices/sessions/[id]/split — commit a confirmed grouping.
// Group 1 keeps this session; each further group gets a fresh session and its
// files re-pointed (move, not copy — same pattern as the RC split). Files keep
// their createdAt, so capture order — the bbox.page invariant — survives the move.
// All resulting sessions are set to PROCESSING: the client fires /process for
// each immediately, and the sweeper (updatedAt-based) can rescue a killed run.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => null)
  const groups = body?.groups as SplitGroup[] | undefined
  if (!Array.isArray(groups) || groups.length === 0 ||
      groups.some(g => !Array.isArray(g.fileIds) || g.fileIds.length === 0)) {
    return NextResponse.json({ error: 'groups must be a non-empty array of non-empty fileId lists' }, { status: 400 })
  }

  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    select: { id: true, status: true, revenueCenterId: true, files: { select: { id: true } } },
  })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  if (!['UPLOADING', 'PROCESSING', 'GROUPING'].includes(session.status)) {
    return NextResponse.json({ error: `Session is ${session.status} — cannot re-split` }, { status: 409 })
  }

  // Every file of the session in exactly one group — no strays, no dupes, no misses.
  const sessionFileIds = new Set(session.files.map(f => f.id))
  const seen = new Set<string>()
  for (const g of groups) {
    for (const fid of g.fileIds) {
      if (!sessionFileIds.has(fid)) return NextResponse.json({ error: `Unknown file: ${fid}` }, { status: 400 })
      if (seen.has(fid)) return NextResponse.json({ error: `File in two groups: ${fid}` }, { status: 400 })
      seen.add(fid)
    }
  }
  if (seen.size !== sessionFileIds.size) {
    return NextResponse.json({ error: 'Every uploaded file must be assigned to a group' }, { status: 400 })
  }

  const [first, ...rest] = groups
  const ops: Prisma.PrismaPromise<unknown>[] = []

  ops.push(prisma.invoiceSession.update({
    where: { id: session.id },
    data: {
      status: 'PROCESSING',
      supplierName: first.supplierName ?? null,
      invoiceNumber: first.invoiceNumber ?? null,
      invoiceDate: first.invoiceDate ?? null,
      errorMessage: null,
    },
  }))

  const newIds: string[] = []
  for (const g of rest) {
    const newId = randomUUID()
    newIds.push(newId)
    ops.push(prisma.invoiceSession.create({
      data: {
        id: newId,
        status: 'PROCESSING',
        revenueCenterId: session.revenueCenterId,
        supplierName: g.supplierName ?? null,
        invoiceNumber: g.invoiceNumber ?? null,
        invoiceDate: g.invoiceDate ?? null,
      },
    }))
    ops.push(prisma.invoiceFile.updateMany({
      where: { id: { in: g.fileIds }, sessionId: session.id },
      data: { sessionId: newId },
    }))
  }

  await prisma.$transaction(ops)

  return NextResponse.json({ sessionIds: [session.id, ...newIds] })
}
```

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit`. Expected: clean.

```bash
git add "src/app/api/invoices/sessions/[id]/split/route.ts"
git commit -m "feat(invoices): split endpoint — commit a confirmed grouping into per-invoice sessions"
```

---

### Task 6: Client types + grouping modal

**Files:**
- Modify: `src/components/invoices/types.ts:1`
- Create: `src/components/invoices/InvoiceGroupingModal.tsx`

**Interfaces:**
- Consumes: peek/split endpoints (Tasks 4–5), `ProposedGroup` type imported from `@/lib/invoice-grouping` (pure module — safe in client code).
- Produces: `<InvoiceGroupingModal sessionId onClose onDone />` — `onClose()` leaves the session in GROUPING (resumable); `onDone()` fires after split + all `process` kicks.

- [ ] **Step 1: Add GROUPING to the status union**

`src/components/invoices/types.ts` line 1:

```ts
export type SessionStatus = 'UPLOADING' | 'GROUPING' | 'PROCESSING' | 'REVIEW' | 'APPROVING' | 'APPROVED' | 'REJECTED' | 'ERROR'
```

- [ ] **Step 2: Create the modal**

`src/components/invoices/InvoiceGroupingModal.tsx`:

```tsx
'use client'
import { useState, useEffect, useMemo } from 'react'
import { X, Loader2, ScanLine, FileText, FileSpreadsheet, AlertTriangle } from 'lucide-react'
import type { ProposedGroup } from '@/lib/invoice-grouping'

interface PeekFile { id: string; fileName: string; fileType: string; fileUrl: string }

interface Props {
  sessionId: string
  onClose: () => void   // keep the batch (session stays GROUPING, resumable from the list)
  onDone: () => void    // split committed + process fired for every invoice
}

function groupLabel(g: ProposedGroup, idx: number): string {
  const bits = [g.supplierName ?? 'Unknown supplier']
  if (g.invoiceNumber) bits.push(`#${g.invoiceNumber}`)
  if (g.invoiceDate) bits.push(g.invoiceDate)
  return `Invoice ${idx + 1} — ${bits.join(' · ')}`
}

// Module scope (project rule: sub-components defined inside a component body
// remount every render and lose state).
function FileThumb({ file, onClick }: { file: PeekFile; onClick: () => void }) {
  const isPdf = file.fileType === 'application/pdf' || file.fileName.toLowerCase().endsWith('.pdf')
  const isCsv = file.fileType === 'text/csv' || file.fileName.toLowerCase().endsWith('.csv')
  return (
    <button
      onClick={onClick}
      className="relative shrink-0 rounded-lg border border-line overflow-hidden hover:border-gold focus:border-gold transition-colors"
      title={`${file.fileName} — tap to move`}
    >
      {isPdf || isCsv ? (
        <span className="h-20 w-16 grid place-items-center bg-bg-2">
          {isPdf ? <FileText size={20} className="text-red" /> : <FileSpreadsheet size={20} className="text-green" />}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={file.fileUrl} alt={file.fileName} className="h-20 w-16 object-cover" />
      )}
    </button>
  )
}

export function InvoiceGroupingModal({ sessionId, onClose, onDone }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<PeekFile[]>([])
  const [groups, setGroups] = useState<ProposedGroup[]>([])
  const [unassigned, setUnassigned] = useState<string[]>([])
  const [movingId, setMovingId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(`/api/invoices/sessions/${sessionId}/peek`, { method: 'POST' })
        const j = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(j.error ?? `Couldn't read the photos (${res.status})`)
        if (!alive) return
        setFiles(j.files); setGroups(j.groups); setUnassigned(j.unassigned)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [sessionId])

  const fileById = useMemo(() => new Map(files.map(f => [f.id, f])), [files])

  // Move a file out of wherever it is, into groups[target] or a new group.
  const moveFile = (fileId: string, target: number | 'new') => {
    setUnassigned(prev => prev.filter(id => id !== fileId))
    setGroups(prev => {
      const stripped = prev
        .map(g => ({ ...g, fileIds: g.fileIds.filter(id => id !== fileId) }))
      const targetGroup = target === 'new'
        ? null
        : stripped[target] ?? null
      const next = stripped.filter(g => g.fileIds.length > 0 || g === targetGroup)
      if (targetGroup) targetGroup.fileIds.push(fileId)
      else next.push({ fileIds: [fileId], kind: 'photos', supplierName: null, invoiceNumber: null, invoiceDate: null })
      return next
    })
    setMovingId(null)
  }

  // Peek totally failed (e.g. every photo unreadable) → offer today's behavior.
  const allUnassigned = !loading && !error && groups.length === 0 && unassigned.length > 0
  const scanAsOne = () => {
    setGroups([{ fileIds: files.map(f => f.id), kind: 'photos', supplierName: null, invoiceNumber: null, invoiceDate: null }])
    setUnassigned([])
  }

  const confirm = async () => {
    setConfirming(true); setError(null)
    try {
      const res = await fetch(`/api/invoices/sessions/${sessionId}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groups: groups.map(g => ({
            fileIds: g.fileIds,
            supplierName: g.supplierName,
            invoiceNumber: g.invoiceNumber,
            invoiceDate: g.invoiceDate,
          })),
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? `Split failed (${res.status})`)
      // Fire OCR per invoice, fire-and-forget — the list's poll shows progress.
      for (const id of j.sessionIds as string[]) {
        fetch(`/api/invoices/sessions/${id}/process`, { method: 'POST' }).catch(() => {})
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setConfirming(false)
    }
  }

  const movingFromLabel = movingId
    ? groups.findIndex(g => g.fileIds.includes(movingId))
    : -1

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-2xl shadow-xl w-full max-w-2xl flex flex-col"
          style={{ maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 2rem)' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gold/15 flex items-center justify-center">
                <ScanLine size={16} className="text-gold" />
              </div>
              <div>
                <h2 className="text-base font-bold text-ink">Confirm invoices</h2>
                <p className="text-xs text-ink-4">Tap a photo to move it if something's misfiled</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-ink-4 hover:bg-bg-2" title="Keep for later">
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {loading && (
              <div className="py-12 flex flex-col items-center gap-3 text-ink-3">
                <Loader2 size={24} className="animate-spin" />
                <p className="text-sm">Reading supplier &amp; invoice numbers…</p>
              </div>
            )}

            {error && (
              <div className="bg-red-soft border border-red-soft rounded-xl p-4 text-sm text-red-text">
                <strong>Error:</strong> {error}
              </div>
            )}

            {allUnassigned && (
              <div className="bg-gold-soft border border-gold-soft rounded-xl p-4 text-sm text-gold-2 space-y-2">
                <p><strong>Couldn&apos;t read these photos.</strong> You can scan them all as one invoice instead.</p>
                <button onClick={scanAsOne} className="px-3 py-1.5 rounded-lg bg-ink text-paper text-xs font-semibold">
                  Scan as one invoice
                </button>
              </div>
            )}

            {!loading && unassigned.length > 0 && !allUnassigned && (
              <div className="border border-gold rounded-xl p-4 space-y-2 bg-gold-soft/40">
                <div className="flex items-center gap-2 text-sm font-semibold text-gold-2">
                  <AlertTriangle size={14} /> Couldn&apos;t place {unassigned.length} photo{unassigned.length > 1 ? 's' : ''} — tap to assign
                </div>
                <div className="flex gap-2 flex-wrap">
                  {unassigned.map(id => {
                    const f = fileById.get(id)
                    return f ? <FileThumb key={id} file={f} onClick={() => setMovingId(id)} /> : null
                  })}
                </div>
              </div>
            )}

            {groups.map((g, i) => (
              <div key={i} className="border border-line rounded-xl p-4 space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-ink truncate">{groupLabel(g, i)}</span>
                  <span className="text-xs text-ink-4 shrink-0">
                    {g.fileIds.length} {g.kind === 'photos' ? `photo${g.fileIds.length > 1 ? 's' : ''}` : g.kind.toUpperCase()}
                  </span>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {g.fileIds.map(id => {
                    const f = fileById.get(id)
                    return f ? (
                      <FileThumb
                        key={id}
                        file={f}
                        onClick={() => g.kind === 'photos' ? setMovingId(id) : undefined}
                      />
                    ) : null
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="px-5 py-4 border-t border-line shrink-0">
            <button
              onClick={confirm}
              disabled={loading || confirming || groups.length === 0 || unassigned.length > 0}
              className="w-full bg-ink text-paper [&_svg]:text-gold rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-ink-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {confirming ? <Loader2 size={18} className="animate-spin" /> : <ScanLine size={18} />}
              {confirming ? 'Starting scans…' : `Scan ${groups.length} invoice${groups.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>

      {/* Move picker */}
      {movingId && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={() => setMovingId(null)} />
          <div className="relative bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-xl p-4 space-y-1.5 max-h-[70dvh] overflow-y-auto">
            <p className="text-xs font-semibold text-ink-3 uppercase tracking-wide px-1 pb-1">Move photo to…</p>
            {groups.map((g, i) => (
              g.kind === 'photos' && i !== movingFromLabel ? (
                <button
                  key={i}
                  onClick={() => moveFile(movingId, i)}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-bg-2 text-sm text-ink-2"
                >
                  {groupLabel(g, i)}
                </button>
              ) : null
            ))}
            <button
              onClick={() => moveFile(movingId, 'new')}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-bg-2 text-sm font-semibold text-ink"
            >
              + New invoice
            </button>
            <button
              onClick={() => setMovingId(null)}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-bg-2 text-sm text-ink-4"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit`. Expected: clean.

```bash
git add src/components/invoices/types.ts src/components/invoices/InvoiceGroupingModal.tsx
git commit -m "feat(invoices): confirm-grouping modal + GROUPING status type"
```

---

### Task 7: Wire the flows — upload modal, page, native scan

**Files:**
- Modify: `src/components/invoices/InvoiceUploadModal.tsx` (Props ~line 10, `handleStartScan` step 3 ~line 147)
- Modify: `src/hooks/useNativeScan.ts` (Options ~line 9, step 5 ~line 119)
- Modify: `src/app/invoices/page.tsx` (state ~line 42, list callbacks lines ~233/283/290, modal block ~line 322)

**Interfaces:**
- Consumes: `InvoiceGroupingModal` (Task 6).
- Produces: `InvoiceUploadModal` gains required prop `onGrouping: (sessionId: string) => void`; `useNativeScan` options gain optional `onGrouping?: (sessionId: string) => void`.

- [ ] **Step 1: Upload modal — hand off multi-file batches**

In `InvoiceUploadModal.tsx` Props:

```ts
interface Props {
  onClose: () => void
  onComplete: (newSessionId: string) => void
  /** Called instead of onComplete when >1 file was uploaded — parent opens the grouping screen. */
  onGrouping: (sessionId: string) => void
  activeRcId: string | null
}
```

Destructure `onGrouping` in the component signature, then replace steps 3–4 of `handleStartScan` (the `fetch(...process...)` + `onComplete(sess.id)` lines):

```ts
      // 3. One file → process immediately (today's flow). Multiple files →
      //    hand off to the grouping screen; OCR starts only after confirm.
      if (compressedFiles.length > 1) {
        onGrouping(sess.id)
      } else {
        fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' }).catch(() => {})
        onComplete(sess.id)
      }
```

- [ ] **Step 2: Native scan hook — same handoff**

In `useNativeScan.ts`:

```ts
interface Options {
  activeRcId: string | null
  onComplete: () => void
  /** Called with the session id when >1 page was captured — parent opens the grouping screen. */
  onGrouping?: (sessionId: string) => void
}
```

Destructure `onGrouping` in `useNativeScan({ activeRcId, onComplete, onGrouping }: Options)`, replace step 5:

```ts
      // 5. One page → OCR immediately. Multi-page capture → grouping screen
      //    (the batch may be several invoices photographed in one go).
      if (pageFiles.length > 1 && onGrouping) {
        onGrouping(sess.id)
      } else {
        fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' }).catch(() => {})
      }

      // 6. Notify parent
      onComplete()
```

and add `onGrouping` to the `useCallback` dependency array: `[activeRcId, onComplete, onGrouping, startUpload]`.

- [ ] **Step 3: Page wiring**

In `src/app/invoices/page.tsx`:

a. Import (with the other dynamic imports, following the `InvoiceUploadModal` pattern at ~line 31):

```ts
const InvoiceGroupingModal = dynamic(
  () => import('@/components/invoices/InvoiceGroupingModal').then(m => ({ default: m.InvoiceGroupingModal })),
  { ssr: false }
)
```

b. State, next to `selectedSessionId` (~line 42):

```ts
  const [groupingSessionId, setGroupingSessionId] = useState<string | null>(null)
```

c. Open-session router — GROUPING sessions open the grouping screen, everything else the drawer. Place after `sessionsRef` is assigned (~line 133):

```ts
  // GROUPING sessions resume the confirm-grouping screen; everything else opens the drawer.
  const handleOpenSession = useCallback((id: string) => {
    const s = sessionsRef.current.find(x => x.id === id)
    if (s?.status === 'GROUPING') setGroupingSessionId(id)
    else setSelectedSessionId(id)
  }, [])
```

d. Swap the three list callbacks (lines ~233, ~283, ~290): `onSelectSession={setSelectedSessionId}` → `onSelectSession={handleOpenSession}` and `onSelect={setSelectedSessionId}` → `onSelect={handleOpenSession}`.

e. Pass the handoff to both capture paths:

```ts
  const { triggerScan, isScanning, scanError, clearError } = useNativeScan({
    activeRcId,
    onComplete: handleScanComplete,
    onGrouping: setGroupingSessionId,
  })
```

and in the upload modal block (~line 322):

```tsx
      {showUpload && (
        <InvoiceUploadModal
          activeRcId={activeRcId}
          onClose={() => setShowUpload(false)}
          onComplete={() => {
            fetchSessions()
            setShowUpload(false)
          }}
          onGrouping={(id) => {
            setShowUpload(false)
            setGroupingSessionId(id)
            fetchSessions()
          }}
        />
      )}
```

f. Render the grouping modal (next to the upload modal block):

```tsx
      {groupingSessionId && (
        <InvoiceGroupingModal
          sessionId={groupingSessionId}
          onClose={() => { setGroupingSessionId(null); fetchSessions() }}
          onDone={() => { setGroupingSessionId(null); fetchSessions() }}
        />
      )}
```

- [ ] **Step 4: Verify + commit**

Run: `npx tsc --noEmit`. Expected: clean. (The `hasTransient` fast-poll list deliberately excludes GROUPING — a batch waiting on the user must not fast-poll.)

```bash
git add src/components/invoices/InvoiceUploadModal.tsx src/hooks/useNativeScan.ts src/app/invoices/page.tsx
git commit -m "feat(invoices): route multi-file uploads and multi-page scans through grouping"
```

---

### Task 8: GROUPING in both list surfaces

**Files:**
- Modify: `src/components/invoices/InvoiceListV2.tsx` (STATUS_ORDER ~line 20, StatusBadge map ~line 41, `isInflight` ~line 287)
- Modify: `src/components/invoices/InboxViewV2.tsx` (STATUS_LABEL ~line 42, STATUS_TINT ~line 50, queue `canOpen` ~line 195)

- [ ] **Step 1: Desktop list (`InvoiceListV2.tsx`)**

STATUS_ORDER — GROUPING sorts with REVIEW (needs user action):

```ts
const STATUS_ORDER: Record<string, number> = {
  REVIEW: 0, GROUPING: 0, PROCESSING: 1, APPROVING: 1, UPLOADING: 2, APPROVED: 3, REJECTED: 4, ERROR: 5,
}
```

StatusBadge map — add:

```ts
    GROUPING:   { label: 'Needs grouping', bg: 'bg-gold-soft',  text: 'text-gold-2',    dot: 'bg-gold' },
```

Also the sort-`order` map inside the component (~line 112 shown by grep as `const order: Partial<Record<SessionStatus, number>> = { REVIEW: 0, ERROR: 1, ... }`) — add `GROUPING: 0`.

Row interaction: `isInflight` at ~line 287 already excludes GROUPING (it lists PROCESSING/APPROVING/ERROR), so GROUPING rows are clickable with no change — verify by reading the line, don't assume.

- [ ] **Step 2: Mobile inbox (`InboxViewV2.tsx`)**

```ts
const STATUS_LABEL: Partial<Record<SessionStatus, string>> = {
  REVIEW:     'Needs review',
  GROUPING:   'Needs grouping',
  PROCESSING: 'Processing',
  UPLOADING:  'Uploading',
  APPROVING:  'Applying',
  ERROR:      'Error',
}

const STATUS_TINT: Partial<Record<SessionStatus, { bg: string; text: string; dot: string }>> = {
  REVIEW:     { bg: 'bg-gold-soft',  text: 'text-gold-2',    dot: 'bg-gold' },
  GROUPING:   { bg: 'bg-gold-soft',  text: 'text-gold-2',    dot: 'bg-gold' },
  PROCESSING: { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  UPLOADING:  { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  APPROVING:  { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  ERROR:      { bg: 'bg-red-soft',   text: 'text-red-text',  dot: 'bg-red' },
}
```

Queue card open rule (~line 195):

```ts
              const canOpen  = session.status === 'REVIEW' || session.status === 'ERROR' || session.status === 'GROUPING'
```

Check how the inbox `queue` is filtered (top of the component): if it filters by an explicit status list, add `'GROUPING'` so batches don't vanish from the mobile inbox.

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit`, then `npm test` (types union changed). Expected: clean/green.

```bash
git add src/components/invoices/InvoiceListV2.tsx src/components/invoices/InboxViewV2.tsx
git commit -m "feat(invoices): GROUPING status in desktop list and mobile inbox"
```

---

### Task 9: Build + end-to-end browser verification

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run `npm run build` (isolated worktree or dev server stopped — memory rule). Expected: success; `peek` and `split` routes listed as `ƒ (Dynamic)`.

- [ ] **Step 2: Unit suite**

Run: `npm test`. Expected: all green including `invoice-grouping.test.ts`.

- [ ] **Step 3: Browser walkthrough (preview server)**

Use the Browser pane (`preview_start`, never Bash). NOTE the memory gotcha: preview serves the MAIN checkout — if implementing in a worktree, the worktree's code is not what the preview shows; merge/copy or run against the main checkout.

1. `/invoices` → Upload → pick 3+ image files that are at least two different invoices → Upload.
2. Expect the grouping screen in ~3–8s with ≥2 cards; supplier/number labels populated.
3. Tap a thumbnail → move it to another card → move it back.
4. Confirm → cards close; the list shows N sessions in `Processing`; they progress to `Review` (poll).
5. Open each session in the drawer → line items match the right invoice; page highlights (bboxes) land on the right rows.
6. Upload a batch, CLOSE the grouping screen → list shows a "Needs grouping" card → click it → screen resumes with the same proposal (instant — cached peekMeta).
7. Upload a single file → no grouping screen, drawer opens as today.
8. Screenshot proof of (2), (4), and (6) for the user.

- [ ] **Step 4: Final commit if fixes were needed, then hand off**

Follow superpowers:finishing-a-development-branch (PR against `main`).
