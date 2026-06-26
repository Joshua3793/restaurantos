# Prep Tasks (checklist) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an RC-scoped, on-demand checklist task system to the prep page — a library managed on Smart Prep whose activated tasks appear on To Do as done-checkboxes that vanish + reset on completion — without touching the cost/inventory spine.

**Architecture:** Two new Prisma models (`PrepTask` library + `PrepTaskLog` daily membership) with no price/recipe/cost linkage. New `/api/prep/tasks/*` routes. Two presentational React components rendered at the top of the Smart Prep and To Do views in `src/app/prep/page.tsx`, which owns fetch + optimistic state. An optional read-only `@`-linked `InventoryItem` reference per task.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind. No test runner — `npm run build` type-checks; UI verified via the preview server.

**Spec:** [docs/superpowers/specs/2026-06-25-prep-tasks-checklist-design.md](../specs/2026-06-25-prep-tasks-checklist-design.md)

---

## Testing note (read first)

This repo has **no unit-test framework**. The correctness gates are:
1. `npm run build` — TypeScript + Next.js build (run after every task that touches `.ts`/`.tsx`/`schema.prisma`).
2. Manual verification through the preview server for UI behavior.

So each task's "verify" step runs `npm run build` and, where relevant, a scripted manual check — these replace the usual TDD red/green steps.

> **Build deadlock gotcha:** `npm run build` can deadlock if the preview/dev server is running. Stop the dev server before building, or build in a clean shell.

## File structure

**Create:**
- `src/app/api/prep/tasks/route.ts` — `GET` (library + today) and `POST` (create task)
- `src/app/api/prep/tasks/[id]/route.ts` — `PATCH` (rename/retag/deactivate) and `DELETE` (soft-deactivate)
- `src/app/api/prep/tasks/[id]/today/route.ts` — `POST` (activate) and `DELETE` (done/remove)
- `src/app/api/prep/tasks/reorder/route.ts` — `PATCH` (write `sortOrder` by index)
- `src/components/prep/PrepTaskLibrary.tsx` — Smart Prep section (library, activate toggle, drag, `@`-picker, create/rename/delete)
- `src/components/prep/PrepTaskList.tsx` — To Do section (done-checkbox + remove ×)

**Modify:**
- `prisma/schema.prisma` — add `PrepTask`, `PrepTaskLog`, and back-relations on `RevenueCenter` + `InventoryItem`
- `src/components/prep/types.ts` — add `PrepTask`, `PrepTaskRow`, `LinkedItemSummary` types
- `src/app/prep/page.tsx` — fetch/state/handlers + render both sections in mobile & desktop blocks

---

## Task 1: Schema + migration

**Files:**
- Modify: `prisma/schema.prisma`

> **Migration gotcha:** `prisma migrate dev` is broken in this project (P3006 shadow drift) and the direct DB host is unreachable. DDL is applied over the pooler with `$executeRawUnsafe`, one statement per call, then registered with `prisma migrate resolve`.

- [ ] **Step 1: Add the two models to `prisma/schema.prisma`**

Append:

```prisma
model PrepTask {
  id                    String         @id @default(uuid())
  name                  String
  revenueCenterId       String
  linkedInventoryItemId String?
  sortOrder             Int            @default(0)
  isActive              Boolean        @default(true)
  createdAt             DateTime       @default(now())
  updatedAt             DateTime       @updatedAt
  revenueCenter         RevenueCenter  @relation("PrepTaskRC", fields: [revenueCenterId], references: [id])
  linkedInventoryItem   InventoryItem? @relation("PrepTaskInventory", fields: [linkedInventoryItemId], references: [id])
  logs                  PrepTaskLog[]

  @@index([revenueCenterId])
}

model PrepTaskLog {
  id         String   @id @default(uuid())
  prepTaskId String
  logDate    DateTime
  createdAt  DateTime @default(now())
  prepTask   PrepTask @relation(fields: [prepTaskId], references: [id], onDelete: Cascade)

  @@unique([prepTaskId, logDate])
}
```

- [ ] **Step 2: Add back-relations to the existing `RevenueCenter` and `InventoryItem` models**

In `model RevenueCenter { ... }` add a field:

```prisma
  prepTasks PrepTask[] @relation("PrepTaskRC")
```

In `model InventoryItem { ... }` add a field:

