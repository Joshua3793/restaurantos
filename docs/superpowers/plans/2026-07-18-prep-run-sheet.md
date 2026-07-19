# Prep To-Do → Run Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/prep` "Today" board with a time-ordered run sheet (start-by = service − hands-on − unattended), plus Kitchen/My-Station modes, a cook roster, live in-progress timers, and a batch-scaling recipe drawer/sheet.

**Architecture:** Additive Prisma schema (Recipe prep-times, PrepItem service + overrides, new `Service` and `Cook` models, `PrepLog` start/finish timestamps). A pure `prep-runsheet.ts` lib holds all time/scaling math (vitest-covered). The prep items API computes effective times + start-by + assigned cook. A new `src/components/prep/runsheet/` component tree renders desktop + mobile surfaces and retires the old `board/` tree and `RecipeViewModal`.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind (flat tokens) · Lucide icons · vitest.

**Design spec:** [docs/superpowers/specs/2026-07-18-prep-run-sheet-redesign-design.md](../specs/2026-07-18-prep-run-sheet-redesign-design.md)
**Prototype reference (Claude Design project `f8ab4c5f-…`, `prep-todo/`):** `shared.jsx` (tokens/helpers/`PTRecipe`/`PTLogBody`), `desktop.jsx` (`PTDesktop`), `mobile.jsx` (`PTMobile`), `data.js` (shapes). Port pixel-faithfully; substitute tokens/icons per Global Constraints.

## Global Constraints

- **Colors:** use the app's **flat Tailwind tokens** (`bg-red`, `text-red-text`, `bg-gold`, `text-ink`, `border-line` …). Numbered classes (`bg-red-500`) are BROKEN in this repo (memory `project_tailwind_color_tokens`). Prototype hex → token intent map is in spec §8.
- **Icons:** Lucide only — `book-open, layers, plus, minus, check, zap, lock, alert-triangle, x, arrow-left, flame, timer, undo-2, users, chef-hat, chevron-down`.
- **Client components:** all interactive files start with `'use client'`. Define every sub-component at **module scope** — never inside another component's body (remount/focus-loss bug, CLAUDE.md).
- **Dual-renderer split at the `md:` breakpoint** (`block md:hidden` / `hidden md:block`), consistent with the other redesigned pages.
- **Route handlers** that mutate or must run live: `export const dynamic = 'force-dynamic'`. Polled GETs return `no-store`.
- **Prisma singleton:** import `prisma` from `src/lib/prisma.ts`. Never `new PrismaClient()`.
- **Prisma Decimal** fields serialize as **strings** in JSON — wrap with `Number()` before arithmetic.
- **Migrations:** the shadow-DB `migrate dev` is broken here (memory `project_prisma_migrate_shadow_broken`); use the diff/db-execute/resolve workaround over the pooler, and **never** `$executeRaw` tagged-templates for `text[]` writes (use `$executeRawUnsafe`). All new columns are nullable/defaulted.
- **Auth:** API writes guarded with `requireSession(minRole)` from `src/lib/auth.ts`; catch `AuthError` → `NextResponse.json({ error }, { status })`. Setup CRUD = ADMIN.
- **Business date/clock:** Pacific local (consistent with EOD), not UTC.
- **No `backdrop-blur` on a fixed inset-0 scrim** (freeze bug, memory `project_backdrop_blur_freeze`).
- **Verify each task:** `npm run build` (type-check) green; `npm test` green after any `src/lib` change; UI tasks additionally verified in the browser preview.

---

# Phase 1 — Data, domain lib, API, Setup

### Task 1: Schema — prep-time, service, cook, timestamp columns

**Files:**
- Modify: `prisma/schema.prisma` (models `Recipe`, `PrepItem`, `PrepLog`, `RevenueCenter`; add `Service`, `Cook`)
- Create (migration SQL): `prisma/migrations/<ts>_prep_run_sheet/migration.sql`

**Interfaces:**
- Produces (Prisma client types consumed by every later task): `Recipe.activeMinutes/passiveMinutes/passiveNote: number|null`; `PrepItem.targetServiceId/activeMinutesOverride/passiveMinutesOverride/passiveNoteOverride`; `PrepItem.targetService: Service|null`; `Service{id,revenueCenterId,name,timeMinutes,sortOrder,isActive}`; `Cook{id,name,initials,homeStation,isActive,sortOrder}`; `PrepLog.startedAt/completedAt: Date|null`.

- [ ] **Step 1: Edit `Recipe`** — add inside the model:
```prisma
  activeMinutes   Int?
  passiveMinutes  Int?
  passiveNote     String?
```

- [ ] **Step 2: Edit `PrepItem`** — add:
```prisma
  targetServiceId        String?
  activeMinutesOverride  Int?
  passiveMinutesOverride Int?
  passiveNoteOverride    String?
  targetService          Service? @relation("PrepItemService", fields: [targetServiceId], references: [id])
```

- [ ] **Step 3: Edit `PrepLog`** — add:
```prisma
  startedAt   DateTime?
  completedAt DateTime?
```

- [ ] **Step 4: Add `Service` + `Cook` models and the `RevenueCenter` back-relation** — append the models and add `services Service[] @relation("ServiceRC")` to `RevenueCenter`:
```prisma
model Service {
  id              String        @id @default(cuid())
  revenueCenterId String
  name            String
  timeMinutes     Int
  sortOrder       Int           @default(0)
  isActive        Boolean       @default(true)
  revenueCenter   RevenueCenter @relation("ServiceRC", fields: [revenueCenterId], references: [id])
  prepItems       PrepItem[]    @relation("PrepItemService")
  @@index([revenueCenterId])
}

model Cook {
  id          String  @id @default(cuid())
  name        String
  initials    String
  homeStation String?
  isActive    Boolean @default(true)
  sortOrder   Int     @default(0)
}
```

