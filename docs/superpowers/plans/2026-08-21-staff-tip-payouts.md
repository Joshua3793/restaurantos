# Staff Tip Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a STAFF user a personal, read-only view of their own tip payouts at `/tips/me`, showing only their own numbers.

**Architecture:** A nullable, unique `Cook.userId` links an app login to a roster row. A pure whitelist projection (`src/lib/tips/me.ts`) turns a frozen `TipPeriod.snapshot` payout record into one person's data, dropping every house-level figure. One new STAFF-reachable endpoint (`GET /api/tips/me`) serves it; every other `/api/tips/*` route stays MANAGER-gated. The `/tips/me` clearance entry is added **last**, so the gate opens only after everything behind it exists and is tested.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind · Vitest

**Spec:** `docs/superpowers/specs/2026-08-21-staff-tip-payouts-design.md`

## Global Constraints

- **The projection is a field-by-field whitelist constructing a NEW object.** Never a spread of a snapshot record, never a delete-list. `TipPeriod.snapshot` contains every cook's pay and the sales array.
- **Never match a user to a cook by name or email.** Not in code, not as a pre-selected default in a picker. The link is always set deliberately by a manager.
- **`/api/tips/me` is the only STAFF-reachable tips endpoint.** Every other route under `/api/tips/*` uses `requireSession('MANAGER')` and must keep doing so.
- **Every API route must `export const dynamic = 'force-dynamic'`.** A GET handler without it is statically prerendered and every non-GET method on the route returns 405.
- **Polled/read routes return `Cache-Control: no-store`.**
- **Prisma `Decimal` fields deserialize as strings.** Wrap with `Number()` before arithmetic.
- **`linked: false` and "no payouts yet" are different states.** Never render `$0.00` for an unlinked account.
- Import Prisma from `src/lib/prisma.ts` only — never instantiate `PrismaClient`.
- Tailwind: use flat color tokens (`bg-red`, `text-red-text`, `text-ink-3`, `bg-gold-soft`, `text-gold-2`). Numbered classes are broken in this repo.
- Sub-components must be defined at module scope, never inside a client component body.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/lib/tips/me.ts` | Pure projection: one payout record + a cookId → one person's `MyPayout`, or null. No I/O. |
| `src/lib/tips/__tests__/me.test.ts` | Unit tests for the projection, including the key-whitelist guard. |
| `src/app/api/tips/me/route.ts` | The only STAFF-reachable tips endpoint. Loads periods, calls the projection. |
| `src/app/api/tips/me/__tests__/route.test.ts` | Route tests: unlinked, staff-allowed, cross-cook isolation, 401. |
| `src/app/tips/me/page.tsx` | The staff screen. Two tabs, four states. |
| `src/components/tips/MyPayoutDetail.tsx` | The Latest-tab detail renderer (hero, stat strip, day list). One copy, used by both tabs. |
| `prisma/migrations/20260821000000_cook_user_link/migration.sql` | Additive nullable column + unique index. |

**Modified:**

| Path | Change |
|---|---|
| `prisma/schema.prisma` | `Cook.userId` + relation; `User.cook` back-relation. |
| `src/app/api/tips/roster/[id]/route.ts` | PATCH accepts `userId`. |
| `src/app/api/tips/roster/__tests__/route.test.ts` | New PATCH cases. (Note: this file currently only tests POST — the PATCH tests are added to it.) |
| `src/lib/tips/types.ts` | `TipPeriodPayload` gains `userLinks` + `appUsers`. **Not** `TipPerson`. |
| `src/app/api/tips/periods/[id]/route.ts` | Populate `userLinks` + `appUsers`. |
| `src/components/tips/SettingsTab.tsx` | "App login" column in the roster table. |
| `src/lib/route-access.ts` | `['/tips/me', 'STAFF']`. |
| `src/lib/nav-items.ts` | `NavItem.staffHref`; `/tips` item gets `staffHref: '/tips/me'`. |
| `src/components/Navigation.tsx` | Resolve `staffHref` at render. |
| `src/lib/__tests__/nav-items.test.ts` | Assert every `staffHref` is STAFF-reachable. |
| `src/lib/__tests__/route-access.test.ts` | Assert `/tips/me` is STAFF and `/tips` still MANAGER. |

**Why account identity stays off `TipPerson`:** `TipPerson` flows into `SplitPerson`, which is frozen into `TipPeriod.snapshot` at pay time and is the input to the staff projection. Putting `userId` there would write account ids into every payout record forever and add a field the whitelist has to keep excluding. `userLinks` is a separate `Record<cookId, userId>` on the payload instead.

---

## Task 1: Schema — link a Cook to a User

**Files:**
- Modify: `prisma/schema.prisma:729-750` (Cook), `prisma/schema.prisma:33-45` (User)
- Create: `prisma/migrations/20260821000000_cook_user_link/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `Cook.userId: string | null`, `Cook.user: User | null`, `User.cook: Cook | null`. Every later task depends on this field existing in the generated client.

- [ ] **Step 1: Add the relation to the Cook model**

In `prisma/schema.prisma`, inside `model Cook`, after the `posPosition` line:

```prisma
  // The app login this roster row belongs to. Nullable because most cooks have
  // no account, and that is normal rather than broken. Unique so one login maps
  // to exactly one roster row — enforced in the DB so a race cannot produce a
  // double-link that shows somebody another person's pay. SetNull, never
  // Cascade: hard-deleting a user must not delete a roster row or erase tip
  // history (same call as ChatConversation.userId).
  //
  // ALWAYS set deliberately by a manager. Never matched from name or email —
  // this domain already fixed that rule for hours (see clockId above), and
  // money is where a wrong guess is worst.
  userId      String? @unique
  user        User?   @relation(fields: [userId], references: [id], onDelete: SetNull)
```

- [ ] **Step 2: Add the back-relation to the User model**

In `model User`, after the `scopes UserScope[]` line:

```prisma
  cook              Cook?
```

- [ ] **Step 3: Validate the schema parses**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 4: Write the migration SQL by hand**

This repo's shadow database is broken (P3006), so `prisma migrate dev` cannot generate this. Create `prisma/migrations/20260821000000_cook_user_link/migration.sql`:

```sql
-- Link a roster row to an app login. Additive and nullable: no backfill.
ALTER TABLE "Cook" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- One login ↔ one roster row. Enforced here, not just in app code, so two
-- concurrent PATCHes cannot both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS "Cook_userId_key" ON "Cook"("userId");

ALTER TABLE "Cook" DROP CONSTRAINT IF EXISTS "Cook_userId_fkey";
ALTER TABLE "Cook" ADD CONSTRAINT "Cook_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

`IF NOT EXISTS` throughout so a re-run on a database that already has the column self-heals rather than failing the deploy.

- [ ] **Step 5: Apply the migration to the database**

The session pooler is required — `DIRECT_URL` is IPv6-only and unreachable from here. Use `DATABASE_URL` on port 5432 with no `pgbouncer` parameter.

Run: `npx prisma db execute --file prisma/migrations/20260821000000_cook_user_link/migration.sql --schema prisma/schema.prisma`
Expected: `Script executed successfully.`

- [ ] **Step 6: Mark the migration applied so the history stays consistent**

Run: `npx prisma migrate resolve --applied 20260821000000_cook_user_link`
Expected: `Migration 20260821000000_cook_user_link marked as applied.`

- [ ] **Step 7: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `Generated Prisma Client ... in NNNms`

- [ ] **Step 8: Verify the column is queryable through the generated client**

Run:
```bash
npx tsx -e "import{prisma}from'./src/lib/prisma';prisma.cook.findFirst({select:{id:true,userId:true}}).then(r=>{console.log('OK',r);process.exit(0)}).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```
Expected: `OK` followed by a row (or `OK null` on an empty table). A failure here means the migration did not reach the database.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260821000000_cook_user_link
git commit -m "feat(tips): link a Cook roster row to an app User"
```

---

## Task 2: The projection — `src/lib/tips/me.ts`

The security spine of the feature. Pure, no I/O, fully unit-tested.

**Files:**
- Create: `src/lib/tips/me.ts`
- Test: `src/lib/tips/__tests__/me.test.ts`

**Interfaces:**
- Consumes: `readSnapshot`, `payoutsInOrder` from `src/lib/tips/snapshot.ts`; `effectiveHours`, `cappedAway` from `src/lib/tips/engine.ts`; `SplitPerson`, `TipPayoutRecord` types from `src/lib/tips/types.ts`.
- Produces:
  ```ts
  export interface MyPayoutDay { label: string; hours: number; rawHours: number; capped: boolean; boost: number; edited: boolean; amount: number }
  export interface MyPayout { periodId: string; startDate: string; endDate: string; paidAt: string; paidByName: string | null; status: 'PAID' | 'BEING_CORRECTED'; roleName: string; multiplier: number; dailyHourCap: number | null; hoursTotal: number; tip: number; envelopeCents: number; perHour: number; days: MyPayoutDay[] }
  export function projectMyPayout(input: { periodId: string; startDate: string; endDate: string; snapshotRaw: unknown; cookId: string }): MyPayout | null
  export const MY_PAYOUT_LIMIT: number  // 26
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/tips/__tests__/me.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { projectMyPayout, type MyPayout } from '@/lib/tips/me'
import type { SplitPerson, TipPayoutRecord } from '@/lib/tips/types'

// The complete set of keys a staff response may contain. Written out BY HAND
// on purpose — this is an independent statement of the disclosure boundary, not
// a mirror of the implementation. If someone adds a field to SplitPerson and it
// reaches the output, this test fails.
const ALLOWED_TOP = [
  'periodId', 'startDate', 'endDate', 'paidAt', 'paidByName', 'status',
  'roleName', 'multiplier', 'dailyHourCap', 'hoursTotal', 'tip',
  'envelopeCents', 'perHour', 'days',
].sort()

const ALLOWED_DAY = [
  'label', 'hours', 'rawHours', 'capped', 'boost', 'edited', 'amount',
].sort()

function person(over: Partial<SplitPerson> = {}): SplitPerson {
  return {
    cookId: 'cook-1', name: 'Sam', lastName: 'Lee', clockId: '4521',
    wage: 21.5, roleId: 'role-1', onPool: true, dailyHourCap: 9,
    hours: [8, 9.5, 0], boosts: [1, 1.5, 1], edited: [false, true, false],
    multiplier: 1.25, roleName: 'Line Cook',
    hoursTotal: 17, weighted: 23.5, daily: [52.1, 88.4, 0],
    tip: 140.5, envelopeCents: 14100,
    ...over,
  } as SplitPerson
}

function record(over: Partial<TipPayoutRecord> = {}): TipPayoutRecord {
  return {
    seq: 1,
    paidAt: '2026-08-18T17:00:00.000Z',
    paidByName: 'Alex Fern',
    poolBasis: 'NET_SALES',
    poolRatePct: 5,
    roundingStepCents: 100,
    dayLabels: ['Mon 4', 'Tue 5', 'Wed 6'],
    basis: [4000, 5000, 3000],
    sales: [4000, 5000, 3000],
    tips: [700, 800, 600],
    tipTotal: 2100,
    roles: [{ id: 'role-1', name: 'Line Cook', multiplier: 1.25, sortOrder: 0 }],
    split: {
      pools: [200, 250, 150], poolTotal: 600, distributedTotal: 600,
      weightedByDay: [10, 12, 8], crewByDay: [3, 4, 2],
      people: [person(), person({ cookId: 'cook-2', name: 'Kim', tip: 99, daily: [30, 39, 30] })],
      hoursTotal: 40, weightedTotal: 60, envelopeTotalCents: 60000,
    },
    audit: { findings: [] },
    ...over,
  } as unknown as TipPayoutRecord
}

const snap = (over: Record<string, unknown> = {}) => ({
  version: 1, current: record(), history: [], trimmed: 0, ...over,
})

const call = (snapshotRaw: unknown, cookId = 'cook-1') =>
  projectMyPayout({
    periodId: 'p1', startDate: '2026-08-04', endDate: '2026-08-06',
    snapshotRaw, cookId,
  })

describe('projectMyPayout — disclosure boundary', () => {
  it('emits exactly the permitted top-level keys and nothing else', () => {
    const out = call(snap()) as MyPayout
    expect(Object.keys(out).sort()).toEqual(ALLOWED_TOP)
  })

  it('emits exactly the permitted day keys and nothing else', () => {
    const out = call(snap()) as MyPayout
    for (const day of out.days) {
      expect(Object.keys(day).sort()).toEqual(ALLOWED_DAY)
    }
  })

  it('leaks no house figure anywhere in the serialized output', () => {
    const json = JSON.stringify(call(snap()))
    // Pool/sales values present in the fixture that must never survive.
    for (const forbidden of ['poolTotal', 'crewByDay', 'weightedByDay', 'poolRatePct', 'distributedTotal', 'weighted', 'wage', 'clockId']) {
      expect(json).not.toContain(forbidden)
    }
  })

  it('never includes another person on the pool', () => {
    const json = JSON.stringify(call(snap()))
    expect(json).not.toContain('Kim')
    expect(json).not.toContain('cook-2')
  })
})