```prisma
  prepTaskRefs PrepTask[] @relation("PrepTaskInventory")
```

- [ ] **Step 3: Create the migration SQL file**

Create `prisma/migrations/20260625000000_prep_tasks/migration.sql` (use the timestamp at execution time; folder name must match what you pass to `resolve`):

```sql
CREATE TABLE "PrepTask" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "revenueCenterId" TEXT NOT NULL,
  "linkedInventoryItemId" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrepTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrepTaskLog" (
  "id" TEXT NOT NULL,
  "prepTaskId" TEXT NOT NULL,
  "logDate" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrepTaskLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PrepTask_revenueCenterId_idx" ON "PrepTask"("revenueCenterId");
CREATE UNIQUE INDEX "PrepTaskLog_prepTaskId_logDate_key" ON "PrepTaskLog"("prepTaskId", "logDate");

ALTER TABLE "PrepTask" ADD CONSTRAINT "PrepTask_revenueCenterId_fkey"
  FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrepTask" ADD CONSTRAINT "PrepTask_linkedInventoryItemId_fkey"
  FOREIGN KEY ("linkedInventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PrepTaskLog" ADD CONSTRAINT "PrepTaskLog_prepTaskId_fkey"
  FOREIGN KEY ("prepTaskId") REFERENCES "PrepTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Apply the DDL over the pooler**

Create a one-off script `scripts/apply-prep-tasks-ddl.ts`:

```ts
import { readFileSync } from 'fs'
import { prisma } from '../src/lib/prisma'