- [ ] **Step 5: Author the migration SQL** (pooler-safe; do NOT run `migrate dev`). Create `prisma/migrations/<timestamp>_prep_run_sheet/migration.sql`:
```sql
ALTER TABLE "Recipe" ADD COLUMN "activeMinutes" INTEGER, ADD COLUMN "passiveMinutes" INTEGER, ADD COLUMN "passiveNote" TEXT;
ALTER TABLE "PrepItem" ADD COLUMN "targetServiceId" TEXT, ADD COLUMN "activeMinutesOverride" INTEGER, ADD COLUMN "passiveMinutesOverride" INTEGER, ADD COLUMN "passiveNoteOverride" TEXT;
ALTER TABLE "PrepLog" ADD COLUMN "startedAt" TIMESTAMP(3), ADD COLUMN "completedAt" TIMESTAMP(3);
CREATE TABLE "Service" ("id" TEXT NOT NULL, "revenueCenterId" TEXT NOT NULL, "name" TEXT NOT NULL, "timeMinutes" INTEGER NOT NULL, "sortOrder" INTEGER NOT NULL DEFAULT 0, "isActive" BOOLEAN NOT NULL DEFAULT true, CONSTRAINT "Service_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Service_revenueCenterId_idx" ON "Service"("revenueCenterId");
CREATE TABLE "Cook" ("id" TEXT NOT NULL, "name" TEXT NOT NULL, "initials" TEXT NOT NULL, "homeStation" TEXT, "isActive" BOOLEAN NOT NULL DEFAULT true, "sortOrder" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "Cook_pkey" PRIMARY KEY ("id"));
ALTER TABLE "Service" ADD CONSTRAINT "Service_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrepItem" ADD CONSTRAINT "PrepItem_targetServiceId_fkey" FOREIGN KEY ("targetServiceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 6: Apply migration over the pooler + mark resolved + regenerate**
Run:
```bash
npx prisma db execute --file prisma/migrations/<timestamp>_prep_run_sheet/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied <timestamp>_prep_run_sheet
npx prisma generate
```
Expected: `db execute` succeeds, `generate` regenerates the client with the new fields.

- [ ] **Step 7: Verify type-check**
Run: `npm run build`
Expected: build compiles (new columns available on the Prisma client; no consumers yet).

- [ ] **Step 8: Commit**
```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(prep): schema for run-sheet (recipe times, service, cook, log stamps)"
```

---

### Task 2: `prep-runsheet.ts` domain lib (pure math, TDD)

**Files:**
- Create: `src/lib/prep-runsheet.ts`
- Test: `src/lib/__tests__/prep-runsheet.test.ts`

**Interfaces:**
- Produces (consumed by API Task 3 + every UI task):
  - `type RunItemTimes = { activeMinutesOverride: number|null; passiveMinutesOverride: number|null; passiveNoteOverride: string|null; linkedRecipe: { activeMinutes: number|null; passiveMinutes: number|null; passiveNote: string|null } | null }`
  - `resolveActive(i: RunItemTimes): number|null`, `resolvePassive(i): number|null`, `resolvePassiveNote(i): string|null`
  - `startByMinutes(serviceTimeMinutes: number|null, activeMin: number|null, passiveMin: number|null): number|null`
  - `type RunState = 'blocked'|'overdue'|'soon'|'later'`; `runState(a: { startBy: number|null; blockedReason: string|null }, nowMin: number): RunState`
  - `minutesBetween(fromMs: number, toMs: number): number`
  - `fmtClock(min: number): string`, `fmtDuration(min: number): string`
  - `stepFor(unit: string): number`, `scaleRound(value: number, unit: string): number`, `scaleQtyLabel(qty: number, scale: number, unit: string): string`

- [ ] **Step 1: Write the failing test** — `src/lib/__tests__/prep-runsheet.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import {
  resolveActive, resolvePassive, resolvePassiveNote, startByMinutes,
  runState, minutesBetween, fmtClock, fmtDuration, stepFor, scaleRound, scaleQtyLabel,
} from '../prep-runsheet'

const rec = (a: number|null, p: number|null, n: string|null) => ({ activeMinutes: a, passiveMinutes: p, passiveNote: n })

describe('effective times: override wins, else recipe, else null', () => {
  it('uses recipe when no override', () => {
    const i = { activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null, linkedRecipe: rec(45, 30, 'cool') }
    expect(resolveActive(i)).toBe(45)
    expect(resolvePassive(i)).toBe(30)
    expect(resolvePassiveNote(i)).toBe('cool')
  })
  it('override wins over recipe', () => {
    const i = { activeMinutesOverride: 20, passiveMinutesOverride: 0, passiveNoteOverride: 'oven', linkedRecipe: rec(45, 30, 'cool') }
    expect(resolveActive(i)).toBe(20)
    expect(resolvePassive(i)).toBe(0)
    expect(resolvePassiveNote(i)).toBe('oven')
  })
  it('null when neither', () => {
    const i = { activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null, linkedRecipe: null }
    expect(resolveActive(i)).toBeNull()
    expect(resolvePassive(i)).toBeNull()
  })
})

describe('startByMinutes', () => {
  it('service − active − passive', () => {
    expect(startByMinutes(690, 45, 30)).toBe(615) // 11:30 − 75m = 10:15
  })
  it('treats null active/passive as 0', () => {
    expect(startByMinutes(690, null, null)).toBe(690)
  })
  it('null service → null', () => {
    expect(startByMinutes(null, 45, 30)).toBeNull()
  })
})

describe('runState', () => {
  it('blocked wins regardless of time', () => {
    expect(runState({ startBy: 100, blockedReason: 'anchovies short' }, 90)).toBe('blocked')
  })
  it('overdue when startBy already passed', () => {
    expect(runState({ startBy: 500, blockedReason: null }, 510)).toBe('overdue')
  })
  it('soon within 60m', () => {
    expect(runState({ startBy: 540, blockedReason: null }, 510)).toBe('soon')
  })
  it('later beyond 60m', () => {
    expect(runState({ startBy: 700, blockedReason: null }, 510)).toBe('later')
  })
  it('null startBy → later', () => {
    expect(runState({ startBy: null, blockedReason: null }, 510)).toBe('later')
  })
})

describe('formatting', () => {
  it('fmtClock pads', () => { expect(fmtClock(615)).toBe('10:15'); expect(fmtClock(90)).toBe('01:30') })
  it('fmtDuration', () => { expect(fmtDuration(45)).toBe('45m'); expect(fmtDuration(80)).toBe('1h20'); expect(fmtDuration(120)).toBe('2h') })
  it('minutesBetween floors to minutes', () => { expect(minutesBetween(0, 90_000)).toBe(1) })
})