describe('projectMyPayout — payout selection', () => {
  it('reads the current payout and reports PAID', () => {
    expect(call(snap())?.status).toBe('PAID')
  })

  it('reads the last real payout of a REOPENED period and flags it', () => {
    // reopenSnapshot pushes current onto history and nulls current. The payout
    // still happened — the cook is holding the cash — so it must still show.
    const reopened = snap({ current: null, history: [record({ seq: 1, paidAt: '2026-08-18T17:00:00.000Z' })] })
    const out = call(reopened)
    expect(out?.status).toBe('BEING_CORRECTED')
    expect(out?.tip).toBe(140.5)
  })

  it('prefers the newest payout when a period was paid, reopened and re-paid', () => {
    const rePaid = snap({
      current: record({ seq: 2, split: { ...record().split, people: [person({ tip: 155.75 })] } }),
      history: [record({ seq: 1 })],
    })
    expect(call(rePaid)?.tip).toBe(155.75)
  })

  it('migrates a legacy flat snapshot through readSnapshot', () => {
    const legacy = { ...record(), paidByName: undefined }
    const out = call(legacy)
    expect(out?.tip).toBe(140.5)
    expect(out?.paidByName).toBeNull()
  })

  it('returns null when the snapshot is absent or unrecognisable', () => {
    expect(call(null)).toBeNull()
    expect(call({ nonsense: true })).toBeNull()
  })

  it('returns null — not a zero row — when the cook is not in the split', () => {
    expect(call(snap(), 'cook-absent')).toBeNull()
  })
})