async function main() {
  const sql = readFileSync('prisma/migrations/20260625000000_prep_tasks/migration.sql', 'utf8')
  // Split on statement boundaries; pooler (transaction mode) runs one statement per call.
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
  for (const stmt of statements) {
    console.log('apply:', stmt.slice(0, 60).replace(/\s+/g, ' '), '…')
    await prisma.$executeRawUnsafe(stmt)
  }
  console.log('done')
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
```

Run: `npx tsx scripts/apply-prep-tasks-ddl.ts`
Expected: prints `apply: …` for each statement then `done`, no error. (If a `CREATE TABLE` errors with "already exists", the tables were partially created — inspect with `npx prisma studio` before retrying.)

- [ ] **Step 5: Register the migration as applied + regenerate the client**

Run:
```bash
npx prisma migrate resolve --applied 20260625000000_prep_tasks
npx prisma generate
```
Expected: `Migration ... marked as applied.` then `Generated Prisma Client`.

- [ ] **Step 6: Verify the build sees the new models**

Run: `npm run build`
Expected: build succeeds; `prisma.prepTask` and `prisma.prepTaskLog` are now typed (they'll be used in later tasks).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260625000000_prep_tasks scripts/apply-prep-tasks-ddl.ts
git commit -m "feat(prep): PrepTask + PrepTaskLog schema and migration"
```

---

## Task 2: Library API — `GET` + `POST /api/prep/tasks`

**Files:**
- Create: `src/app/api/prep/tasks/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const taskSelect = {
  id: true,
  name: true,
  revenueCenterId: true,
  linkedInventoryItemId: true,
  sortOrder: true,
  isActive: true,
  linkedInventoryItem: { select: { id: true, itemName: true } },
} as const

function dayBounds(dateStr: string | null) {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setHours(0, 0, 0, 0)
  return { start: d, end: new Date(d.getTime() + 86_400_000) }
}

export async function GET(req: NextRequest) {
  try {
    await requireSession()
    const { searchParams } = new URL(req.url)
    const rcId = searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const { start, end } = dayBounds(searchParams.get('date'))

    const library = await prisma.prepTask.findMany({
      where: { revenueCenterId: rcId, isActive: true },
      select: taskSelect,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    const today = await prisma.prepTaskLog.findMany({
      where: { prepTask: { revenueCenterId: rcId }, logDate: { gte: start, lt: end } },
      select: { id: true, prepTaskId: true, logDate: true },
    })
    return NextResponse.json({ library, today })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/prep/tasks', e)
    return NextResponse.json({ error: 'Failed to load tasks' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSession()
    const body = await req.json()
    const name = String(body.name ?? '').trim()
    const revenueCenterId = String(body.revenueCenterId ?? '')
    const linkedInventoryItemId = body.linkedInventoryItemId ? String(body.linkedInventoryItemId) : null
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId required' }, { status: 400 })

    const max = await prisma.prepTask.aggregate({
      where: { revenueCenterId },
      _max: { sortOrder: true },
    })
    const task = await prisma.prepTask.create({
      data: {
        name,
        revenueCenterId,
        linkedInventoryItemId,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
      },
      select: taskSelect,
    })
    return NextResponse.json(task, { status: 201 })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/prep/tasks', e)
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Verify build + the route is dynamic**

Run: `npm run build`
Expected: build succeeds; in the route table `/api/prep/tasks` shows `ƒ (Dynamic)`, not `○ (Static)`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/prep/tasks/route.ts
git commit -m "feat(prep): GET/POST /api/prep/tasks (library + today)"
```

---

## Task 3: Task mutation API — `PATCH`/`DELETE /api/prep/tasks/[id]` + reorder

**Files:**
- Create: `src/app/api/prep/tasks/[id]/route.ts`
- Create: `src/app/api/prep/tasks/reorder/route.ts`

> Next.js routes the static segment `reorder` before the dynamic `[id]`, so `/api/prep/tasks/reorder` does not collide with `/api/prep/tasks/:id`.

- [ ] **Step 1: Write `[id]/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const taskSelect = {
  id: true,
  name: true,
  revenueCenterId: true,
  linkedInventoryItemId: true,
  sortOrder: true,
  isActive: true,
  linkedInventoryItem: { select: { id: true, itemName: true } },
} as const

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession()
    const body = await req.json()
    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      data.name = name
    }
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive
    if ('linkedInventoryItemId' in body) {
      data.linkedInventoryItemId = body.linkedInventoryItemId ? String(body.linkedInventoryItemId) : null
    }
    const task = await prisma.prepTask.update({
      where: { id: params.id },
      data,
      select: taskSelect,
    })
    return NextResponse.json(task)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/prep/tasks/[id]', e)
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession()
    // Soft-deactivate to preserve history (never cascade history).
    await prisma.prepTask.update({ where: { id: params.id }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('DELETE /api/prep/tasks/[id]', e)
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write `reorder/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  try {
    await requireSession()
    const body = await req.json()
    const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : []
    if (!ids.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })
    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.prepTask.update({ where: { id }, data: { sortOrder: index } }),
      ),
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/prep/tasks/reorder', e)
    return NextResponse.json({ error: 'Failed to reorder tasks' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: success; both routes show `ƒ (Dynamic)`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/prep/tasks/[id]/route.ts src/app/api/prep/tasks/reorder/route.ts
git commit -m "feat(prep): task update/delete + reorder routes"
```

---

## Task 4: Today-log API — `POST`/`DELETE /api/prep/tasks/[id]/today`

**Files:**
- Create: `src/app/api/prep/tasks/[id]/today/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function dayStart(dateStr: string | null): Date {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// Activate: idempotent create of today's membership log.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession()
    const body = await req.json().catch(() => ({}))
    const logDate = dayStart(body.date ?? null)
    const log = await prisma.prepTaskLog.upsert({
      where: { prepTaskId_logDate: { prepTaskId: params.id, logDate } },
      create: { prepTaskId: params.id, logDate },
      update: {},
      select: { id: true, prepTaskId: true, logDate: true },
    })
    return NextResponse.json(log, { status: 201 })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/prep/tasks/[id]/today', e)
    return NextResponse.json({ error: 'Failed to activate task' }, { status: 500 })
  }
}

// Done / remove: clear today's membership log (vanish + reset).
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession()
    const { searchParams } = new URL(req.url)
    const logDate = dayStart(searchParams.get('date'))
    await prisma.prepTaskLog.deleteMany({ where: { prepTaskId: params.id, logDate } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('DELETE /api/prep/tasks/[id]/today', e)
    return NextResponse.json({ error: 'Failed to clear task' }, { status: 500 })
  }
}
```

> `prepTaskId_logDate` is the compound-unique accessor Prisma generates from `@@unique([prepTaskId, logDate])`. `deleteMany` is used (not `delete`) so a missing log is a no-op rather than a 404 — makes done/remove idempotent.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: success; route shows `ƒ (Dynamic)`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/prep/tasks/[id]/today/route.ts
git commit -m "feat(prep): activate / done-remove today-log route"
```

---

## Task 5: Shared types

**Files:**
- Modify: `src/components/prep/types.ts`

- [ ] **Step 1: Append the task types**

```ts
export interface LinkedItemSummary {
  id: string
  itemName: string
}

export interface PrepTask {
  id: string
  name: string
  revenueCenterId: string
  linkedInventoryItemId: string | null
  sortOrder: number
  isActive: boolean
  linkedInventoryItem: LinkedItemSummary | null
}

export interface PrepTaskTodayLog {
  id: string
  prepTaskId: string
  logDate: string
}

// A library task plus whether it is on today's list (active).
export interface PrepTaskRow extends PrepTask {
  activeToday: boolean
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: success (types are unused so far — that's fine).

- [ ] **Step 3: Commit**

```bash
git add src/components/prep/types.ts
git commit -m "feat(prep): task types"
```

---

## Task 6: `PrepTaskLibrary` component (Smart Prep section)

**Files:**
- Create: `src/components/prep/PrepTaskLibrary.tsx`

This is presentational + local-input state only. It receives the library rows, the inventory list (for the `@`-picker), and callbacks. Drag uses native HTML5 drag-and-drop (no new dependency).

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { useMemo, useRef, useState } from 'react'
import { Plus, GripVertical, Trash2, X } from 'lucide-react'
import type { PrepTaskRow, LinkedItemSummary } from './types'

interface Props {
  rows: PrepTaskRow[]
  inventory: LinkedItemSummary[]
  disabled?: boolean            // true when no specific RC is selected
  onCreate: (name: string, linkedInventoryItemId: string | null) => void
  onToggleActive: (taskId: string, next: boolean) => void
  onDelete: (taskId: string) => void
  onReorder: (orderedIds: string[]) => void
}

// Lightweight fuzzy: case-insensitive subsequence match, ranked by match tightness.
function fuzzyFilter(items: LinkedItemSummary[], q: string): LinkedItemSummary[] {
  const query = q.toLowerCase().trim()
  if (!query) return items.slice(0, 8)
  const scored: { item: LinkedItemSummary; score: number }[] = []
  for (const item of items) {
    const name = item.itemName.toLowerCase()
    let qi = 0
    let firstIdx = -1
    for (let i = 0; i < name.length && qi < query.length; i++) {
      if (name[i] === query[qi]) { if (qi === 0) firstIdx = i; qi++ }
    }
    if (qi === query.length) scored.push({ item, score: firstIdx + (name.length - query.length) })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, 8).map(s => s.item)
}

export default function PrepTaskLibrary({
  rows, inventory, disabled, onCreate, onToggleActive, onDelete, onReorder,
}: Props) {
  const [draft, setDraft] = useState('')
  const [linkedItem, setLinkedItem] = useState<LinkedItemSummary | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null) // null = picker closed
  const dragId = useRef<string | null>(null)

  const suggestions = useMemo(
    () => (mentionQuery === null ? [] : fuzzyFilter(inventory, mentionQuery)),
    [mentionQuery, inventory],
  )

  function onDraftChange(value: string) {
    setDraft(value)
    const at = value.lastIndexOf('@')
    if (at >= 0 && !linkedItem) setMentionQuery(value.slice(at + 1))
    else setMentionQuery(null)
  }

  function pickItem(item: LinkedItemSummary) {
    setLinkedItem(item)
    // strip the "@query" fragment from the draft text
    const at = draft.lastIndexOf('@')
    setDraft(at >= 0 ? draft.slice(0, at).trimEnd() : draft)
    setMentionQuery(null)
  }

  function submit() {
    const name = draft.trim()
    if (!name) return
    onCreate(name, linkedItem?.id ?? null)
    setDraft(''); setLinkedItem(null); setMentionQuery(null)
  }

  function handleDrop(targetId: string) {
    const src = dragId.current
    dragId.current = null
    if (!src || src === targetId) return
    const ids = rows.map(r => r.id)
    const from = ids.indexOf(src)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    onReorder(ids)
  }

  return (
    <section className="mb-4">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 mb-2">Tasks</h3>

      {disabled ? (
        <p className="text-[13px] text-ink-3 italic">Select a revenue center to manage tasks.</p>
      ) : (
        <>
          <ul className="space-y-1">
            {rows.map(row => (
              <li
                key={row.id}
                draggable
                onDragStart={() => { dragId.current = row.id }}
                onDragOver={e => e.preventDefault()}
                onDrop={() => handleDrop(row.id)}
                className="flex items-center gap-2 rounded-lg border border-line bg-paper px-2 py-1.5"
              >
                <GripVertical size={14} className="text-ink-4 cursor-grab shrink-0" />
                <input
                  type="checkbox"
                  checked={row.activeToday}
                  onChange={e => onToggleActive(row.id, e.target.checked)}
                  className="shrink-0"
                  aria-label={`Activate ${row.name} for today`}
                />
                <span className="text-[14px] text-ink flex-1">{row.name}</span>
                {row.linkedInventoryItem && (
                  <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gold-soft text-gold-2 whitespace-nowrap">
                    {row.linkedInventoryItem.itemName}
                  </span>
                )}
                <button onClick={() => onDelete(row.id)} aria-label={`Delete ${row.name}`}
                        className="text-ink-4 hover:text-red-text shrink-0">
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>

          <div className="relative mt-2">
            <div className="flex items-center gap-2">
              <div className="flex-1 flex items-center gap-1.5 rounded-lg border border-line bg-paper px-2 py-1.5">
                {linkedItem && (
                  <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gold-soft text-gold-2 whitespace-nowrap flex items-center gap-1">
                    {linkedItem.itemName}
                    <button onClick={() => setLinkedItem(null)} aria-label="Remove linked ingredient">
                      <X size={11} />
                    </button>
                  </span>
                )}
                <input
                  value={draft}
                  onChange={e => onDraftChange(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submit() }}
                  placeholder="New task… (type @ to link an ingredient)"
                  className="flex-1 bg-transparent text-[14px] text-ink outline-none min-w-0"
                />
              </div>
              <button onClick={submit}
                      className="flex items-center gap-1 rounded-lg bg-ink text-paper px-2.5 py-1.5 text-[13px]">
                <Plus size={14} /> Add
              </button>
            </div>

            {mentionQuery !== null && suggestions.length > 0 && (
              <ul className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-auto rounded-lg border border-line bg-paper shadow-lg">
                {suggestions.map(item => (
                  <li key={item.id}>
                    <button onClick={() => pickItem(item)}
                            className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-wash">
                      {item.itemName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}
```

> Color tokens: this project's numbered Tailwind classes (`bg-gold-500`) are broken — use flat tokens (`bg-gold-soft`, `text-gold-2`, `text-ink-3`, `border-line`, `bg-paper`, `bg-wash`). If `bg-gold-soft`/`bg-wash` don't exist in the theme, grep an existing prep component for the chip/hover classes it uses and match them.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: success. (Component is unused until Task 8; build only type-checks it.)

- [ ] **Step 3: Commit**

```bash
git add src/components/prep/PrepTaskLibrary.tsx
git commit -m "feat(prep): PrepTaskLibrary component (Smart Prep tasks)"
```

---

## Task 7: `PrepTaskList` component (To Do section)

**Files:**
- Create: `src/components/prep/PrepTaskList.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { X } from 'lucide-react'
import type { PrepTaskRow } from './types'

interface Props {
  rows: PrepTaskRow[]   // pass only activeToday rows
  onDone: (taskId: string) => void
  onRemove: (taskId: string) => void
}

export default function PrepTaskList({ rows, onDone, onRemove }: Props) {
  if (rows.length === 0) return null
  return (
    <section className="mb-4">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 mb-2">Tasks</h3>
      <ul className="space-y-1">
        {rows.map(row => (
          <li key={row.id}
              className="flex items-center gap-2 rounded-lg border border-line bg-paper px-2 py-1.5">
            <input
              type="checkbox"
              checked={false}
              onChange={() => onDone(row.id)}
              className="shrink-0"
              aria-label={`Mark ${row.name} done`}
            />
            <span className="text-[14px] text-ink flex-1">{row.name}</span>
            {row.linkedInventoryItem && (
              <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gold-soft text-gold-2 whitespace-nowrap">
                {row.linkedInventoryItem.itemName}
              </span>
            )}
            <button onClick={() => onRemove(row.id)} aria-label={`Remove ${row.name} from today`}
                    className="text-ink-4 hover:text-red-text shrink-0">
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
```

> The checkbox is always `checked={false}` — checking it fires `onDone`, which clears the log so the row disappears on the next render (vanish). There is no persisted done state to reflect.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/components/prep/PrepTaskList.tsx
git commit -m "feat(prep): PrepTaskList component (To Do tasks)"
```

---

## Task 8: Wire into the prep page (fetch, state, render in both renderers)

**Files:**
- Modify: `src/app/prep/page.tsx`

The page already imports `useRc()` (`const { activeRc, activeRcId } = useRc()`) and switches views with `viewMode` (`'today' | 'smartprep' | 'history'`) in both a mobile block (`block sm:hidden` / `flex sm:hidden`) and a desktop block (`hidden sm:block` / `hidden sm:flex`).

- [ ] **Step 1: Add imports near the other prep-component imports**

```tsx
import PrepTaskLibrary from '@/components/prep/PrepTaskLibrary'
import PrepTaskList from '@/components/prep/PrepTaskList'
import type { PrepTask, PrepTaskTodayLog, PrepTaskRow, LinkedItemSummary } from '@/components/prep/types'
```

- [ ] **Step 2: Add task state + fetch effect inside the component body (after existing `useState`s)**

```tsx
const [taskLibrary, setTaskLibrary] = useState<PrepTask[]>([])
const [taskTodayIds, setTaskTodayIds] = useState<Set<string>>(new Set())
const [inventoryForTasks, setInventoryForTasks] = useState<LinkedItemSummary[]>([])

const todayDateStr = useMemo(() => {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString()
}, [])

const loadTasks = useCallback(async () => {
  if (!activeRcId) { setTaskLibrary([]); setTaskTodayIds(new Set()); return }
  const res = await fetch(`/api/prep/tasks?rcId=${activeRcId}&date=${encodeURIComponent(todayDateStr)}`)
  if (!res.ok) return
  const data: { library: PrepTask[]; today: PrepTaskTodayLog[] } = await res.json()
  setTaskLibrary(data.library)
  setTaskTodayIds(new Set(data.today.map(t => t.prepTaskId)))
}, [activeRcId, todayDateStr])

useEffect(() => { loadTasks() }, [loadTasks])

// Inventory list for the @-picker (load once).
useEffect(() => {
  fetch('/api/inventory')
    .then(r => r.ok ? r.json() : [])
    .then((items: { id: string; itemName: string }[]) =>
      setInventoryForTasks(items.map(i => ({ id: i.id, itemName: i.itemName }))))
    .catch(() => {})
}, [])
```

> If `useCallback`/`useEffect`/`useMemo` aren't already imported on this page, add them to the existing `react` import. Confirm the `/api/inventory` GET returns a top-level array of objects with `id` + `itemName`; if it returns `{ items: [...] }`, unwrap accordingly (grep the route or an existing caller on this page).

- [ ] **Step 3: Add the derived rows + handlers**

```tsx
const taskRows: PrepTaskRow[] = useMemo(
  () => taskLibrary.map(t => ({ ...t, activeToday: taskTodayIds.has(t.id) })),
  [taskLibrary, taskTodayIds],
)
const activeTaskRows = useMemo(() => taskRows.filter(r => r.activeToday), [taskRows])
const tasksDisabled = !activeRcId

const createTask = useCallback(async (name: string, linkedInventoryItemId: string | null) => {
  if (!activeRcId) return
  const res = await fetch('/api/prep/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, revenueCenterId: activeRcId, linkedInventoryItemId }),
  })
  if (res.ok) { const t: PrepTask = await res.json(); setTaskLibrary(prev => [...prev, t]) }
}, [activeRcId])