describe('batch scaling', () => {
  it('stepFor by unit', () => { expect(stepFor('kg')).toBe(0.5); expect(stepFor('ea')).toBe(5); expect(stepFor('g')).toBe(50) })
  it('scaleRound kg ≥10 → nearest 0.5', () => { expect(scaleRound(12.3, 'kg')).toBe(12.5) })
  it('scaleRound kg <10 → nearest 0.01', () => { expect(scaleRound(1.234, 'kg')).toBe(1.23) })
  it('scaleRound ea → integer', () => { expect(scaleRound(49.6, 'ea')).toBe(50) })
  it('scaleRound g ≥100 → nearest 5', () => { expect(scaleRound(123, 'g')).toBe(125) })
  it('scaleRound g <100 → integer', () => { expect(scaleRound(61.4, 'g')).toBe(61) })
  it('scaleQtyLabel trims trailing zero for kg', () => { expect(scaleQtyLabel(1.2, 2, 'kg')).toBe('2.4 kg') })
  it('scaleQtyLabel integer units', () => { expect(scaleQtyLabel(60, 2, 'g')).toBe('120 g') })
})
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npm test -- prep-runsheet`
Expected: FAIL — cannot resolve `../prep-runsheet`.

- [ ] **Step 3: Write the implementation** — `src/lib/prep-runsheet.ts`:
```ts
// Pure time + batch-scaling math for the prep run sheet.
export type RunItemTimes = {
  activeMinutesOverride: number | null
  passiveMinutesOverride: number | null
  passiveNoteOverride: string | null
  linkedRecipe: { activeMinutes: number | null; passiveMinutes: number | null; passiveNote: string | null } | null
}

export function resolveActive(i: RunItemTimes): number | null {
  return i.activeMinutesOverride ?? i.linkedRecipe?.activeMinutes ?? null
}
export function resolvePassive(i: RunItemTimes): number | null {
  return i.passiveMinutesOverride ?? i.linkedRecipe?.passiveMinutes ?? null
}
export function resolvePassiveNote(i: RunItemTimes): string | null {
  return i.passiveNoteOverride ?? i.linkedRecipe?.passiveNote ?? null
}

export function startByMinutes(serviceTimeMinutes: number | null, activeMin: number | null, passiveMin: number | null): number | null {
  if (serviceTimeMinutes == null) return null
  return serviceTimeMinutes - (activeMin ?? 0) - (passiveMin ?? 0)
}

export type RunState = 'blocked' | 'overdue' | 'soon' | 'later'
export function runState(a: { startBy: number | null; blockedReason: string | null }, nowMin: number): RunState {
  if (a.blockedReason) return 'blocked'
  if (a.startBy == null) return 'later'
  if (a.startBy < nowMin) return 'overdue'
  if (a.startBy - nowMin <= 60) return 'soon'
  return 'later'
}

export const minutesBetween = (fromMs: number, toMs: number): number => Math.max(0, Math.floor((toMs - fromMs) / 60000))

export const fmtClock = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}`

export function fmtDuration(min: number): string {
  min = Math.max(0, Math.round(min))
  const h = Math.floor(min / 60), r = min % 60
  return h ? (r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`) : `${min}m`
}

export const stepFor = (unit: string): number =>
  unit === 'kg' || unit === 'L' ? 0.5 : unit === 'ea' || unit === 'loaves' ? 5 : 50

export function scaleRound(v: number, unit: string): number {
  if (unit === 'kg' || unit === 'L') return v >= 10 ? Math.round(v * 2) / 2 : Math.round(v * 100) / 100
  if (unit === 'ea' || unit === 'loaves') return Math.round(v)
  return v >= 100 ? Math.round(v / 5) * 5 : Math.round(v)
}

