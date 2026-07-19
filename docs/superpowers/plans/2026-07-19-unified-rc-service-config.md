# Unified RC Service Configuration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `Service` model the single source of service type + hours for every revenue center, configured in the RC editor, so the prep page, `/pass`, and `/preshift` can never disagree about what service is next.

**Architecture:** `Service` gains an `endMinutes` column (the "hours" half). `src/lib/service-hours.ts` is rewritten as a pure module over `Service` rows exposing one `serviceStatus()` answer that every page renders. `RevenueCenter.serviceSchedule` + `schedulingMode` are backfilled into `Service`, then retired; on-demand becomes "this RC has no active services."

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind · vitest

Spec: `docs/superpowers/specs/2026-07-19-unified-rc-service-config-design.md`

## Global Constraints

- **Migrations are hand-written SQL only.** A full-schema `prisma migrate diff` would try to drop the pack-chain columns. Apply with `prisma db execute --url "$DIRECT_URL" --file <sql>`, then record with `prisma migrate resolve --applied <name>`.
- **Use `DIRECT_URL`, not `DATABASE_URL`, for all DDL.** The pgBouncer pooler rejects Prisma's migrate tooling ("prepared statement s0 does not exist").
- **node/npm are not on PATH by default.** Prefix commands with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"`.
- **Never run `npm run build` while the dev server is running** — it corrupts `.next`. Stop the server, `rm -rf .next`, then build.
- **Minute-of-day everywhere.** All service times are integers `0..1439`. `endMinutes < timeMinutes` means the service crosses midnight.
- **`PrepItem.targetServiceId` is never modified.** The run sheet must keep working at every step.
- **Do not commit `scripts/backfill-hot-temps.ts`** — it is another session's uncommitted work. Stage files explicitly by path.
- **`serviceStatus` precedence:** upcoming wins over underway. This matches the run sheet's existing `nextSvc` semantics (next start strictly after now), which the prep header was already aligned to.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | Add `Service.endMinutes`; later drop RC `serviceSchedule`/`schedulingMode` |
| `prisma/migrations/<ts>_service_end_minutes/migration.sql` | Additive DDL (Task 1) |
| `prisma/migrations/<ts>_drop_rc_service_schedule/migration.sql` | Destructive DDL (Task 7) |
| `scripts/backfill-service-hours.ts` | One-off idempotent backfill (Task 2) |
| `src/lib/service-hours.ts` | **Rewritten.** Pure service resolution: `nextService`, `currentService`, `prepDeadlineMinutes`, `serviceStatus`, `fmtDuration`, `fmtServiceHours` |
| `src/lib/__tests__/service-hours.test.ts` | **New.** vitest coverage for the above |
| `src/app/api/services/route.ts`, `[id]/route.ts` | Accept/return `endMinutes` |
| `src/app/api/revenue-centers/route.ts`, `[id]/route.ts` | Return each RC's active `services` inline |
| `src/app/prep/page.tsx` | Prep header renders `serviceStatus` |
| `src/app/pass/page.tsx`, `src/app/preshift/page.tsx` | Render `serviceStatus` instead of JSON windows |
| `src/app/setup/revenue-centers/page.tsx` | Service-period editor replaces the weekday-window editor |
| `src/app/setup/services/page.tsx` | Retired → redirect to `/setup/revenue-centers` |

---

### Task 1: Add `Service.endMinutes`

**Files:**
- Modify: `prisma/schema.prisma` (model `Service`)
- Create: `prisma/migrations/<timestamp>_service_end_minutes/migration.sql`

**Interfaces:**
- Consumes: nothing
- Produces: `Service.endMinutes: Int?` — every later task reads/writes it

- [ ] **Step 1: Add the column to the schema**

In `prisma/schema.prisma`, model `Service`, add `endMinutes` directly under `timeMinutes`:

```prisma
model Service {
  id              String        @id @default(cuid())
  revenueCenterId String
  name            String
  timeMinutes     Int
  // Service END, minute-of-day. Nullable so this ships additively; the RC editor
  // requires it on save. endMinutes < timeMinutes ⇒ the service crosses midnight.
  endMinutes      Int?
  sortOrder       Int           @default(0)
  isActive        Boolean       @default(true)
  revenueCenter   RevenueCenter @relation("ServiceRC", fields: [revenueCenterId], references: [id])
  prepItems       PrepItem[]    @relation("PrepItemService")
  @@index([revenueCenterId])
}
```

- [ ] **Step 2: Validate the schema**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os && npx prisma validate
```
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 3: Write the migration SQL**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os
TS=$(date +%Y%m%d%H%M%S); MIG="prisma/migrations/${TS}_service_end_minutes"
mkdir -p "$MIG"
cat > "$MIG/migration.sql" <<'SQL'
-- Service gains its END time (minute-of-day). Nullable: additive, no backfill here.
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "endMinutes" INTEGER;
SQL
echo "$MIG" > /tmp/mig1.txt && cat "$MIG/migration.sql"
```