const deleteTask = useCallback(async (taskId: string) => {
  setTaskLibrary(prev => prev.filter(t => t.id !== taskId))   // optimistic
  await fetch(`/api/prep/tasks/${taskId}`, { method: 'DELETE' })
}, [])

const reorderTasks = useCallback(async (ids: string[]) => {
  setTaskLibrary(prev => [...prev].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    .map((t, i) => ({ ...t, sortOrder: i })))   // optimistic
  await fetch('/api/prep/tasks/reorder', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  })
}, [])

const setTaskActive = useCallback(async (taskId: string, next: boolean) => {
  setTaskTodayIds(prev => { const s = new Set(prev); next ? s.add(taskId) : s.delete(taskId); return s })  // optimistic
  await fetch(`/api/prep/tasks/${taskId}/today${next ? '' : `?date=${encodeURIComponent(todayDateStr)}`}`, {
    method: next ? 'POST' : 'DELETE',
    headers: next ? { 'Content-Type': 'application/json' } : undefined,
    body: next ? JSON.stringify({ date: todayDateStr }) : undefined,
  })
}, [todayDateStr])

const clearTaskToday = useCallback((taskId: string) => setTaskActive(taskId, false), [setTaskActive])
```

> `setTaskActive(_, true)` POSTs `/today`; `setTaskActive(_, false)` DELETEs `/today?date=`. On To Do, both the done-checkbox and remove × call `clearTaskToday` — identical effect (vanish + reset), matching the spec.

- [ ] **Step 4: Render `PrepTaskLibrary` at the top of the Smart Prep view — in BOTH renderer blocks**

Find where `viewMode === 'smartprep'` content begins in the **mobile** block, and again in the **desktop** block (search for `smartprep` and the urgency buckets / Critical heading). Immediately before the first urgency bucket in each, insert:

```tsx
<PrepTaskLibrary
  rows={taskRows}
  inventory={inventoryForTasks}
  disabled={tasksDisabled}
  onCreate={createTask}
  onToggleActive={setTaskActive}
  onDelete={deleteTask}
  onReorder={reorderTasks}