describe('projectMyPayout — per-person figures', () => {
  it('caps hours at the person’s own contracted cap and marks the day', () => {
    const out = call(snap()) as MyPayout
    expect(out.days[1].rawHours).toBe(9.5)
    expect(out.days[1].hours).toBe(9)
    expect(out.days[1].capped).toBe(true)
    expect(out.days[0].capped).toBe(false)
  })

  it('treats a zero or negative cap as uncapped', () => {
    const s = snap({ current: record({ split: { ...record().split, people: [person({ dailyHourCap: 0 })] } }) })
    const out = call(s) as MyPayout
    expect(out.dailyHourCap).toBeNull()
    expect(out.days[1].hours).toBe(9.5)
    expect(out.days[1].capped).toBe(false)
  })

  it('carries the reward boost and the manual-edit marker per day', () => {
    const out = call(snap()) as MyPayout
    expect(out.days[1].boost).toBe(1.5)
    expect(out.days[1].edited).toBe(true)
    expect(out.days[0].boost).toBe(1)
    expect(out.days[0].edited).toBe(false)
  })

  it('computes perHour from the person’s own tip and hours', () => {
    const out = call(snap()) as MyPayout
    expect(out.perHour).toBeCloseTo(8.26, 2) // 140.50 / 17
  })

  it('guards perHour against zero hours instead of returning Infinity', () => {
    const s = snap({ current: record({ split: { ...record().split, people: [person({ hoursTotal: 0, tip: 0 })] } }) })
    expect(call(s)?.perHour).toBe(0)
  })

  it('carries the envelope and the exact tip separately', () => {
    const out = call(snap()) as MyPayout
    expect(out.tip).toBe(140.5)
    expect(out.envelopeCents).toBe(14100)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/tips/__tests__/me.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/tips/me"`

- [ ] **Step 3: Write the implementation**

Create `src/lib/tips/me.ts`:

```ts
/**
 * ONE person's view of ONE payout.
 *
 * THIS FILE IS A DISCLOSURE BOUNDARY. `TipPeriod.snapshot` holds every cook's
 * pay, the sales series, and the pool totals; this is the only thing that turns
 * it into something a STAFF user may see. The transform therefore CONSTRUCTS A
 * NEW OBJECT field by field. Never spread a record or a SplitPerson here, and
 * never "remove" fields from a copy — a field added to SplitPerson later would
 * ride straight through a spread into a cook's phone. The key-whitelist test in
 * __tests__/me.test.ts is what keeps this honest.
 *
 * Pure and I/O-free so `npm test` covers it directly, like engine/audit/period.
 */
import { effectiveHours } from './engine'
import { payoutsInOrder, readSnapshot } from './snapshot'
import type { SplitPerson } from './types'

/** Most recent periods served to a staff user — a year of fortnights. */
export const MY_PAYOUT_LIMIT = 26

export interface MyPayoutDay {
  label: string
  /** Hours actually paid on — clipped by this person's cap. */
  hours: number
  /** Hours as clocked, so a cap is explicable rather than mysterious. */
  rawHours: number
  capped: boolean
  /** Reward multiplier. 1 = none. */
  boost: number
  /** Hours came from a manual adjustment rather than the clock file. */
  edited: boolean
  amount: number
}

export interface MyPayout {
  periodId: string
  startDate: string
  endDate: string
  paidAt: string
  paidByName: string | null
  /** BEING_CORRECTED when the period was reopened after this payout. */
  status: 'PAID' | 'BEING_CORRECTED'
  roleName: string
  multiplier: number
  dailyHourCap: number | null
  hoursTotal: number
  /** Exact dollars earned. */
  tip: number
  /** Rounded cash actually handed over. */
  envelopeCents: number
  perHour: number
  days: MyPayoutDay[]
}

export interface ProjectMyPayoutInput {
  periodId: string
  startDate: string
  endDate: string
  /** The raw `TipPeriod.snapshot` column. Decoded here via readSnapshot. */
  snapshotRaw: unknown
  cookId: string
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function projectMyPayout({
  periodId, startDate, endDate, snapshotRaw, cookId,
}: ProjectMyPayoutInput): MyPayout | null {
  // Always through readSnapshot — a legacy flat snapshot must migrate to v1
  // before anything reads it, and an unrecognisable blob must read as "no
  // payout" rather than being presented as one.
  const snap = readSnapshot(snapshotRaw)
  if (!snap) return null

  // The LAST payout actually made, whether or not it is still in force. A
  // reopened period has current: null but the cook is still holding the cash;
  // reading `current` alone would erase that payout from their phone.
  const all = payoutsInOrder(snap)
  const record = all[all.length - 1]
  if (!record) return null

  const me = record.split?.people?.find(p => p.cookId === cookId)
  if (!me) return null

  // A cap only applies when it is greater than zero — same rule as
  // effectiveHours, which this delegates the actual clipping to.
  const rawCap = num(me.dailyHourCap, 0)
  const cap = rawCap > 0 ? rawCap : null

  const labels = Array.isArray(record.dayLabels) ? record.dayLabels : []
  const days: MyPayoutDay[] = labels.map((label, d) => {
    const rawHours = num(me.hours?.[d])
    const hours = effectiveHours(me as SplitPerson, d)
    return {
      label: String(label),
      hours,
      rawHours,
      capped: rawHours > hours,
      boost: num(me.boosts?.[d], 1),
      edited: me.edited?.[d] === true,
      amount: num(me.daily?.[d]),
    }
  })

  const hoursTotal = num(me.hoursTotal)
  const tip = num(me.tip)

  return {
    periodId,
    startDate,
    endDate,
    paidAt: String(record.paidAt),
    paidByName: record.paidByName ?? null,
    status: snap.current ? 'PAID' : 'BEING_CORRECTED',
    roleName: String(me.roleName ?? ''),
    multiplier: num(me.multiplier, 1),
    dailyHourCap: cap,
    hoursTotal,
    tip,
    envelopeCents: num(me.envelopeCents),
    // Zero hours must read as $0.00/h, never Infinity or NaN.
    perHour: hoursTotal > 0 ? Math.round((tip / hoursTotal) * 100) / 100 : 0,
    days,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/tips/__tests__/me.test.ts`
Expected: PASS — all 16 tests in the file pass

- [ ] **Step 5: Run the whole suite to confirm nothing regressed**

Run: `npm test`
Expected: all files pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/tips/me.ts src/lib/tips/__tests__/me.test.ts
git commit -m "feat(tips): whitelist projection of one person's payout"
```

---

## Task 3: `GET /api/tips/me`

**Files:**
- Create: `src/app/api/tips/me/route.ts`
- Test: `src/app/api/tips/me/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `projectMyPayout`, `MY_PAYOUT_LIMIT`, `MyPayout` from Task 2; `requireSession`, `AuthError` from `src/lib/auth.ts`.
- Produces: `GET /api/tips/me` returning `{ linked: false }` or `{ linked: true, name: string, payouts: MyPayout[] }`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/tips/me/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same vi.mock-of-Prisma pattern as src/app/api/tips/roster/__tests__/route.test.ts.
const cookFindUnique = vi.fn()
const periodFindMany = vi.fn()
const requireSession = vi.fn()

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cook: { findUnique: (...a: unknown[]) => cookFindUnique(...(a as [])) },
    tipPeriod: { findMany: (...a: unknown[]) => periodFindMany(...(a as [])) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))

const { GET } = await import('@/app/api/tips/me/route')

const splitPerson = (cookId: string, tip: number, name: string) => ({
  cookId, name, lastName: 'X', clockId: '1', wage: 20, roleId: 'r1',
  onPool: true, dailyHourCap: 9, hours: [8], boosts: [1], edited: [false],
  multiplier: 1.25, roleName: 'Line Cook', hoursTotal: 8, weighted: 10,
  daily: [tip], tip, envelopeCents: Math.round(tip) * 100,
})

const snapshot = (people: ReturnType<typeof splitPerson>[]) => ({
  version: 1,
  current: {
    seq: 1, paidAt: '2026-08-18T17:00:00.000Z', paidByName: 'Alex',
    poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
    dayLabels: ['Mon 4'], basis: [4000], sales: [4000], tips: [700],
    tipTotal: 700, roles: [],
    split: {
      pools: [200], poolTotal: 200, distributedTotal: 200,
      weightedByDay: [10], crewByDay: [2], people,
      hoursTotal: 16, weightedTotal: 20, envelopeTotalCents: 20000,
    },
    audit: { findings: [] },
  },
  history: [], trimmed: 0,
})

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockResolvedValue({ id: 'u1', name: 'Sam', role: 'STAFF', isActive: true })
  cookFindUnique.mockResolvedValue(null)
  periodFindMany.mockResolvedValue([])
})

describe('GET /api/tips/me', () => {
  it('is reachable by a STAFF user — no minRole is passed to requireSession', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(requireSession).toHaveBeenCalledWith()
  })

  it('reports linked: false for a user with no roster row, with status 200', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ linked: false })
  })

  it('reports an empty payout list for a linked cook who has never been paid', async () => {
    cookFindUnique.mockResolvedValue({ id: 'cook-1', name: 'Sam' })
    const res = await GET()
    expect(await res.json()).toEqual({ linked: true, name: 'Sam', payouts: [] })
  })

  it('returns only the caller’s own figures, never another cook’s', async () => {
    cookFindUnique.mockResolvedValue({ id: 'cook-1', name: 'Sam' })
    periodFindMany.mockResolvedValue([{
      id: 'p1', startDate: '2026-08-04', endDate: '2026-08-17',
      snapshot: snapshot([splitPerson('cook-1', 140.5, 'Sam'), splitPerson('cook-2', 999.99, 'Kim')]),
    }])
    const res = await GET()
    const body = await res.json()
    expect(body.payouts).toHaveLength(1)
    expect(body.payouts[0].tip).toBe(140.5)
    const json = JSON.stringify(body)
    expect(json).not.toContain('999.99')
    expect(json).not.toContain('Kim')
    expect(json).not.toContain('poolTotal')
  })

  it('drops periods the caller was not paid in rather than emitting a zero row', async () => {
    cookFindUnique.mockResolvedValue({ id: 'cook-1', name: 'Sam' })
    periodFindMany.mockResolvedValue([
      { id: 'p1', startDate: '2026-08-04', endDate: '2026-08-17', snapshot: snapshot([splitPerson('cook-2', 50, 'Kim')]) },
      { id: 'p2', startDate: '2026-07-21', endDate: '2026-08-03', snapshot: snapshot([splitPerson('cook-1', 120, 'Sam')]) },
    ])
    const body = await (await GET()).json()
    expect(body.payouts).toHaveLength(1)
    expect(body.payouts[0].periodId).toBe('p2')
  })

  it('sets no-store so a payout is never served from cache', async () => {
    const res = await GET()
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('returns 401 when there is no session', async () => {
    requireSession.mockRejectedValue(new MockAuthError(401, 'Unauthorized'))
    const res = await GET()
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/api/tips/me/__tests__/route.test.ts`
Expected: FAIL — `Failed to resolve import "@/app/api/tips/me/route"`

- [ ] **Step 3: Write the route**

Create `src/app/api/tips/me/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { MY_PAYOUT_LIMIT, projectMyPayout, type MyPayout } from '@/lib/tips/me'

export const dynamic = 'force-dynamic'

/**
 * The caller's OWN tip payouts. THE ONLY STAFF-REACHABLE TIPS ENDPOINT — every
 * other route under /api/tips/* is requireSession('MANAGER') and must stay that
 * way. Deliberately no minRole here: a manager who is also on the roster reads
 * their own pay through the same door.
 *
 * Paid periods only. A DRAFT recomputes whenever hours, a rate or an import
 * change, so it must never be served as though it were settled.
 *
 * Nothing here shapes the response — `projectMyPayout` is the whitelist, and it
 * is the only thing that ever touches a snapshot record.
 */
export async function GET() {
  try {
    const user = await requireSession()

    const cook = await prisma.cook.findUnique({
      where: { userId: user.id },
      select: { id: true, name: true },
    })
    // NOT a 404: the caller is a perfectly valid user who simply has no roster
    // row. The screen must say "ask a manager to link you", never "$0.00".
    if (!cook) {
      return NextResponse.json({ linked: false }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // Every period that has EVER been paid — including reopened ones, whose
    // snapshot survives with current: null. Capped before projection, so a cook
    // who was off the pool for some of them correctly sees fewer rows.
    const periods = await prisma.tipPeriod.findMany({
      where: { snapshot: { not: Prisma.JsonNull } },
      orderBy: { startDate: 'desc' },
      take: MY_PAYOUT_LIMIT,
      select: { id: true, startDate: true, endDate: true, snapshot: true },
    })

    const payouts = periods
      .map(p => projectMyPayout({
        periodId: p.id,
        startDate: p.startDate,
        endDate: p.endDate,
        snapshotRaw: p.snapshot,
        cookId: cook.id,
      }))
      .filter((p): p is MyPayout => p !== null)

    return NextResponse.json(
      { linked: true, name: cook.name, payouts },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
```

The route imports `Prisma` from `@prisma/client` for `Prisma.JsonNull`, so the test file needs that module mocked too. Add to the mocks at the top of `src/app/api/tips/me/__tests__/route.test.ts`:

```ts
vi.mock('@prisma/client', () => ({ Prisma: { JsonNull: null } }))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/tips/me/__tests__/route.test.ts`
Expected: PASS — 7 tests passed

- [ ] **Step 5: Confirm no other tips route was relaxed**

Run: `grep -rn "requireSession" src/app/api/tips/ --include=route.ts`
Expected: every line reads `requireSession('MANAGER')` except the one in `me/route.ts`, which reads `requireSession()`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/tips/me
git commit -m "feat(tips): GET /api/tips/me serves a staff user their own payouts"
```

---

## Task 4: Roster PATCH accepts `userId`

**Files:**
- Modify: `src/app/api/tips/roster/[id]/route.ts:53-79`
- Test: `src/app/api/tips/roster/__tests__/route.test.ts` (append a PATCH describe block)

**Interfaces:**
- Consumes: `Cook.userId` from Task 1.
- Produces: `PATCH /api/tips/roster/[id]` accepting `{ userId: string | null }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/api/tips/roster/__tests__/route.test.ts`. The existing mock at the top of that file must first be extended — add `update` to the `cook` mock and a `user` model:

```ts
const cookUpdate = vi.fn(async () => ({ id: 'c1', name: 'Sam' }))
const userFindUnique = vi.fn(async () => null as { id: string; isActive: boolean } | null)
```

and inside the existing `vi.mock('@/lib/prisma', ...)` factory, add to `cook` and alongside it:

```ts
      update: (...a: unknown[]) => cookUpdate(...(a as [])),
    },
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...(a as [])),
    },
```

Then append:

```ts
const { PATCH } = await import('@/app/api/tips/roster/[id]/route')

const patchReq = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest
const ctx = { params: { id: 'c1' } }

describe('PATCH /api/tips/roster/[id] — app login link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireSession.mockResolvedValue({ id: 'u9', role: 'MANAGER', isActive: true })
    cookFindUnique.mockResolvedValue({ id: 'c1', name: 'Sam', clockId: '4521' })
    cookUpdate.mockResolvedValue({ id: 'c1', name: 'Sam' })
    userFindUnique.mockResolvedValue(null)
  })

  it('links an active user', async () => {
    userFindUnique.mockResolvedValue({ id: 'u1', isActive: true })
    const res = await PATCH(patchReq({ userId: 'u1' }), ctx)
    expect(res.status).toBe(200)
    expect(cookUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { userId: 'u1' } }))
  })

  it('clears the link when userId is null', async () => {
    const res = await PATCH(patchReq({ userId: null }), ctx)
    expect(res.status).toBe(200)
    expect(cookUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { userId: null } }))
  })

  it('rejects an unknown user with 400', async () => {
    userFindUnique.mockResolvedValue(null)
    const res = await PATCH(patchReq({ userId: 'nope' }), ctx)
    expect(res.status).toBe(400)
  })

  it('rejects a deactivated user with 400', async () => {
    userFindUnique.mockResolvedValue({ id: 'u1', isActive: false })
    const res = await PATCH(patchReq({ userId: 'u1' }), ctx)
    expect(res.status).toBe(400)
  })

  it('returns 409 naming the cook who already holds that login', async () => {
    userFindUnique.mockResolvedValue({ id: 'u1', isActive: true })
    // Second cook.findUnique call — the { where: { userId } } clash pre-check.
    cookFindUnique
      .mockResolvedValueOnce({ id: 'c1', name: 'Sam', clockId: '4521' })
      .mockResolvedValueOnce({ id: 'c2', name: 'Maria Sandoval' })
    const res = await PATCH(patchReq({ userId: 'u1' }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('Maria Sandoval')
  })

  it('maps a P2002 race on userId to the same readable 409', async () => {
    userFindUnique.mockResolvedValue({ id: 'u1', isActive: true })
    cookFindUnique
      .mockResolvedValueOnce({ id: 'c1', name: 'Sam', clockId: '4521' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c2', name: 'Maria Sandoval' })
    cookUpdate.mockRejectedValue(new MockPrismaClientKnownRequestError('unique', 'P2002'))
    const res = await PATCH(patchReq({ userId: 'u1' }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('Maria Sandoval')
  })

  it('leaves the link untouched when userId is absent from the body', async () => {
    await PATCH(patchReq({ lastName: 'Lee' }), ctx)
    expect(cookUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { lastName: 'Lee' } }))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/api/tips/roster/__tests__/route.test.ts`
Expected: FAIL — the link tests fail because `userId` is ignored, so `cookUpdate` is called with `{}`.

- [ ] **Step 3: Handle `userId` in the PATCH body**

In `src/app/api/tips/roster/[id]/route.ts`, immediately after the `body.clockId` block (which ends at line 62 with its closing brace), insert:

```ts
    // The app login this roster row belongs to. Deliberately explicit: nothing
    // in this route ever infers a link from a name or an email.
    if (body.userId !== undefined) {
      if (body.userId === null || body.userId === '') data.userId = null
      else {
        const id = String(body.userId)
        const account = await prisma.user.findUnique({ where: { id }, select: { id: true, isActive: true } })
        if (!account || !account.isActive)
          return NextResponse.json({ error: 'userId is not an active user' }, { status: 400 })
        const clash = await prisma.cook.findUnique({ where: { userId: id }, select: { id: true, name: true } })
        if (clash && clash.id !== params.id)
          return NextResponse.json({ error: `That login is already linked to ${clash.name}` }, { status: 409 })
        data.userId = id
      }
    }
```

- [ ] **Step 4: Map the P2002 race to the same 409**

In the same file, extend the `catch` around `prisma.cook.update`. Replace the existing single-condition block with:

```ts
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        if (typeof data.clockId === 'string') {
          const holder = await prisma.cook.findUnique({ where: { clockId: data.clockId as string } })
          return NextResponse.json(
            { error: `Clock #${data.clockId} already belongs to ${holder?.name ?? 'another cook'}` },
            { status: 409 },
          )
        }
        if (typeof data.userId === 'string') {
          const holder = await prisma.cook.findUnique({ where: { userId: data.userId as string }, select: { name: true } })
          return NextResponse.json(
            { error: `That login is already linked to ${holder?.name ?? 'another cook'}` },
            { status: 409 },
          )
        }
      }
      throw e
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/tips/roster/__tests__/route.test.ts`
Expected: PASS — the existing POST tests plus 7 new PATCH tests

- [ ] **Step 6: Commit**

```bash
git add src/app/api/tips/roster
git commit -m "feat(tips): roster PATCH links a cook to an app login"
```

---

## Task 5: Expose the link on the payload and add the roster picker

**Files:**
- Modify: `src/lib/tips/types.ts` (`TipPeriodPayload`), `src/app/api/tips/periods/[id]/route.ts:61-160`, `src/components/tips/SettingsTab.tsx:24` (GRID) and the roster row

**Interfaces:**
- Consumes: `Cook.userId` from Task 1; `PATCH /api/tips/roster/[id]` from Task 4.
- Produces: `TipPeriodPayload.userLinks: Record<string, string>` (cookId → userId) and `TipPeriodPayload.appUsers: AppUserOption[]` where `interface AppUserOption { id: string; name: string | null; email: string }`.

- [ ] **Step 1: Add the payload fields**

In `src/lib/tips/types.ts`, add above `TipPeriodPayload`:

```ts
/** An app login a roster row can be linked to. */
export interface AppUserOption {
  id: string
  name: string | null
  email: string
}
```

and inside `TipPeriodPayload`, after `roster: TipPerson[]`:

```ts
  /**
   * cookId → linked app login. Kept OFF TipPerson on purpose: TipPerson becomes
   * SplitPerson, which is frozen into TipPeriod.snapshot at pay time and is the
   * input to the staff projection. Account ids have no business in a payout
   * record, and keeping them out is one less thing the whitelist must exclude.
   */
  userLinks: Record<string, string>
  /** Active app logins, for the roster's link picker. */
  appUsers: AppUserOption[]
```

- [ ] **Step 2: Populate them in the period route**

In `src/app/api/tips/periods/[id]/route.ts`, extend the `prisma.cook.findMany` select (around line 66) to include `userId: true`, then after the `roles` query add:

```ts
    // Active logins for the roster's link picker. MANAGER-gated by this route,
    // so no separate ADMIN users endpoint is needed. Sorted by name; the picker
    // NEVER pre-selects a suggestion.
    const appUsers = await prisma.user.findMany({
      where: { isActive: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      select: { id: true, name: true, email: true },
    })
    const userLinks: Record<string, string> = {}
    for (const c of cooks) if (c.userId) userLinks[c.id] = c.userId
```

and add `userLinks,` and `appUsers,` to the `payload` object beside `roster,`.

**Note:** `cooks` is passed to `resolveRoster` via `cooks.map(c => ({ ...c, ... }))`. `RosterCook` has no `userId` field, so the extra property is dropped by the structural type — `resolveRoster` builds `TipPerson` explicitly and never spreads its input. Verify this before moving on:

Run: `grep -n "userId" src/lib/tips/roster.ts`
Expected: no output. If `roster.ts` spreads its cook input, stop and thread `userId` around it instead.

- [ ] **Step 3: Add the App login column to the roster table**

In `src/components/tips/SettingsTab.tsx`, widen the grid at line 24 by inserting a column for the picker between Role and Hours:

```ts
const GRID = 'minmax(180px,1.4fr) 68px 78px 74px 100px 120px 50px 74px 48px 26px'
```

Add the header cell after `<span>Role</span>`:

```tsx
            <span title="The app login that sees this person's payouts at /tips/me">App login</span>
```

Add the picker cell in the row, immediately after the `<RoleSelect ... />` line:

```tsx
                <select
                  value={payload.userLinks[p.cookId] ?? ''}
                  onChange={e => onSaveRoster(p.cookId, { userId: e.target.value || null })}
                  title="Set deliberately — never guessed from a name or an email"
                  className="w-full text-[11.5px] bg-transparent border border-transparent rounded-md px-1.5 py-[5px] outline-none text-ink-2 hover:border-line focus:border-gold focus:bg-paper"
                >
                  <option value="">— none —</option>
                  {payload.appUsers.map(u => (
                    <option key={u.id} value={u.id}>{u.name || u.email}</option>
                  ))}
                </select>
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: `✓ Compiled successfully`. If it fails on a missing `userLinks`/`appUsers` in a test fixture or another `TipPeriodPayload` literal, add the two fields there (`userLinks: {}`, `appUsers: []`).

- [ ] **Step 5: Verify in the browser**

Start the dev server via `preview_start` with the `dev` configuration in `.claude/launch.json`, then:

1. Open `/tips` and select the **Tip settings** tab.
2. Confirm the roster table has an **App login** column reading "— none —" on every row.
3. Pick a user on one row.
4. Check `read_network_requests` for `PATCH /api/tips/roster/<id>` returning **200**.
5. Reload the page and confirm the selection persisted.
6. Set the *same* user on a *different* row. Confirm a **409** whose message names the first cook.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tips/types.ts src/app/api/tips/periods/\[id\]/route.ts src/components/tips/SettingsTab.tsx
git commit -m "feat(tips): roster picker for the app login link"
```

---

## Task 6: The `/tips/me` screen

Reachable at this point only by MANAGER+ — `requiredClearance('/tips/me')` still inherits `MANAGER` from the `/tips` prefix, so the page can be built and reviewed before the gate opens in Task 7.

**Files:**
- Create: `src/app/tips/me/page.tsx`, `src/components/tips/MyPayoutDetail.tsx`

**Interfaces:**
- Consumes: `GET /api/tips/me` from Task 3; `MyPayout`, `MyPayoutDay` types from Task 2; `money`, `hoursLabel` from `src/components/tips/kit.tsx`; `PageHead` from `src/components/layout/PageHead.tsx`.
- Produces: the route `/tips/me`.

- [ ] **Step 1: Write the detail renderer**

Create `src/components/tips/MyPayoutDetail.tsx`. Module scope, not nested — a sub-component defined inside a client component body remounts every render and loses focus.

```tsx
'use client'
import type { MyPayout, MyPayoutDay } from '@/lib/tips/me'
import { money, hoursLabel } from './kit'

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })

function DayRow({ day }: { day: MyPayoutDay }) {
  const worked = day.rawHours > 0
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-line last:border-b-0 text-[13px]">
      <span className="w-16 text-ink-3 shrink-0">{day.label}</span>
      <span className={`w-16 font-mono text-[12px] shrink-0 ${worked ? 'text-ink' : 'text-ink-4'}`}>
        {worked ? hoursLabel(day.hours) : 'off'}
      </span>
      <span className="flex gap-1 flex-wrap min-w-0">
        {day.boost > 1 && (
          <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-gold-soft text-gold-2">
            ×{day.boost}
          </span>
        )}
        {day.capped && (
          <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-red-soft text-red-text">
            capped {day.rawHours}
          </span>
        )}
        {day.edited && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-bg-2 text-ink-3">adjusted</span>
        )}
      </span>
      <span className={`ml-auto font-mono text-[12.5px] font-semibold shrink-0 ${worked ? 'text-ink' : 'text-ink-4'}`}>
        {worked ? money(day.amount) : '—'}
      </span>
    </div>
  )
}

export function MyPayoutDetail({ payout }: { payout: MyPayout }) {
  return (
    <div>
      {payout.status === 'BEING_CORRECTED' && (
        <div className="mb-4 rounded-lg border border-gold bg-gold-soft px-3 py-2 text-[12.5px] text-gold-2">
          This payout is being corrected — the amount may still change.
        </div>
      )}

      <div className="text-center py-4">
        <div className="text-[38px] font-semibold tracking-[-0.03em] leading-none text-ink">
          {money(payout.envelopeCents / 100)}
        </div>
        <div className="text-[12px] text-ink-3 mt-1.5">
          {payout.startDate} – {payout.endDate} · paid {dateLabel(payout.paidAt)}
          {payout.paidByName ? ` by ${payout.paidByName}` : ''}
        </div>
      </div>

      <div className="flex border border-line rounded-lg overflow-hidden my-4">
        {[
          { v: hoursLabel(payout.hoursTotal), l: 'hours' },
          { v: money(payout.perHour), l: 'per hour' },
          { v: money(payout.tip), l: 'earned' },
        ].map(s => (
          <div key={s.l} className="flex-1 py-2 text-center border-r border-line last:border-r-0">
            <b className="block text-[14px] font-semibold text-ink">{s.v}</b>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-3">{s.l}</span>
          </div>
        ))}
      </div>

      <div className="font-mono text-[10.5px] uppercase tracking-[0.02em] text-ink-3 mb-1">
        Your days
      </div>
      {payout.days.map((d, i) => <DayRow key={i} day={d} />)}

      <p className="mt-4 text-[11.5px] text-ink-3 leading-relaxed">
        <b className="text-ink font-medium">Earned</b> is the exact amount your hours came to.
        <b className="text-ink font-medium"> {money(payout.envelopeCents / 100)}</b> is the cash
        that was actually counted out, rounded to whole notes. The difference is rounding, not a deduction.
        {payout.dailyHourCap != null && ` Your contracted shift is ${payout.dailyHourCap} h — hours past it on a single day aren't tipped.`}
      </p>
    </div>
  )
}
```

- [ ] **Step 2: Write the page**

Create `src/app/tips/me/page.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { Banknote } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { MyPayoutDetail } from '@/components/tips/MyPayoutDetail'
import { money, hoursLabel } from '@/components/tips/kit'
import type { MyPayout } from '@/lib/tips/me'

type Data =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'unlinked' }
  | { state: 'ready'; name: string; payouts: MyPayout[] }

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-line rounded-xl bg-paper px-6 py-12 text-center">
      <p className="text-[15px] font-medium text-ink mb-1.5">{title}</p>
      <p className="text-[13px] text-ink-3 max-w-sm mx-auto leading-relaxed">{body}</p>
    </div>
  )
}