- [ ] **Step 4: Apply and record the migration**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os
export $(grep -E '^(DATABASE_URL|DIRECT_URL)=' .env | sed 's/#.*//' | xargs)
MIG=$(cat /tmp/mig1.txt)
npx prisma db execute --url "$DIRECT_URL" --file "$MIG/migration.sql"
npx prisma migrate resolve --applied "$(basename "$MIG")"
npx prisma generate
```
Expected: `Script executed successfully.` → `Migration ... marked as applied.` → `✔ Generated Prisma Client`

- [ ] **Step 5: Commit**

```bash
cd /Users/joshua/dev/fergies-os
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(service): add endMinutes (service hours) to Service"
```

---

### Task 2: Backfill service hours from the legacy schedule

**Files:**
- Create: `scripts/backfill-service-hours.ts`

**Interfaces:**
- Consumes: `Service.endMinutes` (Task 1)
- Produces: every RC's `Service` rows carry real hours; the DB is ready for readers to switch

**Context the implementer needs:** `RevenueCenter.serviceSchedule` is `Json?` shaped `{ "0".."6": [{ label, start, end }] }` where `start`/`end` are `"HH:MM"` and the key is a Monday-first day index. We only need the *set* of distinct windows across the week, since we no longer support per-weekday variation.

- [ ] **Step 1: Write the backfill script**

Create `scripts/backfill-service-hours.ts`:

```ts
/**
 * One-off, idempotent backfill: carry RevenueCenter.serviceSchedule (legacy JSON
 * weekday windows) into the Service model, which becomes the single source of
 * service type + hours.
 *
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-service-hours.ts
 *
 * Non-destructive: fills missing endMinutes and creates missing Service rows.
 * Never deletes or overwrites an endMinutes that is already set.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

type Window = { label?: string; start?: string; end?: string }

const toMin = (hm: string | undefined): number | null => {
  if (!hm) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return null
  const h = Number(m[1]), mm = Number(m[2])
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
  return h * 60 + mm
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/** Distinct windows across the whole week, keyed by label+start+end. */
function distinctWindows(schedule: unknown): { name: string; start: number; end: number | null }[] {
  if (!schedule || typeof schedule !== 'object') return []
  const out = new Map<string, { name: string; start: number; end: number | null }>()
  for (const list of Object.values(schedule as Record<string, Window[]>)) {
    if (!Array.isArray(list)) continue
    for (const w of list) {
      const start = toMin(w.start)
      if (start == null) continue
      const end = toMin(w.end)
      const name = (w.label || '').trim() || 'Service'
      out.set(`${name}|${start}|${end}`, { name, start, end })
    }
  }
  return [...out.values()].sort((a, b) => a.start - b.start)
}