export function scaleQtyLabel(qty: number, scale: number, unit: string): string {
  const v = scaleRound(qty * scale, unit)
  const s = (unit === 'kg' || unit === 'L')
    ? (v % 1 === 0 ? String(v) : v.toFixed(v < 10 ? 2 : 1).replace(/0$/, ''))
    : String(v)
  return `${s} ${unit}`
}
```

- [ ] **Step 4: Run tests to verify they pass**
Run: `npm test -- prep-runsheet`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**
```bash
git add src/lib/prep-runsheet.ts src/lib/__tests__/prep-runsheet.test.ts
git commit -m "feat(prep): prep-runsheet time + batch-scaling lib (tested)"
```

---

### Task 3: Extend `GET /api/prep/items` with run-sheet fields

**Files:**
- Modify: `src/app/api/prep/items/route.ts` (GET handler + select)
- Modify: `src/components/prep/types.ts` (`PrepItemRich` additions)

**Interfaces:**
- Consumes: `resolveActive/resolvePassive/resolvePassiveNote/startByMinutes` (Task 2), Prisma fields (Task 1).
- Produces (consumed by all UI): each item response gains `activeMinutes:number|null`, `passiveMinutes:number|null`, `passiveNote:string|null`, `service:{id,name,timeMinutes}|null`, `startByMinutes:number|null`, `assignedCook:{id,initials,name,homeStation}|null`. `todayLog` gains `startedAt:string|null`, `completedAt:string|null`.

- [ ] **Step 1: Extend the Prisma select** in the GET handler to include the new `PrepItem` fields, `linkedRecipe.{activeMinutes,passiveMinutes,passiveNote,baseYieldQty,yieldUnit}`, and `targetService.{id,name,timeMinutes}`. Load active cooks once: `const cooks = await prisma.cook.findMany({ where: { isActive: true } })` and index by id.

- [ ] **Step 2: Compute per-item fields** in the existing map, using the lib:
```ts
import { resolveActive, resolvePassive, resolvePassiveNote, startByMinutes } from '@/lib/prep-runsheet'
// inside the map, alongside priority/suggestedQty:
const times = {
  activeMinutesOverride: item.activeMinutesOverride,
  passiveMinutesOverride: item.passiveMinutesOverride,
  passiveNoteOverride: item.passiveNoteOverride,
  linkedRecipe: item.linkedRecipe
    ? { activeMinutes: item.linkedRecipe.activeMinutes, passiveMinutes: item.linkedRecipe.passiveMinutes, passiveNote: item.linkedRecipe.passiveNote }
    : null,
}
const activeMinutes = resolveActive(times)
const passiveMinutes = resolvePassive(times)
const passiveNote = resolvePassiveNote(times)
const service = item.targetService ? { id: item.targetService.id, name: item.targetService.name, timeMinutes: item.targetService.timeMinutes } : null
const startByMin = startByMinutes(service?.timeMinutes ?? null, activeMinutes, passiveMinutes)
const cook = item.logs[0]?.assignedTo ? cookById.get(item.logs[0].assignedTo) : null
const assignedCook = cook ? { id: cook.id, initials: cook.initials, name: cook.name, homeStation: cook.homeStation } : null
```
Add `activeMinutes, passiveMinutes, passiveNote, service, startByMinutes: startByMin, assignedCook` to the returned object, and surface `startedAt`/`completedAt` on the `todayLog` mapping.

- [ ] **Step 3: Update `PrepItemRich` + `PrepLogData`** in `src/components/prep/types.ts` with the new optional fields (mirror Step 2 exactly).

- [ ] **Step 4: Verify**
Run: `npm run build`
Expected: green. Then in the browser preview (Task 13 not built yet) hit `/api/prep/items` via `read_network_requests` after loading `/prep`, or `curl` in the running dev server, and confirm items carry `startByMinutes`/`service`/`assignedCook`.

- [ ] **Step 5: Commit**
```bash
git add src/app/api/prep/items/route.ts src/components/prep/types.ts
git commit -m "feat(prep): items API returns effective times, start-by, service, cook"
```

---

### Task 4: Start/finish/reopen timestamps in the log routes

**Files:**
- Modify: `src/app/api/prep/logs/route.ts` (upsert POST)
- Modify: `src/app/api/prep/logs/[id]/route.ts` (PATCH)

**Interfaces:**
- Produces: transitioning a log to `IN_PROGRESS` stamps `startedAt` (once); to `DONE` stamps `completedAt` + keeps `actualPrepQty`; reopening (`IN_PROGRESS` with explicit `completedAt:null`) clears `completedAt`.

- [ ] **Step 1: In the PATCH handler**, after resolving the incoming `status`, derive timestamp writes:
```ts
const now = new Date()
const stamp: Record<string, unknown> = {}
if (status === 'IN_PROGRESS') { stamp.startedAt = existing.startedAt ?? now; if (body.completedAt === null) stamp.completedAt = null }
if (status === 'DONE') stamp.completedAt = now
// merge stamp into the prisma update data
```
(`existing` = the current log row; fetch it if the handler doesn't already.)

- [ ] **Step 2: Mirror in the POST upsert** — when creating/updating a log with `status IN_PROGRESS`/`DONE`, set `startedAt`/`completedAt` the same way.

- [ ] **Step 3: Verify** `npm run build` green. Manually PATCH a log via the dev server: start → `startedAt` set; done → `completedAt` set; re-start with `completedAt:null` → cleared.

- [ ] **Step 4: Commit**
```bash
git add src/app/api/prep/logs
git commit -m "feat(prep): stamp startedAt/completedAt on log transitions"
```

---

### Task 5: `Service` CRUD API (per-RC)

**Files:**
- Create: `src/app/api/services/route.ts` (GET list by RC, POST create)
- Create: `src/app/api/services/[id]/route.ts` (PATCH, DELETE)

**Interfaces:**
- Produces: `GET /api/services?revenueCenterId=<id>` → `Service[]` ordered by `sortOrder, timeMinutes`. `POST {revenueCenterId,name,timeMinutes,sortOrder?}`. `PATCH {name?,timeMinutes?,sortOrder?,isActive?}`. `DELETE` (sets prep items' `targetServiceId` null via FK `ON DELETE SET NULL`).

- [ ] **Step 1: Write `route.ts`** with `export const dynamic = 'force-dynamic'`, `requireSession()` on GET and `requireSession('ADMIN')` on POST, `AuthError` handling, and a `revenueCenterId` query filter (400 if missing on GET). Validate `timeMinutes` is an integer 0–1439 and `name` non-empty.

- [ ] **Step 2: Write `[id]/route.ts`** — PATCH (`ADMIN`, partial update, same validation), DELETE (`ADMIN`).

- [ ] **Step 3: Verify** `npm run build` shows both routes as `ƒ (Dynamic)`. POST a service, GET it back ordered.

- [ ] **Step 4: Commit**
```bash
git add src/app/api/services
git commit -m "feat(services): per-RC service CRUD API"
```

---

### Task 6: `Cook` roster CRUD API

**Files:**
- Create: `src/app/api/prep/cooks/route.ts` (GET list, POST create)
- Create: `src/app/api/prep/cooks/[id]/route.ts` (PATCH, DELETE)

**Interfaces:**
- Produces: `GET /api/prep/cooks` → active cooks ordered by `sortOrder, name`. `POST {name,initials,homeStation?,sortOrder?}`. `PATCH {name?,initials?,homeStation?,isActive?,sortOrder?}`. `DELETE` (hard delete; existing `PrepLog.assignedTo` referencing it simply stops resolving → shows unassigned).

- [ ] **Step 1: Write `route.ts`** — `force-dynamic`, `requireSession()` GET / `requireSession('ADMIN')` POST, `AuthError` handling. Normalize `initials` to uppercase, ≤3 chars; require non-empty `name`.

- [ ] **Step 2: Write `[id]/route.ts`** — PATCH + DELETE (`ADMIN`).

- [ ] **Step 3: Verify** `npm run build` (both `ƒ`). Create a cook, list it.

- [ ] **Step 4: Commit**
```bash
git add src/app/api/prep/cooks
git commit -m "feat(prep): kitchen cook roster CRUD API"
```

---

### Task 7: Setup → Services sub-page

**Files:**
- Create: `src/app/setup/services/page.tsx`
- Modify: `src/app/setup/page.tsx` (add the "Services" card/link) and `src/app/setup/setup-nav` source if a nav list exists (grep `setup` nav; follow the existing sub-page pattern e.g. `src/app/setup/storage-areas/page.tsx`).

**Interfaces:**
- Consumes: `/api/services`, RC list (existing `/api/revenue-centers` or the app's RC source — grep for how `/setup/revenue-centers` loads RCs and reuse).

- [ ] **Step 1: Build the page** following an existing Setup sub-page (`/setup/storage-areas` is the closest CRUD template): an RC selector at top, then a list of that RC's services with name + a time input (accept `HH:MM`, convert to `timeMinutes` via `fmtClock`/parse), reorder via `sortOrder`, add/edit/delete, active toggle. `'use client'`, module-scope rows, flat tokens.

- [ ] **Step 2: Add the Setup hub entry** (title "Services", subtitle "When each service is ready — drives the prep run sheet").

- [ ] **Step 3: Verify** in browser: create Lunch 11:30 / Dinner 17:00 for an RC; edit; delete; reorder. `npm run build` green.

- [ ] **Step 4: Commit**
```bash
git add src/app/setup/services src/app/setup/page.tsx
git commit -m "feat(setup): per-RC Services management page"
```

---

### Task 8: Setup → Kitchen crew sub-page

**Files:**
- Create: `src/app/setup/kitchen-crew/page.tsx`
- Modify: `src/app/setup/page.tsx` (add the card)

**Interfaces:**
- Consumes: `/api/prep/cooks`, `PrepSettings.stations` (via `/api/prep/settings`) for the home-station dropdown.

- [ ] **Step 1: Build the page** — list of cooks (name, initials, home-station select sourced from prep settings stations), add/edit/delete, active toggle, reorder. Same CRUD template as Task 7.

- [ ] **Step 2: Add the Setup hub entry** ("Kitchen crew", "Cooks & stations for the prep run sheet").

- [ ] **Step 3: Verify** in browser: add cooks (Mia/Sauces, Leo/Bakery …). `npm run build` green.

- [ ] **Step 4: Commit**
```bash
git add src/app/setup/kitchen-crew src/app/setup/page.tsx
git commit -m "feat(setup): kitchen crew (cook roster) management page"
```

---

### Task 9: Backfill + seed script

**Files:**
- Create: `scripts/seed-run-sheet.ts`

**Interfaces:**
- Produces: idempotent one-shot: (a) for each `PrepItem` with `estimatedPrepTime != null` and no linked-recipe `activeMinutes` and `activeMinutesOverride == null`, set `activeMinutesOverride = estimatedPrepTime`; (b) for each active RC with zero services, create Lunch (690) + Dinner (1020).

- [ ] **Step 1: Write the script** using the `prisma` singleton, wrapped in guards so re-running is safe (check counts before insert/update). Log a summary of rows touched.

- [ ] **Step 2: Run it** against the dev DB:
```bash
npx tsx scripts/seed-run-sheet.ts
```
Expected: prints counts; re-running prints zero changes.

- [ ] **Step 3: Commit**
```bash
git add scripts/seed-run-sheet.ts
git commit -m "chore(prep): backfill prep times + seed default services"
```

---

# Phase 2 — Desktop run sheet

> **REVISED (2026-07-18, "build on your drawer"):** The run sheet reuses the **existing fused item drawer** (`PrepDrawer` mobile / `PrepBoardDrawer` desktop + `PrepRecipeSection`) that commit `102fd12` built — it does NOT introduce a new recipe/yield surface. "Open recipe" from any run-sheet row calls the page's existing `openDrawer(item)`. Completion stays on the existing paths: the drawer's `onDrawerComplete(item, qty)` (DONE/PARTIAL by `qty ≥ suggestedQty`) and the quick-yield `PrepDoneSheet` via `setDoneSheetItem(item)`. Tasks **16 (RecipeSheet) and 17 (LogYield) are DROPPED**; Task 18 becomes a wiring/cleanup task. `RecipeViewModal` stays (it is now the sub-recipe peek). The prototype's "Start this batch writes `targetToday`" write-back is dropped — the drawer's `makeQty` slider owns batch scaling at completion time.
>
> **Reusable page handlers to wire against** (`src/app/prep/page.tsx`, confirmed via code map): `openDrawer(item)`, `closeDrawer()`, `onRowStatusChange(item, status, qty?)` → PUT `/api/prep/logs/:id` (creates the log first if missing; IN_PROGRESS now stamps `startedAt`, DONE stamps `completedAt` via Task 4), `handleToggleOnList(id, next)`, `handlePriorityChange(id, priority)`, `setDoneSheetItem(item)` (quick-yield sheet), `onDrawerComplete(item, qty)`. The board's row-handler contract is `{ onOpen, onOpenRecipe, onStatusChange, onQuickDone, onToggleOnList, onPriorityChange }` — the run sheet calls the same shapes. **New handler to add:** `handleClaim(item, cookId|null)` — ensure a log exists then PUT `{ assignedTo }`.

### Task 10: Run-sheet atoms, group heads, NOW line, assignee chip

**Files:**
- Create: `src/components/prep/runsheet/atoms.tsx` (`StationTag`, `NeedChip`, `RunwayBar`, `Segmented`, `StatOut` STOCK-OUT badge, `BlockedBadge`)
- Create: `src/components/prep/runsheet/GroupHead.tsx`, `src/components/prep/runsheet/NowLine.tsx`
- Create: `src/components/prep/runsheet/assignee.tsx` (`AssigneeChip` + `ClaimPopover`)

**Interfaces:**
- Consumes: `fmtClock`, `fmtDuration` (Task 2); cook list; `PrepItemRich`.
- Produces:
  - `StationTag({children})`, `NeedChip({service})`, `RunwayBar({activeMin, passiveMin, passiveNote})`, `Segmented<T>({value, options:{id,label,badge?,badgeTone?}[], onPick})`.
  - `GroupHead({dot, title, count, sub?})`, `NowLine({nowMin})`.
  - `AssigneeChip({cook: Cook|null, size?, onClick?})`, `ClaimPopover({cooks, currentId, onPick, onClose})`.

- [ ] **Step 1: Port `atoms.tsx`** from prototype `shared.jsx` (`PTTag`, `PTNeed`, `PTDur`, `PTSegmented`) — same spacing/sizes, flat tokens instead of hex, mono font via the existing font utility (grep how other components apply Geist Mono; use that class rather than inline `fontFamily`). `NeedChip` renders `→ LUNCH 11:30` from a `service` object. `RunwayBar` renders the solid(active)+striped(passive) bar + `"45m hands-on + 30m cool"` text; hides the bar when both are null.

- [ ] **Step 2: Port `GroupHead.tsx` + `NowLine.tsx`** from `DGroupHead`/`PTNowLine` (the pulsing red dot uses the existing `ptpulse`-equivalent; add the keyframe to the page/module CSS or reuse an existing pulse utility — grep for an existing pulse animation before adding one).

- [ ] **Step 3: Port `assignee.tsx`** from `PTAv` + the desktop claim popover in `DRow`: dark chip with gold dot + initials when claimed, dashed "+ CLAIM" when open; popover lists cooks (initials + first name + station) with an UNASSIGN row.

- [ ] **Step 4: Verify** `npm run build` green (components not yet mounted; this is a type/compile check).

- [ ] **Step 5: Commit**
```bash
git add src/components/prep/runsheet/atoms.tsx src/components/prep/runsheet/GroupHead.tsx src/components/prep/runsheet/NowLine.tsx src/components/prep/runsheet/assignee.tsx
git commit -m "feat(prep): run-sheet shared atoms, group heads, NOW line, assignee"
```

---

### Task 11: `RunRow` (desktop ladder row)

**Files:**
- Create: `src/components/prep/runsheet/RunRow.tsx`

**Interfaces:**
- Consumes: atoms (Task 10), `runState`, `fmtClock`, `fmtDuration` (Task 2), `PrepItemRich`.
- Produces: `RunRow({ item, nowMin, dense, cooks, onStart, onOpenRecipe, onClaim })` — one grid row `64px 1fr auto auto`: start-by time + late/in, name (underlined → `onOpenRecipe`) + qty + `StationTag` + STOCK-OUT/BLOCKED badges + `RunwayBar` + `NeedChip`, `AssigneeChip` (+ claim), and the action cluster (book button → `onOpenRecipe`; Start → `onStart`; blocked → disabled "Waiting").

- [ ] **Step 1: Port `DRow`** from `desktop.jsx` faithfully. Left accent border color from `runState` (blocked→gold, overdue→red, soon→ink, later→line). Use `item.startByMinutes`, `item.priority === '911'` for STOCK OUT, `item.todayLog?.blockedReason` for BLOCKED. Density from a prop (default comfortable; compact only affects padding + hides the runway/need meta line).

- [ ] **Step 2: Verify** `npm run build` green.

- [ ] **Step 3: Commit**
```bash
git add src/components/prep/runsheet/RunRow.tsx
git commit -m "feat(prep): desktop run-sheet row"
```

---

### Task 12: `InProgressRail` + `CrewStrip` (desktop)

**Files:**
- Create: `src/components/prep/runsheet/InProgressRail.tsx`
- Create: `src/components/prep/runsheet/CrewStrip.tsx`

**Interfaces:**
- Consumes: `minutesBetween`, `fmtDuration`, `resolveActive/resolvePassive` outputs already on the item (`activeMinutes`,`passiveMinutes`), `runState`.
- Produces:
  - `InProgressRail({ items, nowMs, cooks, onLog, onOpenRecipe })` — horizontal cards; elapsed = `minutesBetween(startedAt, nowMs)`, remaining = `activeMinutes + passiveMinutes − elapsed` (or "over by").
  - `CrewStrip({ cooks, items, nowMin })` — 4-up per-cook cards: current doing task + elapsed, queued count + hands-on load + late count.

- [ ] **Step 1: Port `DRailCard`→`InProgressRail`** and `DCrew`→`CrewStrip` from `desktop.jsx`. Elapsed uses the real `todayLog.startedAt` timestamp (parse to ms) rather than the prototype's minute integer.

- [ ] **Step 2: Verify** `npm run build` green.

- [ ] **Step 3: Commit**
```bash
git add src/components/prep/runsheet/InProgressRail.tsx src/components/prep/runsheet/CrewStrip.tsx
git commit -m "feat(prep): desktop in-progress rail + crew strip"
```

---

### Task 13: `RunSheet` desktop frame + wire into `/prep`

**Files:**
- Create: `src/components/prep/runsheet/RunSheet.tsx`
- Create: `src/components/prep/runsheet/useNowMinute.ts` (a `useNowMs()`/`useNowMinute()` hook ticking every 30s on Pacific-local time)
- Modify: `src/app/prep/page.tsx` (render `<RunSheet>` for the desktop Today surface; load cooks; keep Smart Prep + history)

**Interfaces:**
- Consumes: Tasks 10–12 components, `startByMinutes`/`runState` groupings, `/api/prep/cooks`.
- Produces: `RunSheet({ items, cooks, nowMin, nowMs, onStart, onLog, onClaim, onOpenRecipe })` owning local UI state: `mode` (kitchen|station, default kitchen), `cook`, `group` (time|station|priority, default time), `stFilter`, and rendering: title + status band (done/in-progress/late/blocked, clock + next service), Kitchen/My-Station `Segmented`, crew strip / cook picker, station filter, `InProgressRail`, grouped ladder (`renderLadder` from `DPTDesktop`), collapsible Done (reopen via `onLog`-sibling `onReopen`).

- [ ] **Step 1: Write `useNowMinute.ts`** — `useState` + `setInterval(30_000)`; expose `nowMs` (Date.now) and `nowMin` (minutes past Pacific-local midnight). Use the app's existing Pacific-local helper (grep EOD business-date util) rather than reinventing TZ math.

- [ ] **Step 2: Port `PTDesktop`→`RunSheet`** faithfully (status band, modes, filters, `renderLadder` time/station/priority sections, NOW line, Done). Replace prototype `api`/`tweaks`/`clock` with props: mutations via `onStart(id)`, `onClaim(id, cookId)`, `onLog(item)`, `onReopen(id)`, `onOpenRecipe(item)`; `dense`/`bold` fixed to comfortable/subtle; grouping is a real `Segmented`/pill control.

- [ ] **Step 3: Wire `/prep` desktop** — in `page.tsx`, render `<RunSheet …>` as the desktop **Today** surface (the `viewMode === 'today'` board render on the `hidden md:block` desktop path — study how `PrepBoard` is currently mounted and gated by `viewMode`; the run sheet replaces the *today* list only, NOT Smart Prep, which keeps its `PrepBoard`/intake rendering). Add a `cooks` load (`GET /api/prep/cooks`) alongside the existing loads (store in state; refetch is not critical — cooks change rarely). Wire the run sheet's callbacks to the **existing** page handlers (do NOT invent new endpoints except claim):
  - `onOpenRecipe(item)` and the row/book "open" → `openDrawer(item)` (opens the existing fused drawer).
  - `onStart(item)` → `onRowStatusChange(item, 'IN_PROGRESS')` (stamps `startedAt`).
  - `onReopen(item)` → `onRowStatusChange(item, 'IN_PROGRESS')`.
  - `onLog(item)` (rail/Done quick-finish) → `setDoneSheetItem(item)` (the existing `PrepDoneSheet` quick-yield prompt).
  - `onClaim(item, cookId)` → **new** `handleClaim(item, cookId)`: reuse the log-ensure logic from `handleStatusChange` (POST `/api/prep/logs {prepItemId, revenueCenterId}` if no `todayLog`), then PUT `/api/prep/logs/:id { assignedTo: cookId }`; optimistically update local `items` so the chip reflects immediately.
  The fused drawers (`PrepDrawer`/`PrepBoardDrawer`), `PrepDoneSheet`, `RecipeViewModal` (sub-recipe peek), Smart Prep, and history stay mounted exactly as they are.

- [ ] **Step 4: Verify in browser** (preview_start the dev server; `/prep` desktop, resize ≥ md):
  - Rows are ordered by start-by; NOW line sits between overdue and upcoming.
  - Kitchen↔My-Station toggles scope; station filter works; group-by time/station/priority re-sections.
  - Start a task → it moves to the in-progress rail and the elapsed timer advances after 30s.
  - Claim assigns a cook. Done section reopen round-trips.
  - `read_console_messages` clean; `npm run build` green.

- [ ] **Step 5: Commit**
```bash
git add src/components/prep/runsheet/RunSheet.tsx src/components/prep/runsheet/useNowMinute.ts src/app/prep/page.tsx
git commit -m "feat(prep): desktop run sheet wired into /prep"
```

---

# Phase 3 — Mobile run sheet

### Task 14: Mobile row, rail card, hero

**Files:**
- Create: `src/components/prep/runsheet/RunRowMobile.tsx`
- Create: `src/components/prep/runsheet/InProgressRailMobile.tsx`
- Create: `src/components/prep/runsheet/NextUpHero.tsx`

**Interfaces:**
- Produces: `RunRowMobile({item,nowMin,dense,kitchen,cook,onClaim,onOpenRecipe,onStart})`; `InProgressRailMobile({items,nowMs,onLog,onOpenRecipe})`; `NextUpHero({item,nowMin,onStart,onOpenRecipe})`.

- [ ] **Step 1: Port `MRow`, `MRailCard`, `MHero`** from `mobile.jsx`. Hero "Recipe · scale batch" button → `onOpenRecipe`; blocked state shows the BLOCKED notice; Start → `onStart`.

- [ ] **Step 2: Verify** `npm run build` green.

- [ ] **Step 3: Commit**
```bash
git add src/components/prep/runsheet/RunRowMobile.tsx src/components/prep/runsheet/InProgressRailMobile.tsx src/components/prep/runsheet/NextUpHero.tsx
git commit -m "feat(prep): mobile run-sheet row, rail, next-up hero"
```

---

### Task 15: `RunSheetMobile` + wire into `/prep` mobile

**Files:**
- Create: `src/components/prep/runsheet/RunSheetMobile.tsx`
- Modify: `src/app/prep/page.tsx` (render `<RunSheetMobile>` in the `block md:hidden` wrapper)

**Interfaces:**
- Consumes: Task 14 components, same mutation props as `RunSheet`.
- Produces: `RunSheetMobile({items,cooks,nowMin,nowMs,onStart,onClaim,onLog,onReopen,onOpenRecipe})` — header (date/now/next service), My-Station|Kitchen `Segmented` (default station), cook picker, in-progress rail, hero + "Coming up" queue (station) / time sections (kitchen), Done.

- [ ] **Step 1: Port `PTMobile`→`RunSheetMobile`** faithfully; mutations via props; default mode `station`.

- [ ] **Step 2: Wire `/prep` mobile** — replace the mobile **Today** surface render (the `block md:hidden` mobile Today list — currently `PrepTaskRowCompact` rows) with `<RunSheetMobile>`, passing the SAME wired callbacks as desktop Task 13 (`onOpenRecipe`→`openDrawer`, `onStart`→IN_PROGRESS, `onLog`→`setDoneSheetItem`, `onClaim`→`handleClaim`, `onReopen`→IN_PROGRESS) plus `cooks`, `nowMin`, `nowMs`. The mobile fused `PrepDrawer` and `PrepDoneSheet` stay mounted (they're what `openDrawer`/`setDoneSheetItem` open). Keep the mobile Smart Prep tab intact.

- [ ] **Step 3: Verify in browser** (`resize_window` mobile 375×812): hero shows next-up by start-by; Start; claim-to-me; rail timer; kitchen time sections; Done reopen. Console clean; `npm run build` green.

- [ ] **Step 4: Commit**
```bash
git add src/components/prep/runsheet/RunSheetMobile.tsx src/app/prep/page.tsx
git commit -m "feat(prep): mobile run sheet wired into /prep"
```

---

# Phase 4 — Reconcile & clean up (REVISED for "build on your drawer")

> Tasks 16 (`RecipeSheet`) and 17 (`LogYield`) are **DROPPED** — the fused item drawer (`PrepDrawer`/`PrepBoardDrawer` + `PrepRecipeSection`) and `PrepDoneSheet` from commit `102fd12` already are the recipe + yield surfaces, and Tasks 13/15 wire the run sheet to open them. The prototype's `PTRecipe`/`PTLogBody`/batch-write-back are intentionally not ported. Phase 4 is now a single reconciliation/cleanup task.

### Task 18: Reconcile run sheet with the fused drawer + remove now-dead Today-board code

**Files:**
- Modify: `src/app/prep/page.tsx` (finalize wiring; remove Today-board render paths the run sheet replaced)
- Possibly delete (ONLY if grep proves zero remaining imports): whichever `src/components/prep/board/` list components were used **only** by the Today view (candidates: `PrepBlock`, `PrepRow`, `PrepLater`, `PrepSummaryLine`, and `PrepBoard`/`prep-board-utils.ts` **iff** Smart Prep no longer uses them). **KEEP** `PrepBoardDrawer`, `PrepDrawer`, `PrepRecipeSection`, `PrepDoneSheet`, `RecipeViewModal` (sub-recipe peek) — all still in use.

**Interfaces:**
- Consumes: `RunSheet` (Task 13), `RunSheetMobile` (Task 15), the existing drawer/quick-yield handlers.
- Produces: a `/prep` where the Today surface is the run sheet (desktop + mobile), opening the existing fused drawer for recipe/cook-along and `PrepDoneSheet` for quick yield; Smart Prep unchanged; no dead board code left behind.

- [ ] **Step 1: Confirm the full flow is wired** (mostly done in Tasks 13/15) — verify `onOpenRecipe`→`openDrawer`, `onStart`/`onReopen`→`onRowStatusChange(…, 'IN_PROGRESS')`, `onLog`→`setDoneSheetItem`, `onClaim`→`handleClaim` are all connected for BOTH desktop and mobile, and that `handleClaim` optimistically updates `items`.

- [ ] **Step 2: Identify dead Today-board code** — grep every `board/` component (`rg "PrepBoard\b|PrepBlock|PrepRow|PrepLater|PrepSummaryLine|prep-board-utils"` across `src`). Determine which are now referenced ONLY by the removed Today render vs. still used by Smart Prep. `PrepBoard` currently serves BOTH `viewMode==='today'` and Smart Prep — if Smart Prep still renders through it, DO NOT delete `PrepBoard`/`PrepRow`/etc.; only remove the `viewMode==='today'` branch that the run sheet superseded. Delete a file only when its import count reaches zero. **When in doubt, leave it and note it** — a slightly-larger tree is safer than a broken Smart Prep.

- [ ] **Step 3: Remove the superseded Today render** — delete the now-unreachable `viewMode==='today'` desktop-board + mobile-compact-list JSX and any state/handlers that only fed it (but not the shared `openDrawer`/`onRowStatusChange`/`setDoneSheetItem`/`handleToggleOnList`/`handlePriorityChange`, which the run sheet and Smart Prep both use). Log what you removed vs. kept.

- [ ] **Step 4: Verify in browser** (desktop ≥md AND mobile 375×812):
  - `/prep` Today = the run sheet; rows ordered by start-by; NOW line placed right; Kitchen/My-Station scoping; group-by (desktop); claim; Start → in-progress rail timer advances.
  - Open recipe from a row/book/hero → the **existing fused drawer** opens (upscale slider, ingredients, method); its "Done · add X" completes the prep (DONE/PARTIAL) and the item leaves the list.
  - Quick-done from the rail/row → `PrepDoneSheet` prompt → logs yield.
  - Sub-recipe peek (`RecipeViewModal`) still opens from an ingredient inside the drawer.
  - **Smart Prep tab still works** (intake, add-to-list) — this is the key regression check for the board-code removal.
  - `npm test` green, `npm run build` green (Today API routes `ƒ`), `read_console_messages` clean.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(prep): run sheet replaces Today board; reuse fused drawer + quick-yield"
```