export default function MyTipsPage() {
  const [data, setData] = useState<Data>({ state: 'loading' })
  const [tab, setTab] = useState<'latest' | 'history'>('latest')
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    let live = true
    fetch('/api/tips/me')
      .then(async res => {
        if (!res.ok) throw new Error(`Couldn’t load your payouts (${res.status})`)
        return res.json()
      })
      .then(body => {
        if (!live) return
        if (!body.linked) return setData({ state: 'unlinked' })
        setData({ state: 'ready', name: body.name, payouts: body.payouts ?? [] })
      })
      .catch(e => live && setData({ state: 'error', message: e.message }))
    return () => { live = false }
  }, [])

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 md:py-8">
      <PageHead
        crumbs={<><Banknote size={12} /> TEAM / TIP PAYOUTS</>}
        title="Your tips"
        sub="What you were paid, and the hours it came from."
      />

      {data.state === 'loading' && (
        <div className="border border-line rounded-xl bg-paper h-64 animate-pulse" />
      )}

      {data.state === 'error' && (
        <div className="border border-line rounded-xl bg-paper px-6 py-10 text-center">
          <p className="text-[13.5px] text-ink-2 mb-3">{data.message}</p>
          <button
            onClick={() => { setData({ state: 'loading' }); location.reload() }}
            className="px-3.5 py-2 rounded border border-line bg-paper text-[13px] font-medium text-ink-2 hover:border-ink-3"
          >
            Try again
          </button>
        </div>
      )}

      {/* Never $0.00 — no account link and no money are different facts. */}
      {data.state === 'unlinked' && (
        <Empty
          title="Your payouts aren’t linked to your account yet"
          body="Ask a manager to link your login on the tips roster. Once they do, every payout shows up here."
        />
      )}

      {data.state === 'ready' && data.payouts.length === 0 && (
        <Empty
          title="No payouts yet"
          body="Your first one shows up here once it’s been paid out."
        />
      )}

      {data.state === 'ready' && data.payouts.length > 0 && (
        <>
          <div className="flex border-b border-line mb-5">
            {(['latest', 'history'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2.5 text-[13px] capitalize ${
                  tab === t ? 'text-ink font-semibold border-b-2 border-gold' : 'text-ink-3'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'latest' && <MyPayoutDetail payout={data.payouts[selected]} />}

          {tab === 'history' && (
            <div>
              {data.payouts.map((p, i) => (
                <button
                  key={p.periodId}
                  onClick={() => { setSelected(i); setTab('latest') }}
                  className="w-full flex items-center gap-3 border border-line rounded-lg px-3 py-2.5 mb-2 text-left hover:border-ink-3"
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{p.startDate} – {p.endDate}</span>
                    <span className="block font-mono text-[10.5px] text-ink-3">
                      {hoursLabel(p.hoursTotal)} · {money(p.perHour)}/h
                      {p.status === 'BEING_CORRECTED' ? ' · being corrected' : ''}
                    </span>
                  </span>
                  {/* Same figure the Latest headline shows, so the tabs never disagree. */}
                  <span className="ml-auto text-[17px] font-semibold text-ink shrink-0">
                    {money(p.envelopeCents / 100)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: `✓ Compiled successfully`, and `/tips/me` listed in the route table.

- [ ] **Step 4: Verify all four states in the browser**

With the dev server running (`preview_start`), and `DEV_AUTH_BYPASS=true` resolving you to an OWNER:

1. **Unlinked** — with no `Cook.userId` matching the bypass user, open `/tips/me`. Expect "Your payouts aren't linked to your account yet". Confirm **no `$0.00` appears anywhere** via `get_page_text`.
2. **Linked, no payouts** — on `/tips` → Tip settings, link your login to a roster row that has never been paid. Reload `/tips/me`. Expect "No payouts yet".
3. **Ready** — link your login to a cook who appears in a paid period. Reload. Expect the envelope, the stat strip, and the day list.
4. **History** — click the History tab, click a row, confirm it switches to Latest showing that period, and that the envelope figure matches the row you clicked.
5. Run `read_console_messages` with `onlyErrors: true`. Expect none.
6. `resize_window` to the `mobile` preset and screenshot — confirm the day rows and the stat strip do not overflow horizontally.

- [ ] **Step 5: Confirm the response carries no house data**

With `/tips/me` open, run `read_network_requests` for `/api/tips/me` and read the response body.
Expected: no `poolTotal`, `crewByDay`, `weightedByDay`, `sales`, `basis`, `poolRatePct`, or any `cookId` other than your own.

- [ ] **Step 6: Commit**

```bash
git add src/app/tips/me src/components/tips/MyPayoutDetail.tsx
git commit -m "feat(tips): the staff payout screen at /tips/me"
```

---

## Task 7: Open the gate — clearance and nav

Last on purpose: everything behind the gate now exists and is tested.

**Files:**
- Modify: `src/lib/route-access.ts:28`, `src/lib/nav-items.ts:11-17` and `:45`, `src/components/Navigation.tsx:115`
- Test: `src/lib/__tests__/route-access.test.ts`, `src/lib/__tests__/nav-items.test.ts`

**Interfaces:**
- Consumes: the `/tips/me` route from Task 6.
- Produces: `NavItem.staffHref?: string`; `/tips/me` reachable by STAFF.

- [ ] **Step 1: Write the failing tests**

In `src/lib/__tests__/route-access.test.ts`, add:

```ts
  it('opens /tips/me to STAFF while /tips stays MANAGER', () => {
    expect(requiredClearance('/tips/me')).toBe('STAFF')
    expect(requiredClearance('/tips')).toBe('MANAGER')
    expect(canAccess('STAFF', '/tips/me')).toBe(true)
    expect(canAccess('STAFF', '/tips')).toBe(false)
  })
```

Ensure `canAccess` is in that file's import list.

In `src/lib/__tests__/nav-items.test.ts`, add:

```ts
  it('gives every staffHref a destination STAFF can actually open', () => {
    const withStaff = allNavItems.filter(i => i.staffHref)
    // The tips item is the reason this field exists — if it disappears, this
    // test should fail rather than silently passing on an empty list.
    expect(withStaff.length).toBeGreaterThan(0)
    for (const item of withStaff) {
      expect(canAccess('STAFF', item.staffHref!)).toBe(true)
      // A staffHref is only meaningful when the primary href is gated.
      expect(canAccess('STAFF', item.href)).toBe(false)
    }
  })
```

and add `canAccess` to that file's `route-access` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/route-access.test.ts src/lib/__tests__/nav-items.test.ts`
Expected: FAIL — `requiredClearance('/tips/me')` returns `'MANAGER'` (inherited from the `/tips` prefix), and `staffHref` does not exist on `NavItem`.

- [ ] **Step 3: Open the route to STAFF**

In `src/lib/route-access.ts`, immediately after the `['/tips', 'MANAGER'],` line:

```ts
  // A staff member's OWN payouts. Narrower prefix, so longest-wins overrides
  // the MANAGER entry above for this path only — /tips itself is untouched and
  // the manager console stays gated in middleware, not in component code.
  ['/tips/me', 'STAFF'],
```

- [ ] **Step 4: Add `staffHref` to the nav table**

In `src/lib/nav-items.ts`, add to the `NavItem` type:

```ts
  /**
   * Where this item points for a user who cannot open `href`. A DESTINATION,
   * not a clearance — what anyone may open is still derived solely from an href
   * via requiredClearance(), so the menu still cannot advertise a page
   * middleware would bounce.
   */
  staffHref?: string
```

and change the tips entry:

```ts
      { href: '/tips', label: 'Tip payouts', icon: Banknote, staffHref: '/tips/me' },
```

- [ ] **Step 5: Resolve the destination in Navigation**

In `src/components/Navigation.tsx`, beside the existing `isLocked` helper at line 115, add:

```ts
  // Gated on `role != null` for the same reason isLocked is: while /api/me is
  // in flight, canAccess() denies everything, and resolving on that would point
  // every manager at the staff page for a frame.
  const destOf = (item: NavItem) =>
    item.staffHref && role != null && !canAccess(role, item.href) && canAccess(role, item.staffHref)
      ? item.staffHref
      : item.href
```

Then in each of the three places the file renders a nav link (the desktop group items, the setup items, and the mobile sheet items), replace `href={item.href}` with `href={destOf(item)}` and `const locked = isLocked(item.href)` with `const locked = isLocked(destOf(item))`.

Run `grep -n "isLocked(item.href)\|href={item.href}" src/components/Navigation.tsx` first to find every site; there are three of each.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/route-access.test.ts src/lib/__tests__/nav-items.test.ts`
Expected: PASS

- [ ] **Step 7: Run the whole suite and build**

Run: `npm test && npm run build`
Expected: all tests pass; `✓ Compiled successfully`; `/api/tips/me` shows as `ƒ (Dynamic)` in the route table, not `○ (Static)`.

- [ ] **Step 8: Verify as a real STAFF user in the browser**

`DEV_AUTH_BYPASS` resolves to an OWNER, so it cannot exercise this path. Either sign in as a real STAFF account, or temporarily set `DEV_AUTH_BYPASS=false` and log in as one.

1. Confirm the sidebar shows **Tip payouts with no padlock**.
2. Click it. Confirm the URL is `/tips/me` and the page renders.
3. Navigate directly to `/tips`. Confirm the **no-access** screen renders with the address bar still reading `/tips`.
4. Call `/api/tips/periods` directly from the browser console. Expect **403**.
5. As a MANAGER, confirm **Tip payouts** still goes to `/tips` and the console loads as before.

- [ ] **Step 9: Commit**

```bash
git add src/lib/route-access.ts src/lib/nav-items.ts src/components/Navigation.tsx src/lib/__tests__
git commit -m "feat(tips): open /tips/me to staff and point the nav item there"
```

---

## Done

Run once more at the end:

```bash
npm test && npm run build
```

Per this repo's history, `npm run build` bogus-fails in the main checkout while the dev server is running. Build in a detached worktree with symlinked `node_modules` and `.env`, and note that `next build` rewrites `tsconfig.json`.