async function main() {
  const rcs = await prisma.revenueCenter.findMany({
    select: { id: true, name: true, serviceSchedule: true, services: true },
  })

  let filled = 0, created = 0
  for (const rc of rcs) {
    const windows = distinctWindows(rc.serviceSchedule)
    console.log(`\n=== ${rc.name} (${rc.id})`)
    console.log(`  legacy windows: ${windows.length ? windows.map(w => `${w.name} ${hhmm(w.start)}-${w.end != null ? hhmm(w.end) : '?'}`).join(', ') : '(none)'}`)
    console.log(`  services before: ${rc.services.length ? rc.services.map(s => `${s.name} ${hhmm(s.timeMinutes)}-${s.endMinutes != null ? hhmm(s.endMinutes) : '?'}`).join(', ') : '(none)'}`)

    // 1) Fill endMinutes on existing services that lack it.
    for (const svc of rc.services) {
      if (svc.endMinutes != null) continue
      const byName = windows.find(w => w.name.toLowerCase() === svc.name.toLowerCase() && w.end != null)
      const byStart = windows.filter(w => w.end != null)
        .sort((a, b) => Math.abs(a.start - svc.timeMinutes) - Math.abs(b.start - svc.timeMinutes))[0]
      const match = byName ?? byStart
      if (!match?.end) { console.log(`  ! ${svc.name}: no window to source hours from — set it in the RC editor`); continue }
      await prisma.service.update({ where: { id: svc.id }, data: { endMinutes: match.end } })
      console.log(`  + ${svc.name}: endMinutes ← ${hhmm(match.end)}`)
      filled++
    }

    // 2) Create a Service for any legacy window that has none.
    for (const w of windows) {
      const exists = rc.services.some(
        s => s.name.toLowerCase() === w.name.toLowerCase() || s.timeMinutes === w.start,
      )
      if (exists) continue
      await prisma.service.create({
        data: { revenueCenterId: rc.id, name: w.name, timeMinutes: w.start, endMinutes: w.end ?? null },
      })
      console.log(`  + created service ${w.name} ${hhmm(w.start)}-${w.end != null ? hhmm(w.end) : '?'}`)
      created++
    }

    const after = await prisma.service.findMany({
      where: { revenueCenterId: rc.id }, orderBy: [{ sortOrder: 'asc' }, { timeMinutes: 'asc' }],
    })
    console.log(`  services after:  ${after.length ? after.map(s => `${s.name} ${hhmm(s.timeMinutes)}-${s.endMinutes != null ? hhmm(s.endMinutes) : '?'}`).join(', ') : '(none) → ON-DEMAND'}`)
  }

  console.log(`\nDone. endMinutes filled: ${filled}, services created: ${created}.`)
  console.log('Any RC printed as "(none) → ON-DEMAND" has no services and will show no countdown.')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Run the backfill**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os
npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-service-hours.ts
```
Expected: a per-RC before/after table. Note any RC that reports `no window to source hours from`.

- [ ] **Step 3: Set KITCHEN's Brunch hours explicitly**

KITCHEN's legacy JSON holds an evening window, not Brunch, so the nearest-start match is wrong for it. Brunch is 09:00–16:00. Run:

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os
export $(grep -E '^DIRECT_URL=' .env | sed 's/#.*//' | xargs)
cat > /tmp/kitchen_brunch.sql <<'SQL'
UPDATE "Service" s
SET "endMinutes" = 960          -- 16:00
FROM "RevenueCenter" rc
WHERE s."revenueCenterId" = rc.id
  AND lower(s.name) = 'brunch'
  AND s."timeMinutes" = 540;    -- 09:00
SQL
npx prisma db execute --url "$DIRECT_URL" --file /tmp/kitchen_brunch.sql
```
Expected: `Script executed successfully.`

- [ ] **Step 4: Verify every active service now has hours**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os
cat > /tmp/verify_hours.cjs <<'JS'
const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient()
;(async () => {
  const rows = await p.service.findMany({ where: { isActive: true }, include: { revenueCenter: { select: { name: true } } } })
  for (const s of rows) console.log(`${s.revenueCenter.name}: ${s.name} start=${s.timeMinutes} end=${s.endMinutes ?? 'NULL'}`)
  console.log('missing hours:', rows.filter(s => s.endMinutes == null).length)
  await p.$disconnect()
})()
JS
node /tmp/verify_hours.cjs && rm -f /tmp/verify_hours.cjs
```
Expected: `missing hours: 0`, and a `KITCHEN: Brunch start=540 end=960` line.

- [ ] **Step 5: Commit**

```bash
cd /Users/joshua/dev/fergies-os
git add scripts/backfill-service-hours.ts
git commit -m "chore(service): idempotent backfill of service hours from legacy serviceSchedule"
```

---

### Task 3: Rewrite `service-hours.ts` over Service rows (TDD)

**Files:**
- Modify: `src/lib/service-hours.ts` (full rewrite)
- Create: `src/lib/__tests__/service-hours.test.ts`

**Interfaces:**
- Consumes: `Service.endMinutes` (Task 1)
- Produces — every later task imports these:
  - `interface RcService { id: string; name: string; timeMinutes: number; endMinutes: number | null }`
  - `type ServiceStatus = { kind:'upcoming'; service: RcService; minsUntil: number; prepByMin: number | null } | { kind:'underway'; service: RcService } | { kind:'none' }`
  - `nextService(services: RcService[], nowMin: number): RcService | null`
  - `currentService(services: RcService[], nowMin: number): RcService | null`
  - `prepDeadlineMinutes(services: RcService[], nowMin: number, leadMinutes: number | null): number | null`
  - `serviceStatus(services: RcService[], nowMin: number, leadMinutes: number | null): ServiceStatus`
  - `fmtDuration(ms: number): string` — **unchanged, still milliseconds** (existing callers depend on this)
  - `fmtServiceHours(s: RcService): string`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/service-hours.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  nextService, currentService, prepDeadlineMinutes, serviceStatus, fmtServiceHours,
  type RcService,
} from '@/lib/service-hours'

const svc = (name: string, start: number, end: number | null): RcService =>
  ({ id: name.toLowerCase(), name, timeMinutes: start, endMinutes: end })

const BRUNCH = svc('Brunch', 540, 960)    // 09:00–16:00
const DINNER = svc('Dinner', 1020, 1320)  // 17:00–22:00
const LATE   = svc('Late', 1320, 120)     // 22:00–02:00 (crosses midnight)

describe('nextService', () => {
  it('returns the earliest service starting after now', () => {
    expect(nextService([DINNER, BRUNCH], 480)?.name).toBe('Brunch') // 08:00
    expect(nextService([DINNER, BRUNCH], 600)?.name).toBe('Dinner') // 10:00
  })
  it('returns null once every service has started', () => {
    expect(nextService([BRUNCH, DINNER], 1380)).toBeNull() // 23:00
  })
  it('returns null for no services', () => {
    expect(nextService([], 600)).toBeNull()
  })
})

describe('currentService', () => {
  it('returns the service in progress', () => {
    expect(currentService([BRUNCH, DINNER], 600)?.name).toBe('Brunch') // 10:00
  })
  it('excludes the boundary end and includes the boundary start', () => {
    expect(currentService([BRUNCH], 540)?.name).toBe('Brunch') // 09:00 exactly
    expect(currentService([BRUNCH], 960)).toBeNull()           // 16:00 exactly
  })
  it('handles a service crossing midnight', () => {
    expect(currentService([LATE], 1380)?.name).toBe('Late') // 23:00
    expect(currentService([LATE], 60)?.name).toBe('Late')   // 01:00
    expect(currentService([LATE], 300)).toBeNull()          // 05:00
  })
  it('never reports a service with unknown hours as underway', () => {
    expect(currentService([svc('NoEnd', 540, null)], 600)).toBeNull()
  })
})

describe('prepDeadlineMinutes', () => {
  it('is the next start minus the lead', () => {
    expect(prepDeadlineMinutes([BRUNCH], 480, 60)).toBe(480) // 09:00 − 1h
  })
  it('treats a null lead as zero', () => {
    expect(prepDeadlineMinutes([BRUNCH], 480, null)).toBe(540)
  })
  it('wraps below midnight', () => {
    expect(prepDeadlineMinutes([svc('Early', 30, 300)], 0, 60)).toBe(1410) // 00:30 − 1h → 23:30
  })
  it('is null when nothing is upcoming', () => {
    expect(prepDeadlineMinutes([BRUNCH], 1000, 60)).toBeNull()
  })
})

describe('serviceStatus', () => {
  it('reports the upcoming service, with minutes and prep-by', () => {
    const s = serviceStatus([BRUNCH], 480, 60) // 08:00
    expect(s).toEqual({ kind: 'upcoming', service: BRUNCH, minsUntil: 60, prepByMin: 480 })
  })
  it('prefers an upcoming service over one already underway', () => {
    const s = serviceStatus([BRUNCH, DINNER], 600, null) // Brunch underway, Dinner later
    expect(s.kind).toBe('upcoming')
    expect(s.kind === 'upcoming' && s.service.name).toBe('Dinner')
  })
  it('falls back to underway when it is the last service', () => {
    const s = serviceStatus([BRUNCH], 600, null)
    expect(s).toEqual({ kind: 'underway', service: BRUNCH })
  })
  it('reports none when no services are configured (on-demand)', () => {
    expect(serviceStatus([], 600, 60)).toEqual({ kind: 'none' })
  })
  it('reports none after the last service has ended', () => {
    expect(serviceStatus([BRUNCH], 1000, null)).toEqual({ kind: 'none' })
  })
})

describe('fmtServiceHours', () => {
  it('renders a start–end range', () => {
    expect(fmtServiceHours(BRUNCH)).toBe('09:00–16:00')
  })
  it('renders only the start when the end is unknown', () => {
    expect(fmtServiceHours(svc('NoEnd', 540, null))).toBe('09:00')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os && npx vitest run src/lib/__tests__/service-hours.test.ts
```
Expected: FAIL — `nextService`/`serviceStatus`/`fmtServiceHours` are not exported by `@/lib/service-hours`.

- [ ] **Step 3: Rewrite the module**

Replace the entire contents of `src/lib/service-hours.ts`:

```ts
// src/lib/service-hours.ts
// Pure helpers — no DB. Resolve the current / next service for a revenue center
// from its configured Service rows. Minute-of-day arithmetic throughout.
//
// This module is the single answer every surface renders. Before it existed the
// prep header and the run sheet each computed "the next service" their own way
// and disagreed on screen.

/** A configured service period. Callers pass ACTIVE services only. */
export interface RcService {
  id: string
  name: string
  timeMinutes: number        // start, minute-of-day (0..1439)
  endMinutes: number | null  // end, minute-of-day; < start ⇒ crosses midnight
}

export type ServiceStatus =
  | { kind: 'upcoming'; service: RcService; minsUntil: number; prepByMin: number | null }
  | { kind: 'underway'; service: RcService }
  | { kind: 'none' }

const byStart = (a: RcService, b: RcService) => a.timeMinutes - b.timeMinutes
const wrap = (min: number) => ((min % 1440) + 1440) % 1440

/** Earliest service starting strictly after `nowMin`. null once all have started. */
export function nextService(services: RcService[], nowMin: number): RcService | null {
  return [...services].sort(byStart).find(s => s.timeMinutes > nowMin) ?? null
}

/** Service in progress (start ≤ now < end). A service with unknown hours is never underway. */
export function currentService(services: RcService[], nowMin: number): RcService | null {
  for (const s of [...services].sort(byStart)) {
    if (s.endMinutes == null) continue
    const crossesMidnight = s.endMinutes < s.timeMinutes
    const inWindow = crossesMidnight
      ? nowMin >= s.timeMinutes || nowMin < s.endMinutes
      : nowMin >= s.timeMinutes && nowMin < s.endMinutes
    if (inWindow) return s
  }
  return null
}

/** Coarse prep deadline: the next service's start minus the RC's lead. */
export function prepDeadlineMinutes(
  services: RcService[], nowMin: number, leadMinutes: number | null,
): number | null {
  const next = nextService(services, nowMin)
  if (!next) return null
  return wrap(next.timeMinutes - (leadMinutes ?? 0))
}

/**
 * The single answer every header renders.
 *
 * Precedence: an UPCOMING service wins over one already underway — prep cares
 * about the next deadline, and this matches the run sheet's `nextSvc` semantics.
 * `underway` is the fallback for the last service of the day.
 */
export function serviceStatus(
  services: RcService[], nowMin: number, leadMinutes: number | null,
): ServiceStatus {
  const next = nextService(services, nowMin)
  if (next) {
    return {
      kind: 'upcoming',
      service: next,
      minsUntil: next.timeMinutes - nowMin,
      prepByMin: prepDeadlineMinutes(services, nowMin, leadMinutes),
    }
  }
  const current = currentService(services, nowMin)
  if (current) return { kind: 'underway', service: current }
  return { kind: 'none' }
}

/** "09:00–16:00", or just the start when the end is unknown. */
export function fmtServiceHours(s: RcService): string {
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return s.endMinutes == null ? hhmm(s.timeMinutes) : `${hhmm(s.timeMinutes)}–${hhmm(s.endMinutes)}`
}

/** "2h 30m", "45m", "1d 2h". Clamps negatives to "0m". Takes MILLISECONDS. */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMin = Math.floor(ms / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os && npx vitest run src/lib/__tests__/service-hours.test.ts
```
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
cd /Users/joshua/dev/fergies-os
git add src/lib/service-hours.ts src/lib/__tests__/service-hours.test.ts
git commit -m "feat(service-hours): rewrite over Service rows with a single serviceStatus()"
```

---

### Task 4: Serve `endMinutes` and RC services from the API

**Files:**
- Modify: `src/app/api/services/route.ts` (POST accepts `endMinutes`)
- Modify: `src/app/api/services/[id]/route.ts` (PATCH accepts `endMinutes`)
- Modify: `src/app/api/revenue-centers/route.ts` (GET includes `services`)
- Modify: `src/app/api/revenue-centers/[id]/route.ts` (GET includes `services`)

**Interfaces:**
- Consumes: `Service.endMinutes` (Task 1)
- Produces: every RC payload carries `services: { id, name, timeMinutes, endMinutes }[]` (active only, ordered) — Tasks 5 and 6 rely on this

- [ ] **Step 1: Accept `endMinutes` on create**

In `src/app/api/services/route.ts`, the existing `validateTimeMinutes` already enforces `0..1439`; reuse it. In `POST`, destructure and validate `endMinutes`, then persist it:

```ts
const { revenueCenterId, name, timeMinutes, endMinutes, sortOrder } = body
// … existing revenueCenterId / name / timeMinutes checks …
if (endMinutes !== undefined && endMinutes !== null) {
  const endErr = validateTimeMinutes(endMinutes)
  if (endErr) return NextResponse.json({ error: endErr.replace('timeMinutes', 'endMinutes') }, { status: 400 })
}
```
and add `endMinutes: endMinutes ?? null,` to the `prisma.service.create({ data: { … } })` object.

- [ ] **Step 2: Accept `endMinutes` on update**

In `src/app/api/services/[id]/route.ts`, inside the PATCH handler's update `data` object, add the same conditional-spread pattern the other fields use:

```ts
...(body.endMinutes !== undefined && { endMinutes: body.endMinutes === null ? null : Number(body.endMinutes) }),
```
Validate it the same way before the update:
```ts
if (body.endMinutes !== undefined && body.endMinutes !== null) {
  const v = Number(body.endMinutes)
  if (!Number.isInteger(v) || v < 0 || v > 1439) {
    return NextResponse.json({ error: 'endMinutes must be an integer between 0 and 1439' }, { status: 400 })
  }
}
```

- [ ] **Step 3: Include active services on every RC payload**

In **both** `src/app/api/revenue-centers/route.ts` and `src/app/api/revenue-centers/[id]/route.ts`, add this to the `prisma.revenueCenter.findMany(...)` / `findUnique(...)` call so consumers need no second fetch:

```ts
include: {
  services: {
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { timeMinutes: 'asc' }],
    select: { id: true, name: true, timeMinutes: true, endMinutes: true },
  },
},
```
If the call already uses a `select`, add `services: { … }` inside that `select` instead — `select` and `include` cannot be combined.

- [ ] **Step 4: Verify the API returns services**

Start the dev server (`preview_start`, or `npm run dev`), then:
```bash
curl -s http://localhost:3000/api/revenue-centers | head -c 600
```
Expected: each RC object contains a `"services":[{"id":…,"name":"Brunch","timeMinutes":540,"endMinutes":960}]` array.

- [ ] **Step 5: Commit**

```bash
cd /Users/joshua/dev/fergies-os
git add src/app/api/services src/app/api/revenue-centers
git commit -m "feat(api): expose service endMinutes and inline RC services"
```

---

### Task 5: Switch the readers to `serviceStatus`

**Files:**
- Modify: `src/app/prep/page.tsx`
- Modify: `src/app/pass/page.tsx:13,347,352`
- Modify: `src/app/preshift/page.tsx:11,256,257,287`

**Interfaces:**
- Consumes: `serviceStatus`, `RcService`, `fmtDuration`, `fmtServiceHours` (Task 3); `rc.services` (Task 4)
- Produces: all three surfaces render the same service for the same RC at the same moment

**Rendering rules — identical on all three surfaces:**
- `upcoming` → `"{name} service in {fmtDuration(minsUntil * 60_000)}"`
- `underway` → `"{name} service underway"`
- `none` → `"on-demand"` (no countdown)

- [ ] **Step 1: Prep header**

In `src/app/prep/page.tsx`, replace the interim inline `nextService` memo with the shared helper. `activeRc` already carries `services` after Task 4, and `nowMin` is already in scope from `useNowMinute()`:

```ts
import { fmtDuration, serviceStatus, type RcService } from '@/lib/service-hours'