---

## Self-Review

**Spec coverage:**
- Start-by time model → Tasks 1–3 (schema, lib, API). ✅
- Recipe-authored times + item override → Task 1 (schema), Task 2 (`resolve*`), Task 3 (API). ✅
- Per-RC services → Tasks 1, 5, 7. ✅
- Cook roster → Tasks 1, 6, 8. ✅
- Start/finish timestamps + live timers → Tasks 1, 4, 12, 14. ✅
- Desktop run sheet (status band, modes, crew strip, rail, grouped ladder, Done) → Tasks 10–13. ✅
- Mobile run sheet (hero, queue, kitchen sections, rail) → Tasks 14–15. ✅
- Recipe view + batch scaling → **provided by the existing fused drawer** (`PrepRecipeSection`, commit `102fd12`), which the run sheet opens via `openDrawer` (Tasks 13/15). The prototype's separate `RecipeSheet` (Task 16) is intentionally dropped. The `prep-runsheet` scaling helpers (Task 2) remain for any future use but the drawer owns scaling. ✅ (revised)
- Yield logging → the existing drawer completion (`onDrawerComplete`, DONE/PARTIAL) + `PrepDoneSheet` quick-yield; Task 17 `LogYield` dropped. ✅ (revised)
- Batch write-back to `targetToday` → **dropped**; the drawer's `makeQty` slider owns batch qty at completion time. ✅ (revised)
- Smart Prep intake preserved; RC scoping preserved → Tasks 13/15 keep Smart Prep + the drawers; Task 18 removes only dead Today-board code. ✅
- Retire old `board/` + `RecipeViewModal` → Task 18. ✅
- Backfill + seed → Task 9. ✅