/>
```

- [ ] **Step 5: Render `PrepTaskList` at the top of the To Do view — in BOTH renderer blocks**

Find where `viewMode === 'today'` content begins (the To Do list) in the **mobile** block and the **desktop** block. Immediately before the to-do item list in each, insert:

```tsx
<PrepTaskList rows={activeTaskRows} onDone={clearTaskToday} onRemove={clearTaskToday} />
```

> Per the dual-renderer pattern, both blocks are mounted simultaneously and CSS hides one — you MUST add the component to both the mobile and desktop block or it'll be missing on one form factor.

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: success, 0 type errors.

- [ ] **Step 7: Manual verification via preview**

Start the preview server (`preview_start`) and verify, with a specific RC selected (not "All"):
1. Smart Prep → "Tasks" section is first, above Critical. Type a task, press Add → row appears.
2. Type `@ched` in the new-task input → fuzzy dropdown lists matching inventory items; pick one → chip appears; Add → row shows the chip.
3. Drag a task by its grip handle to reorder → order persists after a page reload.
4. Toggle a task's checkbox on (Smart Prep) → switch to To Do → it appears in the "Tasks" section (first, above the to-do items).
5. On To Do, check the task's box → it vanishes. Switch to Smart Prep → its toggle is off (re-addable same day).
6. On To Do, use × on another active task → it vanishes too.
7. Switch RC selector to "All" → Tasks section shows "Select a revenue center to manage tasks." Switch RC to the other center → its own (empty/different) library shows, confirming per-RC isolation.

Capture a screenshot of Smart Prep with the Tasks section + a chip as proof.

- [ ] **Step 8: Commit**

```bash
git add src/app/prep/page.tsx
git commit -m "feat(prep): render task library (Smart Prep) + task list (To Do)"
```

---

## Self-review checklist (completed during planning)

- **Spec coverage:** separate models (Task 1) · RC-scoped + on-demand library (Tasks 2,8) · activate/done-vanish-reset (Tasks 4,7,8) · name+checkbox minimal (Tasks 6,7) · drag reorder (Tasks 3,6,8) · single read-only `@`-linked ingredient (Tasks 1,2,6,8) · Smart Prep placement above Critical + To Do placement above items (Task 8) · All-RCs read-only note (Tasks 6,8) · no cost/inventory leakage (structural — Task 1). All spec sections map to a task.
- **No persisted `done`:** confirmed across schema (Task 1), today route DELETE (Task 4), and `PrepTaskList` always-unchecked checkbox (Task 7).
- **Type consistency:** `taskSelect` shape (Tasks 2,3) matches the `PrepTask` type incl. `linkedInventoryItem` summary (Task 5); `today` log shape `{id,prepTaskId,logDate}` matches `PrepTaskTodayLog` (Tasks 2,5,8); handler names (`createTask`/`deleteTask`/`reorderTasks`/`setTaskActive`/`clearTaskToday`) are consistent between Task 8 definitions and the component props in Tasks 6,7.
- **Auth:** all four route files call `requireSession()` and catch `AuthError` (Tasks 2–4), per CLAUDE.md's self-guard rule.