const svcStatus = useMemo(
  () => serviceStatus((activeRc?.services ?? []) as RcService[], nowMin, activeRc?.prepLeadMinutes ?? null),
  [activeRc, nowMin],
)
```
Delete the `nextService` memo. Render in the desktop header subtitle (replacing the interim `{nextService && …}` expression):

```tsx
{svcStatus.kind === 'upcoming' && (
  <> · <b className="text-ink font-medium">{svcStatus.service.name}</b> service in <b className="text-ink font-medium">{fmtDuration(svcStatus.minsUntil * 60_000)}</b></>
)}
{svcStatus.kind === 'underway' && (
  <> · <b className="text-ink font-medium">{svcStatus.service.name}</b> service underway</>
)}
{svcStatus.kind === 'none' && <> · on-demand</>}
```
Rebuild `countdown` (consumed by `PrepShiftBand` + `PrepDrawer`) from the same source, keeping its existing `{ serviceLabel, minsToService, startByHHMM }` shape:

```ts
const countdown = useMemo(() => {
  if (svcStatus.kind !== 'upcoming') return null
  const m = svcStatus.prepByMin
  return {
    serviceLabel: fmtDuration(svcStatus.minsUntil * 60_000),
    minsToService: svcStatus.minsUntil,
    startByHHMM: m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
  }
}, [svcStatus])
```
Rewrite `prepBy` (mobile header) off `svcStatus` too — on-demand is now `kind === 'none'`, so the `schedulingMode` check disappears:

```ts
const prepBy = useMemo(() => {
  if (svcStatus.kind === 'none') {
    const lead = activeRc?.prepLeadMinutes != null ? fmtDuration(activeRc.prepLeadMinutes * 60_000) : null
    return { onDemand: true as const, time: null, left: null, lead }
  }
  if (svcStatus.kind !== 'upcoming' || svcStatus.prepByMin == null) return null
  const m = svcStatus.prepByMin
  const dl = new Date(); dl.setHours(Math.floor(m / 60), m % 60, 0, 0)
  return {
    onDemand: false as const,
    time: dl.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    left: fmtDuration(Math.max(0, m - nowMin) * 60_000),
    lead: null,
  }
}, [svcStatus, activeRc, nowMin])
```

- [ ] **Step 2: `/pass`**

In `src/app/pass/page.tsx`, change the import on line 13 and replace the `currentWindow`/`nextServiceStart` calls at lines 347 and 352:

```ts
import { serviceStatus, fmtDuration, type RcService } from '@/lib/service-hours'
```
```ts
// nowMin = minute-of-day for `now`
const nowMin = now.getHours() * 60 + now.getMinutes()
const status = serviceStatus((activeRc?.services ?? []) as RcService[], nowMin, activeRc?.prepLeadMinutes ?? null)
const serviceLabel =
  status.kind === 'upcoming' ? `${status.service.name} service in ${fmtDuration(status.minsUntil * 60_000)}`
  : status.kind === 'underway' ? `${status.service.name} service underway`
  : 'on-demand'