**Placeholder scan:** logic/schema/API steps carry full code; UI-port steps name the exact prototype source symbol + mapping rules (Global Constraints) rather than paraphrase — deliberate for pixel-faithful ports where the prototype is the reference, not a placeholder.

**Type consistency:** `resolveActive/resolvePassive/resolvePassiveNote`, `startByMinutes`, `runState`, `stepFor/scaleRound/scaleQtyLabel`, `fmtClock/fmtDuration`, `minutesBetween` names are used identically in Tasks 2, 3, 11, 12, 16, 17. `assignedCook`/`service`/`startByMinutes` response fields defined in Task 3 are the fields consumed by Tasks 11–16. `onStart(item, target?)` signature (Task 13/18) is consistent.

---

## Execution notes
- Phases are independently shippable: after Phase 1 the data/API/Setup exist with no UI change; Phase 2 swaps desktop; Phase 3 swaps mobile; Phase 4 adds the recipe/yield surfaces and removes the old tree. Each phase ends green on `npm run build` (+`npm test` for lib phases).
- Recipe-editor fields for `activeMinutes`/`passiveMinutes`/`passiveNote` are a **follow-up** (spec §7): the run sheet degrades gracefully for untimed recipes (start-by = service time, no runway bar). If desired, add a small task to the recipe form in a later plan.
