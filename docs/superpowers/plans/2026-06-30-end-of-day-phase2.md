# End-of-Day Phase 2 — Close Ritual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/end-of-day` into a working per-revenue-center close ritual — a checklist (with a food-safety temps gate reused from the existing Temps subsystem), a completion gate, a manager sign-off that writes an immutable compliance record + snapshot, an admin template editor at `/setup/eod-checklist`, and a handover note that surfaces on the next day's Pass.

**Architecture:** Three new Prisma models (`EodCheckItem` template · `EodClose` per-day record · `EodCheckEntry` per-item state), a shared server-side gate/progress lib (`src/lib/eod-close.ts`), two API families (`/api/eod/checklist*` template CRUD mirroring `/api/prep/tasks`, `/api/eod/close*` ritual), reuse of `/api/temps/units` + `computeDayMetrics` + `SafetyTempsSummary` for the temps gate, and a rewire of the Phase 1 EOD page placeholders. Builds on Phase 1 (PR #30) — stacks on branch `feat/end-of-day-page`.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma/PostgreSQL (Supabase, pgBouncer pooler) · Tailwind (flat tokens) · Lucide. No test suite — `npm run build` is the correctness check; visual verification via the preview server.

**Spec:** `docs/superpowers/specs/2026-06-30-end-of-day-phase2-close-ritual-design.md`.

**node/npm path (not on PATH):** `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"`

**Branch setup (do first, once):** `git checkout -b feat/end-of-day-phase2` off `feat/end-of-day-page`. Never build on `main`. Do NOT run a dev/preview server while running `npm run build` (deadlocks in this repo); another session may hold port 3000 — build tolerates it.

---

## File structure

- `prisma/schema.prisma` — 3 new models + 2 back-relations on `RevenueCenter`.
- `scripts/seed-eod-checklist.ts` — idempotent per-RC seed of the default checklist.
- `src/lib/eod-close.ts` — pure gate/progress logic + `businessDateLocal()` + snapshot builder + server `tempsReady`.
- `src/app/api/eod/checklist/route.ts` · `[id]/route.ts` · `reorder/route.ts` — template CRUD.
- `src/app/api/eod/close/route.ts` · `entry/route.ts` · `signoff/route.ts` · `reopen/route.ts` — ritual.
- `src/app/api/eod/handover/route.ts` — latest closed handover for Pass.
- `src/app/end-of-day/page.tsx` + `eod-components.tsx` — rewire checklist/gate/handover; reuse `SafetyTempsSummary`.
- `src/app/setup/eod-checklist/page.tsx` + `src/app/setup/eod-checklist/editor.tsx` — admin editor; add card to `src/app/setup/page.tsx`.
- `src/app/pass/page.tsx` — handover card.

---

### Task 1: Schema — three new models

**Files:** Modify `prisma/schema.prisma`

- [ ] **Step 1: Add the models + relations**

Append near the other feature models (e.g. after `PrepTaskLog`):

```prisma
model EodCheckItem {
  id              String         @id @default(uuid())
  revenueCenterId String
  section         String
  title           String
  meta            String?
  sortOrder       Int            @default(0)
  isBlocker       Boolean        @default(false)
  isActive        Boolean        @default(true)
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
  revenueCenter   RevenueCenter  @relation("EodCheckItemRC", fields: [revenueCenterId], references: [id])
  entries         EodCheckEntry[]

  @@index([revenueCenterId, isActive])
}

model EodClose {
  id              String          @id @default(uuid())
  revenueCenterId String
  businessDate    String          // 'YYYY-MM-DD' local day
  status          String          @default("DRAFT") // 'DRAFT' | 'CLOSED'
  handoverNote    String?
  signedOffBy     String?
  signedOffByName String?
  signedOffAt     DateTime?
  snapshot        Json?
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  revenueCenter   RevenueCenter   @relation("EodCloseRC", fields: [revenueCenterId], references: [id])
  entries         EodCheckEntry[]

  @@unique([revenueCenterId, businessDate])
  @@index([revenueCenterId, status])
}

model EodCheckEntry {
  id            String       @id @default(uuid())
  closeId       String
  itemId        String
  done          Boolean      @default(false)
  updatedByName String?
  updatedAt     DateTime     @updatedAt
  close         EodClose     @relation(fields: [closeId], references: [id], onDelete: Cascade)
  item          EodCheckItem @relation(fields: [itemId], references: [id], onDelete: Cascade)

  @@unique([closeId, itemId])
}
```

- [ ] **Step 2: Add back-relations to `RevenueCenter`**

Find `model RevenueCenter {` and, alongside its other relation fields (e.g. near `prepTasks PrepTask[]` if present), add:

```prisma
  eodCheckItems EodCheckItem[] @relation("EodCheckItemRC")
  eodCloses     EodClose[]     @relation("EodCloseRC")
```

- [ ] **Step 3: Validate the schema**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && cd /Users/joshua/dev/fergies-os && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🎉`. If it complains about a missing opposite relation, fix the relation name to match exactly on both sides (`EodCheckItemRC` / `EodCloseRC`).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(eod): schema for close ritual (EodCheckItem/EodClose/EodCheckEntry)"
```

---

### Task 2: Migration — apply via the pooler workaround

**Files:** Create `prisma/migrations/<timestamp>_eod_close_ritual/migration.sql` (via prisma diff)

**Context:** `prisma migrate dev` is broken here (P3006 shadow-DB drift) and `DATABASE_URL` is a pgBouncer transaction pooler. Use diff → db execute → resolve. `DIRECT_URL` is the direct (migration) connection.

- [ ] **Step 1: Generate the migration SQL from the committed schema vs the DB**

Run:
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os
mkdir -p prisma/migrations/20260630_eod_close_ritual
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260630_eod_close_ritual/migration.sql
```
Expected: a `migration.sql` containing only `CREATE TABLE "EodCheckItem"`, `"EodClose"`, `"EodCheckEntry"`, their indexes, and the FKs. **Read the file** — if it contains DROP/ALTER of unrelated tables, STOP and report BLOCKED (never apply a full-schema diff; the `--from-schema-datasource` should have diffed against the live DB, so only the new tables appear).

- [ ] **Step 2: Apply it to the database over the direct connection**

Run:
```bash
npx prisma db execute --file prisma/migrations/20260630_eod_close_ritual/migration.sql --schema prisma/schema.prisma
```
Expected: `Script executed successfully.` (If it errors that a table already exists, the migration was partially applied — inspect and resolve manually; report BLOCKED if unsure.)

- [ ] **Step 3: Mark the migration applied + regenerate the client**

Run:
```bash
npx prisma migrate resolve --applied 20260630_eod_close_ritual
npx prisma generate
```
Expected: resolve confirms the migration is recorded; generate emits an updated client (the new models are now on `prisma.eodCheckItem` / `prisma.eodClose` / `prisma.eodCheckEntry`).

- [ ] **Step 4: Verify the client sees the models**

Run: `npx prisma studio` is NOT needed. Instead: `node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.eodCheckItem.count().then(n=>{console.log('EodCheckItem rows:',n);process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `EodCheckItem rows: 0` (table exists, empty).

- [ ] **Step 5: Commit**

```bash
git add prisma/migrations/20260630_eod_close_ritual
git commit -m "feat(eod): migration for close-ritual tables"
```

---

### Task 3: Seed the default checklist per RC

**Files:** Create `scripts/seed-eod-checklist.ts`

- [ ] **Step 1: Write the seed script**

```ts
import { prisma } from '../src/lib/prisma'

// Default close-down checklist (checkbox/blocker only — temperature rows are
// handled by the reused Temps gate, NOT seeded here). Seeded per active RC,
// idempotently (skips an RC that already has items).
const DEFAULTS: { section: string; title: string; meta?: string; isBlocker?: boolean }[] = [
  { section: 'Food safety & close-down', title: 'Hot food blast-chilled & date-labelled', meta: 'stocks · sauces · 90 min rule' },
  { section: 'Food safety & close-down', title: 'Food-safety log signed off', meta: 'cleaning + temps · daily record', isBlocker: true },
  { section: 'Clean-down', title: 'Line & prep surfaces sanitised', meta: 'all stations · dated buckets emptied' },
  { section: 'Clean-down', title: 'Grill, fryer & flat-top cleaned', meta: 'oil filtered' },
  { section: 'Clean-down', title: 'Floors mopped · bins & recycling out', meta: 'kitchen + FOH' },
  { section: 'Clean-down', title: 'Dishwasher run, emptied & drained', meta: 'racks stacked for AM' },
  { section: 'Clean-down', title: 'Extraction, gas & equipment off', meta: 'safety-critical before lock-up', isBlocker: true },
  { section: 'Cash & POS close', title: 'Z-report run & filed', meta: 'POS end-of-day' },
  { section: 'Cash & POS close', title: 'Cash drawer counted & reconciled', meta: 'float held back' },
  { section: 'Cash & POS close', title: 'Tips pooled & recorded' },
  { section: 'Cash & POS close', title: 'Safe drop logged & sealed', meta: 'banking bag' },
  { section: 'Cash & POS close', title: 'Sales synced', meta: 'feeds cost + variance' },
  { section: 'Prep & storage for tomorrow', title: 'Proteins pulled to thaw for AM', meta: 'per tomorrow forecast' },
  { section: 'Prep & storage for tomorrow', title: 'Mise rotated FIFO · everything dated', meta: 'walk-ins + dry store' },
  { section: 'Prep & storage for tomorrow', title: '86 board updated for tomorrow' },
  { section: 'Prep & storage for tomorrow', title: 'Delivery & dry store secured', meta: 'AM drop area clear' },
  { section: 'Prep & storage for tomorrow', title: 'Alarm set & premises locked', meta: 'last one out', isBlocker: true },
]

async function main() {
  const rcs = await prisma.revenueCenter.findMany({ where: { isActive: true }, select: { id: true, name: true } })
  for (const rc of rcs) {
    const existing = await prisma.eodCheckItem.count({ where: { revenueCenterId: rc.id } })
    if (existing > 0) { console.log(`skip ${rc.name} (${existing} items)`); continue }
    await prisma.eodCheckItem.createMany({
      data: DEFAULTS.map((d, i) => ({
        revenueCenterId: rc.id,
        section: d.section,
        title: d.title,
        meta: d.meta ?? null,
        isBlocker: d.isBlocker ?? false,
        sortOrder: i,
      })),
    })
    console.log(`seeded ${DEFAULTS.length} items → ${rc.name}`)
  }
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
```

Note: confirm `RevenueCenter` has an `isActive` field (`grep -n "model RevenueCenter" -A20 prisma/schema.prisma`); if not, drop the `where: { isActive: true }` filter and seed all RCs.

- [ ] **Step 2: Run the seed**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && cd /Users/joshua/dev/fergies-os && npx tsx scripts/seed-eod-checklist.ts`
Expected: `seeded 17 items → <RC name>` for each active RC (or `skip` if already seeded). If `tsx` isn't available, use `npx ts-node --compiler-options '{"module":"commonjs"}' scripts/seed-eod-checklist.ts` (check how other scripts in `scripts/` are run first).

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-eod-checklist.ts
git commit -m "feat(eod): seed default close-down checklist per RC"
```

---

### Task 4: Shared gate/progress lib

**Files:** Create `src/lib/eod-close.ts`

- [ ] **Step 1: Confirm temp-utils is server-safe**

Run: `head -3 src/components/temps/temp-utils.ts` and `grep -n "use client" src/components/temps/temp-utils.ts`
- If there is NO `'use client'` directive, you may `import { unitStatus } from '@/components/temps/temp-utils'` server-side (it's pure). 
- If it IS a client module, replicate the tiny safety rule inline (below) instead of importing.

- [ ] **Step 2: Write the lib**

```ts
import { prisma } from '@/lib/prisma'

// Local 'YYYY-MM-DD' — matches TempReading.logDate convention.
export function businessDateLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Temp safety: a reading is in-range when within [safeMin, safeMax] (either bound
// may be null). A unit is "logged & ok today" if it has ≥1 reading today and its
// latest reading is in range. Mirrors temp-utils.unitStatus without importing a
// client module.
function readingInRange(temp: number, safeMin: number | null, safeMax: number | null): boolean {
  if (safeMin != null && temp < safeMin) return false
  if (safeMax != null && temp > safeMax) return false
  return true
}

// Returns { total, ready } for the RC's temp units on `date`. total===0 → ready.
export async function computeTempsReady(revenueCenterId: string, date: string): Promise<{ total: number; ready: boolean }> {
  const units = await prisma.tempUnit.findMany({
    where: { isActive: true, OR: [{ revenueCenterId }, { revenueCenterId: null }] },
    select: {
      id: true, safeMin: true, safeMax: true,
      readings: { where: { logDate: date }, orderBy: { time: 'asc' }, select: { temp: true } },
    },
  })
  const total = units.length
  if (total === 0) return { total: 0, ready: true }
  let logged = 0, flagged = 0
  for (const u of units) {
    if (u.readings.length === 0) continue
    logged++
    const latest = u.readings[u.readings.length - 1]
    if (!readingInRange(Number(latest.temp), u.safeMin == null ? null : Number(u.safeMin), u.safeMax == null ? null : Number(u.safeMax))) flagged++
  }
  return { total, ready: logged === total && flagged === 0 }
}

export interface EodProgress {
  done: number      // checklist items done + (tempsReady ? 1 : 0)
  total: number     // active checklist items + (hasTempUnits ? 1 : 0)
  blockers: number  // open blocker checklist items + (tempsReady ? 0 : 1 when hasTempUnits)
  ready: boolean    // all checklist items done AND tempsReady
  tempsReady: boolean
  hasTempUnits: boolean
}

export function computeProgress(
  items: { id: string; isBlocker: boolean }[],
  doneItemIds: Set<string>,
  temps: { total: number; ready: boolean },
): EodProgress {
  const checklistDone = items.filter(i => doneItemIds.has(i.id)).length
  const checklistBlockersOpen = items.filter(i => i.isBlocker && !doneItemIds.has(i.id)).length
  const hasTempUnits = temps.total > 0
  const done = checklistDone + (temps.ready ? 1 : 0)
  const total = items.length + (hasTempUnits ? 1 : 0)
  const blockers = checklistBlockersOpen + (hasTempUnits && !temps.ready ? 1 : 0)
  const ready = checklistDone === items.length && temps.ready
  return { done, total, blockers, ready, tempsReady: temps.ready, hasTempUnits }
}
```

- [ ] **Step 3: Build**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && cd /Users/joshua/dev/fergies-os && npm run build 2>&1 | tail -15`
Expected: PASS (the lib is imported nowhere yet, but must typecheck).

- [ ] **Step 4: Commit**

```bash
git add src/lib/eod-close.ts
git commit -m "feat(eod): shared close-gate/progress lib"
```

---

### Task 5: Template CRUD API

**Files:** Create `src/app/api/eod/checklist/route.ts`, `src/app/api/eod/checklist/[id]/route.ts`, `src/app/api/eod/checklist/reorder/route.ts`

Mirror `src/app/api/prep/tasks/route.ts` (auth try/catch, `force-dynamic`, MANAGER gate).

- [ ] **Step 1: `route.ts` (GET list + POST create)**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const itemSelect = {
  id: true, revenueCenterId: true, section: true, title: true,
  meta: true, sortOrder: true, isBlocker: true,
} as const

export async function GET(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const rcId = new URL(req.url).searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const items = await prisma.eodCheckItem.findMany({
      where: { revenueCenterId: rcId, isActive: true },
      select: itemSelect,
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    })
    return NextResponse.json(items, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/eod/checklist', e)
    return NextResponse.json({ error: 'Failed to load checklist' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const body = await req.json()
    const revenueCenterId = String(body.revenueCenterId ?? '')
    const section = String(body.section ?? '').trim()
    const title = String(body.title ?? '').trim()
    if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId required' }, { status: 400 })
    if (!section) return NextResponse.json({ error: 'section required' }, { status: 400 })
    if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 })
    const max = await prisma.eodCheckItem.aggregate({ where: { revenueCenterId }, _max: { sortOrder: true } })
    const item = await prisma.eodCheckItem.create({
      data: {
        revenueCenterId, section, title,
        meta: body.meta ? String(body.meta) : null,
        isBlocker: Boolean(body.isBlocker),
        sortOrder: (max._max.sortOrder ?? -1) + 1,
      },
      select: itemSelect,
    })
    return NextResponse.json(item, { status: 201 })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/eod/checklist', e)
    return NextResponse.json({ error: 'Failed to create item' }, { status: 500 })
  }
}
```

- [ ] **Step 2: `[id]/route.ts` (PATCH edit + DELETE soft-delete)**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const itemSelect = {
  id: true, revenueCenterId: true, section: true, title: true,
  meta: true, sortOrder: true, isBlocker: true,
} as const

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('MANAGER')
    const body = await req.json()
    const data: Record<string, unknown> = {}
    if (body.section !== undefined) data.section = String(body.section).trim()
    if (body.title !== undefined) data.title = String(body.title).trim()
    if (body.meta !== undefined) data.meta = body.meta ? String(body.meta) : null
    if (body.isBlocker !== undefined) data.isBlocker = Boolean(body.isBlocker)
    const item = await prisma.eodCheckItem.update({ where: { id: params.id }, data, select: itemSelect })
    return NextResponse.json(item)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/eod/checklist/[id]', e)
    return NextResponse.json({ error: 'Failed to update item' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('MANAGER')
    await prisma.eodCheckItem.update({ where: { id: params.id }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('DELETE /api/eod/checklist/[id]', e)
    return NextResponse.json({ error: 'Failed to delete item' }, { status: 500 })
  }
}
```

- [ ] **Step 3: `reorder/route.ts` (PATCH)**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const body = await req.json()
    const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : []
    if (!ids.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })
    await prisma.$transaction(ids.map((id, i) => prisma.eodCheckItem.update({ where: { id }, data: { sortOrder: i } })))
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/eod/checklist/reorder', e)
    return NextResponse.json({ error: 'Failed to reorder' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Build + commit**

Run the build (`npm run build`, expect PASS, three new `ƒ (Dynamic)` routes). Then:
```bash
git add src/app/api/eod/checklist
git commit -m "feat(eod): checklist template CRUD API"
```

---

### Task 6: Close ritual API

**Files:** Create `src/app/api/eod/close/route.ts`, `close/entry/route.ts`, `close/signoff/route.ts`, `close/reopen/route.ts`

Shared helper — a `getOrCreateDraft(rcId, date)` used by GET/entry/handover; define it inline in `close/route.ts` and import, OR duplicate the 3-line upsert. Simplest: use `prisma.eodClose.upsert` in each route.

- [ ] **Step 1: `close/route.ts` (GET state + PATCH handover)**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal, computeTempsReady, computeProgress } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const rcId = new URL(req.url).searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const date = businessDateLocal()

    const [items, close] = await Promise.all([
      prisma.eodCheckItem.findMany({
        where: { revenueCenterId: rcId, isActive: true },
        select: { id: true, section: true, title: true, meta: true, sortOrder: true, isBlocker: true },
        orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
      }),
      prisma.eodClose.upsert({
        where: { revenueCenterId_businessDate: { revenueCenterId: rcId, businessDate: date } },
        create: { revenueCenterId: rcId, businessDate: date },
        update: {},
        select: {
          id: true, status: true, handoverNote: true, signedOffByName: true, signedOffAt: true, snapshot: true,
          entries: { select: { itemId: true, done: true } },
        },
      }),
    ])

    const doneIds = new Set(close.entries.filter(e => e.done).map(e => e.itemId))
    const temps = await computeTempsReady(rcId, date)
    const progress = computeProgress(items.map(i => ({ id: i.id, isBlocker: i.isBlocker })), doneIds, temps)

    return NextResponse.json({
      date,
      items,                          // flat, section-ordered; client groups by `section`
      doneItemIds: [...doneIds],
      close: {
        id: close.id, status: close.status, handoverNote: close.handoverNote,
        signedOffByName: close.signedOffByName, signedOffAt: close.signedOffAt, snapshot: close.snapshot,
      },
      progress,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/eod/close', e)
    return NextResponse.json({ error: 'Failed to load close' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const body = await req.json()
    const rcId = String(body.rcId ?? '')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const date = businessDateLocal()
    await prisma.eodClose.upsert({
      where: { revenueCenterId_businessDate: { revenueCenterId: rcId, businessDate: date } },
      create: { revenueCenterId: rcId, businessDate: date, handoverNote: String(body.handoverNote ?? '') },
      update: { handoverNote: String(body.handoverNote ?? '') },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/eod/close', e)
    return NextResponse.json({ error: 'Failed to save handover' }, { status: 500 })
  }
}
```

- [ ] **Step 2: `close/entry/route.ts` (PATCH toggle an item)**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal, computeTempsReady, computeProgress } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const body = await req.json()
    const rcId = String(body.rcId ?? '')
    const itemId = String(body.itemId ?? '')
    const done = Boolean(body.done)
    if (!rcId || !itemId) return NextResponse.json({ error: 'rcId and itemId required' }, { status: 400 })
    const date = businessDateLocal()

    const close = await prisma.eodClose.upsert({
      where: { revenueCenterId_businessDate: { revenueCenterId: rcId, businessDate: date } },
      create: { revenueCenterId: rcId, businessDate: date },
      update: {},
      select: { id: true },
    })
    await prisma.eodCheckEntry.upsert({
      where: { closeId_itemId: { closeId: close.id, itemId } },
      create: { closeId: close.id, itemId, done, updatedByName: user.name ?? user.email ?? null },
      update: { done, updatedByName: user.name ?? user.email ?? null },
    })

    const [items, entries, temps] = await Promise.all([
      prisma.eodCheckItem.findMany({ where: { revenueCenterId: rcId, isActive: true }, select: { id: true, isBlocker: true } }),
      prisma.eodCheckEntry.findMany({ where: { closeId: close.id, done: true }, select: { itemId: true } }),
      computeTempsReady(rcId, date),
    ])
    const doneIds = new Set(entries.map(e => e.itemId))
    return NextResponse.json({ progress: computeProgress(items, doneIds, temps), doneItemIds: [...doneIds] })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/eod/close/entry', e)
    return NextResponse.json({ error: 'Failed to update entry' }, { status: 500 })
  }
}
```

Note: confirm `requireSession` returns an object with `name`/`email` (`grep -n "return" src/lib/auth.ts | head` and inspect the session shape used elsewhere, e.g. how routes read `user.email`). Adjust `user.name ?? user.email` to the real fields.

- [ ] **Step 3: `close/signoff/route.ts` (POST — validate ready, snapshot, close)**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal, computeTempsReady, computeProgress } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const rcId = String((await req.json()).rcId ?? '')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const date = businessDateLocal()

    const close = await prisma.eodClose.upsert({
      where: { revenueCenterId_businessDate: { revenueCenterId: rcId, businessDate: date } },
      create: { revenueCenterId: rcId, businessDate: date },
      update: {},
      select: { id: true },
    })
    const [items, entries, temps] = await Promise.all([
      prisma.eodCheckItem.findMany({ where: { revenueCenterId: rcId, isActive: true }, select: { id: true, isBlocker: true } }),
      prisma.eodCheckEntry.findMany({ where: { closeId: close.id, done: true }, select: { itemId: true } }),
      computeTempsReady(rcId, date),
    ])
    const doneIds = new Set(entries.map(e => e.itemId))
    const progress = computeProgress(items, doneIds, temps)
    if (!progress.ready) return NextResponse.json({ error: 'Not ready to close', progress }, { status: 409 })

    // Snapshot: headline numbers for this RC/today (dayStart..dayEnd UTC-bracketed like reports/dashboard).
    const dayStart = new Date(`${date}T00:00:00.000Z`)
    const dayEnd = new Date(`${date}T23:59:59.999Z`)
    const [sales, purchases] = await Promise.all([
      prisma.salesEntry.findMany({ where: { date: { gte: dayStart, lte: dayEnd }, revenueCenterId: rcId }, select: { totalRevenue: true, foodSalesPct: true, covers: true } }),
      prisma.invoiceScanItem.aggregate({
        where: { approved: true, splitToSessionId: null, session: { approvedAt: { gte: dayStart, lte: dayEnd }, revenueCenterId: rcId } },
        _sum: { rawLineTotal: true },
      }),
    ])
    const netSales = sales.reduce((s, e) => s + Number(e.totalRevenue), 0)
    const foodSales = sales.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
    const covers = sales.reduce((s, e) => s + (e.covers ?? 0), 0)
    const foodCostDollars = Number(purchases._sum.rawLineTotal ?? 0)
    const snapshot = {
      netSales, covers, foodCostDollars,
      foodCostPct: foodSales > 0 ? (foodCostDollars / foodSales) * 100 : null,
      checklist: { done: progress.done, total: progress.total },
      tempsReady: progress.tempsReady,
      signedOffByName: user.name ?? user.email ?? null,
      signedOffAt: new Date().toISOString(),
    }

    const updated = await prisma.eodClose.update({
      where: { id: close.id },
      data: { status: 'CLOSED', signedOffBy: user.id ?? null, signedOffByName: user.name ?? user.email ?? null, signedOffAt: new Date(), snapshot },
      select: { id: true, status: true, signedOffByName: true, signedOffAt: true, snapshot: true },
    })
    return NextResponse.json({ close: updated, progress })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/eod/close/signoff', e)
    return NextResponse.json({ error: 'Failed to sign off' }, { status: 500 })
  }
}
```

Note: confirm the session `user` exposes `id` (`grep -n "id" src/lib/auth.ts`); if not, drop `signedOffBy` or use email.

- [ ] **Step 4: `close/reopen/route.ts` (POST — clear sign-off)**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const rcId = String((await req.json()).rcId ?? '')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const date = businessDateLocal()
    await prisma.eodClose.updateMany({
      where: { revenueCenterId: rcId, businessDate: date },
      data: { status: 'DRAFT', signedOffBy: null, signedOffByName: null, signedOffAt: null, snapshot: undefined },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/eod/close/reopen', e)
    return NextResponse.json({ error: 'Failed to reopen' }, { status: 500 })
  }
}
```

Note: `snapshot: undefined` leaves the column unchanged; to actually clear it use Prisma's `{ set: null }` is not valid for Json — use `snapshot: Prisma.DbNull`. Import `{ Prisma }` from `@prisma/client` and set `snapshot: Prisma.DbNull`. Apply that correction.

- [ ] **Step 5: Build + commit**

Build (expect PASS, four new dynamic routes). Then:
```bash
git add src/app/api/eod/close
git commit -m "feat(eod): close ritual API (state, entry, signoff, reopen)"
```

---

### Task 7: Handover API

**Files:** Create `src/app/api/eod/handover/route.ts`

- [ ] **Step 1: Write it**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

// Latest CLOSED close BEFORE today for the RC, with a non-empty handover note.
export async function GET(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const rcId = new URL(req.url).searchParams.get('rcId')
    if (!rcId) return NextResponse.json(null)
    const today = businessDateLocal()
    const close = await prisma.eodClose.findFirst({
      where: { revenueCenterId: rcId, status: 'CLOSED', businessDate: { lt: today }, NOT: { handoverNote: null } },
      orderBy: { businessDate: 'desc' },
      select: { handoverNote: true, signedOffByName: true, businessDate: true },
    })
    if (!close || !close.handoverNote?.trim()) return NextResponse.json(null)
    return NextResponse.json(close, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/eod/handover', e)
    return NextResponse.json(null)
  }
}
```

(`businessDate` is a `'YYYY-MM-DD'` string, so lexical `< today` equals chronological `< today` — correct.)

- [ ] **Step 2: Build + commit**

Build (PASS). Then:
```bash
git add src/app/api/eod/handover
git commit -m "feat(eod): handover read API for Pass"
```

---

### Task 8: Rewire the End-of-day page — checklist, temps gate, sign-off, handover

**Files:** Modify `src/app/end-of-day/page.tsx` and `src/app/end-of-day/eod-components.tsx`

This replaces the Phase 1 placeholder `CloseRail` gate/handover and adds a live close-down section. Read the current files first. Read `docs/design-refs/end-of-day.design.html` (checklist rows, gate ring SVG at `id="ringFill"`) and `docs/design-refs/end-of-day.behavior.js` (judging/gate logic) for markup + behavior to transcribe, and reuse `SafetyTempsSummary` exactly as `src/app/preshift/page.tsx:297` does.

- [ ] **Step 1: Add a close-state hook + types to `page.tsx`**

Add interfaces and a second fetch (keyed on active RC), alongside the existing Phase 1 summary fetch:

```ts
export interface EodCheckItemDTO { id: string; section: string; title: string; meta: string | null; sortOrder: number; isBlocker: boolean }
export interface EodProgressDTO { done: number; total: number; blockers: number; ready: boolean; tempsReady: boolean; hasTempUnits: boolean }
export interface EodCloseState {
  date: string
  items: EodCheckItemDTO[]
  doneItemIds: string[]
  close: { id: string; status: 'DRAFT' | 'CLOSED'; handoverNote: string | null; signedOffByName: string | null; signedOffAt: string | null; snapshot: unknown }
  progress: EodProgressDTO
}
```

In the component, when a **specific RC** is active (`activeKind === 'rc'` && `activeRcId`), fetch `/api/eod/close?rcId=${activeRcId}` into `closeState`, and fetch `/api/temps/units?rcId=${activeRcId}&date=${today}` into `tempUnits` for the `SafetyTempsSummary` display (mirror `preshift/page.tsx` lines ~136-142 + 203-206 for `computeDayMetrics`/`tempsReady`). When no specific RC is active, skip these and render the RC picker (Step 4).

- [ ] **Step 2: Wire item toggle + handover + sign-off handlers**

- Toggle: `PATCH /api/eod/close/entry` `{rcId, itemId, done: !currentlyDone}`; on response, set `doneItemIds` + `progress` from the payload.
- Handover: debounced (e.g. 600ms) `PATCH /api/eod/close` `{rcId, handoverNote}`.
- Sign-off: `POST /api/eod/close/signoff` `{rcId}`; on 200 → `router.push('/pass')`; on 409 → keep the page, surface "Not ready".
- Reopen: `POST /api/eod/close/reopen` `{rcId}` → refetch close state.

- [ ] **Step 3: Replace the placeholder blocks in `eod-components.tsx`**

- **Close-down section** (new, in the main column under Day-in-review): render `items` grouped by `section`; each row is a checkbox (filled when `doneItemIds.includes(id)`), title, `meta`, blocker rows accent `bg-red` per the design. Above/within the food-safety section, render `<SafetyTempsSummary logged total flagged blocking onLogTemps={() => router.push('/temps')} />` from `@/components/preshift/SafetyTempsSummary`, fed by `computeDayMetrics(tempUnits)`.
- **`CloseRail` gate** (replace the Phase 1 static ring): a progress ring driven by `progress.done/total` (transcribe the SVG from the design ref — circle `r=44`, `stroke-dasharray=2π·44`, `stroke-dashoffset` scaled by pct; color: `#dc2626` if blockers, `#d97706` if not-ready-no-blockers, `#16a34a` if ready). Title/sub from state: not-ready-with-blockers / almost-closed / ready / (if `status==='CLOSED'`) "Day closed · {signedOffByName} · {HH:MM from signedOffAt}". Button: "Close the day" enabled only when `ready` (calls sign-off); when `CLOSED`, show a "Reopen" button instead.
- **Handover textarea** (replace the disabled Phase 1 placeholder): controlled, seeded from `close.handoverNote`, `onChange` → debounced save.

Keep all sub-components at module scope. Use flat tokens only.

- [ ] **Step 4: No-RC state**

When `activeKind !== 'rc'`, render (in place of the close-down + gate) a card: "Close is per revenue center — pick one to close:" with a button per RC from `useRc()`'s available RCs that calls the context's RC-setter (inspect how other pages switch the active RC — likely a `setActiveRc`/scope setter in `RevenueCenterContext`). If the context can't set RC programmatically, link to the RC switcher UI instead.

- [ ] **Step 5: Build + verify + commit**

Build (PASS). Then start the preview server and verify on `/end-of-day` with a specific RC active: checklist renders grouped, ticking updates the ring, temps row shows and deep-links, sign-off blocks until ready then redirects, reopen works, handover persists (reload keeps it). (See Task 10 for the full verification pass.) Commit:
```bash
git add src/app/end-of-day
git commit -m "feat(eod): wire live checklist, temps gate, sign-off, handover on End-of-day"
```

---

### Task 9: Admin editor + Setup card

**Files:** Create `src/app/setup/eod-checklist/page.tsx` + `src/app/setup/eod-checklist/editor.tsx`; modify `src/app/setup/page.tsx`

- [ ] **Step 1: Add the Setup card**

In `src/app/setup/page.tsx`, add to the `cards` array (import a suitable Lucide icon, e.g. `ClipboardCheck`):

```tsx
  { href: '/setup/eod-checklist', label: 'End-of-day checklist', icon: ClipboardCheck, description: 'Close-down checklist items per revenue center.', built: true },
```

- [ ] **Step 2: Build the editor page**

Create `src/app/setup/eod-checklist/page.tsx` (`'use client'`): RC tabs (from `useRc()` available RCs, or `/api/revenue-centers` — inspect how `/setup/revenue-centers` lists them). On RC select, fetch `GET /api/eod/checklist?rcId=`, group by `section`. Provide: add item (section select/free-text + title + meta + blocker checkbox → `POST`), inline edit (→ `PATCH /api/eod/checklist/[id]`), soft-delete (→ `DELETE`), and reorder within the list (up/down buttons → `PATCH /api/eod/checklist/reorder` with the new `ids` order). Put the row/list rendering in `editor.tsx` (module-scope components). Follow the visual patterns of an existing Setup sub-page (e.g. `src/app/setup/revenue-centers/page.tsx`) for card/form styling and flat tokens.

- [ ] **Step 3: Build + verify + commit**

Build (PASS). Preview: `/setup/eod-checklist` lists seeded items per RC; add/edit/reorder/delete round-trip and reflect on `/end-of-day` after refetch. Commit:
```bash
git add src/app/setup/eod-checklist src/app/setup/page.tsx
git commit -m "feat(eod): admin checklist editor at /setup/eod-checklist"
```

---

### Task 10: Pass handover card + full verification

**Files:** Modify `src/app/pass/page.tsx`; verification only otherwise

- [ ] **Step 1: Add the handover card to Pass**

In `src/app/pass/page.tsx`, fetch `GET /api/eod/handover?rcId=${activeRcId}` (when a specific RC is active) and, when non-null, render a small card in the existing card grid: heading "Handover from last close", the note, and a mono sub-line "{signedOffByName} · {businessDate}". Hidden when null. Match the page's existing card styling + flat tokens; define the card component at module scope.

- [ ] **Step 2: Build**

Run `npm run build` — expect PASS across all routes.

- [ ] **Step 3: End-to-end preview verification**

Start the preview server. With a specific RC active on `/end-of-day`:
- Checklist renders grouped by section; blocker rows accented.
- Temps row shows `logged/total`; "Log temps →" navigates to `/temps`.
- Ticking items updates the gate ring % and enables "Close the day" only when all items done AND temps ready.
- "Close the day" while not ready → stays (409); when ready → writes CLOSED, shows signed-off state, redirects to `/pass`.
- On `/pass`, the "Handover from last close" card appears (after a close with a handover note on a prior day — to test same-day, temporarily verify the endpoint returns the row via `preview_eval` fetch, since the card filters to `businessDate < today`).
- Reopen returns the day to DRAFT.
- `/setup/eod-checklist` edits reflect on `/end-of-day` after reload.
- `preview_console_logs` clean; `preview_network` shows the eod endpoints 200.
- Screenshot desktop + mobile.

- [ ] **Step 4: Commit**

```bash
git add src/app/pass/page.tsx
git commit -m "feat(eod): surface last-close handover on Pass"
```

---

## Self-review notes

- **Spec coverage:** data model (T1) · migration (T2) · seed (T3) · gate lib incl. server tempsReady (T4) · template CRUD (T5) · close/entry/signoff/reopen (T6) · handover read (T7) · page rewire incl. temps gate, gate ring, sign-off, reopen, handover, no-RC picker (T8) · admin editor + Setup card (T9) · Pass handover card + verification (T10). All spec sections mapped.
- **Known verify-then-adapt points (flagged in-task):** exact session fields on `requireSession` (`user.name`/`email`/`id`) in T6; `RevenueCenter.isActive` in T3; `temp-utils` client-directive in T4; `Prisma.DbNull` for clearing the Json snapshot in T6/reopen; how the RC context exposes available RCs + programmatic switch in T8/T9.
- **Type consistency:** `EodProgress` (lib, T4) ↔ `EodProgressDTO` (page, T8) share fields `{done,total,blockers,ready,tempsReady,hasTempUnits}`. `computeProgress` / `computeTempsReady` / `businessDateLocal` names match across T4/T6. `itemSelect` shape consistent across T5/T6.
- **Dynamic routes:** every new route exports `dynamic = 'force-dynamic'` (checked in build output per task).

## Out of scope (later phases)
Distinct PM close-temp requirement · prep-for-tomorrow queue · order drafting · 86-board writes · forecast · comps/discounts sync · labour · print/email report.