```
Replace the existing `cur`/`next` variables and whatever string they fed with `serviceLabel`.

- [ ] **Step 3: `/preshift`**

In `src/app/preshift/page.tsx`, change the import on line 11 and replace lines 256–257 and the `MProgress` props on line 287:

```ts
import { serviceStatus, fmtDuration, type RcService } from '@/lib/service-hours'
```
```ts
const nowMin = now.getHours() * 60 + now.getMinutes()
const status = serviceStatus((activeRc?.services ?? []) as RcService[], nowMin, activeRc?.prepLeadMinutes ?? null)
const serviceCountdown = status.kind === 'upcoming' ? fmtDuration(status.minsUntil * 60_000) : null
const countdownLabel =
  status.kind === 'upcoming' ? `to ${status.service.name}`
  : status.kind === 'underway' ? `${status.service.name} underway`
  : null
```
`MProgress` keeps its existing `countdown` / `countdownLabel` props — only the values feeding them change.

- [ ] **Step 4: Verify all three agree**

Start the dev server and load `/prep`, `/pass`, `/preshift` for the same RC. Confirm each shows the **same** service name and countdown (or all show "on-demand"). This is the exact inconsistency that motivated the work.

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os && npm test
```
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/joshua/dev/fergies-os
git add src/app/prep/page.tsx src/app/pass/page.tsx src/app/preshift/page.tsx
git commit -m "feat(service): prep, pass and preshift all render the shared serviceStatus"
```

---

### Task 6: Service-period editor in the RC editor; retire `/setup/services`

**Files:**
- Modify: `src/app/setup/revenue-centers/page.tsx` (replace the weekday-window editor)
- Modify: `src/app/setup/services/page.tsx` (replace with a redirect)

**Interfaces:**
- Consumes: `/api/services` CRUD (Task 4), `rc.services` (Task 4), `fmtServiceHours` (Task 3)
- Produces: the only surface that writes service configuration

**What to remove:** in `src/app/setup/revenue-centers/page.tsx` — the `ServiceSchedule` / `ServiceWindow` import (line 4), `EMPTY_WINDOW` (line 58), the `dayWindows` / `setDay` / `editWindow` helpers (~lines 69–85) and the weekday-window JSX they drive, plus the `schedulingMode` and `schedule` form fields (lines 39–41, 149, 158, 182–183). Keep `prepLeadMinutes` (the `prepLeadH`/`prepLeadM` inputs).

- [ ] **Step 1: Add the service-period editor component**

Add to `src/app/setup/revenue-centers/page.tsx`, at **module scope** (not inside the page component — components defined in a component body remount on every render):

```tsx
interface ServiceRow { id: string; name: string; timeMinutes: number; endMinutes: number | null }

const toHHMM = (m: number | null) =>
  m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const fromHHMM = (v: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1]), mm = Number(m[2])
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
  return h * 60 + mm
}

function ServicePeriodEditor({ rcId, services, onChanged }: {
  rcId: string
  services: ServiceRow[]
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (fn: () => Promise<Response>) => {
    setBusy(true); setError(null)
    try {
      const res = await fn()
      if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? 'Save failed')
      else onChanged()
    } catch { setError('Save failed — check your connection.') }
    finally { setBusy(false) }
  }

  const addService = () => save(() => fetch('/api/services', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revenueCenterId: rcId, name: 'Service', timeMinutes: 540, endMinutes: 960 }),
  }))

  const patch = (id: string, data: Partial<ServiceRow>) => save(() => fetch(`/api/services/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }))

  const remove = (id: string) => save(() => fetch(`/api/services/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  }))

  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.05em] text-ink-3">Services</div>
      {services.length === 0 && (
        <p className="text-[12.5px] text-ink-3">
          No services — this revenue center is treated as <b className="text-ink font-medium">on-demand</b> (no countdown shown).
        </p>
      )}
      {services.map(s => (
        <div key={s.id} className="flex items-center gap-2">
          <input
            defaultValue={s.name}
            onBlur={e => e.target.value.trim() && e.target.value !== s.name && patch(s.id, { name: e.target.value.trim() })}
            placeholder="Brunch"
            className="flex-1 min-w-0 border border-line rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="time" defaultValue={toHHMM(s.timeMinutes)}
            onBlur={e => { const v = fromHHMM(e.target.value); if (v != null && v !== s.timeMinutes) patch(s.id, { timeMinutes: v }) }}
            className="border border-line rounded-lg px-2 py-2 text-sm"
          />
          <span className="text-ink-4">–</span>
          <input
            type="time" defaultValue={toHHMM(s.endMinutes)}
            onBlur={e => { const v = fromHHMM(e.target.value); if (v != null && v !== s.endMinutes) patch(s.id, { endMinutes: v }) }}
            className="border border-line rounded-lg px-2 py-2 text-sm"
          />
          <button type="button" onClick={() => remove(s.id)} disabled={busy}
            className="px-2 py-2 text-ink-3 hover:text-red disabled:opacity-50" title="Remove service">✕</button>
        </div>
      ))}
      <button type="button" onClick={addService} disabled={busy}
        className="self-start px-3 py-2 rounded-lg border border-line text-[13px] text-ink-2 hover:border-ink-3 disabled:opacity-50">
        + Add service
      </button>
      {error && <p className="text-[12.5px] text-red-text">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Mount it and delete the weekday-window UI**

In the RC edit form, delete the weekday-window block and render instead:

```tsx
<ServicePeriodEditor rcId={rc.id} services={rc.services ?? []} onChanged={reloadRcs} />
```
`reloadRcs` is the page's existing refetch of `/api/revenue-centers`; use whatever that function is named in this file. Also delete the `schedulingMode` select and drop `schedulingMode` / `schedule` from the form state and from the PUT body.

- [ ] **Step 3: Retire `/setup/services`**

Replace the entire contents of `src/app/setup/services/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

// Service type + hours are configured per revenue center in the RC editor.
export default function ServicesSetupRedirect() {
  redirect('/setup/revenue-centers')
}
```
Then remove any nav link pointing at `/setup/services`:
```bash
cd /Users/joshua/dev/fergies-os && grep -rn "/setup/services" src/ --include=*.tsx
```
Delete each link found (except the redirect page itself).

- [ ] **Step 4: Verify**

Start the dev server. On `/setup/revenue-centers`: add a service, rename it, change its hours, remove it — each change persists across a reload. Confirm `/setup/services` redirects. Then reload `/prep` and confirm the header reflects the edited hours.

- [ ] **Step 5: Commit**

```bash
cd /Users/joshua/dev/fergies-os
git add src/app/setup/revenue-centers/page.tsx src/app/setup/services/page.tsx
git commit -m "feat(setup): service periods live in the RC editor; retire /setup/services"
```

---

### Task 7: Drop the dead columns (destructive — confirm first)

**Files:**
- Modify: `prisma/schema.prisma` (model `RevenueCenter`)
- Create: `prisma/migrations/<timestamp>_drop_rc_service_schedule/migration.sql`

**Interfaces:**
- Consumes: Tasks 5 and 6 shipped and verified — nothing reads or writes `serviceSchedule` / `schedulingMode`
- Produces: one configuration, one place

- [ ] **Step 1: Confirm nothing references the columns**

```bash
cd /Users/joshua/dev/fergies-os
grep -rn "serviceSchedule\|schedulingMode\|SchedulableRc\|ServiceWindow\|ServiceSchedule" src/ --include=*.ts --include=*.tsx
```
Expected: **no output.** If anything is listed, fix it before continuing — do not proceed.

- [ ] **Step 2: Ask the user before running the drop**

Post this and wait for an explicit yes:

> "Tasks 1–6 are verified and nothing references `serviceSchedule` / `schedulingMode`. Ready to drop both columns from `RevenueCenter`. This is irreversible — the backfill in Task 2 already carried that config into `Service`, so nothing is lost. Proceed?"

- [ ] **Step 3: Remove the fields from the schema**

In `prisma/schema.prisma`, model `RevenueCenter`, delete these two lines (keep `prepLeadMinutes`):

```prisma
  schedulingMode    String            @default("FIXED")
  serviceSchedule   Json?
```

Then validate:
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os && npx prisma validate
```
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 4: Write, apply and record the migration**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os
export $(grep -E '^DIRECT_URL=' .env | sed 's/#.*//' | xargs)
TS=$(date +%Y%m%d%H%M%S); MIG="prisma/migrations/${TS}_drop_rc_service_schedule"
mkdir -p "$MIG"
cat > "$MIG/migration.sql" <<'SQL'
-- Service type + hours now live solely in the Service model.
ALTER TABLE "RevenueCenter" DROP COLUMN IF EXISTS "serviceSchedule";
ALTER TABLE "RevenueCenter" DROP COLUMN IF EXISTS "schedulingMode";
SQL
npx prisma db execute --url "$DIRECT_URL" --file "$MIG/migration.sql"
npx prisma migrate resolve --applied "$(basename "$MIG")"
npx prisma generate
```
Expected: `Script executed successfully.` → `marked as applied.` → `✔ Generated Prisma Client`

- [ ] **Step 5: Full verification and commit**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os
npm test
# stop the dev server first, then:
rm -rf .next && npm run build 2>&1 | grep -E "Compiled successfully|Failed|Type error"
```
Expected: all tests pass; `✓ Compiled successfully`.

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "chore(service): drop RevenueCenter.serviceSchedule and schedulingMode"
```

---

## Self-Review

**Spec coverage:**
- Data model (`endMinutes`, drop RC columns, derived on-demand) → Tasks 1, 7; on-demand surfaces in Tasks 5 and 6
- Shared helper (`nextService`, `currentService`, `prepDeadlineMinutes`, `serviceStatus`, `fmtServiceHours`) → Task 3
- Consumers (prep, run sheet, `/pass`, `/preshift`, RC editor, retire `/setup/services`) → Tasks 5, 6. The run sheet needs no change — it already reads `item.service`.
- Data delivery (`services` inline on the RC API) → Task 4
- Rendering rules (upcoming / underway / none) → Task 5, applied identically on all three surfaces
- Active filtering (API returns active only; editor fetches inactive to re-enable) → Task 4 Step 3; the editor's remove is a soft `isActive:false` (Task 6)
- Migration steps 1–5 → Tasks 1, 2, 3+4+5, 6, 7 respectively
- Testing (all six spec bullets) → Task 3 Step 1
- Risk "endMinutes left null" → `currentService` skips null-end services (Task 3), backfill flags them (Task 2 Step 2), editor requires them (Task 6)

**Type consistency:** `RcService` and `ServiceStatus` are defined once in Task 3 and imported unchanged in Tasks 5 and 6. `fmtDuration` remains millisecond-based in every call site (`minsUntil * 60_000`). `countdown` keeps its existing `{ serviceLabel, minsToService, startByHHMM }` shape so `PrepShiftBand` and `PrepDrawer` need no edits. `ServiceRow` in Task 6 matches the API's `select`.

**Placeholders:** none — every code step contains complete code, every command its expected output.
