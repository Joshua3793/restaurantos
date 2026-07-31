# Tip Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/tips` — a persisted, auditable kitchen tip-pool payout run that divides a % of a daily basis (net sales **or** the tips customers actually left) across BOH staff by weighted hours, reconciles every clocked hour, and produces cash envelopes and a payroll export.

**Architecture:** A `TipPeriod` row owns one 14-day payout run (basis, rate, cap, rounding, imported punches, per-day adjustments, and a frozen snapshot once paid). The daily numbers come from the app's own `SalesEntry` rows through a **configurable scope** stored in `TipSettings` — the scope is independent of the revenue center the pool belongs to (tips for RC *Kitchen* can be driven by sales from Location *Cafe*). The **pool basis** is equally configurable: `NET_SALES` (the BOH pool is a % of sales) or `TIPS_COLLECTED` (the BOH pool is a % of the FOH tip pot). Customer tips are captured per day into a new `SalesEntry.tipsCollected` column, filled by the existing Toast sync — `Check.payments[].tipAmount` is already in the `ordersBulk` response the app fetches. A workbook import can override individual days. The roster is the existing `Cook` model extended with payroll fields. All split math and reconciliation live in pure isomorphic libs (`src/lib/tips/*`) so the page recomputes instantly as the manager drags the pool rate, and so the math is unit-tested by `npm test`.

**The FOH → BOH tip-out, stated once:** the customer's tips are the FOH pot. The BOH pool is a withdrawal from that pot, sized either as a % of sales (how Fergie's does it today) or as a % of the pot itself. Whichever basis is selected, the page **always** shows tips collected, the pool as a share of them, and the FOH remainder — so the withdrawal is legible and defensible to both sides of the pass.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind (flat design tokens) · lucide-react · `xlsx` (SheetJS, already a dependency) · vitest.

## Global Constraints

- **Design source of truth:** the Claude Design project `Controla OS`, file `app/Tips.html` (+ `app/tips.js`, `app/tips-audit.js`, `app/tips-xlsx.js`, `app/tips-data.js`, `app/shell.js`, `app/styles.css`). Every class in the mock's `<style>` block maps to a Tailwind token that already exists in `tailwind.config.ts`.
- **Colors:** use flat tokens only — `bg-paper`, `bg-bg-2`, `text-ink`, `text-ink-2`, `text-ink-3`, `text-ink-4`, `border-line`, `border-line-2`, `text-gold`, `text-gold-2`, `bg-gold-soft`, `red`, `red-soft`, `red-text`, `green`, `green-soft`, `green-text`, `blue`, `blue-soft`, `blue-text`. **Never** numbered Tailwind classes (`bg-red-500` is broken in this repo).
- **Every API route handler must guard itself** with `requireSession(minRole?)` from `@/lib/auth` and catch `AuthError` — API routes are excluded from middleware.
- **Every route file with a non-GET handler must `export const dynamic = 'force-dynamic'`** or the non-GET methods return 405 in production.
- **Prisma `Decimal` serialises to a string in JSON.** Every API mapper in this plan converts with `Number()` before returning.
- **Never use `$executeRaw` tagged templates for array columns** (pgBouncer transaction mode). This plan uses `Json` columns instead of `text[]` everywhere, so no raw SQL is needed at runtime.
- **`prisma migrate dev` is broken in this repo (P3006 shadow DB).** Migrations are hand-written SQL applied with `prisma db execute --url "$DIRECT_URL"` then registered with `prisma migrate resolve --applied`.
- **Currency:** CAD. Money strings use `toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`.
- **The daily hour cap is per person, never house-wide.** Some of the crew are on 10 h shift agreements and some on 8 h, so the cap is a contract term stored on `Cook.dailyHourCap`. There is no cap column on `TipPeriod` and no cap argument on `effectiveHours`. `TipSettings.defaultDailyHourCap` exists **only** to prefill a newly created roster row; changing it restates nothing.
- **Role gating:** `/tips` is MANAGER+. Tip-payroll fields on `Cook` are writable at MANAGER via `/api/tips/roster/*`; identity fields (`name`, `initials`, `homeStation`) stay ADMIN-only on the existing `/api/prep/cooks/*` routes.
- **Verification:** `npm test` after any change under `src/lib/tips/`; `npm run build` after any task that touches more than one file.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `prisma/migrations/20260731120000_tip_payouts/migration.sql` | Additive schema: 5 new tables, 6 new `Cook` columns, 2 new `SalesEntry` tip columns |
| `src/lib/toast/__tests__/tips.test.ts` | Coverage for `checkTipTotals` — voids, refunds, auto-gratuity |
| `src/lib/tips/period.ts` | Period window maths — start/end dates, 14 day labels, day index ↔ ISO date |
| `src/lib/tips/engine.ts` | **Pure.** The split: day pools, weighted hours, per-person tips, largest-remainder envelope rounding, denomination breakdown |
| `src/lib/tips/audit.ts` | **Pure.** Hours reconciliation ledger + findings (errors/warnings/info) with fix actions |
| `src/lib/tips/xlsx.ts` | **Server.** Parses the Toast *Sales Summary* and *Clocks Summary* workbooks via SheetJS |
| `src/lib/tips/sales.ts` | **Server-only.** Resolves the configured scope to RC ids and folds `SalesEntry` rows into 14 daily net-sales **and** tips-collected numbers; `selectBasis` picks which the rate applies to |
| `src/lib/tips/types.ts` | Shared DTOs crossing the API boundary |
| `src/app/api/tips/settings/route.ts` | Singleton `TipSettings` GET/PUT |
| `src/app/api/tips/roles/route.ts` · `src/app/api/tips/roles/[id]/route.ts` | `TipRole` CRUD |
| `src/app/api/tips/roster/route.ts` · `src/app/api/tips/roster/[id]/route.ts` | Tip-payroll fields on `Cook` |
| `src/app/api/tips/periods/route.ts` | List / open a period |
| `src/app/api/tips/periods/[id]/route.ts` | Full page payload (GET) + rate/cap/rounding/ignores (PATCH) |
| `src/app/api/tips/periods/[id]/import/route.ts` | Workbook upload → punches / sales override |
| `src/app/api/tips/periods/[id]/adjustments/route.ts` | Per-person-per-day hours override + reward boost |
| `src/app/api/tips/periods/[id]/pay/route.ts` | Freeze snapshot, mark PAID (and reopen) |
| `src/app/api/tips/periods/[id]/export/route.ts` | Payroll CSV |
| `src/app/tips/page.tsx` | Page shell: period selector, tip chrome strip, KPI row, tab state |
| `src/components/tips/kit.tsx` | Shared primitives: money/hours formatters, `DayStrip`, `WeightSelect`, `RoleChipClass`, `MethodNote` |
| `src/components/tips/SplitTab.tsx` | Sortable split table + expandable per-person day detail |
| `src/components/tips/DailyPoolsTab.tsx` | 14 day cards |
| `src/components/tips/CashTab.tsx` | Envelopes + bank order + drift |
| `src/components/tips/ChecksTab.tsx` | Findings, ledger, source files |
| `src/components/tips/ImportTab.tsx` | Two dropzones + paste fallback |
| `src/components/tips/SettingsTab.tsx` | Roster table, roles & multipliers, pool rules, **sales scope picker** |

**Modified**

| File | Change |
|---|---|
| `prisma/schema.prisma` | 5 new models, `Cook` extended, `SalesEntry.tipsCollected` + `.autoGratuity`, `RevenueCenter.tipPeriods` back-relation |
| `src/lib/toast/client.ts` | `ToastPayment` + `ToastAppliedServiceCharge` types, `ToastCheck.payments`/`.appliedServiceCharges`, `checkTipTotals()` |
| `src/lib/toast/sales-sync.ts` | Tips apportioned per revenue center by each check's routed revenue; both tip columns written on upsert |
| `src/app/api/sales/route.ts` · `src/app/sales/page.tsx` | Optional `tipsCollected` on a manual sales entry |
| `src/components/Navigation.tsx` | New `TEAM` nav group with `Tip payouts` (MANAGER+) |
| `src/middleware.ts` | `/tips` added to `MANAGER_PREFIXES` |
| `src/app/setup/page.tsx` | New setup card linking to `/tips` settings |
| `CLAUDE.md` | Page→API map row, new subsystem paragraph |

**Deliberate deviations from the mock** (record these in the PR description):

1. **Sales are app-native.** The mock reads net sales only from the workbook. Here they come from `SalesEntry` through a configurable scope; the workbook import becomes a per-day *override*. Rationale: the mock's numbers would silently disagree with `/sales` and `/reports`.
2. **Workbooks parse server-side** with the existing `xlsx` dependency rather than the mock's hand-rolled `DecompressionStream` unzip. Punches are persisted, so the mock's "nothing is uploaded" privacy line is dropped from the copy.
3. **Duplicate employee codes are impossible**, not a finding — `Cook.clockId` gets a unique index. The mock's `dupe-<code>` check is not ported.
4. **Largest-remainder rounding handles a negative remainder.** `tips.js` only ever increments (`for(...; left>0; left--)`), so when `poolTotal` rounds *down* the envelopes overshoot the target. The port decrements from the smallest fractional part in that case.
5. **The pool basis is selectable, and the FOH tip pot is always visible.** The mock only knows "% of net sales". Here `poolBasis` also accepts `TIPS_COLLECTED`, and the page shows tips collected, the tip-out %, and the FOH remainder regardless of which basis is in use — including a blocking `overdraw` error when a sales-sized pool exceeds the pot it is drawn from.

---

### Task 1: Schema & migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260731120000_tip_payouts/migration.sql`

**Interfaces:**
- Produces: Prisma models `TipSettings`, `TipRole`, `TipPeriod`, `TipPunch`, `TipDayAdjustment`; `Cook` gains `lastName`, `clockId`, `wage`, `tipRoleId`, `onTipPool`, `posPosition`.

- [ ] **Step 1: Add the models to `prisma/schema.prisma`**

Append at the end of the file:

```prisma
// ─────────────────────────── TIP PAYOUTS ───────────────────────────
// One tip pool run = one TipPeriod. Daily net sales are NOT stored on the
// period: they are read live from SalesEntry through the scope configured in
// TipSettings (which is deliberately independent of the pool's own RC — tips
// for RC "Kitchen" are commonly driven by sales for the whole "Cafe" location).
// salesOverride only exists for days the app has no SalesEntry row for.

model TipSettings {
  id                String   @id @default("singleton")
  // What the pool rate is a percentage OF.
  //   'NET_SALES'      → day pool = that day's net sales × rate
  //   'TIPS_COLLECTED' → day pool = the tips customers left that day × rate
  // The second is the direct FOH→BOH tip-out; the first sizes the same
  // withdrawal off sales instead. Both draw from the same FOH pot.
  poolBasis         String   @default("NET_SALES")
  // Count auto-gratuity (a service charge with gratuity = true) as customer
  // tips. Houses differ: some pay it out with the tip pot, some treat it as
  // revenue. Only affects tipsCollected, never net sales.
  includeAutoGratuity Boolean @default(true)
  poolRatePct       Decimal  @default(5)
  // PREFILL ONLY — never a live cap. The cap that actually applies is
  // Cook.dailyHourCap, because it is a contract term per person (some crew are
  // on 10 h agreements, some on 8 h). This value is only copied into a new
  // roster row's cap when one is created; changing it restates nothing.
  defaultDailyHourCap Decimal?
  rewardTiers       Json     @default("[1.25, 1.5, 2]")
  roundingStepCents Int      @default(100)
  periodDays        Int      @default(14)
  periodStartDow    Int      @default(0) // 0 = Sunday
  // Sales basis. mode 'LOCATION' → every active RC under salesLocationId.
  // mode 'RC' → exactly the ids in salesRcIds.
  salesSourceMode   String   @default("LOCATION")
  salesLocationId   String?
  salesRcIds        Json     @default("[]")
  // Which RC the pool itself belongs to (the crew side). Used for period keys
  // and access scoping — never for the sales basis.
  poolRevenueCenterId String?
  denoms            Json     @default("[{\"v\":10000,\"l\":\"$100\",\"on\":false},{\"v\":5000,\"l\":\"$50\",\"on\":true},{\"v\":2000,\"l\":\"$20\",\"on\":true},{\"v\":1000,\"l\":\"$10\",\"on\":true},{\"v\":500,\"l\":\"$5\",\"on\":true},{\"v\":200,\"l\":\"$2\",\"on\":true},{\"v\":100,\"l\":\"$1\",\"on\":true},{\"v\":25,\"l\":\"25¢\",\"on\":true},{\"v\":10,\"l\":\"10¢\",\"on\":true},{\"v\":5,\"l\":\"5¢\",\"on\":true}]")
  posMap            Json     @default("{}") // clock Position → TipRole.id
  poolDepartments   Json     @default("[\"Back of House\"]")
  updatedAt         DateTime @updatedAt
}

model TipRole {
  id         String  @id @default(cuid())
  name       String
  multiplier Decimal @default(1)
  sortOrder  Int     @default(0)
  isActive   Boolean @default(true)
  cooks      Cook[]
}

model TipPeriod {
  id                String   @id @default(cuid())
  revenueCenterId   String
  startDate         String   // 'YYYY-MM-DD', local business date
  endDate           String   // 'YYYY-MM-DD', inclusive
  status            String   @default("DRAFT") // 'DRAFT' | 'PAID'
  // Frozen from TipSettings when the period opens, so changing the house rule
  // later never silently restates a period somebody has already been paid for.
  poolBasis         String   @default("NET_SALES") // 'NET_SALES' | 'TIPS_COLLECTED'
  poolRatePct       Decimal
  // NO period-wide hour cap. The cap is a per-person contract term and lives on
  // Cook.dailyHourCap; what each person's cap WAS at payment time is preserved
  // in `snapshot`, which stores the resolved cap on every SplitPerson.
  roundingStepCents Int      @default(100)
  salesOverride     Json?    // number[] length = day count, or null
  tipsOverride      Json?    // number[] length = day count, or null
  salesFileName     String?
  clockFileName     String?
  salesImportedAt   DateTime?
  clockImportedAt   DateTime?
  ignoredClockIds   Json     @default("[]")
  paidAt            DateTime?
  paidByName        String?
  snapshot          Json?    // frozen SplitResult + audit at the moment of payment
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  revenueCenter     RevenueCenter      @relation("TipPeriodRC", fields: [revenueCenterId], references: [id])
  punches           TipPunch[]
  adjustments       TipDayAdjustment[]

  @@unique([revenueCenterId, startDate])
  @@index([revenueCenterId, status])
}

model TipPunch {
  id         String    @id @default(cuid())
  periodId   String
  clockId    String
  firstName  String
  lastName   String
  position   String
  department String
  dayIndex   Int
  hours      Decimal
  status     String    @default("Approved")
  note       String?
  period     TipPeriod @relation(fields: [periodId], references: [id], onDelete: Cascade)

  @@index([periodId])
  @@index([periodId, clockId])
}

model TipDayAdjustment {
  id       String    @id @default(cuid())
  periodId String
  cookId   String
  dayIndex Int
  hours    Decimal?  // null = use the clocked hours
  boost    Decimal   @default(1)
  period   TipPeriod @relation(fields: [periodId], references: [id], onDelete: Cascade)
  cook     Cook      @relation(fields: [cookId], references: [id], onDelete: Cascade)

  @@unique([periodId, cookId, dayIndex])
  @@index([periodId])
}
```

- [ ] **Step 2: Extend `Cook` and `RevenueCenter`**

Replace the `Cook` model (currently at `prisma/schema.prisma:681`) with:

```prisma
model Cook {
  id          String  @id @default(cuid())
  name        String
  initials    String
  homeStation String?
  isActive    Boolean @default(true)
  sortOrder   Int     @default(0)
  // ── tip payroll (see TipPeriod) ──
  lastName    String?
  clockId     String? @unique // POS employee number; the ONLY key hours match on
  wage        Decimal?        // reference only — never affects the split
  // Contracted shift length, in hours. Hours clocked ABOVE this on any single
  // day are not paid tips. Assigned per person, not house-wide: some of the
  // crew are on 10 h agreements and some on 8 h. Null = this person is uncapped.
  // Prefilled from TipSettings.defaultDailyHourCap when a roster row is created.
  dailyHourCap Decimal?
  tipRoleId   String?
  onTipPool   Boolean @default(true)
  posPosition String?         // last Position seen on the clock file
  tipRole     TipRole?           @relation(fields: [tipRoleId], references: [id], onDelete: SetNull)
  tipAdjustments TipDayAdjustment[]
}
```

Add one line to `model RevenueCenter` (after `services  Service[] @relation("ServiceRC")`):

```prisma
  tipPeriods        TipPeriod[]       @relation("TipPeriodRC")
```

Add one line to `model SalesEntry` (after `source  String  @default("manual")`):

```prisma
  // Customer tips for the day — the FOH pot the BOH pool is withdrawn from.
  // Kept as TWO columns because houses disagree about whether auto-gratuity is
  // a tip or revenue: tipsCollected is the sum of payment tips, autoGratuity is
  // the sum of service charges flagged gratuity. TipSettings.includeAutoGratuity
  // decides whether to add them AT READ TIME, so flipping the house rule
  // restates every period without re-syncing Toast.
  // NULLABLE ON PURPOSE: null means "we have no tip data for this day", which is
  // a blocking error when the pool basis is TIPS_COLLECTED. Zero means the day
  // genuinely took no tips. Never conflate the two.
  tipsCollected   Decimal?
  autoGratuity    Decimal?
```

- [ ] **Step 3: Hand-write the migration SQL**

Create `prisma/migrations/20260731120000_tip_payouts/migration.sql`:

```sql
-- Tip payouts: additive only. No existing column is altered or dropped.

CREATE TABLE "TipSettings" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "poolBasis" TEXT NOT NULL DEFAULT 'NET_SALES',
  "includeAutoGratuity" BOOLEAN NOT NULL DEFAULT true,
  "poolRatePct" DECIMAL(65,30) NOT NULL DEFAULT 5,
  "defaultDailyHourCap" DECIMAL(65,30),
  "rewardTiers" JSONB NOT NULL DEFAULT '[1.25, 1.5, 2]',
  "roundingStepCents" INTEGER NOT NULL DEFAULT 100,
  "periodDays" INTEGER NOT NULL DEFAULT 14,
  "periodStartDow" INTEGER NOT NULL DEFAULT 0,
  "salesSourceMode" TEXT NOT NULL DEFAULT 'LOCATION',
  "salesLocationId" TEXT,
  "salesRcIds" JSONB NOT NULL DEFAULT '[]',
  "poolRevenueCenterId" TEXT,
  "denoms" JSONB NOT NULL DEFAULT '[{"v":10000,"l":"$100","on":false},{"v":5000,"l":"$50","on":true},{"v":2000,"l":"$20","on":true},{"v":1000,"l":"$10","on":true},{"v":500,"l":"$5","on":true},{"v":200,"l":"$2","on":true},{"v":100,"l":"$1","on":true},{"v":25,"l":"25¢","on":true},{"v":10,"l":"10¢","on":true},{"v":5,"l":"5¢","on":true}]',
  "posMap" JSONB NOT NULL DEFAULT '{}',
  "poolDepartments" JSONB NOT NULL DEFAULT '["Back of House"]',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TipSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TipRole" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "multiplier" DECIMAL(65,30) NOT NULL DEFAULT 1,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "TipRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TipPeriod" (
  "id" TEXT NOT NULL,
  "revenueCenterId" TEXT NOT NULL,
  "startDate" TEXT NOT NULL,
  "endDate" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "poolBasis" TEXT NOT NULL DEFAULT 'NET_SALES',
  "poolRatePct" DECIMAL(65,30) NOT NULL,
  "roundingStepCents" INTEGER NOT NULL DEFAULT 100,
  "salesOverride" JSONB,
  "tipsOverride" JSONB,
  "salesFileName" TEXT,
  "clockFileName" TEXT,
  "salesImportedAt" TIMESTAMP(3),
  "clockImportedAt" TIMESTAMP(3),
  "ignoredClockIds" JSONB NOT NULL DEFAULT '[]',
  "paidAt" TIMESTAMP(3),
  "paidByName" TEXT,
  "snapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TipPeriod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TipPunch" (
  "id" TEXT NOT NULL,
  "periodId" TEXT NOT NULL,
  "clockId" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "position" TEXT NOT NULL,
  "department" TEXT NOT NULL,
  "dayIndex" INTEGER NOT NULL,
  "hours" DECIMAL(65,30) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Approved',
  "note" TEXT,
  CONSTRAINT "TipPunch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TipDayAdjustment" (
  "id" TEXT NOT NULL,
  "periodId" TEXT NOT NULL,
  "cookId" TEXT NOT NULL,
  "dayIndex" INTEGER NOT NULL,
  "hours" DECIMAL(65,30),
  "boost" DECIMAL(65,30) NOT NULL DEFAULT 1,
  CONSTRAINT "TipDayAdjustment_pkey" PRIMARY KEY ("id")
);

-- Customer tips per day. Nullable: NULL = no tip data, 0 = genuinely no tips.
-- Split so TipSettings.includeAutoGratuity can be flipped without a re-sync.
ALTER TABLE "SalesEntry"
  ADD COLUMN "tipsCollected" DECIMAL(65,30),
  ADD COLUMN "autoGratuity" DECIMAL(65,30);

ALTER TABLE "Cook"
  ADD COLUMN "lastName" TEXT,
  ADD COLUMN "clockId" TEXT,
  ADD COLUMN "wage" DECIMAL(65,30),
  ADD COLUMN "dailyHourCap" DECIMAL(65,30),
  ADD COLUMN "tipRoleId" TEXT,
  ADD COLUMN "onTipPool" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "posPosition" TEXT;

CREATE UNIQUE INDEX "Cook_clockId_key" ON "Cook"("clockId");
CREATE UNIQUE INDEX "TipPeriod_revenueCenterId_startDate_key" ON "TipPeriod"("revenueCenterId", "startDate");
CREATE INDEX "TipPeriod_revenueCenterId_status_idx" ON "TipPeriod"("revenueCenterId", "status");
CREATE INDEX "TipPunch_periodId_idx" ON "TipPunch"("periodId");
CREATE INDEX "TipPunch_periodId_clockId_idx" ON "TipPunch"("periodId", "clockId");
CREATE UNIQUE INDEX "TipDayAdjustment_periodId_cookId_dayIndex_key" ON "TipDayAdjustment"("periodId", "cookId", "dayIndex");
CREATE INDEX "TipDayAdjustment_periodId_idx" ON "TipDayAdjustment"("periodId");

ALTER TABLE "Cook" ADD CONSTRAINT "Cook_tipRoleId_fkey"
  FOREIGN KEY ("tipRoleId") REFERENCES "TipRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TipPeriod" ADD CONSTRAINT "TipPeriod_revenueCenterId_fkey"
  FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TipPunch" ADD CONSTRAINT "TipPunch_periodId_fkey"
  FOREIGN KEY ("periodId") REFERENCES "TipPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TipDayAdjustment" ADD CONSTRAINT "TipDayAdjustment_periodId_fkey"
  FOREIGN KEY ("periodId") REFERENCES "TipPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TipDayAdjustment" ADD CONSTRAINT "TipDayAdjustment_cookId_fkey"
  FOREIGN KEY ("cookId") REFERENCES "Cook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "TipRole" ("id", "name", "multiplier", "sortOrder") VALUES
  ('tiprole_lead',   'Lead',   1.5, 0),
  ('tiprole_line',   'Line',   1.2, 1),
  ('tiprole_junior', 'Junior', 1.1, 2),
  ('tiprole_dish',   'Dish',   1.0, 3)
ON CONFLICT DO NOTHING;
```

- [ ] **Step 4: Apply the migration and regenerate the client**

```bash
npx prisma db execute --file prisma/migrations/20260731120000_tip_payouts/migration.sql --url "$DIRECT_URL" && npx prisma migrate resolve --applied 20260731120000_tip_payouts && npx prisma generate
```

Expected: `Script executed successfully.`, then `Migration ... marked as applied.`, then `Generated Prisma Client`.

- [ ] **Step 5: Verify the client compiles against the new models**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: exit 0 (no new errors — nothing consumes the models yet).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260731120000_tip_payouts && git commit -m "feat(tips): tip payout schema — periods, punches, roles, settings, roster fields"
```

---

### Task 2: Period window helpers

**Files:**
- Create: `src/lib/tips/period.ts`
- Test: `src/lib/tips/__tests__/period.test.ts`

**Interfaces:**
- Produces: `periodDays(startDate, count)`, `dayLabels(startDate, count)`, `dayIndexOf(startDate, iso)`, `previousPeriodStart(startDate, count)`, `nextPeriodStart(startDate, count)`, `defaultPeriodStart(today, dow, count)`, `periodLabel(startDate, count)`.

All dates are plain `'YYYY-MM-DD'` strings and all arithmetic is done on UTC-noon `Date` objects so a DST boundary can never shift a day index.

- [ ] **Step 1: Write the failing test**

Create `src/lib/tips/__tests__/period.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  periodDays, dayLabels, dayIndexOf, previousPeriodStart,
  nextPeriodStart, defaultPeriodStart, periodLabel,
} from '@/lib/tips/period'

describe('periodDays', () => {
  it('returns 14 consecutive ISO dates from the start', () => {
    const days = periodDays('2026-07-12', 14)
    expect(days).toHaveLength(14)
    expect(days[0]).toBe('2026-07-12')
    expect(days[13]).toBe('2026-07-25')
  })

  it('crosses a month boundary without drifting', () => {
    expect(periodDays('2026-07-26', 14)[13]).toBe('2026-08-08')
  })

  it('crosses the Pacific DST fall-back without losing a day', () => {
    const days = periodDays('2026-10-25', 14)
    expect(days[9]).toBe('2026-11-03')
    expect(days[13]).toBe('2026-11-07')
  })
})

describe('dayLabels', () => {
  it('labels each day "Ddd D" like the mock', () => {
    const labels = dayLabels('2026-07-12', 14)
    expect(labels[0]).toBe('Sun 12')
    expect(labels[6]).toBe('Sat 18')
    expect(labels[13]).toBe('Sat 25')
  })
})

describe('dayIndexOf', () => {
  it('maps an ISO date inside the window to its index', () => {
    expect(dayIndexOf('2026-07-12', '2026-07-12')).toBe(0)
    expect(dayIndexOf('2026-07-12', '2026-07-25')).toBe(13)
  })

  it('returns a negative or out-of-range index outside the window', () => {
    expect(dayIndexOf('2026-07-12', '2026-07-11')).toBe(-1)
    expect(dayIndexOf('2026-07-12', '2026-07-26')).toBe(14)
  })
})

describe('period navigation', () => {
  it('steps back and forward by a whole period', () => {
    expect(previousPeriodStart('2026-07-12', 14)).toBe('2026-06-28')
    expect(nextPeriodStart('2026-07-12', 14)).toBe('2026-07-26')
  })
})

describe('defaultPeriodStart', () => {
  it('snaps back to the most recent period boundary on the configured weekday', () => {
    // 2026-07-31 is a Friday; the containing Sun-start 14-day window opened 2026-07-26
    expect(defaultPeriodStart('2026-07-31', 0, 14)).toBe('2026-07-26')
  })

  it('returns the day itself when it is already the boundary weekday', () => {
    expect(defaultPeriodStart('2026-07-26', 0, 14)).toBe('2026-07-26')
  })
})

describe('periodLabel', () => {
  it('renders the mock header string', () => {
    expect(periodLabel('2026-07-12', 14)).toBe('Sun Jul 12 → Sat Jul 25 · 2026')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/tips/__tests__/period.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/tips/period"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/tips/period.ts`:

```ts
/**
 * Tip period window maths.
 *
 * A period is a run of N consecutive local business days identified by a
 * 'YYYY-MM-DD' start date. All arithmetic happens on UTC-noon Date objects so
 * a daylight-saving transition can never shift a day index by one — the same
 * trick the EOD business-date code uses.
 */

const DAY_MS = 86_400_000
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'YYYY-MM-DD' → a Date pinned to 12:00 UTC on that calendar day. */
export function toUtcNoon(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0))
}

/** A UTC-noon Date → 'YYYY-MM-DD'. */
export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Shift an ISO date by whole days. */
export function addDays(iso: string, n: number): string {
  return toIso(new Date(toUtcNoon(iso).getTime() + n * DAY_MS))
}

/** The `count` consecutive ISO dates that make up the period. */
export function periodDays(startDate: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(startDate, i))
}

/** Column labels for the day strip — "Sun 12", "Mon 13", … */
export function dayLabels(startDate: string, count: number): string[] {
  return periodDays(startDate, count).map(iso => {
    const d = toUtcNoon(iso)
    return `${DOW[d.getUTCDay()]} ${d.getUTCDate()}`
  })
}

/**
 * Index of `iso` within the window. Deliberately unclamped: callers use
 * `< 0 || >= count` to detect a punch dated outside the period.
 */
export function dayIndexOf(startDate: string, iso: string): number {
  return Math.round((toUtcNoon(iso).getTime() - toUtcNoon(startDate).getTime()) / DAY_MS)
}

export function previousPeriodStart(startDate: string, count: number): string {
  return addDays(startDate, -count)
}

export function nextPeriodStart(startDate: string, count: number): string {
  return addDays(startDate, count)
}

/**
 * The start of the period containing `today`, anchored so period boundaries
 * always land on `startDow` (0 = Sunday) and repeat every `count` days from
 * the most recent such weekday.
 */
export function defaultPeriodStart(today: string, startDow: number, count: number): string {
  const d = toUtcNoon(today)
  const back = (d.getUTCDay() - startDow + 7) % 7
  const weekStart = addDays(today, -back)
  // Anchor the repeating window on the ISO epoch so consecutive periods tile.
  const weeks = Math.round(toUtcNoon(weekStart).getTime() / DAY_MS / 7)
  const span = Math.max(1, Math.round(count / 7))
  const offset = ((weeks % span) + span) % span
  return addDays(weekStart, -offset * 7)
}

/** "Sun Jul 12 → Sat Jul 25 · 2026" */
export function periodLabel(startDate: string, count: number): string {
  const a = toUtcNoon(startDate)
  const b = toUtcNoon(addDays(startDate, count - 1))
  const fmt = (d: Date) => `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`
  return `${fmt(a)} → ${fmt(b)} · ${b.getUTCFullYear()}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/tips/__tests__/period.test.ts
```

Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tips/period.ts src/lib/tips/__tests__/period.test.ts && git commit -m "feat(tips): period window helpers"
```

---

### Task 3: The split engine (pure)

**Files:**
- Create: `src/lib/tips/types.ts`, `src/lib/tips/engine.ts`
- Test: `src/lib/tips/__tests__/engine.test.ts`

**Interfaces:**
- Consumes: nothing (fully pure — **must not** import `server-only`, Prisma, or `next/*`; the page runs it in the browser on every keystroke).
- Produces:
  - types `TipRoleDef`, `TipPerson`, `SplitInput`, `SplitPerson`, `SplitResult`, `Denom`, `Breakdown`
  - `effectiveHours(person, day)`, `cappedAway(person, day)`, `computeSplit(input)`, `breakdown(cents, denoms)`, `sortPeople(people, key, dir)` — note `effectiveHours` takes **no cap argument**: the cap is a contract term read off `person.dailyHourCap`

- [ ] **Step 1: Write `src/lib/tips/types.ts`**

```ts
/** DTOs shared by the tip engine, the audit, and the API payload. */

export interface TipRoleDef {
  id: string
  name: string
  multiplier: number
  sortOrder: number
}

export interface TipPerson {
  cookId: string
  name: string
  lastName: string | null
  clockId: string | null
  wage: number | null
  roleId: string | null
  onPool: boolean
  /**
   * This person's contracted daily hour cap. Hours clocked above it on any one
   * day are not paid tips. Null = uncapped. Per-person, never house-wide.
   */
  dailyHourCap: number | null
  /** Source hours per day — clocked, or the manual override where `edited` is true. */
  hours: number[]
  /** Reward multiplier per day. 1 = none. */
  boosts: number[]
  /** True on days whose hours came from a manual adjustment rather than the clock file. */
  edited: boolean[]
}

export interface Denom {
  /** Face value in cents. */
  v: number
  /** Display label, e.g. "$20", "25¢". */
  l: string
  on: boolean
}

/** What the pool rate is a percentage of. */
export type PoolBasis = 'NET_SALES' | 'TIPS_COLLECTED'

export interface SplitInput {
  /**
   * The per-day amount the pool rate applies to — daily net sales when the
   * basis is NET_SALES, daily customer tips when it is TIPS_COLLECTED. The
   * engine deliberately does not know which: the caller resolves the basis.
   */
  basis: number[]
  poolRatePct: number
  roundingStepCents: number
  roles: TipRoleDef[]
  people: TipPerson[]
}

export interface SplitPerson extends TipPerson {
  multiplier: number
  roleName: string
  /** Capped hours summed across the period. */
  hoursTotal: number
  /** hours × role multiplier × reward boost, summed. */
  weighted: number
  /** Exact tip dollars per day. */
  daily: number[]
  /** Exact tip dollars for the period. */
  tip: number
  /** Rounded cash envelope, in cents. */
  envelopeCents: number
}

export interface SplitResult {
  /** Day pool dollars — basis × rate. */
  pools: number[]
  poolTotal: number
  /** Weighted hours on shift per day. */
  weightedByDay: number[]
  /** Head count on shift per day. */
  crewByDay: number[]
  /** Only people on the pool with hours > 0, sorted tips high → low. */
  people: SplitPerson[]
  hoursTotal: number
  weightedTotal: number
  envelopeTotalCents: number
}

export interface Breakdown {
  parts: Array<Denom & { n: number }>
  /** Cents that could not be made from the enabled denominations. */
  remainder: number
}

export type SortKey =
  | 'name' | 'role' | 'hours' | 'weighted' | 'rate' | 'share' | 'tip' | 'env'
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/tips/__tests__/engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeSplit, cappedAway, effectiveHours, breakdown, sortPeople } from '@/lib/tips/engine'
import type { TipPerson, TipRoleDef, Denom } from '@/lib/tips/types'

const ROLES: TipRoleDef[] = [
  { id: 'lead', name: 'Lead', multiplier: 1.5, sortOrder: 0 },
  { id: 'dish', name: 'Dish', multiplier: 1, sortOrder: 1 },
]

function person(over: Partial<TipPerson> & { cookId: string; name: string }): TipPerson {
  return {
    lastName: null, clockId: null, wage: null, roleId: 'dish', onPool: true,
    dailyHourCap: null,
    hours: Array(4).fill(0), boosts: Array(4).fill(1), edited: Array(4).fill(false),
    ...over,
  }
}

describe('effectiveHours', () => {
  it('returns the raw hours when the person is uncapped', () => {
    const p = person({ cookId: 'a', name: 'A', hours: [12, 4, 0, 0] })
    expect(effectiveHours(p, 0)).toBe(12)
  })

  it("clamps to the person's own cap", () => {
    const p = person({ cookId: 'a', name: 'A', hours: [12, 4, 0, 0], dailyHourCap: 10 })
    expect(effectiveHours(p, 0)).toBe(10)
    expect(effectiveHours(p, 1)).toBe(4)
  })

  it('caps two people on the same shift differently', () => {
    const eight = person({ cookId: 'a', name: 'Eight', hours: [11, 0, 0, 0], dailyHourCap: 8 })
    const ten = person({ cookId: 'b', name: 'Ten', hours: [11, 0, 0, 0], dailyHourCap: 10 })
    expect(effectiveHours(eight, 0)).toBe(8)
    expect(effectiveHours(ten, 0)).toBe(10)
  })

  it('reports what each cap clipped away', () => {
    const p = person({ cookId: 'a', name: 'A', hours: [11.5, 0, 0, 0], dailyHourCap: 8 })
    expect(cappedAway(p, 0)).toBeCloseTo(3.5, 6)
    expect(cappedAway(person({ cookId: 'b', name: 'B', hours: [11.5, 0, 0, 0] }), 0)).toBe(0)
  })
})

describe('per-person caps in the split', () => {
  it('pays the 8 h cook for 8 h and the 10 h cook for 10 h on the same day', () => {
    const r = computeSplit({
      basis: [1800, 0, 0, 0], poolRatePct: 10, roundingStepCents: 100, roles: ROLES,
      people: [
        person({ cookId: 'a', name: 'Ana', hours: [12, 0, 0, 0], dailyHourCap: 8 }),
        person({ cookId: 'b', name: 'Bo', hours: [12, 0, 0, 0], dailyHourCap: 10 }),
      ],
    })
    const ana = r.people.find(p => p.cookId === 'a')!
    const bo = r.people.find(p => p.cookId === 'b')!
    expect(ana.hoursTotal).toBe(8)
    expect(bo.hoursTotal).toBe(10)
    // weighted 8 + 10 = 18 → $180 pool splits 80 / 100
    expect(ana.tip).toBeCloseTo(80, 6)
    expect(bo.tip).toBeCloseTo(100, 6)
  })

  it('leaves an uncapped person on their full clocked hours', () => {
    const r = computeSplit({
      basis: [1000, 0, 0, 0], poolRatePct: 10, roundingStepCents: 100, roles: ROLES,
      people: [person({ cookId: 'a', name: 'Ana', hours: [13.25, 0, 0, 0] })],
    })
    expect(r.people[0].hoursTotal).toBe(13.25)
  })
})

describe('computeSplit', () => {
  const base = {
    basis: [1000, 1000, 0, 0],
    poolRatePct: 10,
    roundingStepCents: 100,
    roles: ROLES,
  }

  it('splits each day pool by weighted hours on that day', () => {
    const r = computeSplit({
      ...base,
      people: [
        person({ cookId: 'a', name: 'Ana', roleId: 'lead', hours: [10, 0, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', roleId: 'dish', hours: [10, 10, 0, 0] }),
      ],
    })
    expect(r.pools).toEqual([100, 100, 0, 0])
    expect(r.poolTotal).toBeCloseTo(200, 6)
    // Day 0: weighted = 10×1.5 + 10×1 = 25 → Ana 15/25, Bo 10/25
    const ana = r.people.find(p => p.cookId === 'a')!
    const bo = r.people.find(p => p.cookId === 'b')!
    expect(ana.tip).toBeCloseTo(60, 6)
    expect(bo.tip).toBeCloseTo(140, 6) // 40 on day 0 + the whole 100 on day 1
  })

  it('distributes the pool to the cent', () => {
    const r = computeSplit({
      ...base,
      basis: [1234.56, 987.65, 543.21, 0],
      people: [
        person({ cookId: 'a', name: 'Ana', roleId: 'lead', hours: [7.33, 8.12, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', hours: [9.5, 0, 6.25, 0] }),
        person({ cookId: 'c', name: 'Cy', hours: [0, 4.75, 8, 0] }),
      ],
    })
    const sum = r.people.reduce((a, p) => a + p.tip, 0)
    expect(Math.abs(sum - r.poolTotal)).toBeLessThan(0.005)
  })

  it('applies the reward multiplier only on the boosted day', () => {
    const boosted = person({ cookId: 'a', name: 'Ana', hours: [10, 0, 0, 0] })
    boosted.boosts[0] = 2
    const r = computeSplit({
      ...base,
      people: [boosted, person({ cookId: 'b', name: 'Bo', hours: [10, 0, 0, 0] })],
    })
    // Day 0 weighted = 20 + 10 = 30 → Ana 2/3 of $100
    expect(r.people.find(p => p.cookId === 'a')!.tip).toBeCloseTo(66.6667, 3)
  })

  it('excludes people who are off the pool and people with no hours', () => {
    const r = computeSplit({
      ...base,
      people: [
        person({ cookId: 'a', name: 'Ana', hours: [10, 0, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', hours: [10, 0, 0, 0], onPool: false }),
        person({ cookId: 'c', name: 'Cy' }),
      ],
    })
    expect(r.people.map(p => p.cookId)).toEqual(['a'])
    expect(r.crewByDay[0]).toBe(1)
  })

  it('leaves a day pool undistributed when nobody was on shift', () => {
    const r = computeSplit({
      ...base,
      basis: [0, 0, 500, 0],
      people: [person({ cookId: 'a', name: 'Ana', hours: [8, 0, 0, 0] })],
    })
    expect(r.pools[2]).toBe(50)
    expect(r.weightedByDay[2]).toBe(0)
    expect(r.people[0].tip).toBe(0)
  })

  it('rounds envelopes to the step with largest remainder, hitting the target exactly', () => {
    const r = computeSplit({
      ...base,
      basis: [1000, 0, 0, 0],
      people: [
        person({ cookId: 'a', name: 'Ana', hours: [3, 0, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', hours: [3, 0, 0, 0] }),
        person({ cookId: 'c', name: 'Cy', hours: [3, 0, 0, 0] }),
      ],
    })
    // $100 / 3 = $33.33 each; rounded to $1 the target is $100
    expect(r.envelopeTotalCents).toBe(10000)
    expect(r.people.map(p => p.envelopeCents).sort()).toEqual([3300, 3300, 3400])
  })

  it('gives back cents when the pool rounds DOWN (the mock overshoots here)', () => {
    const r = computeSplit({
      ...base,
      basis: [1004, 0, 0, 0], // pool = $100.40 → target at $1 rounding = $100
      roundingStepCents: 100,
      people: [
        person({ cookId: 'a', name: 'Ana', hours: [1, 0, 0, 0] }),
        person({ cookId: 'b', name: 'Bo', hours: [1, 0, 0, 0] }),
      ],
    })
    expect(r.envelopeTotalCents).toBe(10000)
  })
})

describe('breakdown', () => {
  const denoms: Denom[] = [
    { v: 5000, l: '$50', on: true },
    { v: 2000, l: '$20', on: true },
    { v: 500, l: '$5', on: false },
    { v: 100, l: '$1', on: true },
  ]

  it('makes the amount from the largest enabled notes first', () => {
    const b = breakdown(9300, denoms)
    expect(b.parts.map(p => [p.l, p.n])).toEqual([['$50', 1], ['$20', 2], ['$1', 3]])
    expect(b.remainder).toBe(0)
  })

  it('reports what it cannot make when a denomination is switched off', () => {
    const b = breakdown(50, denoms)
    expect(b.parts).toEqual([])
    expect(b.remainder).toBe(50)
  })
})

describe('sortPeople', () => {
  it('sorts by the requested key and direction, tie-breaking on name', () => {
    const r = computeSplit({
      basis: [1000, 0, 0, 0], poolRatePct: 10,
      roundingStepCents: 100, roles: ROLES,
      people: [
        person({ cookId: 'b', name: 'Bo', hours: [5, 0, 0, 0] }),
        person({ cookId: 'a', name: 'Ana', hours: [5, 0, 0, 0] }),
      ],
    })
    expect(sortPeople(r.people, 'name', 1).map(p => p.name)).toEqual(['Ana', 'Bo'])
    expect(sortPeople(r.people, 'name', -1).map(p => p.name)).toEqual(['Bo', 'Ana'])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run src/lib/tips/__tests__/engine.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/tips/engine"`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/tips/engine.ts`:

```ts
/**
 * Tip split engine — PURE. No DOM, no Prisma, no server-only imports: the page
 * re-runs this on every keystroke as the manager drags the pool rate.
 *
 * Method (identical to the BOH tips sheet the mock reproduces):
 *   1. day pool      = that day's basis × pool rate  (basis = net sales OR tips collected)
 *   2. weighted hrs  = Σ over people of (capped hours × role multiplier × reward boost)
 *   3. person's day  = day pool × their weighted hours ÷ the day's weighted hours
 *   4. period tip    = Σ of their daily shares
 * Working the busy days therefore earns more per hour, which is the whole point.
 */
import type {
  Breakdown, Denom, SortKey, SplitInput, SplitPerson, SplitResult, TipPerson, TipRoleDef,
} from './types'

const FALLBACK_ROLE: TipRoleDef = { id: '', name: '—', multiplier: 1, sortOrder: 999 }

export function roleOf(person: TipPerson, roles: TipRoleDef[]): TipRoleDef {
  return roles.find(r => r.id === person.roleId) ?? FALLBACK_ROLE
}

/**
 * Hours actually paid on a day — the raw clocked hours, clamped by THIS
 * PERSON'S contracted cap. There is deliberately no house-wide cap argument:
 * a 10 h-agreement cook and an 8 h-agreement cook are capped differently on
 * the same shift, so the cap can only live on the person.
 */
export function effectiveHours(person: TipPerson, day: number): number {
  const raw = person.hours[day] ?? 0
  const cap = person.dailyHourCap
  return cap != null && cap > 0 ? Math.min(raw, cap) : raw
}

/** Hours clipped off one person's day by their own cap. 0 when uncapped. */
export function cappedAway(person: TipPerson, day: number): number {
  return (person.hours[day] ?? 0) - effectiveHours(person, day)
}

export function computeSplit(input: SplitInput): SplitResult {
  const { basis, poolRatePct, roundingStepCents, roles, people } = input
  const dayCount = basis.length

  const pools = basis.map(b => (b * poolRatePct) / 100)
  const poolTotal = pools.reduce((a, b) => a + b, 0)

  const active = people.filter(p => p.onPool)
  const weightedByDay: number[] = []
  const crewByDay: number[] = []
  for (let d = 0; d < dayCount; d++) {
    let w = 0
    let crew = 0
    for (const p of active) {
      const h = effectiveHours(p, d)
      if (h > 0) crew++
      w += h * roleOf(p, roles).multiplier * (p.boosts[d] ?? 1)
    }
    weightedByDay.push(w)
    crewByDay.push(crew)
  }

  const computed: SplitPerson[] = people.map(p => {
    const role = roleOf(p, roles)
    const daily: number[] = []
    let hoursTotal = 0
    let weighted = 0
    let tip = 0
    for (let d = 0; d < dayCount; d++) {
      const h = p.onPool ? effectiveHours(p, d) : 0
      const w = h * role.multiplier * (p.boosts[d] ?? 1)
      hoursTotal += h
      weighted += w
      const share = weightedByDay[d] > 0 ? (pools[d] * w) / weightedByDay[d] : 0
      daily.push(share)
      tip += share
    }
    return {
      ...p,
      multiplier: role.multiplier,
      roleName: role.name,
      hoursTotal, weighted, daily, tip,
      envelopeCents: 0,
    }
  }).filter(p => p.onPool && p.hoursTotal > 0)

  computed.sort((a, b) => b.tip - a.tip)
  assignEnvelopes(computed, poolTotal, roundingStepCents)

  return {
    pools, poolTotal, weightedByDay, crewByDay,
    people: computed,
    hoursTotal: computed.reduce((a, p) => a + p.hoursTotal, 0),
    weightedTotal: computed.reduce((a, p) => a + p.weighted, 0),
    envelopeTotalCents: computed.reduce((a, p) => a + p.envelopeCents, 0),
  }
}

/**
 * Largest-remainder rounding: every envelope is a whole multiple of `step`
 * cents and the envelopes sum EXACTLY to the pool rounded to that step.
 *
 * Differs from the mock on purpose: tips.js only ever hands units out
 * (`for(...; left>0; left--)`), so when the pool rounds DOWN the envelopes
 * overshoot the target and the float silently covers the difference. Here a
 * negative remainder takes units back, starting from the smallest fraction.
 */
function assignEnvelopes(people: SplitPerson[], poolTotal: number, step: number): void {
  if (!people.length) return
  const units = people.map(p => (p.tip * 100) / step)
  const floors = units.map(Math.floor)
  const target = Math.round((poolTotal * 100) / step)
  let left = target - floors.reduce((a, b) => a + b, 0)

  const byFraction = units
    .map((u, i) => ({ i, frac: u - Math.floor(u) }))
    .sort((a, b) => b.frac - a.frac)

  for (let k = 0; k < byFraction.length && left > 0; k++, left--) floors[byFraction[k].i]++
  for (let k = byFraction.length - 1; k >= 0 && left < 0; k--) {
    if (floors[byFraction[k].i] > 0) { floors[byFraction[k].i]--; left++ }
  }

  people.forEach((p, i) => { p.envelopeCents = floors[i] * step })
}

/** Greedy note/coin breakdown for one envelope. */
export function breakdown(cents: number, denoms: Denom[]): Breakdown {
  const parts: Breakdown['parts'] = []
  let rem = cents
  for (const d of denoms) {
    if (!d.on) continue
    const n = Math.floor(rem / d.v)
    if (n > 0) { parts.push({ ...d, n }); rem -= n * d.v }
  }
  return { parts, remainder: rem }
}

const SORT_VALUE: Record<SortKey, (p: SplitPerson) => number | string> = {
  name: p => p.name.toLowerCase(),
  role: p => p.multiplier,
  hours: p => p.hoursTotal,
  weighted: p => p.weighted,
  rate: p => (p.hoursTotal ? p.tip / p.hoursTotal : 0),
  share: p => p.tip,
  tip: p => p.tip,
  env: p => p.envelopeCents,
}

/** Default direction per column — names ascend, money descends. */
export const DEFAULT_SORT_DIR: Record<SortKey, 1 | -1> = {
  name: 1, role: -1, hours: -1, weighted: -1, rate: -1, share: -1, tip: -1, env: -1,
}

export function sortPeople(people: SplitPerson[], key: SortKey, dir: 1 | -1): SplitPerson[] {
  const value = SORT_VALUE[key] ?? SORT_VALUE.tip
  return people.slice().sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    if (va < vb) return -dir
    if (va > vb) return dir
    return a.name.localeCompare(b.name)
  })
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/lib/tips/__tests__/engine.test.ts
```

Expected: PASS — 18 tests across the four describes.

- [ ] **Step 6: Run the whole suite so nothing regressed**

```bash
npm test
```

Expected: all suites pass (the pre-existing 47 cost-math tests plus the new ones).

- [ ] **Step 7: Commit**

```bash
git add src/lib/tips/types.ts src/lib/tips/engine.ts src/lib/tips/__tests__/engine.test.ts && git commit -m "feat(tips): pure split engine with largest-remainder envelope rounding"
```

---

### Task 4: The reconciliation audit (pure)

**Files:**
- Create: `src/lib/tips/audit.ts`
- Test: `src/lib/tips/__tests__/audit.test.ts`

**Interfaces:**
- Consumes: `SplitResult`, `SplitPerson`, `TipPerson`, `TipRoleDef`, `effectiveHours`, `cappedAway` from Task 3; `PunchRow` (defined here).
- Produces: `auditPeriod(input: AuditInput): AuditResult` with `{ ledger, findings, counts }`. Finding shape: `{ severity: 'error'|'warn'|'info', id, title, detail, actions?, amount? }`; action shape `{ label, kind: 'addPerson'|'ignoreCode'|'onPool'|'setCode'|'goto', arg, ghost? }`.

This is a faithful port of `app/tips-audit.js` minus the duplicate-code check (impossible — `Cook.clockId` is unique).

- [ ] **Step 1: Write the failing test**

Create `src/lib/tips/__tests__/audit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { auditPeriod } from '@/lib/tips/audit'
import { computeSplit } from '@/lib/tips/engine'
import type { PunchRow } from '@/lib/tips/audit'
import type { TipPerson, TipRoleDef } from '@/lib/tips/types'

const ROLES: TipRoleDef[] = [{ id: 'dish', name: 'Dish', multiplier: 1, sortOrder: 0 }]
const DAYS = ['Sun 12', 'Mon 13']

function person(over: Partial<TipPerson> & { cookId: string; name: string }): TipPerson {
  return {
    lastName: null, clockId: null, wage: null, roleId: 'dish', onPool: true,
    dailyHourCap: null,
    hours: [0, 0], boosts: [1, 1], edited: [false, false], ...over,
  }
}

function punch(over: Partial<PunchRow> & { clockId: string; hours: number }): PunchRow {
  return {
    firstName: 'X', lastName: 'Y', position: 'Dishwasher', department: 'Back of House',
    dayIndex: 0, status: 'Approved', note: null, ...over,
  }
}

function run(people: TipPerson[], punches: PunchRow[], over: Record<string, unknown> = {}) {
  const split = computeSplit({
    basis: [1000, 1000], poolRatePct: 10,
    roundingStepCents: 100, roles: ROLES, people,
  })
  return auditPeriod({
    dayLabels: DAYS, basis: [1000, 1000], poolBasis: 'NET_SALES',
    sales: [1000, 1000], tipsCollected: [null, null],
    roles: ROLES, people, punches, split,
    roundingStepCents: 100, poolDepartments: ['Back of House'],
    ignoredClockIds: [], missingBasisDays: [], ...over,
  })
}

describe('auditPeriod', () => {
  it('is all clear when every punch matches a roster member', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 })],
    )
    expect(r.counts.error).toBe(0)
    expect(r.counts.missingHours).toBeCloseTo(0, 6)
    expect(r.counts.shifts).toBe(1)
  })

  it('raises an error for hours clocked by somebody not on the roster', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '959', hours: 7.13, firstName: 'Bevan', lastName: 'Garrett' })],
    )
    const f = r.findings.find(x => x.id === 'unknown-959')!
    expect(f.severity).toBe('error')
    expect(f.title).toContain('Bevan Garrett')
    expect(f.actions!.map(a => a.kind)).toEqual(['addPerson', 'ignoreCode'])
    expect(r.counts.missingHours).toBeCloseTo(7.13, 6)
  })

  it('drops an ignored code out of the missing-hours total', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '959', hours: 7.13 })],
      { ignoredClockIds: ['959'] },
    )
    expect(r.findings.some(f => f.id === 'unknown-959')).toBe(false)
    expect(r.counts.missingHours).toBeCloseTo(0, 6)
  })

  it('flags unapproved punches as unpaid', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 3, dayIndex: 1, status: 'Pending' })],
    )
    expect(r.findings.find(f => f.id === 'unapproved-706')!.severity).toBe('error')
  })

  it('warns when somebody who worked is switched off the pool', () => {
    const r = run(
      [
        person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] }),
        person({ cookId: 'b', name: 'Bo', clockId: '559', hours: [8, 0], onPool: false }),
      ],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '559', hours: 8 })],
    )
    const f = r.findings.find(x => x.id === 'offpool-559')!
    expect(f.severity).toBe('warn')
    expect(f.actions![0].kind).toBe('onPool')
  })

  it('ignores punches from another department', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '900', hours: 6, department: 'Front of House' })],
    )
    expect(r.counts.missingHours).toBeCloseTo(0, 6)
    expect(r.ledger.find(l => l.label === 'Other department')!.value).toBeCloseTo(-6, 6)
  })

  it("warns when someone's own shift cap removes paid hours, naming them", () => {
    const r = run(
      [
        person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [12, 0], dailyHourCap: 8 }),
        person({ cookId: 'b', name: 'Bo', clockId: '559', hours: [12, 0], dailyHourCap: 10 }),
      ],
      [punch({ clockId: '706', hours: 12 }), punch({ clockId: '559', hours: 12 })],
    )
    const f = r.findings.find(x => x.id === 'cap')!
    expect(f.severity).toBe('warn')
    expect(f.title).toContain('6.00 h')      // Ana loses 4, Bo loses 2
    expect(f.detail).toContain('Ana')
    expect(f.detail).toContain('8 h cap')
    expect(f.detail).toContain('Bo')
  })

  it('raises no cap finding when nobody is capped', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [12, 0] })],
      [punch({ clockId: '706', hours: 12 })],
    )
    expect(r.findings.some(f => f.id === 'cap')).toBe(false)
  })

  it('errors when a day has sales but nobody on shift', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 })],
    )
    expect(r.findings.find(f => f.id === 'orphan-1')!.severity).toBe('error')
  })

  it('errors when a roster member on the pool has no employee code', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', hours: [8, 0] })],
      [],
    )
    expect(r.findings.find(f => f.id === 'nocode')!.severity).toBe('warn')
  })

  it('errors when the app has no basis figure for a day', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 })],
      { missingBasisDays: [1] },
    )
    expect(r.findings.find(f => f.id === 'nobasis')!.severity).toBe('error')
  })

  it('names the missing figure after the basis in use', () => {
    const sales = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 })],
      { missingBasisDays: [1] },
    )
    expect(sales.findings.find(f => f.id === 'nobasis')!.title).toContain('net sales')

    const tips = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 })],
      { poolBasis: 'TIPS_COLLECTED', missingBasisDays: [1] },
    )
    expect(tips.findings.find(f => f.id === 'nobasis')!.title).toContain('tips collected')
  })

  it('closes the ledger — clocked hours equal paid plus every deduction', () => {
    const r = run(
      [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '959', hours: 5 })],
    )
    expect(r.counts.unexplained).toBeCloseTo(0, 6)
  })
})

describe('the FOH → BOH tip-out', () => {
  const worker = [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })]
  const punches = [punch({ clockId: '706', hours: 8 })]

  it('reports the pool as a share of the tips customers actually left', () => {
    // pool = 10% of [1000, 1000] = $200; tips collected = $800 → 25%
    const r = run(worker, punches, { tipsCollected: [400, 400] })
    const f = r.findings.find(x => x.id === 'takeout')!
    expect(f.severity).toBe('info')
    expect(f.title).toContain('25%')
    expect(f.detail).toContain('$600.00') // FOH remainder
  })

  it('warns when the sales-based pool takes more than half the tip pot', () => {
    const r = run(worker, punches, { tipsCollected: [180, 180] }) // $200 of $360 = 56%
    expect(r.findings.find(f => f.id === 'bigtakeout')!.severity).toBe('warn')
  })

  it('errors when the sales-based pool exceeds the tip pot entirely', () => {
    const r = run(worker, punches, { tipsCollected: [50, 50] }) // $200 pool vs $100 pot
    const f = r.findings.find(x => x.id === 'overdraw')!
    expect(f.severity).toBe('error')
    expect(f.detail).toContain('cannot fund')
  })

  it('never overdraws when the basis IS the tip pot', () => {
    const people = [person({ cookId: 'a', name: 'Ana', clockId: '706', hours: [8, 0] })]
    const split = computeSplit({
      basis: [400, 400], poolRatePct: 10,
      roundingStepCents: 100, roles: ROLES, people,
    })
    const r = auditPeriod({
      dayLabels: DAYS, basis: [400, 400], poolBasis: 'TIPS_COLLECTED',
      sales: [1000, 1000], tipsCollected: [400, 400], roles: ROLES, people,
      punches, split, roundingStepCents: 100,
      poolDepartments: ['Back of House'], ignoredClockIds: [], missingBasisDays: [],
    })
    expect(r.findings.some(f => f.id === 'overdraw')).toBe(false)
    expect(r.findings.find(f => f.id === 'takeout')!.title).toContain('10%')
  })

  it('notes that tip data is missing without blocking a sales-based payout', () => {
    const r = run(worker, punches)
    const f = r.findings.find(x => x.id === 'notips')!
    expect(f.severity).toBe('info')
    expect(r.counts.error).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/tips/__tests__/audit.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/tips/audit"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/tips/audit.ts`:

```ts
/**
 * Tip payout reconciliation — PURE.
 *
 * Proves where every clocked hour went and flags anything that would make the
 * payout wrong. The ledger must close: clocked = paid + every deduction. If it
 * does not, the period is not safe to pay.
 *
 * Ported from the design's tips-audit.js. The mock's duplicate-employee-code
 * check is NOT ported — Cook.clockId carries a unique index, so two roster rows
 * cannot share a code.
 */
import { cappedAway, effectiveHours, roleOf } from './engine'
import type { PoolBasis, SplitResult, TipPerson, TipRoleDef } from './types'

export interface PunchRow {
  clockId: string
  firstName: string
  lastName: string
  position: string
  department: string
  dayIndex: number
  hours: number
  status: string
  note: string | null
}

export type Severity = 'error' | 'warn' | 'info'

export interface FindingAction {
  label: string
  kind: 'addPerson' | 'ignoreCode' | 'onPool' | 'setCode' | 'goto'
  arg: string
  ghost?: boolean
}

export interface Finding {
  severity: Severity
  id: string
  title: string
  detail: string
  actions?: FindingAction[]
  /** Hours or dollars at stake — used only to rank findings of equal severity. */
  amount?: number
}

export interface LedgerRow {
  label: string
  value: number
  note?: string
  lead?: boolean
  subtotal?: boolean
  bad?: boolean
  warn?: boolean
  muted?: boolean
  closed?: boolean
}

export interface AuditInput {
  dayLabels: string[]
  /** The per-day amount the rate was applied to (net sales OR tips collected). */
  basis: number[]
  /** Which of the two `basis` is. Only changes the wording of the findings. */
  poolBasis: PoolBasis
  /** Daily net sales — always supplied, even when the basis is TIPS_COLLECTED. */
  sales: number[]
  /** Daily customer tips. `null` on a day the app has no tip data for. */
  tipsCollected: Array<number | null>
  roles: TipRoleDef[]
  people: TipPerson[]
  punches: PunchRow[]
  split: SplitResult
  roundingStepCents: number
  poolDepartments: string[]
  ignoredClockIds: string[]
  /**
   * Day indexes the configured scope produced no usable BASIS figure for —
   * no SalesEntry row at all when the basis is NET_SALES, or a row with a null
   * `tipsCollected` when it is TIPS_COLLECTED. Always a blocking error: a day
   * with no data is not the same as a day that took nothing.
   */
  missingBasisDays: number[]
}

export interface AuditResult {
  ledger: LedgerRow[]
  findings: Finding[]
  counts: {
    error: number
    warn: number
    info: number
    shifts: number
    eligible: number
    inPool: number
    unexplained: number
    /** Clocked kitchen hours that are being left out of the payout entirely. */
    missingHours: number
    lostPeople: string[]
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const hrs = (n: number) => `${r2(n).toFixed(2)} h`
const money = (n: number) =>
  '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

export function auditPeriod(input: AuditInput): AuditResult {
  const {
    dayLabels, basis, poolBasis, sales, tipsCollected, roles, people: roster, punches, split,
    roundingStepCents, poolDepartments, ignoredClockIds, missingBasisDays,
  } = input
  const basisNoun = poolBasis === 'TIPS_COLLECTED' ? 'tips collected' : 'net sales'
  const dayCount = dayLabels.length
  const findings: Finding[] = []
  const add = (
    severity: Severity, id: string, title: string, detail: string,
    actions?: FindingAction[], amount?: number,
  ) => { findings.push({ severity, id, title, detail, actions, amount }) }

  const byCode = new Map<string, { p: TipPerson; i: number }>()
  roster.forEach((p, i) => { if (p.clockId) byCode.set(String(p.clockId), { p, i }) })

  // ── bucket every punch ────────────────────────────────────────────────────
  const bucket = { dept: 0, period: 0, unapproved: 0, unknown: 0, ignored: 0, offpool: 0 }
  const unknown = new Map<string, { code: string; name: string; last: string; pos: string; h: number; n: number }>()
  const offpool = new Map<string, { code: string; name: string; cookId: string; h: number; n: number }>()
  const unapproved = new Map<string, { code: string; name: string; last: string; h: number; n: number }>()
  let eligible = 0
  let shifts = 0

  for (const r of punches) {
    const code = String(r.clockId)
    const h = r.hours
    if (poolDepartments.length && !poolDepartments.includes(r.department)) { bucket.dept = r2(bucket.dept + h); continue }
    if (r.dayIndex < 0 || r.dayIndex >= dayCount) { bucket.period = r2(bucket.period + h); continue }
    if (!/approved/i.test(r.status || '')) {
      bucket.unapproved = r2(bucket.unapproved + h)
      const u = unapproved.get(code) ?? { code, name: r.firstName, last: r.lastName, h: 0, n: 0 }
      u.h = r2(u.h + h); u.n++; unapproved.set(code, u)
      continue
    }
    const match = byCode.get(code)
    if (!match) {
      if (ignoredClockIds.includes(code)) { bucket.ignored = r2(bucket.ignored + h); continue }
      bucket.unknown = r2(bucket.unknown + h)
      const u = unknown.get(code) ?? { code, name: r.firstName, last: r.lastName, pos: r.position, h: 0, n: 0 }
      u.h = r2(u.h + h); u.n++; unknown.set(code, u)
      continue
    }
    if (!match.p.onPool) {
      bucket.offpool = r2(bucket.offpool + h)
      const u = offpool.get(code) ?? { code, name: match.p.name, cookId: match.p.cookId, h: 0, n: 0 }
      u.h = r2(u.h + h); u.n++; offpool.set(code, u)
      continue
    }
    eligible = r2(eligible + h)
    shifts++
  }

  // ── the ledger ────────────────────────────────────────────────────────────
  const pooled = roster.filter(p => p.onPool)
  const rawHours = r2(pooled.reduce((a, p) => a + p.hours.reduce((x, y) => x + y, 0), 0))
  const capAdj = r2(pooled.reduce(
    (a, p) => a + p.hours.reduce((x, _y, d) => x + cappedAway(p, d), 0), 0))
  const manual = r2(rawHours - eligible)
  const inPool = r2(rawHours - capAdj)
  const splitHours = r2(split.hoursTotal)
  const unexplained = r2(inPool - splitHours)
  const lost = r2(bucket.unknown + bucket.unapproved)

  const ledger: LedgerRow[] = [
    { label: 'Clocked in the hours file', value: r2(punches.reduce((a, r) => a + r.hours, 0)), lead: true, note: plural(punches.length, 'shift') },
    { label: 'Other department', value: -bucket.dept, muted: !bucket.dept },
    { label: 'Dated outside the period', value: -bucket.period, muted: !bucket.period },
    { label: 'Not approved', value: -bucket.unapproved, bad: bucket.unapproved > 0, muted: !bucket.unapproved },
    { label: 'Not on the tip roster', value: -bucket.unknown, bad: bucket.unknown > 0, muted: !bucket.unknown, note: bucket.unknown ? people(unknown.size) : undefined },
    { label: 'Excluded on purpose', value: -bucket.ignored, muted: !bucket.ignored },
    { label: 'Taken off the pool', value: -bucket.offpool, warn: bucket.offpool > 0, muted: !bucket.offpool },
    { label: 'Eligible hours', value: eligible, subtotal: true },
    { label: 'Manual edits on the split', value: manual, warn: Math.abs(manual) > 0.005, muted: Math.abs(manual) < 0.005 },
    { label: 'Removed by shift caps', value: -capAdj, warn: capAdj > 0, muted: !capAdj },
    { label: 'Paid in this pool', value: inPool, lead: true, closed: Math.abs(unexplained) < 0.005 && lost < 0.005, bad: lost >= 0.005 },
  ]

  // ── hours that vanished ───────────────────────────────────────────────────
  ;[...unknown.values()].sort((a, b) => b.h - a.h).forEach(u => {
    add('error', `unknown-${u.code}`,
      `${u.name} ${u.last} is not on the tip roster`,
      `${hrs(u.h)} over ${plural(u.n, 'shift')} as ${u.pos} (clock #${u.code}) are being left out of the split.`,
      [
        { label: 'Add to roster', kind: 'addPerson', arg: u.code },
        { label: 'Not kitchen', kind: 'ignoreCode', arg: u.code, ghost: true },
      ], u.h)
  })
  ;[...unapproved.values()].forEach(u => {
    add('error', `unapproved-${u.code}`,
      `${u.name} ${u.last} has unapproved punches`,
      `${plural(u.n, 'shift')} totalling ${hrs(u.h)} are still pending approval and are not paid. Approve them in the POS and re-import.`,
      undefined, u.h)
  })
  ;[...offpool.values()].forEach(u => {
    add('warn', `offpool-${u.code}`,
      `${u.name} worked but is switched off the pool`,
      `${hrs(u.h)} clocked and excluded on purpose. Turn them back on in Tip settings if that is wrong.`,
      [{ label: 'Put back on the pool', kind: 'onPool', arg: u.cookId }], u.h)
  })
  if (Math.abs(unexplained) >= 0.005) {
    add('error', 'unexplained', `${hrs(Math.abs(unexplained))} cannot be traced`,
      `The reconciliation does not close: ${hrs(inPool)} should be in the pool but the split is paying ${hrs(splitHours)}. Re-import the hours file before paying anyone.`,
      undefined, Math.abs(unexplained))
  }
  if (capAdj > 0.005) {
    // Caps are per person, so name who was clipped and by how much — one
    // house-wide number would be unactionable when every contract differs.
    const clipped = pooled
      .map(p => ({
        name: p.name,
        cap: p.dailyHourCap,
        lost: r2(p.hours.reduce((x, _y, d) => x + cappedAway(p, d), 0)),
      }))
      .filter(x => x.lost >= 0.005)
      .sort((a, b) => b.lost - a.lost)
    add('warn', 'cap', `Shift caps removed ${hrs(capAdj)}`,
      clipped.slice(0, 4).map(x => `${x.name} \u2212${x.lost.toFixed(2)} h (${x.cap} h cap)`).join(', ') +
      (clipped.length > 4 ? ` +${clipped.length - 4} more` : '') +
      '. Hours above a person\u2019s contracted shift are not paid tips. Raise their cap in Tip settings to include them.',
      [{ label: 'Open Tip settings', kind: 'goto', arg: 'settings' }], capAdj)
  }

  // ── the same person under two codes ───────────────────────────────────────
  const byLast = new Map<string, { p: TipPerson; i: number }>()
  roster.forEach((p, i) => {
    const key = (p.lastName ?? '').toLowerCase()
    if (key && !byLast.has(key)) byLast.set(key, { p, i })
  })
  ;[...unknown.values()].forEach(u => {
    const hit = byLast.get((u.last ?? '').toLowerCase())
    if (hit && !hit.p.hours.some(h => h > 0)) {
      add('warn', `code-${u.code}`,
        `Two codes for ${hit.p.name} ${hit.p.lastName}?`,
        `The roster has ${hit.p.name} ${hit.p.lastName} on code #${hit.p.clockId ?? '—'}, but the clock file shows ${u.name} ${u.last} on #${u.code} with ${hrs(u.h)}. One of them is wrong.`,
        [{ label: `Use #${u.code}`, kind: 'setCode', arg: `${hit.p.cookId}:${u.code}` }])
    }
  })

  // ── money ─────────────────────────────────────────────────────────────────
  // Compare the split against what was DISTRIBUTABLE, not against the whole
  // pool: a day with a basis but nobody on shift contributes to poolTotal and
  // to nobody's tip, and is reported separately as `orphan-<d>` below. Using
  // poolTotal here would raise a false blocking error on every such period.
  const tipSum = split.people.reduce((a, p) => a + p.tip, 0)
  const distributable = split.pools.reduce((a, pool, d) => a + (split.weightedByDay[d] > 0 ? pool : 0), 0)
  if (Math.abs(tipSum - distributable) >= 0.005) {
    add('error', 'balance', 'The split does not add up',
      `Individual tips total ${money(tipSum)} against ${money(distributable)} of distributable pool — a gap of ${money(Math.abs(tipSum - distributable))}.`)
  }
  split.pools.forEach((pool, d) => {
    if (pool > 0.005 && split.weightedByDay[d] <= 0) {
      add('error', `orphan-${d}`, `${money(pool)} has nobody to pay on ${dayLabels[d]}`,
        'There were sales that day but no eligible hours on the clock, so that day pool cannot be handed out.')
    }
  })
  if (missingBasisDays.length) {
    add('error', 'nobasis', `${plural(missingBasisDays.length, 'day')} have no ${basisNoun} in the app`,
      `${missingBasisDays.map(d => dayLabels[d]).join(', ')} produced no pool because the configured scope has no ${basisNoun} for them. ` +
      (poolBasis === 'TIPS_COLLECTED'
        ? 'Re-run the Toast sync for those days, or import the sales workbook to override.'
        : 'Sync or enter those days, or import the sales workbook to override.'),
      [{ label: 'Open Import data', kind: 'goto', arg: 'import' }])
  }
  const zeroDays = basis.map((v, d) => (v <= 0 ? d : -1)).filter(d => d >= 0 && !missingBasisDays.includes(d))
  if (zeroDays.length) {
    add('warn', 'zerobasis', `${plural(zeroDays.length, 'day')} with no ${basisNoun}`,
      `${zeroDays.map(d => dayLabels[d]).join(', ')} produced no pool. Check the scope if the kitchen was open.`)
  }

  /* ---- the FOH → BOH tip-out, whatever the basis ---- */
  const tipDays = tipsCollected.filter((t): t is number => t != null)
  if (tipDays.length) {
    const tipPot = r2(tipDays.reduce((a, b) => a + b, 0))
    const takeoutPct = tipPot > 0 ? (split.poolTotal / tipPot) * 100 : 0
    if (poolBasis === 'NET_SALES' && tipDays.length === tipsCollected.length) {
      // Sizing the withdrawal off sales can outrun the pot it is drawn from.
      // That is not a rounding nit — it means FOH cannot fund the tip-out.
      if (split.poolTotal > tipPot + 0.005) {
        add('error', 'overdraw', 'The BOH pool is larger than the tips customers left',
          `The pool is ${money(split.poolTotal)} but only ${money(tipPot)} was collected in tips this period. Front of house cannot fund a ${takeoutPct.toFixed(0)}% tip-out. Lower the pool rate or switch the basis to tips collected.`)
      } else if (takeoutPct > 50) {
        add('warn', 'bigtakeout', `The tip-out is ${takeoutPct.toFixed(0)}% of the tip pot`,
          `${money(split.poolTotal)} of the ${money(tipPot)} customers left goes to the kitchen, leaving ${money(tipPot - split.poolTotal)} for front of house. Worth a sanity check against the house agreement.`)
      } else {
        add('info', 'takeout', `The tip-out is ${takeoutPct.toFixed(0)}% of the tip pot`,
          `${money(split.poolTotal)} to the kitchen, ${money(tipPot - split.poolTotal)} left for front of house out of ${money(tipPot)} collected.`)
      }
    }
    if (poolBasis === 'TIPS_COLLECTED') {
      add('info', 'takeout', `The tip-out is ${takeoutPct.toFixed(0)}% of the tip pot`,
        `${money(split.poolTotal)} to the kitchen, ${money(tipPot - split.poolTotal)} left for front of house out of ${money(tipPot)} collected.`)
    }
  } else if (poolBasis === 'NET_SALES') {
    add('info', 'notips', 'No tip data for this period',
      'The pool is sized off sales, so the payout is unaffected — but without tip totals the split cannot show what share of the front-of-house pot the kitchen is taking. Re-run the Toast sync to capture it.')
  }

  // Rounding drift is envelopes vs the tips actually owed — NOT vs poolTotal,
  // which would fold any undistributed day pool into a figure labelled
  // "rounding" and hide it.
  const drift = r2(split.envelopeTotalCents / 100 - split.distributedTotal)
  if (Math.abs(drift) >= 0.005) {
    const perHead = Math.abs(drift) / Math.max(1, split.people.length)
    add(perHead > 0.5 ? 'warn' : 'info', 'drift',
      `Cash rounding is ${drift > 0 ? 'over' : 'under'} by ${money(Math.abs(drift))}`,
      `Envelopes round to ${roundingStepCents >= 100 ? '$' + roundingStepCents / 100 : roundingStepCents + '¢'}. ${drift > 0 ? 'The float covers the difference.' : 'The remainder carries into the next period.'}`)
  }

  // ── people & roles ────────────────────────────────────────────────────────
  const noRole = pooled.filter(p => !roles.some(r => r.id === p.roleId))
  if (noRole.length) {
    add('error', 'norole', `${people(noRole.length)} have no role`,
      `${noRole.map(p => p.name).join(', ')} are weighted at ×1 by default. Give them a role in Tip settings.`,
      [{ label: 'Open Tip settings', kind: 'goto', arg: 'settings' }])
  }
  const noCode = pooled.filter(p => !p.clockId)
  if (noCode.length) {
    add('warn', 'nocode', `${people(noCode.length)} have no employee code`,
      `${noCode.map(p => p.name).join(', ')} cannot be matched to the clock file, so their hours must be typed by hand.`,
      [{ label: 'Open Tip settings', kind: 'goto', arg: 'settings' }])
  }
  const idle = pooled.filter(p => !p.hours.some(h => h > 0)).map(p => p.name)
  if (idle.length) {
    add('info', 'idle', `${plural(idle.length, 'roster member')} with no hours`,
      `${idle.join(', ')} did not clock in this period and get nothing. They stay on the roster.`)
  }
  const notes = punches.filter(r => r.note)
  if (notes.length) {
    add('info', 'notes', `${plural(notes.length, 'shift')} carry a manager note`,
      notes.slice(0, 4).map(r => `${r.firstName} · ${dayLabels[r.dayIndex] ?? '—'} · “${r.note}”`).join(' • ') + (notes.length > 4 ? ' • …' : ''))
  }

  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 }
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.amount ?? 0) - (a.amount ?? 0))

  return {
    ledger,
    findings,
    counts: {
      error: findings.filter(f => f.severity === 'error').length,
      warn: findings.filter(f => f.severity === 'warn').length,
      info: findings.filter(f => f.severity === 'info').length,
      shifts, eligible, inPool, unexplained,
      missingHours: lost,
      lostPeople: [...unknown.values(), ...unapproved.values()]
        .sort((a, b) => b.h - a.h)
        .map(u => `${u.name} ${u.last}`),
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/tips/__tests__/audit.test.ts
```

Expected: PASS — 17 tests across the two describes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tips/audit.ts src/lib/tips/__tests__/audit.test.ts && git commit -m "feat(tips): hours reconciliation ledger and payout findings"
```

---

### Task 5: Workbook parsers

**Files:**
- Create: `src/lib/tips/xlsx.ts`
- Test: `src/lib/tips/__tests__/xlsx.test.ts`

**Interfaces:**
- Consumes: `dayIndexOf` from `@/lib/tips/period`; `PunchRow` from `@/lib/tips/audit`.
- Produces:
  - `parseSalesWorkbook(buffer: Buffer): { iso: string[]; sales: number[]; tips: number[] | null; reportedNet: number | null }`
  - `parseClocksWorkbook(buffer: Buffer, startDate: string, dayCount: number): { rows: PunchRow[]; total: number; peopleCount: number; outside: number; pending: number }`

Both throw `Error` with a message written for the manager, not the developer — the import panel renders it verbatim.

- [ ] **Step 1: Write the failing test**

Create `src/lib/tips/__tests__/xlsx.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseSalesWorkbook, parseClocksWorkbook } from '@/lib/tips/xlsx'

function book(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

describe('parseSalesWorkbook', () => {
  it('reads the "Sales by day" sheet into ISO dates and net sales', () => {
    const buf = book({
      'Sales by day': [
        ['Date', 'Net sales'],
        [20260712, 12698.27],
        [20260713, 9112.81],
      ],
      'Revenue summary': [['Net sales', 'Gross'], [21811.08, 24000]],
    })
    const r = parseSalesWorkbook(buf)
    expect(r.iso).toEqual(['2026-07-12', '2026-07-13'])
    expect(r.sales).toEqual([12698.27, 9112.81])
    expect(r.reportedNet).toBeCloseTo(21811.08, 2)
  })

  it('reports tips as null when the export has no tips column', () => {
    const r = parseSalesWorkbook(book({
      'Sales by day': [['Date', 'Net sales'], [20260712, 100]],
    }))
    expect(r.tips).toBeNull()
  })

  it('reads a tips column when the export carries one, wherever it sits', () => {
    const r = parseSalesWorkbook(book({
      'Sales by day': [
        ['Date', 'Net sales', 'Discounts', 'Tips'],
        [20260712, 100, 5, 18.5],
        [20260713, 200, 0, 31.25],
      ],
    }))
    expect(r.tips).toEqual([18.5, 31.25])
  })

  it('throws a manager-readable error when the sheet is missing', () => {
    expect(() => parseSalesWorkbook(book({ Summary: [['nope']] })))
      .toThrow(/Sales by day/)
  })
})

describe('parseClocksWorkbook', () => {
  const rows = [
    ['Clocks Summary'],
    ['First Name', 'Last Name', 'Clock ID', 'Position', 'Department', 'Date In', 'Total Less Break', 'Status', 'Manager Comments'],
    ['Liam', 'Sjogren', '706', 'Sous Chef', 'Back of House', '2026-07-12', 9.62, 'Approved', ''],
    ['Thaign', 'Lillie', '1155', 'BOH team', 'Back of House', '2026-07-13', 10, 'Approved', 'iPad had no power'],
    ['Ghost', 'Shift', '999', 'BOH team', 'Back of House', '2026-08-30', 4, 'Approved', ''],
    ['Totals', '', '', '', '', '', 23.62, '', ''],
  ]

  it('maps punches onto day indexes relative to the period start', () => {
    const r = parseClocksWorkbook(book({ Sheet1: rows }), '2026-07-12', 14)
    expect(r.rows).toHaveLength(3)
    expect(r.rows[0]).toMatchObject({ clockId: '706', dayIndex: 0, hours: 9.62, department: 'Back of House' })
    expect(r.rows[1]).toMatchObject({ clockId: '1155', dayIndex: 1, note: 'iPad had no power' })
    expect(r.peopleCount).toBe(3)
    expect(r.total).toBeCloseTo(23.62, 2)
  })

  it('counts punches dated outside the period without dropping them', () => {
    const r = parseClocksWorkbook(book({ Sheet1: rows }), '2026-07-12', 14)
    expect(r.outside).toBe(1)
    expect(r.rows.find(x => x.clockId === '999')!.dayIndex).toBeGreaterThan(13)
  })

  it('drops the Totals footer row', () => {
    const r = parseClocksWorkbook(book({ Sheet1: rows }), '2026-07-12', 14)
    expect(r.rows.some(x => x.firstName === 'Totals')).toBe(false)
  })

  it('throws when the header row is not the Clocks Summary layout', () => {
    expect(() => parseClocksWorkbook(book({ Sheet1: [['a', 'b']] }), '2026-07-12', 14))
      .toThrow(/Clocks Summary/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/tips/__tests__/xlsx.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/tips/xlsx"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/tips/xlsx.ts`:

```ts
/**
 * Reads the two POS workbooks that drive a tip period.
 *
 * Runs on the server with SheetJS (already a dependency, and already how
 * /api/sales/import and the inventory import read workbooks) rather than the
 * design mock's hand-rolled DecompressionStream unzip — punches are persisted,
 * so there is nothing to gain from keeping the bytes in the browser.
 *
 * Every thrown message is written for the manager staring at the drop zone.
 */
import * as XLSX from 'xlsx'
import { dayIndexOf } from './period'
import type { PunchRow } from './audit'

type Row = unknown[]

function sheetRows(wb: XLSX.WorkBook, name: string): Row[] | null {
  const key = wb.SheetNames.find(n => n.toLowerCase() === name.toLowerCase())
  if (!key) return null
  return XLSX.utils.sheet_to_json<Row>(wb.Sheets[key], { header: 1, defval: null, raw: true })
}

function num(v: unknown): number {
  if (v == null) return NaN
  if (typeof v === 'number') return v
  return parseFloat(String(v).replace(/[$,\s]/g, ''))
}

/** Excel serial (or a parseable date string) → 'YYYY-MM-DD'. */
function toIsoDate(v: unknown): string | null {
  if (typeof v === 'number' && v > 1000) {
    const ms = Math.round((v - 25569) * 86_400_000)
    return new Date(ms).toISOString().slice(0, 10)
  }
  const s = String(v ?? '').trim()
  // Toast writes the day key as yyyyMMdd
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10)
}

export interface ParsedSales {
  iso: string[]
  sales: number[]
  /**
   * Tips per day, when the export carries a tips column — Toast's Sales Summary
   * includes one on some configurations and not others. `null` means the
   * workbook said nothing about tips, which must NOT be read as zero.
   */
  tips: number[] | null
  /** "Net sales" from the Revenue summary sheet, when present — a cross-check. */
  reportedNet: number | null
}

/**
 * Sales Summary workbook → one net-sales figure per calendar day, plus tips
 * when the export carries them.
 * Needs the "Sales by day" sheet: column A the day key, column B net sales.
 */
export function parseSalesWorkbook(buffer: Buffer): ParsedSales {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const rows = sheetRows(wb, 'Sales by day')
  if (!rows) {
    throw new Error('No “Sales by day” sheet — export the Sales Summary with day detail turned on.')
  }

  // Optional tips column, located by header text rather than position.
  const header = (rows[0] ?? []).map(c => String(c ?? '').trim().toLowerCase())
  const tipCol = header.findIndex(h => /^tips?$/.test(h) || /tip (amount|total)/.test(h))

  const iso: string[] = []
  const sales: number[] = []
  const tips: number[] = []
  for (const r of rows.slice(1)) {
    const day = toIsoDate(r?.[0])
    const net = num(r?.[1])
    if (!day || isNaN(net)) continue
    iso.push(day)
    sales.push(Math.round(net * 100) / 100)
    if (tipCol >= 0) {
      const t = num(r?.[tipCol])
      tips.push(isNaN(t) ? 0 : Math.round(t * 100) / 100)
    }
  }
  if (!iso.length) throw new Error('“Sales by day” had no usable rows.')

  let reportedNet: number | null = null
  const rev = sheetRows(wb, 'Revenue summary')
  if (rev?.[0]) {
    const i = rev[0].findIndex(h => /^net sales$/i.test(String(h ?? '')))
    if (i >= 0) {
      const v = num(rev[1]?.[i])
      if (!isNaN(v)) reportedNet = v
    }
  }

  return { iso, sales, tips: tipCol >= 0 ? tips : null, reportedNet }
}

export interface ParsedClocks {
  rows: PunchRow[]
  total: number
  peopleCount: number
  /** Punches whose date falls outside the period window. Kept, flagged by the audit. */
  outside: number
  pending: number
}

/**
 * Clocks Summary workbook → one PunchRow per approved-or-not punch.
 * Hours are matched to people by Clock ID only — never by name, so a spelling
 * change in the POS cannot silently drop somebody from the payout.
 */
export function parseClocksWorkbook(
  buffer: Buffer,
  startDate: string,
  dayCount: number,
): ParsedClocks {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheet = wb.SheetNames[0]
  if (!sheet) throw new Error('That workbook has no sheets.')
  const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheet], { header: 1, defval: null, raw: true })

  const headerIdx = rows.findIndex(r => r?.some(c => /^first name$/i.test(String(c ?? '').trim())))
  if (headerIdx < 0) {
    throw new Error('No header row found — this does not look like a Clocks Summary export.')
  }
  const header = rows[headerIdx].map(c => String(c ?? '').trim().toLowerCase())
  const col = (...names: string[]) => {
    for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i }
    return -1
  }
  const C = {
    first: col('first name'),
    last: col('last name'),
    code: col('clock id', 'employee number'),
    pos: col('position'),
    dept: col('department'),
    dateIn: col('date in'),
    hours: col('total less break', 'total'),
    status: col('status'),
    notes: [col('time in comments'), col('time out comments'), col('manager comments')].filter(i => i >= 0),
  }
  if (C.code < 0 || C.dateIn < 0 || C.hours < 0) {
    throw new Error('Missing a Clock ID, Date In or Total Less Break column — re-export the Clocks Summary.')
  }

  const out: PunchRow[] = []
  for (const r of rows.slice(headerIdx + 1)) {
    const first = String(r?.[C.first] ?? '').trim()
    if (!first || /^totals?$/i.test(first)) continue
    const code = String(r?.[C.code] ?? '').trim()
    const hours = Math.round(num(r?.[C.hours]) * 100) / 100
    const iso = toIsoDate(r?.[C.dateIn])
    if (!code || isNaN(hours) || !iso) continue
    out.push({
      clockId: code,
      firstName: first,
      lastName: C.last >= 0 ? String(r?.[C.last] ?? '').trim() : '',
      position: C.pos >= 0 ? String(r?.[C.pos] ?? '').trim() : '',
      department: C.dept >= 0 ? String(r?.[C.dept] ?? '').trim() : '',
      dayIndex: dayIndexOf(startDate, iso),
      hours,
      status: C.status >= 0 ? String(r?.[C.status] ?? 'Approved').trim() || 'Approved' : 'Approved',
      note: C.notes.map(i => r?.[i]).filter(Boolean).join(' · ') || null,
    })
  }
  if (!out.length) throw new Error('No punches found in that workbook.')

  return {
    rows: out,
    total: Math.round(out.reduce((a, r) => a + r.hours, 0) * 100) / 100,
    peopleCount: new Set(out.map(r => r.clockId)).size,
    outside: out.filter(r => r.dayIndex < 0 || r.dayIndex >= dayCount).length,
    pending: out.filter(r => !/approved/i.test(r.status)).length,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/tips/__tests__/xlsx.test.ts
```

Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tips/xlsx.ts src/lib/tips/__tests__/xlsx.test.ts && git commit -m "feat(tips): server-side Sales Summary and Clocks Summary parsers"
```

---

### Task 6: Scope resolver — daily net sales and tips

**Files:**
- Create: `src/lib/tips/sales.ts`
- Test: `src/lib/tips/__tests__/sales.test.ts`

**Interfaces:**
- Consumes: `periodDays` from `@/lib/tips/period`; `dedupeSalesEntries` from `@/lib/sales-dedup`; `resolveScopedRcIds` from `@/lib/rc-scope`.
- Produces:
  - `foldDailyTotals(rows, days): DailyTotals` — **pure**, exported for testing, where `DailyTotals = { net: number[]; tips: Array<number | null>; missingSalesDays: number[]; missingTipDays: number[] }`
  - `resolveSalesScopeRcIds(user, settings): Promise<{ rcIds: string[]; label: string }>` — server-only
  - `dailyTotals(user, settings, startDate, dayCount): Promise<DailyTotals & { rcIds: string[]; label: string }>` — server-only

**This is the task that answers "the sales basis is configurable and independent of the pool's RC."** `TipSettings.salesSourceMode` is `'LOCATION'` (every active RC under `salesLocationId`) or `'RC'` (exactly `salesRcIds`). Neither has anything to do with `TipPeriod.revenueCenterId`, which is the crew side of the pool. The same scope produces **both** figures per day — net sales and tips collected — so `TipPeriod.poolBasis` picks between them without a second scope to keep in sync.

- [ ] **Step 1: Write the failing test**

Create `src/lib/tips/__tests__/sales.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { foldDailyTotals } from '@/lib/tips/sales'

const DAYS = ['2026-07-12', '2026-07-13', '2026-07-14']

function row(
  date: string, rc: string, total: number,
  opts: { tips?: number | null; grat?: number | null; source?: string; periodType?: string } = {},
) {
  return {
    date: new Date(date + 'T12:00:00.000Z'),
    revenueCenterId: rc,
    totalRevenue: total,
    tipsCollected: opts.tips === undefined ? null : opts.tips,
    autoGratuity: opts.grat === undefined ? null : opts.grat,
    source: opts.source ?? 'manual',
    periodType: opts.periodType ?? 'day',
  }
}

describe('foldDailyTotals', () => {
  it('sums every revenue center in scope onto its day', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100), row('2026-07-12', 'bar', 50), row('2026-07-13', 'kitchen', 80)],
      DAYS,
    )
    expect(r.net).toEqual([150, 80, 0])
  })

  it('reports days with no entry at all, not days that genuinely sold nothing', () => {
    const r = foldDailyTotals([row('2026-07-12', 'kitchen', 100), row('2026-07-13', 'kitchen', 0)], DAYS)
    expect(r.missingSalesDays).toEqual([2])
  })

  it('keeps the Toast row when a manual row shadows it', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100, { source: 'manual' }), row('2026-07-12', 'kitchen', 120, { source: 'toast' })],
      DAYS,
    )
    expect(r.net[0]).toBe(120)
  })

  it('ignores multi-day period rows so one week entry cannot inflate a single day', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100), row('2026-07-12', 'kitchen', 9000, { periodType: 'week' })],
      DAYS,
    )
    expect(r.net[0]).toBe(100)
  })

  it('rounds to the cent', () => {
    const r = foldDailyTotals([row('2026-07-12', 'a', 10.005), row('2026-07-12', 'b', 10.005)], DAYS)
    expect(r.net[0]).toBe(20.01)
  })

  it('sums tips across the scope and reports days with no tip data as null', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100, { tips: 18 }), row('2026-07-12', 'bar', 50, { tips: 7 }),
       row('2026-07-13', 'kitchen', 80)],
      DAYS,
    )
    expect(r.tips).toEqual([25, null, null])
    expect(r.missingTipDays).toEqual([1, 2])
  })

  it('distinguishes a day that took zero tips from a day with no tip data', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100, { tips: 0 }), row('2026-07-13', 'kitchen', 80)],
      DAYS,
    )
    expect(r.tips[0]).toBe(0)
    expect(r.tips[1]).toBeNull()
    expect(r.missingTipDays).toEqual([1, 2])
  })

  it('counts a day as having tip data when at least one revenue center reports it', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100, { tips: 18 }), row('2026-07-12', 'bar', 50)],
      DAYS,
    )
    expect(r.tips[0]).toBe(18)
    expect(r.missingTipDays).not.toContain(0)
  })

  it('adds auto-gratuity to the tip pot only when the house counts it', () => {
    const rows = [row('2026-07-12', 'kitchen', 100, { tips: 18, grat: 30 })]
    expect(foldDailyTotals(rows, DAYS, true).tips[0]).toBe(48)
    expect(foldDailyTotals(rows, DAYS, false).tips[0]).toBe(18)
  })

  it('still reports a day as having tip data when only auto-gratuity was charged', () => {
    const rows = [row('2026-07-12', 'kitchen', 100, { grat: 30 })]
    expect(foldDailyTotals(rows, DAYS, true).tips[0]).toBe(30)
    // With auto-grat excluded there is no payment-tip figure at all for that day.
    expect(foldDailyTotals(rows, DAYS, false).tips[0]).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/tips/__tests__/sales.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/tips/sales"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/tips/sales.ts`:

```ts
/**
 * Daily net sales for a tip period.
 *
 * THE SALES BASIS IS DELIBERATELY INDEPENDENT OF THE POOL'S REVENUE CENTER.
 * A kitchen tip pool is normally funded by the whole venue's sales, not by the
 * kitchen RC's own line: tips for RC "Kitchen" are typically driven by every RC
 * under Location "Cafe". TipSettings.salesSourceMode picks which:
 *   'LOCATION' → every active RC under salesLocationId
 *   'RC'       → exactly the ids listed in salesRcIds
 * Neither reads TipPeriod.revenueCenterId, which is the crew side of the pool.
 *
 * Only periodType 'day' rows are summed. A multi-day manual entry carries a
 * single start date and would dump a whole week onto one day pool (the same
 * trap documented in sales-dedup.ts).
 */
import 'server-only'
import { prisma } from '@/lib/prisma'
import type { TipSettings, User } from '@prisma/client'
import { dedupeSalesEntries } from '@/lib/sales-dedup'
import { resolveScopedRcIds } from '@/lib/rc-scope'
import { periodDays } from './period'

interface SalesRow {
  date: Date
  revenueCenterId: string
  totalRevenue: number
  tipsCollected: number | null
  autoGratuity: number | null
  source: string
  periodType: string
}

export interface DailyTotals {
  /** Net sales per day. A day with no row reads 0 and is listed in missingSalesDays. */
  net: number[]
  /** Customer tips per day. `null` on a day no revenue center reported tips. */
  tips: Array<number | null>
  missingSalesDays: number[]
  missingTipDays: number[]
}

/**
 * Folds SalesEntry rows into per-day net sales AND per-day customer tips.
 * PURE — exported so the fold is unit-testable without a database.
 *
 * The `missing*` lists carry day indexes with NO data at all, which is a
 * different (and much worse) condition than a day that genuinely took $0: the
 * audit turns a missing BASIS day into a blocking error rather than a warning.
 * A tip figure of 0 and a tip figure of null must never be conflated — that
 * distinction is the whole reason SalesEntry.tipsCollected is nullable.
 */
export function foldDailyTotals(
  rows: SalesRow[],
  days: string[],
  includeAutoGratuity = true,
): DailyTotals {
  const daily = rows.filter(r => r.periodType === 'day')
  const deduped = dedupeSalesEntries(daily)

  const salesByDay = new Map<string, number>()
  const tipsByDay = new Map<string, number>()
  const sawSales = new Set<string>()
  const sawTips = new Set<string>()

  for (const r of deduped) {
    const key = r.date.toISOString().slice(0, 10)
    salesByDay.set(key, (salesByDay.get(key) ?? 0) + Number(r.totalRevenue))
    sawSales.add(key)
    // Auto-gratuity counts as a tip only when the house says so — the decision
    // is applied here, at read time, never baked into the stored columns.
    const grat = includeAutoGratuity ? r.autoGratuity : null
    if (r.tipsCollected != null || grat != null) {
      const amount = Number(r.tipsCollected ?? 0) + Number(grat ?? 0)
      tipsByDay.set(key, (tipsByDay.get(key) ?? 0) + amount)
      sawTips.add(key)
    }
  }

  const round = (n: number) => Math.round(n * 100) / 100
  return {
    net: days.map(d => round(salesByDay.get(d) ?? 0)),
    tips: days.map(d => (sawTips.has(d) ? round(tipsByDay.get(d) ?? 0) : null)),
    missingSalesDays: days.map((d, i) => (sawSales.has(d) ? -1 : i)).filter(i => i >= 0),
    missingTipDays: days.map((d, i) => (sawTips.has(d) ? -1 : i)).filter(i => i >= 0),
  }
}

/**
 * The revenue centers the pool's sales are read from, intersected with the
 * caller's own access scope so a scoped manager can never widen their reach
 * through the tip settings.
 */
export async function resolveSalesScopeRcIds(
  user: User,
  settings: Pick<TipSettings, 'salesSourceMode' | 'salesLocationId' | 'salesRcIds'>,
): Promise<{ rcIds: string[]; label: string }> {
  const allowed = await resolveScopedRcIds(user)

  if (settings.salesSourceMode === 'LOCATION' && settings.salesLocationId) {
    const location = await prisma.location.findUnique({
      where: { id: settings.salesLocationId },
      select: { name: true, revenueCenters: { where: { isActive: true }, select: { id: true } } },
    })
    if (!location) return { rcIds: [], label: 'No sales source configured' }
    const ids = location.revenueCenters.map(rc => rc.id)
    return {
      rcIds: allowed === null ? ids : ids.filter(id => allowed.has(id)),
      label: `${location.name} · all revenue centers`,
    }
  }

  const configured = Array.isArray(settings.salesRcIds) ? (settings.salesRcIds as string[]) : []
  if (!configured.length) return { rcIds: [], label: 'No sales source configured' }
  const rcs = await prisma.revenueCenter.findMany({
    where: { id: { in: configured } },
    select: { id: true, name: true },
  })
  const ids = rcs.map(rc => rc.id)
  return {
    rcIds: allowed === null ? ids : ids.filter(id => allowed.has(id)),
    label: rcs.map(rc => rc.name).join(' + ') || 'No sales source configured',
  }
}

/** The period's daily net sales and customer tips, straight from SalesEntry. */
export async function dailyTotals(
  user: User,
  settings: Pick<TipSettings, 'salesSourceMode' | 'salesLocationId' | 'salesRcIds' | 'includeAutoGratuity'>,
  startDate: string,
  dayCount: number,
): Promise<DailyTotals & { rcIds: string[]; label: string }> {
  const days = periodDays(startDate, dayCount)
  const { rcIds, label } = await resolveSalesScopeRcIds(user, settings)
  const allMissing = days.map((_, i) => i)
  if (!rcIds.length) {
    return {
      net: days.map(() => 0), tips: days.map(() => null),
      missingSalesDays: allMissing, missingTipDays: allMissing, rcIds, label,
    }
  }

  const rows = await prisma.salesEntry.findMany({
    where: {
      revenueCenterId: { in: rcIds },
      date: { gte: new Date(days[0] + 'T00:00:00.000Z'), lte: new Date(days[days.length - 1] + 'T23:59:59.999Z') },
    },
    select: {
      date: true, revenueCenterId: true, totalRevenue: true,
      tipsCollected: true, autoGratuity: true, source: true, periodType: true,
    },
  })

  const folded = foldDailyTotals(
    rows.map(r => ({
      ...r,
      totalRevenue: Number(r.totalRevenue),
      tipsCollected: r.tipsCollected == null ? null : Number(r.tipsCollected),
      autoGratuity: r.autoGratuity == null ? null : Number(r.autoGratuity),
    })),
    days,
    settings.includeAutoGratuity,
  )
  return { ...folded, rcIds, label }
}

/**
 * Picks the per-day amount the pool rate applies to, and the day indexes that
 * amount is missing on. One place, so the page, the freeze and the export can
 * never disagree about what the pool was a percentage of.
 */
export function selectBasis(
  totals: Pick<DailyTotals, 'net' | 'tips' | 'missingSalesDays' | 'missingTipDays'>,
  poolBasis: 'NET_SALES' | 'TIPS_COLLECTED',
): { basis: number[]; missingBasisDays: number[] } {
  return poolBasis === 'TIPS_COLLECTED'
    ? { basis: totals.tips.map(t => t ?? 0), missingBasisDays: totals.missingTipDays }
    : { basis: totals.net, missingBasisDays: totals.missingSalesDays }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/tips/__tests__/sales.test.ts
```

Expected: PASS — 10 tests. (`foldDailyTotals` is imported from a module that also has `import 'server-only'`; vitest resolves `server-only` fine because nothing in the test touches Prisma. If the import fails, add `server-only` to `test.alias` in `vitest.config.ts` pointing at an empty stub — do **not** remove the `server-only` marker.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/tips/sales.ts src/lib/tips/__tests__/sales.test.ts && git commit -m "feat(tips): configurable scope resolver over SalesEntry, net sales and tips"
```

---

### Task 6A: Capture customer tips from Toast

> Lettered rather than renumbered so the ~40 cross-references in Tasks 7–14 stay valid. It slots between Tasks 6 and 7 and depends only on Task 1.

**Files:**
- Modify: `src/lib/toast/client.ts` (add `ToastPayment`, `ToastAppliedServiceCharge`, extend `ToastCheck`), `src/lib/toast/sales-sync.ts` (sum tips per RC, write both columns), `src/app/api/sales/route.ts` (accept manual tips)
- Create: `src/lib/toast/__tests__/tips.test.ts`
- Modify: `src/app/sales/page.tsx` (optional tips field on the manual entry form)

**Interfaces:**
- Consumes: the existing `fetchOrdersForBusinessDateInt` → `ToastOrder[]` pipeline. **No new API call and no new Toast scope** — `Check.payments[]` and `Check.appliedServiceCharges[]` already come back in the `/orders/v2/ordersBulk` response the app fetches today; `client.ts` simply does not model them.
- Produces: `checkTipTotals(check, includeAutoGratuity): { tips: number; gratuity: number }` (pure, exported for testing); `RcBucket.tips` / `RcBucket.gratuity`; `SalesEntry.tipsCollected` / `.autoGratuity` populated on every Toast sync.

**Attribution rule.** Revenue is routed **per line item** (one check can split across revenue centers — a café ticket's brunch to CAFE, its cocktail to BAR), but a tip belongs to the **check**, not a line. Tips are therefore split across the check's revenue centers **in proportion to that check's routed revenue**. A check that routed no revenue at all falls back to the order's RC; if that is also unresolved the tip is counted as unattributed and reported, never silently dropped.

- [ ] **Step 1: Write the failing test**

Create `src/lib/toast/__tests__/tips.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { checkTipTotals } from '@/lib/toast/client'
import type { ToastCheck } from '@/lib/toast/client'

const check = (over: Partial<ToastCheck>): ToastCheck => ({ guid: 'c1', ...over })

describe('checkTipTotals', () => {
  it('sums tipAmount across the check payments', () => {
    const r = checkTipTotals(check({
      payments: [
        { guid: 'p1', amount: 40, tipAmount: 8, type: 'CREDIT', paymentStatus: 'CAPTURED' },
        { guid: 'p2', amount: 20, tipAmount: 3, type: 'CASH' },
      ],
    }), true)
    expect(r.tips).toBe(11)
  })

  it('ignores voided and denied payments', () => {
    const r = checkTipTotals(check({
      payments: [
        { guid: 'p1', amount: 40, tipAmount: 8, type: 'CREDIT', paymentStatus: 'VOIDED' },
        { guid: 'p2', amount: 40, tipAmount: 5, type: 'CREDIT', paymentStatus: 'DENIED' },
        { guid: 'p3', amount: 40, tipAmount: 7, type: 'CREDIT', paymentStatus: 'CAPTURED' },
      ],
    }), true)
    expect(r.tips).toBe(7)
  })

  it('subtracts a refunded tip', () => {
    const r = checkTipTotals(check({
      payments: [{
        guid: 'p1', amount: 40, tipAmount: 10, type: 'CREDIT', paymentStatus: 'CAPTURED',
        refundStatus: 'PARTIAL', refund: { tipRefundAmount: 4 },
      }],
    }), true)
    expect(r.tips).toBe(6)
  })

  it('never returns a negative tip when a refund exceeds the tip', () => {
    const r = checkTipTotals(check({
      payments: [{
        guid: 'p1', amount: 40, tipAmount: 5, type: 'CREDIT', paymentStatus: 'CAPTURED',
        refundStatus: 'FULL', refund: { tipRefundAmount: 9 },
      }],
    }), true)
    expect(r.tips).toBe(0)
  })

  it('reports gratuity service charges separately from payment tips', () => {
    const r = checkTipTotals(check({
      payments: [{ guid: 'p1', amount: 100, tipAmount: 12, type: 'CREDIT', paymentStatus: 'CAPTURED' }],
      appliedServiceCharges: [
        { guid: 's1', name: 'Auto grat 20%', chargeAmount: 20, gratuity: true },
        { guid: 's2', name: 'Booking fee', chargeAmount: 5, gratuity: false },
      ],
    }), true)
    expect(r.tips).toBe(12)
    expect(r.gratuity).toBe(20)
  })

  it('returns zero gratuity when the house does not count auto-grat as tips', () => {
    const r = checkTipTotals(check({
      appliedServiceCharges: [{ guid: 's1', name: 'Auto grat', chargeAmount: 20, gratuity: true }],
    }), false)
    expect(r.gratuity).toBe(0)
  })

  it('is zero for a check with no payments at all', () => {
    expect(checkTipTotals(check({}), true)).toEqual({ tips: 0, gratuity: 0 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/toast/__tests__/tips.test.ts
```

Expected: FAIL — `"checkTipTotals" is not exported by "src/lib/toast/client.ts"`.

- [ ] **Step 3: Extend the Toast types and add the summer**

In `src/lib/toast/client.ts`, add above `export interface ToastCheck`:

```ts
/**
 * A payment on a check. Already present in every ordersBulk response — the app
 * simply never modelled it. `amount` EXCLUDES the tip; `tipAmount` is the tip.
 * https://doc.toasttab.com/openapi/orders/tag/Data-definitions/schema/Payment/
 */
export interface ToastPayment {
  guid: string
  /** Payment amount, excluding the tip. */
  amount?: number
  /** The amount tipped on this payment. */
  tipAmount?: number
  type?: string // CASH | CREDIT | GIFTCARD | HOUSE_ACCOUNT | OTHER | UNDETERMINED …
  paymentStatus?: string // OPEN | PROCESSING | AUTHORIZED | CAPTURED | VOIDED | DENIED | ERROR
  refundStatus?: string // NONE | PARTIAL | FULL
  refund?: { refundAmount?: number; tipRefundAmount?: number }
  voidInfo?: { voidDate?: string } | null
}

/**
 * A restaurant-configured service charge. `gratuity: true` marks auto-gratuity,
 * which some houses pay out with the tip pot and some treat as revenue — hence
 * TipSettings.includeAutoGratuity rather than a hard-coded rule.
 */
export interface ToastAppliedServiceCharge {
  guid: string
  name?: string
  chargeAmount?: number
  chargeType?: string
  gratuity?: boolean
  taxable?: boolean
  refundDetails?: { refundAmount?: number } | null
}
```

Extend `ToastCheck` — add two fields after `selections?: ToastSelection[]`:

```ts
  payments?: ToastPayment[]
  appliedServiceCharges?: ToastAppliedServiceCharge[]
```

Then add the summer below the `ToastOrder` interface:

```ts
/** Payment states whose tip never reached the house. */
const DEAD_PAYMENT_STATUS = new Set(['VOIDED', 'DENIED', 'ERROR'])

/**
 * Customer tips on one check, net of refunds.
 *
 * Returns payment tips and gratuity service charges SEPARATELY so the two can
 * be stored in separate columns — whether auto-gratuity counts as a tip is a
 * house policy that must stay changeable without re-syncing Toast.
 */
export function checkTipTotals(
  check: ToastCheck,
  includeAutoGratuity: boolean,
): { tips: number; gratuity: number } {
  let tips = 0
  for (const p of check.payments ?? []) {
    if (p.voidInfo) continue
    if (p.paymentStatus && DEAD_PAYMENT_STATUS.has(p.paymentStatus)) continue
    const net = (p.tipAmount ?? 0) - (p.refund?.tipRefundAmount ?? 0)
    if (net > 0) tips += net
  }

  let gratuity = 0
  if (includeAutoGratuity) {
    for (const s of check.appliedServiceCharges ?? []) {
      if (!s.gratuity) continue
      const net = (s.chargeAmount ?? 0) - (s.refundDetails?.refundAmount ?? 0)
      if (net > 0) gratuity += net
    }
  }

  const round = (n: number) => Math.round(n * 100) / 100
  return { tips: round(tips), gratuity: round(gratuity) }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/toast/__tests__/tips.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Attribute tips per revenue center in the sync**

In `src/lib/toast/sales-sync.ts`, add two fields to `RcBucket`:

```ts
interface RcBucket {
  revenueCenterId: string
  totalRevenue: number
  foodRevenue: number
  /** Customer payment tips, split across RCs by each check's routed revenue. */
  tips: number
  /** Gratuity service charges, split the same way. */
  gratuity: number
  covers: number
  qtyByRecipe: Map<string, number>
  unmatched: Map<string, number> // toastItemGuid → qty (sold but no recipe mapping)
}
```

Update `getBucket` to seed them:

```ts
    if (!b) { b = { revenueCenterId: rcId, totalRevenue: 0, foodRevenue: 0, tips: 0, gratuity: 0, covers: 0, qtyByRecipe: new Map(), unmatched: new Map() }; buckets.set(rcId, b) }
```

Import the summer at the top of the file, alongside the existing client imports:

```ts
import { checkTipTotals } from './client'
```

Inside `for (const order of orders)`, the check loop currently reads:

```ts
    for (const check of order.checks ?? []) {
      if (check.voided || check.deleted) continue
      for (const sel of check.selections ?? []) {
```

Replace that block's body so each check's revenue split is tracked, then its tips are apportioned. The full replacement for the check loop:

```ts
    for (const check of order.checks ?? []) {
      if (check.voided || check.deleted) continue

      // Revenue this check routed, per RC — the weights the tip is split by.
      const checkRcRevenue = new Map<string, number>()

      for (const sel of check.selections ?? []) {
        if (sel.voided || sel.deferred) continue
        const item = sel.item?.guid ? itemByGuid.get(sel.item.guid) : undefined
        const menuRc = item?.toastMenu ? menuRoutes.get(item.toastMenu) : undefined
        const rcId = menuRc ?? orderRc
        if (!rcId) continue // can't route (no menu mapping, no order RC) → skip line

        const cls = classifyGroup(item?.toastGroup)
        if (cls.ignore) continue // Toast scaffolding lines

        const bucket = getBucket(rcId)
        routedAny = true
        const price = sel.price ?? 0
        bucket.totalRevenue += price
        if (cls.isFood) bucket.foodRevenue += price
        orderRcRevenue.set(rcId, (orderRcRevenue.get(rcId) ?? 0) + price)
        checkRcRevenue.set(rcId, (checkRcRevenue.get(rcId) ?? 0) + price)

        const qty = Math.round(sel.quantity ?? 0)
        if (qty <= 0) continue
        if (item?.recipeId) {
          bucket.qtyByRecipe.set(item.recipeId, (bucket.qtyByRecipe.get(item.recipeId) ?? 0) + qty)
        } else if (sel.item?.guid) {
          bucket.unmatched.set(sel.item.guid, (bucket.unmatched.get(sel.item.guid) ?? 0) + qty)
        }
      }

      // A tip belongs to the CHECK, not to a line, so split it across the RCs
      // this check actually sold into, weighted by their share of its revenue.
      // No routed revenue → fall back to the order's RC; still nothing → count
      // it as unattributed rather than dropping it on the floor.
      const { tips, gratuity } = checkTipTotals(check, includeAutoGratuity)
      if (tips > 0 || gratuity > 0) {
        const weights = checkRcRevenue.size
          ? checkRcRevenue
          : orderRc ? new Map([[orderRc, 1]]) : new Map<string, number>()
        const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0)
        if (totalWeight > 0) {
          for (const [rcId, weight] of weights) {
            const share = weight / totalWeight
            const b = getBucket(rcId)
            b.tips += tips * share
            b.gratuity += gratuity * share
          }
        } else {
          unattributedTips += tips + gratuity
        }
      }
    }
```

Declare the two new locals beside `skippedUnmappedRcOrders`:

```ts
  let unattributedTips = 0
  const includeAutoGratuity =
    (await prisma.tipSettings.findUnique({ where: { id: 'singleton' }, select: { includeAutoGratuity: true } }))
      ?.includeAutoGratuity ?? true
```

- [ ] **Step 6: Write both columns on the upsert**

In the same file, the `salesEntry.update` and `salesEntry.create` calls each carry `totalRevenue` / `foodSalesPct` / `covers`. Add the two tip columns to **both**, rounded to the cent:

```ts
            totalRevenue: bucket.totalRevenue,
            foodSalesPct,
            tipsCollected: Math.round(bucket.tips * 100) / 100,
            autoGratuity: Math.round(bucket.gratuity * 100) / 100,
            covers: bucket.covers || null,
```

Add `tipsCollected` to the `perRc` result entry so the sync log shows it, and surface the unattributed total on `DaySyncResult`:

```ts
      tipsCollected: Math.round(bucket.tips * 100) / 100,
```

```ts
export interface DaySyncResult {
  businessDate: number
  ordersPulled: number
  status: 'ok' | 'skipped' | 'error'
  /** Tips on checks that routed to no revenue center — reported, never dropped. */
  unattributedTips: number
  perRc: { /* … existing fields … */ tipsCollected: number }[]
```

and include `unattributedTips` in the returned object. Log it when non-zero, next to the existing `manualConflicts` warning:

```ts
  if (unattributedTips > 0.005) console.warn(`[toast-sync ${yyyymmdd}] ${unattributedTips.toFixed(2)} in tips could not be attributed to a revenue center`)
```

- [ ] **Step 7: Let a manual sales entry carry tips**

In `src/app/api/sales/route.ts`'s `POST` handler, the body is destructured as `const { lineItems = [], revenueCenterId: bodyRcId, ...rest } = body`. Add explicit validation before the create so a manual day can supply tips (needed whenever the pool basis is `TIPS_COLLECTED` and a day was never synced from Toast):

```ts
  // Optional customer tips on a manual entry. Absent → null ("no tip data"),
  // which the tip payout audit treats very differently from 0.
  let tipsCollected: number | null = null
  if (rest.tipsCollected !== undefined && rest.tipsCollected !== null && rest.tipsCollected !== '') {
    const v = Number(rest.tipsCollected)
    if (!isFinite(v) || v < 0) {
      return NextResponse.json({ error: 'tipsCollected must be a positive number' }, { status: 400 })
    }
    tipsCollected = Math.round(v * 100) / 100
  }
```

Pass `tipsCollected` in the `prisma.salesEntry.create({ data: { … } })` call, and drop `tipsCollected` out of the spread `rest` so it is not written twice.

In `src/app/sales/page.tsx`, add one optional field to the manual-entry form beside the revenue input — label `Tips collected`, `type="number"`, `step="0.01"`, `min="0"`, placeholder `optional`, with the hint `leave blank if unknown — blank is not zero`. Send it in the POST body as `tipsCollected`.

- [ ] **Step 8: Backfill the tip columns for days already synced**

Every existing `SalesEntry` has `tipsCollected = NULL`, so a `TIPS_COLLECTED` period over past days would be all-blocking-errors until re-synced. Re-run the Toast sync over the range you intend to pay from — the sync is idempotent and upserts the same rows:

```bash
curl -s -X POST localhost:3000/api/toast/sync -H 'content-type: application/json' -d '{"startDate":"2026-07-12","endDate":"2026-07-25"}' | head -c 600
```

Check the exact request shape of the existing sync endpoint under `src/app/api/toast/` before running this — if it syncs a single day, loop the dates. Expected: each day reports a non-zero `tipsCollected` for at least one revenue center. Days that predate the restaurant's Toast connection stay null and must be entered manually or overridden from the workbook.

⚠️ This writes to the **live** database. Confirm with the user before running it against production data.

- [ ] **Step 9: Verify and commit**

```bash
npm test && npm run build 2>&1 | grep -E "Failed to compile|Type error" | head
```

Expected: all suites pass, no compile or type errors.

```bash
git add src/lib/toast src/app/api/sales/route.ts src/app/sales/page.tsx && git commit -m "feat(sales): capture customer tips and auto-gratuity per revenue center from Toast"
```

---

### Task 7: Settings, roles and roster API

**Files:**
- Create: `src/app/api/tips/settings/route.ts`, `src/app/api/tips/roles/route.ts`, `src/app/api/tips/roles/[id]/route.ts`, `src/app/api/tips/roster/route.ts`, `src/app/api/tips/roster/[id]/route.ts`

**Interfaces:**
- Consumes: `requireSession`, `AuthError`, `prisma`, `resolveSalesScopeRcIds` (Task 6).
- Produces:
  - `GET/PUT /api/tips/settings` → `TipSettingsDTO`
  - `GET/POST /api/tips/roles`, `PATCH/DELETE /api/tips/roles/[id]` → `TipRoleDef[]`
  - `POST /api/tips/roster` (create a Cook from a clock punch), `PATCH /api/tips/roster/[id]` (tip-payroll fields only)

Gating: read MANAGER, write MANAGER. **`/api/tips/roster` writes only the payroll columns** (`lastName`, `clockId`, `wage`, `tipRoleId`, `onTipPool`, `posPosition`) — `name`, `initials`, `homeStation`, `isActive` remain ADMIN-only on the existing `/api/prep/cooks/*` routes, and roster rows are never deleted here. That narrow widening is deliberate: the manager running payroll must be able to add the dishwasher whose punches are stranded on the Checks tab.

- [ ] **Step 1: Write the settings route**

Create `src/app/api/tips/settings/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveSalesScopeRcIds } from '@/lib/tips/sales'
import type { TipSettings } from '@prisma/client'

// Singleton row + a PUT handler: this route MUST stay dynamic or PUT 405s in prod.
export const dynamic = 'force-dynamic'

const DEFAULTS = {
  id: 'singleton',
  poolBasis: 'NET_SALES',
  includeAutoGratuity: true,
  poolRatePct: 5,
  defaultDailyHourCap: null,
  rewardTiers: [1.25, 1.5, 2],
  roundingStepCents: 100,
  periodDays: 14,
  periodStartDow: 0,
  salesSourceMode: 'LOCATION',
  salesLocationId: null,
  salesRcIds: [],
  poolRevenueCenterId: null,
  poolDepartments: ['Back of House'],
  posMap: {},
  denoms: [
    { v: 10000, l: '$100', on: false }, { v: 5000, l: '$50', on: true },
    { v: 2000, l: '$20', on: true }, { v: 1000, l: '$10', on: true },
    { v: 500, l: '$5', on: true }, { v: 200, l: '$2', on: true },
    { v: 100, l: '$1', on: true }, { v: 25, l: '25¢', on: true },
    { v: 10, l: '10¢', on: true }, { v: 5, l: '5¢', on: true },
  ],
}

/** Prisma Decimal → number, Json → typed. Every response goes through this. */
export function toDto(s: TipSettings) {
  return {
    poolBasis: s.poolBasis as 'NET_SALES' | 'TIPS_COLLECTED',
    includeAutoGratuity: s.includeAutoGratuity,
    poolRatePct: Number(s.poolRatePct),
    defaultDailyHourCap: s.defaultDailyHourCap == null ? null : Number(s.defaultDailyHourCap),
    rewardTiers: s.rewardTiers as number[],
    roundingStepCents: s.roundingStepCents,
    periodDays: s.periodDays,
    periodStartDow: s.periodStartDow,
    salesSourceMode: s.salesSourceMode,
    salesLocationId: s.salesLocationId,
    salesRcIds: s.salesRcIds as string[],
    poolRevenueCenterId: s.poolRevenueCenterId,
    poolDepartments: s.poolDepartments as string[],
    posMap: s.posMap as Record<string, string>,
    denoms: s.denoms as Array<{ v: number; l: string; on: boolean }>,
  }
}

/** Reads the singleton, creating it with defaults the first time. */
export async function loadSettings(): Promise<TipSettings> {
  const existing = await prisma.tipSettings.findUnique({ where: { id: 'singleton' } })
  if (existing) return existing
  return prisma.tipSettings.create({ data: DEFAULTS })
}

export async function GET() {
  try {
    const user = await requireSession('MANAGER')
    const settings = await loadSettings()
    const scope = await resolveSalesScopeRcIds(user, settings)
    return NextResponse.json({ ...toDto(settings), salesScopeLabel: scope.label, salesScopeRcIds: scope.rcIds })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/settings GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const body = await req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}

    if (body.poolBasis !== undefined) {
      if (!['NET_SALES', 'TIPS_COLLECTED'].includes(body.poolBasis))
        return NextResponse.json({ error: "poolBasis must be 'NET_SALES' or 'TIPS_COLLECTED'" }, { status: 400 })
      data.poolBasis = body.poolBasis
    }
    if (body.includeAutoGratuity !== undefined) {
      if (typeof body.includeAutoGratuity !== 'boolean')
        return NextResponse.json({ error: 'includeAutoGratuity must be a boolean' }, { status: 400 })
      data.includeAutoGratuity = body.includeAutoGratuity
    }
    if (body.poolRatePct !== undefined) {
      const v = Number(body.poolRatePct)
      if (!isFinite(v) || v < 0 || v > 100) return NextResponse.json({ error: 'poolRatePct must be between 0 and 100' }, { status: 400 })
      data.poolRatePct = v
    }
    if (body.defaultDailyHourCap !== undefined) {
      // Prefill for NEW roster rows only. Changing it never restates a period —
      // the live cap is Cook.dailyHourCap, edited per person.
      if (body.defaultDailyHourCap === null || body.defaultDailyHourCap === '') data.defaultDailyHourCap = null
      else {
        const v = Number(body.defaultDailyHourCap)
        if (!isFinite(v) || v <= 0 || v > 24) return NextResponse.json({ error: 'defaultDailyHourCap must be between 0 and 24 hours' }, { status: 400 })
        data.defaultDailyHourCap = v
      }
    }
    if (body.rewardTiers !== undefined) {
      if (!Array.isArray(body.rewardTiers) || body.rewardTiers.some((n: unknown) => !isFinite(Number(n)) || Number(n) < 1))
        return NextResponse.json({ error: 'rewardTiers must be numbers of 1 or more' }, { status: 400 })
      data.rewardTiers = [...new Set(body.rewardTiers.map(Number))].sort((a, b) => a - b)
    }
    if (body.roundingStepCents !== undefined) {
      const v = Number(body.roundingStepCents)
      if (![5, 10, 25, 100, 500].includes(v)) return NextResponse.json({ error: 'roundingStepCents must be 5, 10, 25, 100 or 500' }, { status: 400 })
      data.roundingStepCents = v
    }
    if (body.periodDays !== undefined) {
      const v = Number(body.periodDays)
      if (![7, 14, 28].includes(v)) return NextResponse.json({ error: 'periodDays must be 7, 14 or 28' }, { status: 400 })
      data.periodDays = v
    }
    if (body.periodStartDow !== undefined) {
      const v = Number(body.periodStartDow)
      if (!Number.isInteger(v) || v < 0 || v > 6) return NextResponse.json({ error: 'periodStartDow must be 0–6' }, { status: 400 })
      data.periodStartDow = v
    }
    if (body.salesSourceMode !== undefined) {
      if (!['LOCATION', 'RC'].includes(body.salesSourceMode))
        return NextResponse.json({ error: "salesSourceMode must be 'LOCATION' or 'RC'" }, { status: 400 })
      data.salesSourceMode = body.salesSourceMode
    }
    if (body.salesLocationId !== undefined) data.salesLocationId = body.salesLocationId || null
    if (body.salesRcIds !== undefined) {
      if (!Array.isArray(body.salesRcIds)) return NextResponse.json({ error: 'salesRcIds must be an array' }, { status: 400 })
      data.salesRcIds = body.salesRcIds.map(String)
    }
    if (body.poolRevenueCenterId !== undefined) data.poolRevenueCenterId = body.poolRevenueCenterId || null
    if (body.poolDepartments !== undefined) {
      if (!Array.isArray(body.poolDepartments)) return NextResponse.json({ error: 'poolDepartments must be an array' }, { status: 400 })
      data.poolDepartments = body.poolDepartments.map(String)
    }
    if (body.posMap !== undefined) data.posMap = body.posMap ?? {}
    if (body.denoms !== undefined) {
      if (!Array.isArray(body.denoms)) return NextResponse.json({ error: 'denoms must be an array' }, { status: 400 })
      data.denoms = body.denoms
    }

    await loadSettings() // guarantee the row exists before update
    const saved = await prisma.tipSettings.update({ where: { id: 'singleton' }, data })
    const scope = await resolveSalesScopeRcIds(user, saved)
    return NextResponse.json({ ...toDto(saved), salesScopeLabel: scope.label, salesScopeRcIds: scope.rcIds })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/settings PUT]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write the roles routes**

Create `src/app/api/tips/roles/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import type { TipRole } from '@prisma/client'

export const dynamic = 'force-dynamic'

export const toRoleDto = (r: TipRole) => ({
  id: r.id, name: r.name, multiplier: Number(r.multiplier), sortOrder: r.sortOrder,
})

export async function GET() {
  try {
    await requireSession('MANAGER')
    const roles = await prisma.tipRole.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    return NextResponse.json(roles.map(toRoleDto))
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roles GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const body = await req.json().catch(() => ({}))
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    const multiplier = Number(body.multiplier ?? 1)
    if (!isFinite(multiplier) || multiplier < 0 || multiplier > 5)
      return NextResponse.json({ error: 'multiplier must be between 0 and 5' }, { status: 400 })
    const count = await prisma.tipRole.count({ where: { isActive: true } })
    const role = await prisma.tipRole.create({ data: { name, multiplier, sortOrder: count } })
    return NextResponse.json(toRoleDto(role), { status: 201 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roles POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

Create `src/app/api/tips/roles/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { toRoleDto } from '../route'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('MANAGER')
    const existing = await prisma.tipRole.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      data.name = name
    }
    if (body.multiplier !== undefined) {
      const v = Number(body.multiplier)
      if (!isFinite(v) || v < 0 || v > 5) return NextResponse.json({ error: 'multiplier must be between 0 and 5' }, { status: 400 })
      data.multiplier = v
    }
    if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder) || 0

    const role = await prisma.tipRole.update({ where: { id: params.id }, data })
    return NextResponse.json(toRoleDto(role))
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roles/[id] PATCH]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * Deactivates the role and moves everyone on it to `fallbackRoleId`.
 * Soft delete, because a PAID period's snapshot still names the role.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('MANAGER')
    const existing = await prisma.tipRole.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const remaining = await prisma.tipRole.count({ where: { isActive: true, id: { not: params.id } } })
    if (remaining === 0) return NextResponse.json({ error: 'The last role cannot be deleted' }, { status: 400 })

    const fallbackId = req.nextUrl.searchParams.get('fallbackRoleId')
    const fallback = fallbackId
      ? await prisma.tipRole.findFirst({ where: { id: fallbackId, isActive: true } })
      : await prisma.tipRole.findFirst({ where: { isActive: true, id: { not: params.id } }, orderBy: { sortOrder: 'asc' } })
    if (!fallback) return NextResponse.json({ error: 'fallbackRoleId is not a live role' }, { status: 400 })

    await prisma.$transaction([
      prisma.cook.updateMany({ where: { tipRoleId: params.id }, data: { tipRoleId: fallback.id } }),
      prisma.tipRole.update({ where: { id: params.id }, data: { isActive: false } }),
    ])
    return NextResponse.json({ ok: true, movedTo: fallback.id })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roles/[id] DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Write the roster routes**

Create `src/app/api/tips/roster/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { loadSettings } from '../settings/route'

export const dynamic = 'force-dynamic'

/** Initials from a first name — matches the ADMIN cook form's normalisation. */
function initialsFor(first: string, last: string): string {
  const a = first.trim()[0] ?? 'X'
  const b = last.trim()[0] ?? ''
  return (a + b).toUpperCase().slice(0, 3)
}

/**
 * Creates a roster row from a clock punch stranded on the Checks tab.
 * MANAGER (not ADMIN, like /api/prep/cooks) on purpose: the person running the
 * payout must be able to un-strand hours. Creation only — this route never
 * deletes or deactivates a cook.
 */
export async function POST(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const body = await req.json().catch(() => ({}))
    const first = String(body.firstName ?? '').trim()
    const last = String(body.lastName ?? '').trim()
    const clockId = String(body.clockId ?? '').trim()
    if (!first) return NextResponse.json({ error: 'firstName is required' }, { status: 400 })
    if (!clockId) return NextResponse.json({ error: 'clockId is required' }, { status: 400 })

    const clash = await prisma.cook.findUnique({ where: { clockId } })
    if (clash) return NextResponse.json({ error: `Clock #${clockId} already belongs to ${clash.name}` }, { status: 409 })

    // Position → role, via the map in Tip settings; falls back to the last role.
    const settings = await loadSettings()
    const posMap = (settings.posMap ?? {}) as Record<string, string>
    const position = String(body.position ?? '').trim()
    const roles = await prisma.tipRole.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } })
    const mapped = posMap[position]
    const roleId = roles.find(r => r.id === mapped)?.id ?? roles[roles.length - 1]?.id ?? null

    const cook = await prisma.cook.create({
      data: {
        name: first,
        lastName: last || null,
        initials: initialsFor(first, last),
        clockId,
        posPosition: position || null,
        tipRoleId: roleId,
        // Prefilled once, then owned by the person — never re-read from settings.
        dailyHourCap: settings.defaultDailyHourCap,
        onTipPool: true,
        sortOrder: await prisma.cook.count(),
      },
    })
    return NextResponse.json({ id: cook.id }, { status: 201 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roster POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

Create `src/app/api/tips/roster/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * Tip-payroll fields on a Cook. Deliberately NOT able to touch name, initials,
 * homeStation or isActive — those stay on the ADMIN-gated /api/prep/cooks/[id]
 * route, so a manager editing the payout cannot rewrite the prep run sheet.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('MANAGER')
    const existing = await prisma.cook.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}

    if (body.lastName !== undefined) data.lastName = String(body.lastName ?? '').trim() || null
    if (body.posPosition !== undefined) data.posPosition = String(body.posPosition ?? '').trim() || null
    if (body.onTipPool !== undefined) {
      if (typeof body.onTipPool !== 'boolean') return NextResponse.json({ error: 'onTipPool must be a boolean' }, { status: 400 })
      data.onTipPool = body.onTipPool
    }
    if (body.wage !== undefined) {
      if (body.wage === null || body.wage === '') data.wage = null
      else {
        const v = Number(body.wage)
        if (!isFinite(v) || v < 0) return NextResponse.json({ error: 'wage must be a positive number' }, { status: 400 })
        data.wage = v
      }
    }
    if (body.dailyHourCap !== undefined) {
      if (body.dailyHourCap === null || body.dailyHourCap === '') data.dailyHourCap = null
      else {
        const v = Number(body.dailyHourCap)
        if (!isFinite(v) || v <= 0 || v > 24)
          return NextResponse.json({ error: 'dailyHourCap must be between 0 and 24 hours' }, { status: 400 })
        data.dailyHourCap = Math.round(v * 100) / 100
      }
    }
    if (body.tipRoleId !== undefined) {
      if (body.tipRoleId === null) data.tipRoleId = null
      else {
        const role = await prisma.tipRole.findFirst({ where: { id: String(body.tipRoleId), isActive: true } })
        if (!role) return NextResponse.json({ error: 'tipRoleId is not a live role' }, { status: 400 })
        data.tipRoleId = role.id
      }
    }
    if (body.clockId !== undefined) {
      const code = String(body.clockId ?? '').trim()
      if (!code) data.clockId = null
      else {
        const clash = await prisma.cook.findUnique({ where: { clockId: code } })
        if (clash && clash.id !== params.id)
          return NextResponse.json({ error: `Clock #${code} already belongs to ${clash.name}` }, { status: 409 })
        data.clockId = code
      }
    }

    const cook = await prisma.cook.update({ where: { id: params.id }, data })
    return NextResponse.json({
      id: cook.id, name: cook.name, lastName: cook.lastName, clockId: cook.clockId,
      wage: cook.wage == null ? null : Number(cook.wage),
      dailyHourCap: cook.dailyHourCap == null ? null : Number(cook.dailyHourCap),
      tipRoleId: cook.tipRoleId, onTipPool: cook.onTipPool,
    })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roster/[id] PATCH]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Type-check and confirm the routes are dynamic**

```bash
npm run build 2>&1 | grep -E "api/tips|Failed|error" | head -30
```

Expected: every `/api/tips/*` line shows `ƒ (Dynamic)`; no `Failed to compile`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/tips && git commit -m "feat(tips): settings, roles and roster API"
```

---

### Task 8: Period list, open, and the page payload

**Files:**
- Create: `src/app/api/tips/periods/route.ts`, `src/app/api/tips/periods/[id]/route.ts`, `src/lib/tips/roster.ts`
- Modify: `src/lib/tips/types.ts` (add `TipPeriodPayload`)
- Test: `src/lib/tips/__tests__/roster.test.ts`

**Interfaces:**
- Consumes: `loadSettings` (Task 7), `toRoleDto` (Task 7), `dailyTotals` (Task 6), `periodDays`/`dayLabels`/`defaultPeriodStart`/`periodLabel`/`addDays` (Task 2).
- Produces:
  - `GET /api/tips/periods` → `{ periods: PeriodSummary[]; defaultStartDate: string }`
  - `POST /api/tips/periods` `{ startDate, revenueCenterId }` → `{ id }` (idempotent — returns the existing period for that key)
  - `resolveRoster(input)` from `src/lib/tips/roster.ts` — **pure**, the single place clocked hours and per-day adjustments are folded into `TipPerson[]`. Task 9's `build.ts` imports the same function; there must be exactly one copy of this logic, because two copies that drift change what people get paid.
  - `GET /api/tips/periods/[id]` → `TipPeriodPayload` (everything the page needs, in one round trip)
  - `PATCH /api/tips/periods/[id]` `{ poolBasis?, poolRatePct?, roundingStepCents?, ignoredClockIds? }` — note there is deliberately **no** period-wide hour cap; caps are per person via `PATCH /api/tips/roster/[id]`

The split and the audit are **not** computed server-side for the GET: the page recomputes them from the payload on every keystroke using the pure libs from Tasks 3–4. The server only computes them once, at payment time (Task 10).

- [ ] **Step 1: Add the payload type**

Append to `src/lib/tips/types.ts`:

```ts
import type { PunchRow } from './audit'
// `PoolBasis`, `TipRoleDef`, `TipPerson` and `Denom` are declared earlier in
// THIS file (Task 3) — do not add an import for them.

export interface TipPeriodSummary {
  id: string
  revenueCenterId: string
  revenueCenterName: string
  startDate: string
  endDate: string
  status: 'DRAFT' | 'PAID'
  paidAt: string | null
  paidByName: string | null
}

/** Everything /tips needs, in one round trip. */
export interface TipPeriodPayload {
  period: TipPeriodSummary & {
    poolBasis: PoolBasis
    poolRatePct: number
    roundingStepCents: number
    ignoredClockIds: string[]
    salesFileName: string | null
    clockFileName: string | null
    salesImportedAt: string | null
    clockImportedAt: string | null
    /** Frozen SplitResult + AuditResult, present only once status is PAID. */
    snapshot: unknown | null
  }
  dayLabels: string[]
  dayDates: string[]
  periodLabel: string
  /** The per-day amount the rate is applied to, after overrides. */
  basis: number[]
  /** Day indexes with no usable basis figure — always a blocking audit error. */
  missingBasisDays: number[]
  sales: {
    net: number[]
    /** Day indexes the configured scope had no SalesEntry row for. */
    missingDays: number[]
    /** Day indexes whose figure came from the imported workbook, not the app. */
    overriddenDays: number[]
    scopeLabel: string
  }
  tips: {
    /** Customer tips per day; `null` where the app has no tip data. */
    collected: Array<number | null>
    missingDays: number[]
    overriddenDays: number[]
    /** Sum of the days that DO have data — the FOH pot the pool comes out of. */
    total: number
    /** True when auto-gratuity is being counted as part of the pot. */
    includesAutoGratuity: boolean
  }
  roles: TipRoleDef[]
  /** Every cook, with this period's hours and boosts already resolved. */
  roster: TipPerson[]
  punches: PunchRow[]
  punchTotal: number
  rewardTiers: number[]
  denoms: Denom[]
  poolDepartments: string[]
}
```

- [ ] **Step 2: Write the list/open route**

Create `src/app/api/tips/periods/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable, resolveScopedRcIds } from '@/lib/rc-scope'
import { addDays, defaultPeriodStart } from '@/lib/tips/period'
import { loadSettings } from '../settings/route'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await requireSession('MANAGER')
    const allowed = await resolveScopedRcIds(user)
    const settings = await loadSettings()

    const periods = await prisma.tipPeriod.findMany({
      where: allowed === null ? {} : { revenueCenterId: { in: [...allowed] } },
      orderBy: { startDate: 'desc' },
      take: 26,
      include: { revenueCenter: { select: { name: true } } },
    })

    const today = new Date().toISOString().slice(0, 10)
    return NextResponse.json({
      defaultStartDate: defaultPeriodStart(today, settings.periodStartDow, settings.periodDays),
      periods: periods.map(p => ({
        id: p.id,
        revenueCenterId: p.revenueCenterId,
        revenueCenterName: p.revenueCenter.name,
        startDate: p.startDate,
        endDate: p.endDate,
        status: p.status,
        paidAt: p.paidAt?.toISOString() ?? null,
        paidByName: p.paidByName,
      })),
    })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * Opens (or re-opens) the period starting on `startDate`. Idempotent: the
 * (revenueCenterId, startDate) unique key means clicking "next period" twice
 * lands on the same row rather than creating a duplicate.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const body = await req.json().catch(() => ({}))
    const settings = await loadSettings()

    const startDate = String(body.startDate ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate))
      return NextResponse.json({ error: 'startDate must be YYYY-MM-DD' }, { status: 400 })

    const rcId = String(body.revenueCenterId ?? settings.poolRevenueCenterId ?? '')
    if (!rcId) return NextResponse.json({ error: 'Pick the revenue center this pool belongs to in Tip settings first.' }, { status: 400 })
    await assertRcWritable(user, rcId)

    const existing = await prisma.tipPeriod.findUnique({
      where: { revenueCenterId_startDate: { revenueCenterId: rcId, startDate } },
    })
    if (existing) return NextResponse.json({ id: existing.id })

    const created = await prisma.tipPeriod.create({
      data: {
        revenueCenterId: rcId,
        startDate,
        endDate: addDays(startDate, settings.periodDays - 1),
        // Frozen from settings at open time: changing the house rule later must
        // never silently restate a period somebody has already been paid for.
        poolBasis: settings.poolBasis,
        poolRatePct: settings.poolRatePct,
        roundingStepCents: settings.roundingStepCents,
      },
    })
    return NextResponse.json({ id: created.id }, { status: 201 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 2A: Write the shared roster resolver (with tests)**

Create `src/lib/tips/roster.ts`:

```ts
/**
 * Folds a period's clock punches and per-day adjustments into the TipPerson[]
 * the engine and the audit consume.
 *
 * PURE, and the ONLY copy of this logic. Both callers — the page payload route
 * and the server-side freeze/export path in build.ts — import this function.
 * Two divergent copies would silently change what people get paid.
 */
import type { TipPerson } from './types'

export interface RosterCook {
  id: string
  name: string
  lastName: string | null
  clockId: string | null
  wage: number | null
  dailyHourCap: number | null
  tipRoleId: string | null
  onTipPool: boolean
}

export interface RosterPunch {
  clockId: string
  department: string
  dayIndex: number
  hours: number
  status: string
}

export interface RosterAdjustment {
  cookId: string
  dayIndex: number
  /** null = fall back to the clocked hours for that day. */
  hours: number | null
  boost: number
}

export interface ResolveRosterInput {
  cooks: RosterCook[]
  punches: RosterPunch[]
  adjustments: RosterAdjustment[]
  dayCount: number
  /** Empty = accept every department. */
  poolDepartments: string[]
}

export function resolveRoster(input: ResolveRosterInput): TipPerson[] {
  const { cooks, punches, adjustments, dayCount, poolDepartments } = input

  // Clocked hours per day per code — filtered exactly as the pool filters them:
  // right department, inside the period, approved.
  const clockedByCode = new Map<string, number[]>()
  for (const p of punches) {
    if (poolDepartments.length && !poolDepartments.includes(p.department)) continue
    if (p.dayIndex < 0 || p.dayIndex >= dayCount) continue
    if (!/approved/i.test(p.status)) continue
    const code = String(p.clockId)
    const days = clockedByCode.get(code) ?? Array(dayCount).fill(0)
    days[p.dayIndex] = Math.round((days[p.dayIndex] + p.hours) * 100) / 100
    clockedByCode.set(code, days)
  }

  const adjByCook = new Map<string, Map<number, RosterAdjustment>>()
  for (const a of adjustments) {
    const m = adjByCook.get(a.cookId) ?? new Map<number, RosterAdjustment>()
    m.set(a.dayIndex, a)
    adjByCook.set(a.cookId, m)
  }

  return cooks.map(c => {
    const clocked = (c.clockId ? clockedByCode.get(String(c.clockId)) : null) ?? Array(dayCount).fill(0)
    const adj = adjByCook.get(c.id)
    const hours: number[] = []
    const boosts: number[] = []
    const edited: boolean[] = []
    for (let d = 0; d < dayCount; d++) {
      const a = adj?.get(d)
      hours.push(a?.hours ?? clocked[d])
      boosts.push(a?.boost ?? 1)
      edited.push(a?.hours != null)
    }
    return {
      cookId: c.id,
      name: c.name,
      lastName: c.lastName,
      clockId: c.clockId,
      wage: c.wage,
      dailyHourCap: c.dailyHourCap,
      roleId: c.tipRoleId,
      onPool: c.onTipPool,
      hours, boosts, edited,
    }
  })
}
```

Create `src/lib/tips/__tests__/roster.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveRoster } from '@/lib/tips/roster'
import type { RosterCook, RosterPunch } from '@/lib/tips/roster'

const cook = (over: Partial<RosterCook> & { id: string; name: string }): RosterCook => ({
  lastName: null, clockId: null, wage: null, dailyHourCap: null,
  tipRoleId: 'dish', onTipPool: true, ...over,
})

const punch = (over: Partial<RosterPunch> & { clockId: string; hours: number }): RosterPunch => ({
  department: 'Back of House', dayIndex: 0, status: 'Approved', ...over,
})

const run = (cooks: RosterCook[], punches: RosterPunch[], adjustments: Parameters<typeof resolveRoster>[0]['adjustments'] = []) =>
  resolveRoster({ cooks, punches, adjustments, dayCount: 3, poolDepartments: ['Back of House'] })

describe('resolveRoster', () => {
  it('matches punches to a cook by clock id and sums them onto their day', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', clockId: '706' })],
      [punch({ clockId: '706', hours: 8 }), punch({ clockId: '706', hours: 1.5 })],
    )
    expect(p.hours).toEqual([9.5, 0, 0])
    expect(p.edited).toEqual([false, false, false])
  })

  it('never matches on name — a cook with no clock id gets no hours', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', lastName: 'Smith' })],
      [punch({ clockId: '706', hours: 8 })],
    )
    expect(p.hours).toEqual([0, 0, 0])
  })

  it('drops punches from another department, outside the period, or unapproved', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', clockId: '706' })],
      [
        punch({ clockId: '706', hours: 8 }),
        punch({ clockId: '706', hours: 5, department: 'Front of House' }),
        punch({ clockId: '706', hours: 5, dayIndex: 9 }),
        punch({ clockId: '706', hours: 5, dayIndex: 1, status: 'Pending' }),
      ],
    )
    expect(p.hours).toEqual([8, 0, 0])
  })

  it('accepts every department when none is configured', () => {
    const out = resolveRoster({
      cooks: [cook({ id: 'c1', name: 'Ana', clockId: '706' })],
      punches: [punch({ clockId: '706', hours: 8, department: 'Front of House' })],
      adjustments: [], dayCount: 3, poolDepartments: [],
    })
    expect(out[0].hours[0]).toBe(8)
  })

  it('lets a manual hours adjustment override the clocked hours and marks the day edited', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', clockId: '706' })],
      [punch({ clockId: '706', hours: 8 })],
      [{ cookId: 'c1', dayIndex: 0, hours: 6.25, boost: 1 }],
    )
    expect(p.hours[0]).toBe(6.25)
    expect(p.edited[0]).toBe(true)
  })

  it('applies a boost without touching the clocked hours', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', clockId: '706' })],
      [punch({ clockId: '706', hours: 8 })],
      [{ cookId: 'c1', dayIndex: 0, hours: null, boost: 1.5 }],
    )
    expect(p.hours[0]).toBe(8)
    expect(p.boosts[0]).toBe(1.5)
    expect(p.edited[0]).toBe(false)
  })

  it('carries the payroll fields straight through', () => {
    const [p] = run(
      [cook({ id: 'c1', name: 'Ana', lastName: 'Smith', clockId: '706', wage: 22, dailyHourCap: 8, tipRoleId: 'lead', onTipPool: false })],
      [],
    )
    expect(p).toMatchObject({
      cookId: 'c1', name: 'Ana', lastName: 'Smith', clockId: '706',
      wage: 22, dailyHourCap: 8, roleId: 'lead', onPool: false,
    })
  })
})
```

Run it:

```bash
npx vitest run src/lib/tips/__tests__/roster.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 3: Write the payload route**

Create `src/app/api/tips/periods/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { dayLabels, periodDays, periodLabel } from '@/lib/tips/period'
import { dailyTotals } from '@/lib/tips/sales'
import { resolveRoster } from '@/lib/tips/roster'
import { loadSettings } from '../../settings/route'
import { toRoleDto } from '../../roles/route'
import type { TipPeriodPayload } from '@/lib/tips/types'
import type { PunchRow } from '@/lib/tips/audit'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({
      where: { id: params.id },
      include: {
        revenueCenter: { select: { name: true } },
        punches: true,
        adjustments: true,
      },
    })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })

    const settings = await loadSettings()
    const dayCount = periodDays(period.startDate, settings.periodDays).length
    const labels = dayLabels(period.startDate, settings.periodDays)
    const dates = periodDays(period.startDate, settings.periodDays)

    // ── sales + tips: app-native, with the workbook overriding per day ──────
    const live = await dailyTotals(user, settings, period.startDate, settings.periodDays)

    /** Applies a per-day override array over a live series. */
    const applyOverride = <T extends number | null>(
      liveSeries: T[], raw: unknown, liveMissing: number[],
    ): { series: Array<number | null>; overridden: number[]; missing: number[] } => {
      const override = Array.isArray(raw) ? (raw as (number | null)[]) : null
      const overridden: number[] = []
      const series = liveSeries.map((v, i) => {
        const o = override?.[i]
        if (o == null || !isFinite(Number(o))) return v as number | null
        overridden.push(i)
        return Number(o)
      })
      return { series, overridden, missing: liveMissing.filter(i => !overridden.includes(i)) }
    }

    const salesRes = applyOverride(live.net, period.salesOverride, live.missingSalesDays)
    const tipsRes = applyOverride(live.tips, period.tipsOverride, live.missingTipDays)
    const net = salesRes.series.map(v => v ?? 0)
    const tipsSeries = tipsRes.series

    const poolBasis = period.poolBasis as 'NET_SALES' | 'TIPS_COLLECTED'
    const basis = poolBasis === 'TIPS_COLLECTED' ? tipsSeries.map(v => v ?? 0) : net
    const missingBasisDays = poolBasis === 'TIPS_COLLECTED' ? tipsRes.missing : salesRes.missing
    const tipTotal = Math.round(
      tipsSeries.reduce<number>((a, v) => a + (v ?? 0), 0) * 100,
    ) / 100

    // ── roster: every cook, with this period's hours + boosts resolved ──────
    const cooks = await prisma.cook.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true, name: true, lastName: true, clockId: true, wage: true,
        dailyHourCap: true, tipRoleId: true, onTipPool: true,
      },
    })
    const roles = await prisma.tipRole.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })

    const poolDepartments = (settings.poolDepartments ?? []) as string[]
    // Single copy of the punches→hours fold; build.ts calls the same function.
    const roster = resolveRoster({
      cooks: cooks.map(c => ({
        ...c,
        wage: c.wage == null ? null : Number(c.wage),
        dailyHourCap: c.dailyHourCap == null ? null : Number(c.dailyHourCap),
      })),
      punches: period.punches.map(p => ({
        clockId: p.clockId, department: p.department, dayIndex: p.dayIndex,
        hours: Number(p.hours), status: p.status,
      })),
      adjustments: period.adjustments.map(a => ({
        cookId: a.cookId, dayIndex: a.dayIndex,
        hours: a.hours == null ? null : Number(a.hours), boost: Number(a.boost),
      })),
      dayCount,
      poolDepartments,
    })

    const punches: PunchRow[] = period.punches.map(p => ({
      clockId: p.clockId,
      firstName: p.firstName,
      lastName: p.lastName,
      position: p.position,
      department: p.department,
      dayIndex: p.dayIndex,
      hours: Number(p.hours),
      status: p.status,
      note: p.note,
    }))

    const payload: TipPeriodPayload = {
      period: {
        id: period.id,
        revenueCenterId: period.revenueCenterId,
        revenueCenterName: period.revenueCenter.name,
        startDate: period.startDate,
        endDate: period.endDate,
        status: period.status as 'DRAFT' | 'PAID',
        paidAt: period.paidAt?.toISOString() ?? null,
        paidByName: period.paidByName,
        poolBasis,
        poolRatePct: Number(period.poolRatePct),
        roundingStepCents: period.roundingStepCents,
        ignoredClockIds: (period.ignoredClockIds ?? []) as string[],
        salesFileName: period.salesFileName,
        clockFileName: period.clockFileName,
        salesImportedAt: period.salesImportedAt?.toISOString() ?? null,
        clockImportedAt: period.clockImportedAt?.toISOString() ?? null,
        snapshot: period.snapshot ?? null,
      },
      dayLabels: labels,
      dayDates: dates,
      periodLabel: periodLabel(period.startDate, settings.periodDays),
      basis,
      missingBasisDays,
      sales: {
        net,
        missingDays: salesRes.missing,
        overriddenDays: salesRes.overridden,
        scopeLabel: live.label,
      },
      tips: {
        collected: tipsSeries,
        missingDays: tipsRes.missing,
        overriddenDays: tipsRes.overridden,
        total: tipTotal,
        includesAutoGratuity: settings.includeAutoGratuity,
      },
      roles: roles.map(toRoleDto),
      roster,
      punches,
      punchTotal: Math.round(punches.reduce((a, p) => a + p.hours, 0) * 100) / 100,
      rewardTiers: (settings.rewardTiers ?? []) as number[],
      denoms: (settings.denoms ?? []) as TipPeriodPayload['denoms'],
      poolDepartments,
    }
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id] GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({ where: { id: params.id } })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })
    if (period.status === 'PAID')
      return NextResponse.json({ error: 'This period is paid. Reopen it before changing the split.' }, { status: 409 })

    const body = await req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}
    if (body.poolBasis !== undefined) {
      // Switchable on a DRAFT period so a manager can compare "5% of sales" with
      // "30% of the tip pot" before committing. Blocked on PAID by the guard above.
      if (!['NET_SALES', 'TIPS_COLLECTED'].includes(body.poolBasis))
        return NextResponse.json({ error: "poolBasis must be 'NET_SALES' or 'TIPS_COLLECTED'" }, { status: 400 })
      data.poolBasis = body.poolBasis
    }
    if (body.poolRatePct !== undefined) {
      const v = Number(body.poolRatePct)
      if (!isFinite(v) || v < 0 || v > 100) return NextResponse.json({ error: 'poolRatePct must be between 0 and 100' }, { status: 400 })
      data.poolRatePct = v
    }
    if (body.roundingStepCents !== undefined) {
      const v = Number(body.roundingStepCents)
      if (![5, 10, 25, 100, 500].includes(v)) return NextResponse.json({ error: 'roundingStepCents must be 5, 10, 25, 100 or 500' }, { status: 400 })
      data.roundingStepCents = v
    }
    if (body.ignoredClockIds !== undefined) {
      if (!Array.isArray(body.ignoredClockIds)) return NextResponse.json({ error: 'ignoredClockIds must be an array' }, { status: 400 })
      data.ignoredClockIds = [...new Set(body.ignoredClockIds.map(String))]
    }

    await prisma.tipPeriod.update({ where: { id: params.id }, data })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id] PATCH]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Smoke-test the payload against the dev server**

Start the dev server with `preview_start` (never `npm run dev` from Bash), then:

```bash
curl -s localhost:3000/api/tips/periods | head -c 400
```

Expected: JSON with `defaultStartDate` and an empty `periods` array. Then open a period and fetch it:

```bash
curl -s -X POST localhost:3000/api/tips/periods -H 'content-type: application/json' -d '{"startDate":"2026-07-12","revenueCenterId":"REPLACE_WITH_A_REAL_RC_ID"}'
```

Expected: `{"id":"…"}` with status 201. `curl -s localhost:3000/api/tips/periods/<id>` should return `dayLabels` of length 14 starting `"Sun 12"`, and `sales.missingDays` listing every day the configured scope has no entry for.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tips/types.ts src/app/api/tips/periods && git commit -m "feat(tips): period list, open, and the single-fetch page payload"
```

---

### Task 9: Import, adjustments, pay and export

**Files:**
- Create: `src/app/api/tips/periods/[id]/import/route.ts`, `src/app/api/tips/periods/[id]/adjustments/route.ts`, `src/app/api/tips/periods/[id]/pay/route.ts`, `src/app/api/tips/periods/[id]/export/route.ts`

**Interfaces:**
- Consumes: `parseSalesWorkbook`/`parseClocksWorkbook` (Task 5), `computeSplit` (Task 3), `auditPeriod` (Task 4), `dailyTotals` (Task 6), `loadSettings`/`toRoleDto` (Task 7), the payload builder from Task 8.
- Produces:
  - `POST …/import` (multipart: `file`, `kind=sales|clocks`) → `{ ok, summary }`
  - `PUT …/adjustments` `{ cookId, dayIndex, hours?, boost? }` → `{ ok }`; `DELETE …/adjustments?cookId=…` clears every adjustment for one person
  - `POST …/pay` `{ reopen?: boolean }` → `{ ok, status }`
  - `GET …/export` → `text/csv`

- [ ] **Step 1: Write the import route**

Create `src/app/api/tips/periods/[id]/import/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { parseClocksWorkbook, parseSalesWorkbook } from '@/lib/tips/xlsx'
import { periodDays } from '@/lib/tips/period'
import { loadSettings } from '../../../settings/route'

export const dynamic = 'force-dynamic'
/** Workbooks are small; the default body limit is plenty. Guard anyway. */
const MAX_BYTES = 8 * 1024 * 1024

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({ where: { id: params.id } })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })
    if (period.status === 'PAID')
      return NextResponse.json({ error: 'This period is paid. Reopen it before importing.' }, { status: 409 })

    const form = await req.formData()
    const file = form.get('file')
    const kind = String(form.get('kind') ?? '')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'That workbook is too large.' }, { status: 400 })
    if (kind !== 'sales' && kind !== 'clocks')
      return NextResponse.json({ error: "kind must be 'sales' or 'clocks'" }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const settings = await loadSettings()
    const days = periodDays(period.startDate, settings.periodDays)

    if (kind === 'sales') {
      let parsed
      try { parsed = parseSalesWorkbook(buffer) }
      catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

      // Map the workbook's rows onto the period's days; a day the workbook does
      // not cover keeps whatever the app already has (override stays null).
      const byDate = new Map(parsed.iso.map((iso, i) => [iso, parsed.sales[i]]))
      const override = days.map(d => byDate.get(d) ?? null)
      const matched = override.filter(v => v != null).length
      // The Sales Summary carries a tips column on some Toast configurations.
      // When present it overrides the app's tip figures the same way.
      const tipsByDate = parsed.tips ? new Map(parsed.iso.map((iso, i) => [iso, parsed.tips![i]])) : null
      const tipsOverride = tipsByDate ? days.map(d => tipsByDate.get(d) ?? null) : undefined
      if (matched === 0) {
        return NextResponse.json({
          error: `That workbook covers ${parsed.iso[0]} → ${parsed.iso[parsed.iso.length - 1]}, which does not overlap this period (${period.startDate} → ${period.endDate}).`,
        }, { status: 400 })
      }

      await prisma.tipPeriod.update({
        where: { id: params.id },
        data: {
          salesOverride: override,
          ...(tipsOverride ? { tipsOverride } : {}),
          salesFileName: file.name,
          salesImportedAt: new Date(),
        },
      })
      const total = override.reduce<number>((a, v) => a + (v ?? 0), 0)
      const tipTotal = tipsOverride?.reduce<number>((a, v) => a + (v ?? 0), 0) ?? null
      return NextResponse.json({
        ok: true,
        summary: {
          days: matched,
          total: Math.round(total * 100) / 100,
          reportedNet: parsed.reportedNet,
          tipsTotal: tipTotal == null ? null : Math.round(tipTotal * 100) / 100,
        },
      })
    }

    let parsed
    try { parsed = parseClocksWorkbook(buffer, period.startDate, settings.periodDays) }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

    // A re-import replaces the period's punches wholesale, and clears the
    // ignore list — the codes it named may not exist in the new file.
    await prisma.$transaction([
      prisma.tipPunch.deleteMany({ where: { periodId: params.id } }),
      prisma.tipPunch.createMany({
        data: parsed.rows.map(r => ({
          periodId: params.id,
          clockId: r.clockId,
          firstName: r.firstName,
          lastName: r.lastName,
          position: r.position,
          department: r.department,
          dayIndex: r.dayIndex,
          hours: r.hours,
          status: r.status,
          note: r.note,
        })),
      }),
      prisma.tipPeriod.update({
        where: { id: params.id },
        data: { clockFileName: file.name, clockImportedAt: new Date(), ignoredClockIds: [] },
      }),
    ])

    const known = new Set(
      (await prisma.cook.findMany({ where: { clockId: { not: null } }, select: { clockId: true } }))
        .map(c => String(c.clockId)),
    )
    const strangers = [...new Set(parsed.rows.map(r => r.clockId))].filter(c => !known.has(c)).length

    return NextResponse.json({
      ok: true,
      summary: {
        shifts: parsed.rows.length,
        hours: parsed.total,
        people: parsed.peopleCount,
        outside: parsed.outside,
        pending: parsed.pending,
        strangers,
      },
    })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/import POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write the adjustments route**

Create `src/app/api/tips/periods/[id]/adjustments/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { loadSettings } from '../../../settings/route'

export const dynamic = 'force-dynamic'

async function guard(userPromise: ReturnType<typeof requireSession>, id: string) {
  const user = await userPromise
  const period = await prisma.tipPeriod.findUnique({ where: { id } })
  if (!period) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  if (!(await isRcInScope(user, period.revenueCenterId)))
    return { error: NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 }) }
  if (period.status === 'PAID')
    return { error: NextResponse.json({ error: 'This period is paid. Reopen it before editing hours.' }, { status: 409 }) }
  return { period }
}

/**
 * Upsert one person's override for one day.
 *   hours: number → manual hours replace the clocked hours
 *   hours: null   → fall back to the clocked hours
 *   boost: number → reward multiplier (1 = none)
 * A row whose hours are null AND boost is 1 carries no information, so it is
 * deleted rather than stored — that keeps the audit's "manual edits" line honest.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await guard(requireSession('MANAGER'), params.id)
    if (g.error) return g.error

    const body = await req.json().catch(() => ({}))
    const cookId = String(body.cookId ?? '')
    const dayIndex = Number(body.dayIndex)
    const settings = await loadSettings()
    if (!cookId) return NextResponse.json({ error: 'cookId is required' }, { status: 400 })
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= settings.periodDays)
      return NextResponse.json({ error: `dayIndex must be 0–${settings.periodDays - 1}` }, { status: 400 })

    const cook = await prisma.cook.findUnique({ where: { id: cookId } })
    if (!cook) return NextResponse.json({ error: 'Not a roster member' }, { status: 400 })

    const existing = await prisma.tipDayAdjustment.findUnique({
      where: { periodId_cookId_dayIndex: { periodId: params.id, cookId, dayIndex } },
    })

    let hours: number | null = existing?.hours == null ? null : Number(existing.hours)
    if (body.hours !== undefined) {
      if (body.hours === null || body.hours === '') hours = null
      else {
        const v = Number(body.hours)
        if (!isFinite(v) || v < 0 || v > 24) return NextResponse.json({ error: 'hours must be between 0 and 24' }, { status: 400 })
        hours = Math.round(v * 100) / 100
      }
    }

    let boost = existing ? Number(existing.boost) : 1
    if (body.boost !== undefined) {
      const v = Number(body.boost)
      if (!isFinite(v) || v < 1 || v > 5) return NextResponse.json({ error: 'boost must be between 1 and 5' }, { status: 400 })
      boost = v
    }

    if (hours == null && boost === 1) {
      if (existing) await prisma.tipDayAdjustment.delete({ where: { id: existing.id } })
      return NextResponse.json({ ok: true, cleared: true })
    }

    await prisma.tipDayAdjustment.upsert({
      where: { periodId_cookId_dayIndex: { periodId: params.id, cookId, dayIndex } },
      create: { periodId: params.id, cookId, dayIndex, hours, boost },
      update: { hours, boost },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/adjustments PUT]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** Clears one person's adjustments (?cookId=…) or the whole period's. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await guard(requireSession('MANAGER'), params.id)
    if (g.error) return g.error
    const cookId = req.nextUrl.searchParams.get('cookId')
    await prisma.tipDayAdjustment.deleteMany({
      where: { periodId: params.id, ...(cookId ? { cookId } : {}) },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/adjustments DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Extract the split builder so pay and export share it**

Create `src/lib/tips/build.ts`:

```ts
import 'server-only'
import { prisma } from '@/lib/prisma'
import type { User } from '@prisma/client'
import { computeSplit } from './engine'
import { auditPeriod } from './audit'
import { dailyTotals } from './sales'
import { resolveRoster } from './roster'
import { dayLabels, periodDays } from './period'
import type { PoolBasis, SplitResult, TipPerson, TipRoleDef } from './types'
import type { AuditResult, PunchRow } from './audit'

/**
 * Rebuilds a period's split and audit on the server from the persisted rows.
 * The page recomputes the same numbers in the browser on every keystroke; this
 * is the authoritative pass used to freeze a payment and to build the export,
 * so both go through exactly the same pure functions.
 */
export async function buildPeriodSplit(user: User, periodId: string): Promise<{
  split: SplitResult
  audit: AuditResult
  roles: TipRoleDef[]
  people: TipPerson[]
  dayLabels: string[]
  basis: number[]
  poolBasis: PoolBasis
  sales: number[]
  tips: Array<number | null>
  tipTotal: number
  poolRatePct: number
  roundingStepCents: number
} | null> {
  const period = await prisma.tipPeriod.findUnique({
    where: { id: periodId },
    include: { punches: true, adjustments: true },
  })
  if (!period) return null

  const settings = await prisma.tipSettings.findUnique({ where: { id: 'singleton' } })
  const dayCount = settings?.periodDays ?? 14
  const poolDepartments = ((settings?.poolDepartments ?? []) as string[])
  const labels = dayLabels(period.startDate, dayCount)
  const days = periodDays(period.startDate, dayCount)

  const live = await dailyTotals(
    user,
    settings ?? {
      salesSourceMode: 'LOCATION', salesLocationId: null, salesRcIds: [], includeAutoGratuity: true,
    },
    period.startDate,
    dayCount,
  )

  /** Applies a per-day override array over a live series. Mirrors the payload route. */
  const applyOverride = (
    liveSeries: Array<number | null>, raw: unknown, liveMissing: number[],
  ) => {
    const override = Array.isArray(raw) ? (raw as (number | null)[]) : null
    const overridden = new Set<number>()
    const series = liveSeries.map((v, i) => {
      const o = override?.[i]
      if (o == null || !isFinite(Number(o))) return v
      overridden.add(i)
      return Number(o)
    })
    return { series, missing: liveMissing.filter(i => !overridden.has(i)) }
  }

  const salesRes = applyOverride(live.net, period.salesOverride, live.missingSalesDays)
  const tipsRes = applyOverride(live.tips, period.tipsOverride, live.missingTipDays)
  const sales = salesRes.series.map(v => v ?? 0)
  const tips = tipsRes.series

  const poolBasis = period.poolBasis as PoolBasis
  const basis = poolBasis === 'TIPS_COLLECTED' ? tips.map(v => v ?? 0) : sales
  const missingBasisDays = poolBasis === 'TIPS_COLLECTED' ? tipsRes.missing : salesRes.missing
  const tipTotal = Math.round(tips.reduce<number>((a, v) => a + (v ?? 0), 0) * 100) / 100

  const roleRows = await prisma.tipRole.findMany({
    where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  const roles: TipRoleDef[] = roleRows.map(r => ({
    id: r.id, name: r.name, multiplier: Number(r.multiplier), sortOrder: r.sortOrder,
  }))

  const cooks = await prisma.cook.findMany({
    where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  // Same resolver the payload route uses — one copy, so the numbers the page
  // shows and the numbers frozen at payment can never drift apart.
  const people: TipPerson[] = resolveRoster({
    cooks: cooks.map(c => ({
      id: c.id, name: c.name, lastName: c.lastName, clockId: c.clockId,
      wage: c.wage == null ? null : Number(c.wage),
      dailyHourCap: c.dailyHourCap == null ? null : Number(c.dailyHourCap),
      tipRoleId: c.tipRoleId, onTipPool: c.onTipPool,
    })),
    punches: period.punches.map(p => ({
      clockId: p.clockId, department: p.department, dayIndex: p.dayIndex,
      hours: Number(p.hours), status: p.status,
    })),
    adjustments: period.adjustments.map(a => ({
      cookId: a.cookId, dayIndex: a.dayIndex,
      hours: a.hours == null ? null : Number(a.hours), boost: Number(a.boost),
    })),
    dayCount,
    poolDepartments,
  })

  const punches: PunchRow[] = period.punches.map(p => ({
    clockId: p.clockId, firstName: p.firstName, lastName: p.lastName,
    position: p.position, department: p.department, dayIndex: p.dayIndex,
    hours: Number(p.hours), status: p.status, note: p.note,
  }))

  const poolRatePct = Number(period.poolRatePct)
  const split = computeSplit({
    basis, poolRatePct,
    roundingStepCents: period.roundingStepCents, roles, people,
  })
  const audit = auditPeriod({
    dayLabels: labels, basis, poolBasis, sales, tipsCollected: tips,
    roles, people, punches, split,
    roundingStepCents: period.roundingStepCents,
    poolDepartments, ignoredClockIds: (period.ignoredClockIds ?? []) as string[],
    missingBasisDays,
  })

  // `days` is unused downstream today but keeps the ISO dates one lookup away
  // if the export ever needs them per column.
  void days
  return {
    split, audit, roles, people, dayLabels: labels,
    basis, poolBasis, sales, tips, tipTotal,
    poolRatePct, roundingStepCents: period.roundingStepCents,
  }
}
```

- [ ] **Step 4: Write the pay route**

Create `src/app/api/tips/periods/[id]/pay/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { buildPeriodSplit } from '@/lib/tips/build'

export const dynamic = 'force-dynamic'

/**
 * Freezes the period. The snapshot is the whole SplitResult + AuditResult at
 * the moment of payment, so what was actually handed out stays readable even
 * after a rate change, a roster edit, or a sales correction.
 *
 * A period with unresolved ERRORS cannot be paid — that is the entire point of
 * the Checks tab. Warnings and info do not block.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({ where: { id: params.id } })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })

    const body = await req.json().catch(() => ({}))

    if (body.reopen === true) {
      if (period.status !== 'PAID') return NextResponse.json({ error: 'This period is not paid.' }, { status: 409 })
      await prisma.tipPeriod.update({
        where: { id: params.id },
        data: { status: 'DRAFT', paidAt: null, paidByName: null },
      })
      return NextResponse.json({ ok: true, status: 'DRAFT' })
    }

    if (period.status === 'PAID') return NextResponse.json({ error: 'This period is already paid.' }, { status: 409 })

    const built = await buildPeriodSplit(user, params.id)
    if (!built) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (built.audit.counts.error > 0) {
      return NextResponse.json({
        error: `${built.audit.counts.error} unresolved ${built.audit.counts.error === 1 ? 'issue' : 'issues'} on the Checks tab. Settle them before paying.`,
        findings: built.audit.findings.filter(f => f.severity === 'error').map(f => f.title),
      }, { status: 409 })
    }

    await prisma.tipPeriod.update({
      where: { id: params.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paidByName: user.name ?? user.email,
        snapshot: {
          paidAt: new Date().toISOString(),
          poolBasis: built.poolBasis,
          poolRatePct: built.poolRatePct,
          roundingStepCents: built.roundingStepCents,
          dayLabels: built.dayLabels,
          basis: built.basis,
          sales: built.sales,
          tips: built.tips,
          tipTotal: built.tipTotal,
          roles: built.roles,
          split: built.split,
          audit: built.audit,
        } as unknown as object,
      },
    })
    return NextResponse.json({ ok: true, status: 'PAID' })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/pay POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 5: Write the export route**

Create `src/app/api/tips/periods/[id]/export/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { buildPeriodSplit } from '@/lib/tips/build'

export const dynamic = 'force-dynamic'

/** RFC-4180 quoting — a surname with a comma must not shift every column. */
const cell = (v: unknown) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('MANAGER')
    const period = await prisma.tipPeriod.findUnique({ where: { id: params.id } })
    if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await isRcInScope(user, period.revenueCenterId)))
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })

    const built = await buildPeriodSplit(user, params.id)
    if (!built) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const { split } = built

    const rows: unknown[][] = [[
      'Name', 'Surname', 'Code', 'Role', 'Weight', 'Hours', 'Weighted hours',
      'Rewarded days', '$ per hour', 'Share %', 'Tips exact', 'Envelope',
    ]]
    for (const p of split.people) {
      rows.push([
        p.name, p.lastName ?? '', p.clockId ?? '', p.roleName, p.multiplier,
        p.hoursTotal.toFixed(2), p.weighted.toFixed(2),
        p.boosts.filter(b => b > 1).length,
        p.hoursTotal ? (p.tip / p.hoursTotal).toFixed(2) : '0.00',
        split.poolTotal ? ((p.tip / split.poolTotal) * 100).toFixed(2) : '0.00',
        p.tip.toFixed(2), (p.envelopeCents / 100).toFixed(2),
      ])
    }
    rows.push([])
    rows.push(['Period', `${period.startDate} → ${period.endDate}`])
    rows.push(['Pool basis', built.poolBasis === 'TIPS_COLLECTED' ? 'Tips collected' : 'Net sales'])
    rows.push(['Pool rate', `${built.poolRatePct}%`])
    rows.push(['Net sales', built.sales.reduce((a, b) => a + b, 0).toFixed(2)])
    rows.push(['Tips collected', built.tipTotal.toFixed(2)])
    rows.push(['Pool total', split.poolTotal.toFixed(2)])
    rows.push([
      'Tip-out share of the tip pot',
      built.tipTotal > 0 ? `${((split.poolTotal / built.tipTotal) * 100).toFixed(1)}%` : 'n/a',
    ])
    rows.push([
      'Left for front of house',
      built.tipTotal > 0 ? (built.tipTotal - split.poolTotal).toFixed(2) : 'n/a',
    ])
    rows.push(['Envelopes total', (split.envelopeTotalCents / 100).toFixed(2)])
    rows.push(['Status', period.status])

    const csv = rows.map(r => r.map(cell).join(',')).join('\n')
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="kitchen-tips-${period.startDate}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/periods/[id]/export GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 6: Verify every tips route is dynamic and the build is clean**

```bash
npm run build 2>&1 | grep -E "api/tips|Failed to compile|Type error" | head -30
```

Expected: each `/api/tips/…` row shows `ƒ (Dynamic)`; no `Failed to compile`, no `Type error`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tips/build.ts src/app/api/tips/periods && git commit -m "feat(tips): workbook import, day adjustments, freeze-on-pay and payroll export"
```

---

### Task 10: Page shell, shared kit, and the Split tab

**Files:**
- Create: `src/components/tips/kit.tsx`, `src/components/tips/SplitTab.tsx`, `src/app/tips/page.tsx`

**Interfaces:**
- Consumes: `TipPeriodPayload`, `computeSplit`, `sortPeople`, `DEFAULT_SORT_DIR`, `effectiveHours`, `auditPeriod`, `PageHead`.
- Produces:
  - from `kit.tsx`: `money`, `money0`, `hoursLabel`, `initials`, `weightClass`, `DayStrip`, `DayStripLegend`, `RoleSelect`, `MethodNote`, `TipTabId`, `TIP_TABS`
  - from `SplitTab.tsx`: `<SplitTab payload split audit onAdjust onRoleChange onFix … />`
  - from `page.tsx`: the `/tips` route

The page is desktop-first, matching the mock's 1440px canvas. On `< md` it renders a single card telling the manager to open it on a desktop — a payout run is a desk task and the mock has no mobile design to port.

- [ ] **Step 1: Write the shared kit**

Create `src/components/tips/kit.tsx`:

```tsx
'use client'
import type { ReactNode } from 'react'
import type { SplitPerson, TipRoleDef } from '@/lib/tips/types'
import { effectiveHours } from '@/lib/tips/engine'

export type TipTabId = 'split' | 'days' | 'cash' | 'checks' | 'import' | 'settings'

export const TIP_TABS: Array<{ id: TipTabId; label: string }> = [
  { id: 'split', label: 'Split' },
  { id: 'days', label: 'Daily pools' },
  { id: 'cash', label: 'Cash & envelopes' },
  { id: 'checks', label: 'Checks' },
  { id: 'import', label: 'Import data' },
  { id: 'settings', label: 'Tip settings' },
]

export const money = (n: number) =>
  '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const money0 = (n: number) => '$' + Math.round(n).toLocaleString('en-CA')
export const hoursLabel = (n: number) => (Math.round(n * 100) / 100).toFixed(2) + ' h'
export const signedHours = (n: number) =>
  (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n * 100) / 100).toFixed(2)
export const initials = (name: string) => name.slice(0, 2).toUpperCase()

/** Role-weight pill colouring — mirrors `.wsel.w15/.w12/.w11/.w10` in the mock. */
export function weightClass(multiplier: number): string {
  if (multiplier >= 1.5) return 'bg-gold-soft text-gold-2'
  if (multiplier >= 1.2) return 'bg-blue-soft text-blue-text'
  if (multiplier >= 1.1) return 'bg-bg-2 text-ink-2'
  return 'bg-bg-2 text-ink-3'
}

/**
 * The 14-cell day strip. Filled = worked, gold = rewarded day, red = capped.
 * A week-2 divider sits before the 8th cell, as in the mock.
 */
export function DayStrip({ person, dayLabels }: { person: SplitPerson; dayLabels: string[] }) {
  return (
    <span className="grid" style={{ gridTemplateColumns: `repeat(${dayLabels.length}, 1fr)` }}>
      {dayLabels.map((label, d) => {
        const raw = person.hours[d] ?? 0
        const h = effectiveHours(person, d)
        const rewarded = (person.boosts[d] ?? 1) > 1
        // Capped against THIS person's contracted shift, not a house-wide value.
        const capped = person.dailyHourCap != null && raw > person.dailyHourCap
        const title = `${label}${h > 0
          ? ` · ${h}h${rewarded ? ` · reward ×${person.boosts[d]}` : ''}${capped ? ` (capped from ${raw}h)` : ''}`
          : ' · off'}`

        // Two independent signals share one 9×14 block:
        //   gold = rewarded day, red = hours clipped by this person's shift cap.
        // A day that is BOTH splits the block horizontally — gold on top, red
        // underneath — rather than letting one condition hide the other, which
        // is what a single-colour precedence chain would do. Rendered as two
        // half-height children so every colour stays a design token (a CSS
        // gradient would need raw hex).
        const box = 'w-[9px] h-[14px] rounded-[2px] border overflow-hidden'
        if (h > 0 && rewarded && capped) {
          return (
            <span key={d} className={cellWrap(d)}>
              <i title={title} className={`${box} border-red flex flex-col`}>
                <span className="flex-1 bg-gold" />
                <span className="flex-1 bg-red" />
              </i>
            </span>
          )
        }
        const tone = h <= 0
          ? 'bg-bg-2 border-line'
          : capped ? 'bg-red border-red'
          : rewarded ? 'bg-gold border-gold-2'
          : 'bg-ink border-ink'
        return (
          <span key={d} className={cellWrap(d)}>
            <i title={title} className={`${box} ${tone}`} />
          </span>
        )
      })}
    </span>
  )
}

/** Day-strip cell wrapper. The 8th cell carries the week-2 divider. */
function cellWrap(d: number): string {
  return `flex flex-col items-center gap-[3px] ${
    d === 7
      ? 'relative before:absolute before:-left-[2px] before:top-[2px] before:bottom-0 before:w-px before:bg-line-2'
      : ''
  }`
}

/** Shared legend for the day strip — keep the wording identical everywhere. */
export function DayStripLegend() {
  return (
    <span className="inline-flex items-center gap-3 font-mono text-[10.5px] text-ink-3">
      <span className="inline-flex items-center gap-1.5">
        <i className="w-[9px] h-[14px] rounded-[2px] border bg-ink border-ink" />WORKED
      </span>
      <span className="inline-flex items-center gap-1.5 text-gold-2">
        <i className="w-[9px] h-[14px] rounded-[2px] border bg-gold border-gold-2" />REWARDED
      </span>
      <span className="inline-flex items-center gap-1.5 text-red-text">
        <i className="w-[9px] h-[14px] rounded-[2px] border bg-red border-red" />CAPPED
      </span>
      <span className="inline-flex items-center gap-1.5">
        <i className="w-[9px] h-[14px] rounded-[2px] border border-red overflow-hidden flex flex-col">
          <span className="flex-1 bg-gold" />
          <span className="flex-1 bg-red" />
        </i>BOTH
      </span>
    </span>
  )
}

/** Role picker rendered as a coloured pill, used in the split and the roster. */
export function RoleSelect({
  value, roles, onChange, className = '',
}: {
  value: string | null
  roles: TipRoleDef[]
  onChange: (roleId: string) => void
  className?: string
}) {
  const active = roles.find(r => r.id === value)
  return (
    <select
      value={value ?? ''}
      onClick={e => e.stopPropagation()}
      onChange={e => onChange(e.target.value)}
      className={`font-mono text-[11px] rounded-full px-2 py-1 font-semibold cursor-pointer outline-none appearance-none border border-transparent ${weightClass(active?.multiplier ?? 1)} ${className}`}
    >
      {!active && <option value="">— no role</option>}
      {roles.map(r => (
        <option key={r.id} value={r.id}>
          {r.name} ×{String(r.multiplier)}
        </option>
      ))}
    </select>
  )
}

/** The grey explainer card under a tab's content. */
export function MethodNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2.5 items-start bg-paper border border-line rounded-md px-3.5 py-3 mt-4 text-[12px] text-ink-3 leading-[1.55] [&_b]:text-ink-2 [&_b]:font-medium">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 mt-px text-ink-4">
        <circle cx="12" cy="12" r="10" /><path d="M12 8h.01M12 11v5" />
      </svg>
      <span>{children}</span>
    </div>
  )
}
```

- [ ] **Step 2: Write the Split tab**

Create `src/components/tips/SplitTab.tsx`:

```tsx
'use client'
import { useState } from 'react'
import type { AuditResult, FindingAction } from '@/lib/tips/audit'
import type { SortKey, SplitPerson, SplitResult, TipRoleDef } from '@/lib/tips/types'
import { DEFAULT_SORT_DIR, effectiveHours, sortPeople } from '@/lib/tips/engine'
import { DayStrip, DayStripLegend, MethodNote, RoleSelect, initials, money } from './kit'

const COLUMNS: Array<{ key: SortKey | 'strip'; label: string; right?: boolean }> = [
  { key: 'name', label: 'Team member' },
  { key: 'role', label: 'Role weight' },
  { key: 'strip', label: '' },
  { key: 'hours', label: 'Hours', right: true },
  { key: 'weighted', label: 'Weighted', right: true },
  { key: 'rate', label: '$ / h', right: true },
  { key: 'share', label: 'Share', right: true },
  { key: 'tip', label: 'Tips', right: true },
  { key: 'env', label: 'Envelope', right: true },
]

const GRID = '1.35fr 112px 178px 60px 74px 66px 92px 96px 100px'

/** "8h × 12 · 10h × 6 · uncapped × 3" — the crew's contracted shift lengths. */
function capSummary(people: SplitPerson[]): string {
  if (!people.length) return '—'
  const counts = new Map<string, number>()
  for (const p of people) {
    const key = p.dailyHourCap == null ? 'uncapped' : `${p.dailyHourCap}h`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] === 'uncapped' ? 1 : b[0] === 'uncapped' ? -1 : parseFloat(a[0]) - parseFloat(b[0])))
    .map(([k, n]) => `${k} × ${n}`)
    .join(' · ')
}

export interface SplitTabProps {
  split: SplitResult
  audit: AuditResult
  roles: TipRoleDef[]
  dayLabels: string[]
  rewardTiers: number[]
  readOnly: boolean
  onRoleChange: (cookId: string, roleId: string) => void
  /** Per-person contracted shift cap. Null clears it (uncapped). */
  onCapChange: (cookId: string, cap: number | null) => void
  onHoursChange: (cookId: string, dayIndex: number, hours: number) => void
  onBoostChange: (cookId: string, dayIndex: number, boost: number) => void
  onClearAdjustments: (cookId: string) => void
  onFix: (action: FindingAction) => void
  onGoto: (tab: string) => void
}

export function SplitTab(props: SplitTabProps) {
  const { split, audit, roles, dayLabels, readOnly } = props
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'tip', dir: -1 })
  const [open, setOpen] = useState<string | null>(null)

  const rows = sortPeople(split.people, sort.key, sort.dir)
  const toggleSort = (key: SortKey) =>
    setSort(s => (s.key === key ? { key, dir: (-s.dir) as 1 | -1 } : { key, dir: DEFAULT_SORT_DIR[key] }))

  const alerts = audit.findings.filter(f => f.severity !== 'info').slice(0, 3)
  const rewardedDays = split.people.reduce((a, p) => a + p.boosts.filter(b => b > 1).length, 0)
  const avgRate = split.hoursTotal ? split.poolTotal / split.hoursTotal : 0

  return (
    <div>
      {alerts.length > 0 && (
        <div className="flex flex-col gap-px bg-line border border-line rounded-md overflow-hidden mb-3.5">
          {alerts.map(f => (
            <div key={f.id} className={`grid grid-cols-[auto_1fr_auto] gap-[11px] items-center px-3.5 py-2.5 text-[13px] ${f.severity === 'error' ? 'bg-[#fffafa]' : 'bg-paper'}`}>
              <span className={`w-[17px] h-[17px] rounded-full grid place-items-center text-[11px] font-bold text-paper shrink-0 ${f.severity === 'error' ? 'bg-red' : 'bg-gold'}`}>!</span>
              <span><b className="font-semibold">{f.title}</b> — {f.detail}</span>
              <button onClick={() => props.onGoto('checks')} className="font-mono text-[10.5px] text-ink-3 hover:text-gold-2">
                Review {audit.counts.error + audit.counts.warn} checks →
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-[1fr_auto_auto] gap-2.5 items-center mb-3.5">
        <div className="flex items-center gap-4 min-w-0">
          <span className="font-mono text-[10.5px] text-ink-3 whitespace-nowrap">CLICK A ROW FOR THE DAY DETAIL</span>
          <DayStripLegend />
        </div>
        {/* Caps are contract terms per person, so this is a read-out, not a
            control: "8h × 12 · 10h × 6 · uncapped × 3". Editing happens on the
            person (open a row) or in Tip settings. */}
        <span className="font-mono text-[11px] text-ink-3" title="Contracted shift caps across the crew">
          SHIFT CAPS {capSummary(split.people)}
        </span>
        <button
          onClick={() => split.people.forEach(p => props.onClearAdjustments(p.cookId))}
          disabled={readOnly}
          className="px-2.5 py-1.5 rounded text-[13px] font-medium text-ink-3 hover:bg-bg-2 hover:text-ink disabled:opacity-40"
        >
          Reset edits
        </button>
      </div>

      <div className="bg-paper border border-line rounded-xl overflow-hidden">
        <div className="grid items-center px-[18px] py-[11px] bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 tracking-[0.02em] uppercase" style={{ gridTemplateColumns: GRID }}>
          {COLUMNS.map(col =>
            col.key === 'strip' ? (
              <span key="strip" className="grid" style={{ gridTemplateColumns: `repeat(${dayLabels.length}, 1fr)` }}>
                {dayLabels.map(l => (
                  <span key={l} className="text-center text-[9px] tracking-normal" title={l}>
                    {l.charAt(0)}<br />{l.replace(/\D+/g, '')}
                  </span>
                ))}
              </span>
            ) : (
              <span
                key={col.key}
                onClick={() => toggleSort(col.key as SortKey)}
                className={`inline-flex items-center gap-1 cursor-pointer select-none rounded px-1 -mx-1 hover:text-ink hover:bg-line ${col.right ? 'justify-end' : ''} ${sort.key === col.key ? 'text-ink font-semibold' : ''}`}
              >
                {col.label}
                <i className="not-italic text-[7px] text-gold-2 leading-none">
                  {sort.key === col.key ? (sort.dir === 1 ? '▲' : '▼') : ''}
                </i>
              </span>
            ),
          )}
        </div>

        {rows.map(p => {
          const isOpen = open === p.cookId
          const share = split.poolTotal ? (p.tip / split.poolTotal) * 100 : 0
          return (
            <div key={p.cookId}>
              <div
                onClick={() => setOpen(isOpen ? null : p.cookId)}
                className={`grid items-center px-[18px] py-[11px] border-b border-line text-[13.5px] cursor-pointer ${isOpen ? 'bg-bg-2' : 'hover:bg-bg'}`}
                style={{ gridTemplateColumns: GRID }}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <span className="w-7 h-7 rounded-full bg-bg-2 border border-line grid place-items-center font-mono text-[10px] font-semibold text-ink-2 shrink-0">{initials(p.name)}</span>
                  <span className="font-medium leading-tight">
                    {p.name}
                    <small className="block font-mono text-[9.5px] text-ink-4 font-normal mt-px">
                      #{p.clockId ?? '—'}{p.wage != null ? ` · $${p.wage}/h` : ''}
                    </small>
                  </span>
                  <span className={`ml-auto text-ink-4 text-[9px] transition-transform ${isOpen ? 'rotate-90 text-gold-2' : ''}`}>▶</span>
                </span>
                <span>
                  <RoleSelect value={p.roleId} roles={roles} onChange={id => props.onRoleChange(p.cookId, id)} />
                </span>
                <DayStrip person={p} dayLabels={dayLabels} />
                <span className="font-mono text-[12.5px] text-right text-ink-3">{p.hoursTotal.toFixed(1)}</span>
                <span className="font-mono text-[12.5px] text-right text-ink-3">{p.weighted.toFixed(1)}</span>
                <span className="font-mono text-[12.5px] text-right text-ink">{p.hoursTotal ? '$' + (p.tip / p.hoursTotal).toFixed(2) : '—'}</span>
                <span className="flex items-center gap-2 justify-end">
                  <span className="w-[30px] h-1.5 rounded-full bg-bg-2 overflow-hidden">
                    <span className="block h-full bg-ink rounded-full" style={{ width: `${Math.min(100, (share / 13) * 100)}%` }} />
                  </span>
                  <span className="font-mono text-[12.5px] text-ink-3">{share.toFixed(1)}%</span>
                </span>
                <span className="font-mono text-[13px] font-semibold text-right text-ink">{money(p.tip)}</span>
                <span className="font-mono text-[12.5px] text-right text-gold-2 font-semibold">{money(p.envelopeCents / 100)}</span>
              </div>
              {isOpen && <PersonDetail {...props} person={p} />}
            </div>
          )
        })}

        <div className="grid items-center px-[18px] py-3 bg-bg-2 border-t border-line font-mono text-[12px] font-semibold" style={{ gridTemplateColumns: GRID }}>
          <span className="text-[10.5px] text-ink-3 uppercase tracking-[0.02em] font-medium">{split.people.length} people</span>
          <span />
          <span className="text-[10.5px] text-ink-3 uppercase tracking-[0.02em] font-medium text-center">
            {rewardedDays} rewarded days
          </span>
          <span className="text-right">{split.hoursTotal.toFixed(1)}</span>
          <span className="text-right">{split.weightedTotal.toFixed(1)}</span>
          <span className="text-right">${avgRate.toFixed(2)}</span>
          <span className="text-right">100%</span>
          <span className="text-right">{money(split.people.reduce((a, p) => a + p.tip, 0))}</span>
          <span className="text-right text-gold-2">{money(split.envelopeTotalCents / 100)}</span>
        </div>
      </div>

      <MethodNote>
        <b>How the split works:</b> each day, the pool rate of that day&rsquo;s basis forms the day
        pool. It&rsquo;s divided by the weighted hours worked that day (hours × role weight × any day
        reward), so people who work the busy days earn more per hour. The daily shares are then
        summed per person — checked to the cent on the Checks tab.
      </MethodNote>
    </div>
  )
}

/** The expanded per-person panel: two weeks of editable day cards. */
function PersonDetail({
  person, dayLabels, rewardTiers, readOnly,
  onHoursChange, onBoostChange, onClearAdjustments, onCapChange,
}: SplitTabProps & { person: SplitPerson }) {
  const cap = person.dailyHourCap
  const tiers = [1, ...rewardTiers]
  const rewarded = person.boosts.filter(b => b > 1).length
  const weeks: number[][] = []
  for (let i = 0; i < dayLabels.length; i += 7) {
    weeks.push(Array.from({ length: Math.min(7, dayLabels.length - i) }, (_, k) => i + k))
  }

  return (
    <div className="bg-[#fbfbfa] border-b border-line px-[18px] pt-4 pb-[18px]" onClick={e => e.stopPropagation()}>
      <div className="flex items-end justify-between gap-5 mb-3.5">
        <div className="flex gap-[26px]">
          {[
            ['Days worked', `${person.hours.filter((_, d) => effectiveHours(person, d) > 0).length} / ${dayLabels.length}`, false],
            ['Hours', person.hoursTotal.toFixed(2), false],
            ['Weighted', person.weighted.toFixed(2), false],
            ['Rewarded days', String(rewarded), rewarded > 0],
            ['Tips', money(person.tip), true],
            ['Per hour', person.hoursTotal ? money(person.tip / person.hoursTotal) : '—', false],
          ].map(([label, value, gold]) => (
            <span key={label as string} className="flex flex-col gap-[3px]">
              <span className="font-mono text-[9.5px] text-ink-3 tracking-[0.03em] uppercase">{label}</span>
              <span className={`font-mono text-[15px] font-semibold ${gold ? 'text-gold-2' : 'text-ink'}`}>{value}</span>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {/* The cap is this person's contract term — edited where their hours are. */}
          <label className="inline-flex items-center gap-1.5 font-mono text-[10px] text-ink-3 uppercase tracking-[0.03em]">
            Shift cap
            <span className="inline-flex items-center gap-[3px] font-mono text-[11px] text-ink-4 border border-line rounded-md px-2 py-1 bg-paper focus-within:border-gold">
              <input
                type="number" step="0.5" min="1" max="24" placeholder="none"
                defaultValue={cap ?? ''} disabled={readOnly}
                onBlur={e => {
                  const v = parseFloat(e.target.value)
                  onCapChange(person.cookId, isFinite(v) && v > 0 ? v : null)
                }}
                className="w-12 font-mono text-[12.5px] font-semibold bg-transparent border-none outline-none text-right text-ink [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              />
              h
            </span>
          </label>
          {rewarded > 0 && !readOnly && (
            <button onClick={() => onClearAdjustments(person.cookId)} className="px-2.5 py-1.5 rounded text-[13px] font-medium text-ink-3 hover:bg-bg-2 hover:text-ink">
              Clear rewards
            </button>
          )}
        </div>
      </div>

      {weeks.map((week, wi) => (
        <div key={wi}>
          <p className="font-mono text-[9.5px] text-ink-3 tracking-[0.06em] uppercase mb-[7px] flex items-center gap-2 after:content-[''] after:flex-1 after:h-px after:bg-line">
            Week {wi + 1}
          </p>
          <div className="grid grid-cols-7 gap-2 mb-3.5">
            {week.map(d => {
              const raw = person.hours[d] ?? 0
              const h = effectiveHours(person, d)
              const boost = person.boosts[d] ?? 1
              const capped = cap != null && raw > cap
              // Same two signals as the day strip, at card scale: a gold rail
              // for a rewarded day, a red rail for a capped one, and BOTH rails
              // when the day is both — never one hiding the other.
              const frame = h <= 0
                ? 'bg-transparent border-dashed border-line'
                : capped && boost > 1 ? 'border-red bg-[#fffdf6]'
                : capped ? 'border-red bg-paper'
                : boost > 1 ? 'border-gold bg-[#fffdf6]'
                : 'border-line bg-paper'
              return (
                <div key={d} className={`relative overflow-hidden rounded p-[9px_10px_10px] flex flex-col gap-[7px] border ${frame}`}>
                  {(boost > 1 || capped) && (
                    <span className="absolute inset-y-0 left-0 w-[3px] flex flex-col" aria-hidden>
                      {boost > 1 && <span className="flex-1 bg-gold" />}
                      {capped && <span className="flex-1 bg-red" />}
                    </span>
                  )}
                  <div className="flex items-baseline justify-between">
                    <span className={`font-mono text-[9.5px] tracking-[0.04em] uppercase ${capped ? 'text-red-text font-semibold' : boost > 1 ? 'text-gold-2 font-semibold' : 'text-ink-3'}`}>{dayLabels[d]}</span>
                    <span className={`font-mono text-[10px] ${boost > 1 ? 'text-gold-2' : 'text-ink-4'}`}>{h > 0 ? money(person.daily[d]) : '—'}</span>
                  </div>
                  <div className="flex items-center gap-[5px]">
                    <input
                      type="number" step="0.25" min="0" max="16" defaultValue={raw}
                      disabled={readOnly}
                      onBlur={e => {
                        const v = parseFloat(e.target.value)
                        onHoursChange(person.cookId, d, isFinite(v) && v >= 0 ? v : 0)
                      }}
                      className="w-full font-mono text-[14px] font-semibold border border-line rounded-md px-[7px] py-[5px] outline-none focus:border-gold text-ink bg-paper [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="font-mono text-[10px] text-ink-4">h</span>
                  </div>
                  {capped && <span className="font-mono text-[9px] text-red-text">capped from {raw}h to {cap}h</span>}
                  <div className="flex gap-[3px]">
                    {tiers.map(t => (
                      <button
                        key={t}
                        disabled={readOnly}
                        onClick={() => onBoostChange(person.cookId, d, boost === t ? 1 : t)}
                        className={`flex-1 font-mono text-[9.5px] py-1 text-center rounded-[5px] border ${boost === t ? 'bg-gold border-gold text-paper font-semibold' : 'bg-paper border-line text-ink-3 hover:border-gold hover:text-gold-2'}`}
                      >
                        {t === 1 ? '—' : `×${t}`}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Write the page shell**

Create `src/app/tips/page.tsx`:

```tsx
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Banknote, Check, Download } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { computeSplit } from '@/lib/tips/engine'
import { auditPeriod, type FindingAction } from '@/lib/tips/audit'
import type { TipPeriodPayload } from '@/lib/tips/types'
import { MethodNote, TIP_TABS, money, type TipTabId } from '@/components/tips/kit'
import { SplitTab } from '@/components/tips/SplitTab'

export default function TipsPage() {
  const [payload, setPayload] = useState<TipPeriodPayload | null>(null)
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [tab, setTab] = useState<TipTabId>('split')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /* ── load ──────────────────────────────────────────────────────────────── */
  const loadPeriod = useCallback(async (id: string) => {
    const res = await fetch(`/api/tips/periods/${id}`, { cache: 'no-store' })
    if (!res.ok) { setError((await res.json()).error ?? 'Could not load the period'); return }
    setPayload(await res.json())
    setPeriodId(id)
    setError(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await fetch('/api/tips/periods', { cache: 'no-store' })
      if (!res.ok) { setError((await res.json()).error ?? 'Could not load tip periods'); return }
      const { periods, defaultStartDate } = await res.json()
      if (cancelled) return
      if (periods.length) { void loadPeriod(periods[0].id); return }
      // No period yet — open the current one.
      const created = await fetch('/api/tips/periods', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startDate: defaultStartDate }),
      })
      if (!created.ok) { setError((await created.json()).error ?? 'Could not open a period'); return }
      const { id } = await created.json()
      if (!cancelled) void loadPeriod(id)
    })()
    return () => { cancelled = true }
  }, [loadPeriod])

  /* ── derive ────────────────────────────────────────────────────────────── */
  const { split, audit } = useMemo(() => {
    if (!payload) return { split: null, audit: null }
    const s = computeSplit({
      basis: payload.basis,
      poolRatePct: payload.period.poolRatePct,
      roundingStepCents: payload.period.roundingStepCents,
      roles: payload.roles,
      people: payload.roster,
    })
    const a = auditPeriod({
      dayLabels: payload.dayLabels,
      basis: payload.basis,
      poolBasis: payload.period.poolBasis,
      sales: payload.sales.net,
      tipsCollected: payload.tips.collected,
      roles: payload.roles,
      people: payload.roster,
      punches: payload.punches,
      split: s,
      roundingStepCents: payload.period.roundingStepCents,
      poolDepartments: payload.poolDepartments,
      ignoredClockIds: payload.period.ignoredClockIds,
      missingBasisDays: payload.missingBasisDays,
    })
    return { split: s, audit: a }
  }, [payload])

  /* ── mutate ────────────────────────────────────────────────────────────── */
  const patchPeriod = useCallback(async (body: Record<string, unknown>) => {
    if (!periodId) return
    setBusy(true)
    const res = await fetch(`/api/tips/periods/${periodId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) setError((await res.json()).error ?? 'Could not save')
    await loadPeriod(periodId)
    setBusy(false)
  }, [periodId, loadPeriod])

  const putAdjustment = useCallback(async (body: Record<string, unknown>) => {
    if (!periodId) return
    setBusy(true)
    const res = await fetch(`/api/tips/periods/${periodId}/adjustments`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) setError((await res.json()).error ?? 'Could not save that edit')
    await loadPeriod(periodId)
    setBusy(false)
  }, [periodId, loadPeriod])

  const applyFix = useCallback(async (action: FindingAction) => {
    if (!periodId || !payload) return
    setBusy(true)
    try {
      if (action.kind === 'goto') { setTab(action.arg as TipTabId); return }
      if (action.kind === 'ignoreCode') {
        await patchPeriod({ ignoredClockIds: [...payload.period.ignoredClockIds, action.arg] })
        return
      }
      if (action.kind === 'onPool') {
        await fetch(`/api/tips/roster/${action.arg}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ onTipPool: true }),
        })
      }
      if (action.kind === 'setCode') {
        const [cookId, code] = action.arg.split(':')
        await fetch(`/api/tips/roster/${cookId}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clockId: code }),
        })
      }
      if (action.kind === 'addPerson') {
        const punch = payload.punches.find(p => p.clockId === action.arg)
        if (punch) {
          const res = await fetch('/api/tips/roster', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              firstName: punch.firstName, lastName: punch.lastName,
              clockId: punch.clockId, position: punch.position,
            }),
          })
          if (!res.ok) setError((await res.json()).error ?? 'Could not add that person')
        }
      }
      await loadPeriod(periodId)
    } finally { setBusy(false) }
  }, [periodId, payload, patchPeriod, loadPeriod])

  const markPaid = useCallback(async () => {
    if (!periodId || !payload) return
    const reopen = payload.period.status === 'PAID'
    setBusy(true)
    const res = await fetch(`/api/tips/periods/${periodId}/pay`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reopen }),
    })
    if (!res.ok) setError((await res.json()).error ?? 'Could not update the period')
    await loadPeriod(periodId)
    setBusy(false)
  }, [periodId, payload, loadPeriod])

  /* ── render ────────────────────────────────────────────────────────────── */
  if (error && !payload) {
    return <div className="bg-paper border border-line rounded-xl p-12 text-center text-[14px] text-red-text">{error}</div>
  }
  if (!payload || !split || !audit) {
    return <div className="bg-paper border border-line rounded-xl p-12 text-center font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">Loading tip period…</div>
  }

  const readOnly = payload.period.status === 'PAID'
  const netSales = payload.sales.net.reduce((a, b) => a + b, 0)
  const badge = audit.counts.error || audit.counts.warn || 0
  const onTips = payload.period.poolBasis === 'TIPS_COLLECTED'
  const basisLabel = onTips ? 'tips collected' : 'net sales'
  const basisTotal = onTips ? payload.tips.total : netSales
  // The FOH pot and what the kitchen takes out of it — shown whatever the basis,
  // because that is the number both sides of the pass actually argue about.
  const tipPot = payload.tips.total
  const hasTips = payload.tips.collected.some(v => v != null)
  const takeoutPct = hasTips && tipPot > 0 ? (split.poolTotal / tipPot) * 100 : null

  return (
    <div>
      {/* Mobile: a payout run is a desk task — the mock has no phone layout. */}
      <div className="md:hidden bg-paper border border-line rounded-xl p-8 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">Desktop only</p>
        <p className="text-[14px] text-ink-2 mt-2">Tip payouts need the full split table. Open Controla OS on a desktop to run the payout.</p>
      </div>

      <div className="hidden md:block">
        {/* dark tip chrome — the page's own strip, not the food-cost spine */}
        <div className="bg-ink text-paper px-8 py-2.5 flex items-center gap-6 -mx-8 -mt-6 mb-6">
          {[
            ['Period', payload.periodLabel.replace(/ · \d{4}$/, '')],
            ['Net sales', money(netSales)],
            ['Tips collected', hasTips ? money(tipPot) : '—'],
            ['Pool rate', `${payload.period.poolRatePct.toFixed(1)}% of ${basisLabel}`],
          ].map(([l, v]) => (
            <span key={l} className="flex items-baseline gap-2">
              <span className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.02em]">{l}</span>
              <span className="font-mono text-[14px] font-semibold">{v}</span>
            </span>
          ))}
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.02em]">Kitchen pool</span>
            <span className="font-mono text-[14px] font-semibold text-[#86efac]">{money(split.poolTotal)}</span>
          </span>
          <span className="flex-1" />
          <span className="font-mono text-[10.5px] text-ink-3">
            Sales from {payload.sales.scopeLabel}
          </span>
        </div>

        <PageHead
          crumbs={<><Banknote size={13} /> TEAM / TIP PAYOUTS</>}
          title="Kitchen tip pool"
          sub={
            <span className="flex items-center gap-3">
              <span className="font-mono text-[11.5px] text-ink">{payload.periodLabel}</span>
              <label className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
                POOL RATE
                <input
                  type="number" step="0.5" min="0" max="100"
                  value={payload.period.poolRatePct}
                  disabled={readOnly}
                  onChange={e => {
                    const v = parseFloat(e.target.value)
                    if (isFinite(v) && v >= 0) void patchPeriod({ poolRatePct: v })
                  }}
                  className="w-[58px] font-mono text-[12px] text-right border border-line rounded-md px-[7px] py-1 bg-paper text-ink outline-none focus:border-gold [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
                % of
                {/* Flipping the basis re-sizes the whole pool, so it is a first-class
                    control here, not buried in settings. Frozen once the period is paid. */}
                <select
                  value={payload.period.poolBasis}
                  disabled={readOnly}
                  onChange={e => void patchPeriod({ poolBasis: e.target.value })}
                  className="font-mono text-[11px] border border-line rounded-md px-1.5 py-1 bg-paper text-ink-2 cursor-pointer outline-none hover:border-ink-3"
                >
                  <option value="NET_SALES">net sales</option>
                  <option value="TIPS_COLLECTED">tips collected</option>
                </select>
              </label>
              <button
                onClick={() => setTab('checks')}
                className={`font-mono text-[10px] uppercase tracking-normal px-2.5 py-[3px] rounded-full inline-flex items-center gap-1.5 font-medium ${audit.counts.error ? 'bg-red-soft text-red-text' : audit.counts.warn ? 'bg-gold-soft text-gold-2' : 'bg-green-soft text-green-text'}`}
              >
                <span className="w-[5px] h-[5px] rounded-full bg-current opacity-70" />
                {audit.counts.error ? `${audit.counts.error} ISSUE${audit.counts.error === 1 ? '' : 'S'}`
                  : audit.counts.warn ? `${audit.counts.warn} WARNING${audit.counts.warn === 1 ? '' : 'S'}`
                  : 'ALL CHECKS PASS'}
              </button>
            </span>
          }
          actions={
            <>
              <a
                href={periodId ? `/api/tips/periods/${periodId}/export` : '#'}
                className="inline-flex items-center gap-[7px] px-3.5 py-[9px] rounded border border-line bg-paper text-[13px] font-medium text-ink-2 hover:border-ink-3"
              >
                <Download size={13} className="text-ink-3" />Export for payroll
              </a>
              <button
                onClick={markPaid}
                disabled={busy}
                className="inline-flex items-center gap-[7px] px-4 py-[9px] rounded bg-ink text-paper text-[13px] font-medium border border-ink hover:bg-ink-2 disabled:opacity-50"
              >
                <Check size={13} className="text-gold" />
                {readOnly ? 'Reopen period' : 'Mark period paid'}
              </button>
            </>
          }
        />

        {error && (
          <div className="mb-4 rounded-md border border-red bg-red-soft px-3.5 py-2.5 text-[13px] text-red-text">{error}</div>
        )}

        <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr' }}>
          <div className="bg-ink text-paper border border-ink rounded-xl px-5 py-[18px] flex flex-col justify-between min-h-[128px]">
            <span className="font-mono text-[10.5px] text-ink-4">TIP POOL · {payload.dayLabels.length} DAYS</span>
            <span className="text-[48px] font-semibold tracking-[-0.045em] leading-none mt-2">
              {money(split.poolTotal).split('.')[0]}
              <sub className="text-[22px] font-medium text-gold align-baseline">.{money(split.poolTotal).split('.')[1]}</sub>
            </span>
            <span className="font-mono text-[11px] text-ink-4 mt-2">
              <b className="text-paper font-medium">{payload.period.poolRatePct.toFixed(1)}%</b> of ${Math.round(basisTotal).toLocaleString('en-CA')} {basisLabel}
            </span>
          </div>
          {[
            // The tip-out card replaces the mock's "team on pool" as the second
            // slot: how much of the FOH pot the kitchen is taking is the number
            // the payout actually gets challenged on.
            takeoutPct != null
              ? ['TIP-OUT TO KITCHEN', `${takeoutPct.toFixed(0)}%`, `${money(tipPot - split.poolTotal)} left for front of house`]
              : ['TEAM ON POOL', String(split.people.length), `${split.hoursTotal.toFixed(1)} h worked`],
            ['WEIGHTED HOURS', split.weightedTotal.toLocaleString('en-CA', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), `${split.people.length} people · ${split.hoursTotal.toFixed(1)} h`],
            ['AVG TIP RATE', `$${(split.hoursTotal ? split.poolTotal / split.hoursTotal : 0).toFixed(2)}/h`, 'across all weights'],
          ].map(([label, value, sub]) => (
            <div key={label} className="relative bg-paper border border-line rounded-xl px-5 py-[18px] flex flex-col justify-between min-h-[128px]">
              <span className="absolute top-0 left-0 w-8 h-0.5 bg-gold" />
              <span className="font-mono text-[10.5px] text-ink-3">{label}</span>
              <span className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 whitespace-nowrap">{value}</span>
              <span className="font-mono text-[11px] text-ink-3 mt-2">{sub}</span>
            </div>
          ))}
        </div>

        <nav className="flex items-stretch px-8 bg-paper border-b border-line h-12 -mx-8 mb-6">
          {TIP_TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-[7px] px-[18px] text-[13.5px] font-medium border-b-2 ${tab === t.id ? 'border-gold text-ink' : 'border-transparent text-ink-3 hover:text-ink-2'}`}
            >
              {t.label}
              {t.id === 'checks' && badge > 0 && (
                <i className={`not-italic inline-grid place-items-center min-w-4 h-4 px-1 rounded-full text-paper font-mono text-[9.5px] font-semibold ${audit.counts.error ? 'bg-red' : 'bg-gold'}`}>{badge}</i>
              )}
            </button>
          ))}
        </nav>

        {tab === 'split' && (
          <SplitTab
            split={split} audit={audit} roles={payload.roles}
            dayLabels={payload.dayLabels}
            rewardTiers={payload.rewardTiers} readOnly={readOnly}
            onCapChange={(cookId, cap) => {
              void fetch(`/api/tips/roster/${cookId}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ dailyHourCap: cap }),
              }).then(() => periodId && loadPeriod(periodId))
            }}
            onRoleChange={(cookId, roleId) => {
              void fetch(`/api/tips/roster/${cookId}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tipRoleId: roleId }),
              }).then(() => periodId && loadPeriod(periodId))
            }}
            onHoursChange={(cookId, dayIndex, hours) => void putAdjustment({ cookId, dayIndex, hours })}
            onBoostChange={(cookId, dayIndex, boost) => void putAdjustment({ cookId, dayIndex, boost })}
            onClearAdjustments={cookId => {
              if (!periodId) return
              void fetch(`/api/tips/periods/${periodId}/adjustments?cookId=${cookId}`, { method: 'DELETE' })
                .then(() => loadPeriod(periodId))
            }}
            onFix={applyFix}
            onGoto={t => setTab(t as TipTabId)}
          />
        )}

        {tab !== 'split' && (
          <MethodNote>This tab lands in the next task.</MethodNote>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify the page renders and the split reconciles**

Open the preview with `preview_start` (name the dev-server entry in `.claude/launch.json`), navigate to `http://localhost:3000/tips`, then check with `read_console_messages` and `read_page`:

- the KPI row shows a pool equal to `rate% × net sales`
- the split table's Tips column sums to the pool in the footer
- clicking a row expands the two-week day detail
- the toolbar reads `SHIFT CAPS 8h × N · 10h × M · uncapped × K` — a read-out, not a single editable cap — followed by the WORKED / REWARDED / CAPPED / BOTH legend
- setting one person's **Shift cap** to 8 in their detail clips only their days; everybody else's hours are untouched, and the Checks tab's cap warning names them
- **day-strip colours:** an ordinary worked day is ink, a rewarded day is gold, a capped day is red, and a day that is *both* is a single block split horizontally — gold top half, red bottom half — with a red border. Zoom the strip with `computer {action: "zoom"}` on a row that has all four states to confirm the split block reads at 9×14 px; if it does not, switch the split to vertical (`flex-row` with two `flex-1` children) rather than dropping one of the signals.
- `read_console_messages` reports no errors

Take a screenshot with `computer {action: "screenshot"}` and compare against the mock's Split tab.

- [ ] **Step 5: Commit**

```bash
git add src/components/tips src/app/tips && git commit -m "feat(tips): /tips page shell and the split table"
```

---

### Task 11: Daily pools and Cash & envelopes tabs

**Files:**
- Create: `src/components/tips/DailyPoolsTab.tsx`, `src/components/tips/CashTab.tsx`
- Modify: `src/app/tips/page.tsx` (mount both tabs)

**Interfaces:**
- Consumes: `SplitResult`, `Denom`, `breakdown` (Task 3), `money`/`money0` (Task 10).
- Produces: `<DailyPoolsTab split sales dayLabels />`, `<CashTab split denoms roundingStepCents onDenomToggle onRoundingChange readOnly />`

- [ ] **Step 1: Write the Daily pools tab**

Create `src/components/tips/DailyPoolsTab.tsx`:

```tsx
'use client'
import type { SplitResult } from '@/lib/tips/types'
import { money, money0 } from './kit'

export function DailyPoolsTab({
  split, sales, tips, dayLabels, overriddenDays, missingDays, basisLabel, onTips,
}: {
  split: SplitResult
  sales: number[]
  /** Customer tips per day; `null` where the app has no data for that day. */
  tips: Array<number | null>
  dayLabels: string[]
  overriddenDays: number[]
  /** Days with no usable BASIS figure — red-bordered, they pay nobody. */
  missingDays: number[]
  basisLabel: string
  onTips: boolean
}) {
  const peak = split.pools.indexOf(Math.max(...split.pools))

  return (
    <div>
      <div className="grid grid-cols-7 gap-2.5 mb-2.5">
        {dayLabels.map((label, d) => {
          const missing = missingDays.includes(d)
          const overridden = overriddenDays.includes(d)
          return (
            <div
              key={d}
              className={`bg-paper border rounded-md px-[13px] py-3 flex flex-col gap-2 ${
                missing ? 'border-red' : d === peak ? 'border-gold shadow-[0_0_0_1px_var(--tw-shadow-color)] shadow-gold' : 'border-line'
              }`}
            >
              <span className="font-mono text-[10px] text-ink-3 tracking-[0.02em] uppercase flex justify-between">
                <span>{label}</span>
                <span className={missing ? 'text-red-text font-semibold' : d === peak ? 'text-gold-2 font-semibold' : ''}>
                  {missing ? 'NO DATA' : overridden ? 'FILE' : d === peak ? 'PEAK' : ''}
                </span>
              </span>
              <span className="text-[19px] font-semibold tracking-[-0.03em]">{money(split.pools[d])}</span>
              <span className="font-mono text-[10px] text-ink-3 leading-[1.5]">
                {/* The basis line is emphasised; the other figure is shown for
                    context so the two are always comparable on the same card. */}
                <b className={onTips ? 'text-ink-4' : 'text-ink-2'}>{money0(sales[d])}</b> sales
                {' · '}
                <b className={onTips ? 'text-ink-2' : 'text-ink-4'}>
                  {tips[d] == null ? '—' : money0(tips[d]!)}
                </b> tips<br />
                {split.crewByDay[d]} on shift · {split.weightedByDay[d].toFixed(1)} wh<br />
                <b className="text-ink-2">{split.weightedByDay[d] > 0 ? money(split.pools[d] / split.weightedByDay[d]) : '—'}</b> / weighted h
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-[18px] font-mono text-[10.5px] text-ink-3 flex justify-between">
        <span>Pool per day = {basisLabel} × pool rate · rate/h = day pool ÷ weighted hours on shift</span>
        <span>TOTAL POOL {money(split.poolTotal)}</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Write the Cash tab**

Create `src/components/tips/CashTab.tsx`:

```tsx
'use client'
import type { Denom, SplitResult } from '@/lib/tips/types'
import { breakdown } from '@/lib/tips/engine'
import { money } from './kit'

/** Denomination chip colouring — mirrors `.d100/.d50/.d20/.d10/.d5/.dcoin`. */
function chipClass(cents: number): string {
  if (cents === 10000) return 'bg-[#f3e8dc] text-[#7c4a1e]'
  if (cents === 5000) return 'bg-red-soft text-red-text'
  if (cents === 2000) return 'bg-green-soft text-green-text'
  if (cents === 1000) return 'bg-[#ede9fe] text-[#6d28d9]'
  if (cents === 500) return 'bg-blue-soft text-blue-text'
  return 'bg-bg-2 text-ink-2 border border-line'
}

const STEPS: Array<{ cents: number; label: string }> = [
  { cents: 5, label: '5¢' },
  { cents: 100, label: '$1' },
  { cents: 500, label: '$5' },
]

export function CashTab({
  split, denoms, roundingStepCents, readOnly, onDenomToggle, onRoundingChange,
}: {
  split: SplitResult
  denoms: Denom[]
  roundingStepCents: number
  readOnly: boolean
  onDenomToggle: (index: number) => void
  onRoundingChange: (cents: number) => void
}) {
  const withEnvelopes = split.people.filter(p => p.envelopeCents > 0)

  // Bank order — every envelope's breakdown, summed by denomination.
  const bank = new Map<string, number>()
  const envelopes = withEnvelopes.map(p => {
    const bd = breakdown(p.envelopeCents, denoms)
    bd.parts.forEach(part => bank.set(part.l, (bank.get(part.l) ?? 0) + part.n))
    return { person: p, bd }
  })
  const pieces = [...bank.values()].reduce((a, b) => a + b, 0)
  const drift = split.envelopeTotalCents / 100 - split.poolTotal

  return (
    <div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-2.5 items-center mb-3.5">
        <div className="font-mono text-[10.5px] text-ink-3">ENVELOPES · ROUNDED FOR CASH · NO PENNIES (CAD)</div>
        <span className="font-mono text-[11px] text-ink-3">ROUND TO</span>
        <div className="flex bg-paper border border-line rounded p-[3px]">
          {STEPS.map(s => (
            <button
              key={s.cents}
              disabled={readOnly}
              onClick={() => onRoundingChange(s.cents)}
              className={`px-2.5 py-1 font-mono text-[11px] rounded-md ${roundingStepCents === s.cents ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-5 items-start">
        <div className="grid grid-cols-2 gap-3">
          {envelopes.map(({ person, bd }) => (
            <div key={person.cookId} className="bg-paper border border-line rounded-xl px-4 py-3.5">
              <div className="flex justify-between items-baseline mb-[9px]">
                <span className="font-semibold text-[13.5px] tracking-[-0.01em]">{person.name}</span>
                <span className="font-mono text-[16px] font-semibold tracking-[-0.01em]">{money(person.envelopeCents / 100)}</span>
              </div>
              <div className="flex flex-wrap gap-[5px]">
                {bd.parts.map(part => (
                  <span key={part.l} className={`font-mono text-[10.5px] px-2 py-[3px] rounded-md font-semibold ${chipClass(part.v)}`}>
                    <b className="font-normal opacity-65 mr-px">{part.n}×</b>{part.l}
                  </span>
                ))}
                {bd.remainder > 0 && (
                  <span className="font-mono text-[10.5px] px-2 py-[3px] rounded-md font-semibold bg-red-soft text-red-text">
                    {(bd.remainder / 100).toFixed(2)} short — enable smaller coins
                  </span>
                )}
              </div>
            </div>
          ))}
          {!envelopes.length && (
            <div className="col-span-2 bg-paper border border-line rounded-xl py-12 text-center font-mono text-[10.5px] text-ink-3">
              NO ENVELOPES YET — IMPORT THE CLOCKS WORKBOOK
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3.5">
          <div className="bg-paper border border-line rounded-xl p-5">
            <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Bank order</h3>
            <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">what to withdraw to fill every envelope</p>
            <div className="flex flex-col gap-0.5 pb-3.5 border-b border-line mb-3">
              <span className="text-[30px] font-semibold tracking-[-0.035em]">{money(split.envelopeTotalCents / 100)}</span>
              <span className="font-mono text-[10.5px] text-ink-3">{pieces} pieces · {envelopes.length} envelopes</span>
            </div>
            {denoms.map((d, i) => {
              const n = d.on ? (bank.get(d.l) ?? 0) : 0
              return (
                <div key={d.l} className={`grid grid-cols-[34px_1fr_auto_auto] items-center gap-2.5 py-1.5 text-[13px] ${d.on ? '' : 'opacity-40'}`}>
                  <span className={`font-mono text-[10.5px] px-2 py-[3px] rounded-md font-semibold text-center ${chipClass(d.v)}`}>{d.l}</span>
                  <button
                    disabled={readOnly}
                    onClick={() => onDenomToggle(i)}
                    className={`w-[30px] h-[18px] rounded-full relative shrink-0 ${d.on ? 'bg-green' : 'bg-line-2'}`}
                    aria-label={`${d.on ? 'Disable' : 'Enable'} ${d.l}`}
                  >
                    <span className={`absolute top-0.5 w-3.5 h-3.5 bg-paper rounded-full shadow-sm transition-all ${d.on ? 'left-3.5' : 'left-0.5'}`} />
                  </button>
                  <span className="font-mono text-[12.5px] text-right text-ink">{d.on ? `×${n}` : '—'}</span>
                  <span className="font-mono text-[11px] text-ink-3 text-right min-w-[70px]">{d.on && n ? money((n * d.v) / 100) : ''}</span>
                </div>
              )
            })}
            <div className="mt-3 px-3 py-2.5 rounded bg-bg-2 font-mono text-[10.5px] text-ink-3 leading-[1.6] [&_b]:text-ink [&_b]:font-semibold">
              Envelopes total <b>{money(split.envelopeTotalCents / 100)}</b> vs exact pool <b>{money(split.poolTotal)}</b><br />
              {Math.abs(drift) < 0.005
                ? 'Exact to the cent — nothing carried.'
                : drift > 0
                  ? <><b>{money(drift)}</b> over — rounded up, covered by the float.</>
                  : <><b>{money(-drift)}</b> under — remainder carries into next period&rsquo;s pool.</>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Mount both tabs in the page**

In `src/app/tips/page.tsx`, add the imports:

```tsx
import { DailyPoolsTab } from '@/components/tips/DailyPoolsTab'
import { CashTab } from '@/components/tips/CashTab'
```

Add a denominations handler next to `patchPeriod` (denoms live on `TipSettings`, not the period):

```tsx
  const saveSettings = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true)
    const res = await fetch('/api/tips/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) setError((await res.json()).error ?? 'Could not save settings')
    if (periodId) await loadPeriod(periodId)
    setBusy(false)
  }, [periodId, loadPeriod])
```

Replace the `{tab !== 'split' && <MethodNote>…</MethodNote>}` placeholder with:

```tsx
        {tab === 'days' && (
          <DailyPoolsTab
            split={split}
            sales={payload.sales.net}
            tips={payload.tips.collected}
            dayLabels={payload.dayLabels}
            overriddenDays={onTips ? payload.tips.overriddenDays : payload.sales.overriddenDays}
            missingDays={payload.missingBasisDays}
            basisLabel={basisLabel}
            onTips={onTips}
          />
        )}

        {tab === 'cash' && (
          <CashTab
            split={split}
            denoms={payload.denoms}
            roundingStepCents={payload.period.roundingStepCents}
            readOnly={readOnly}
            onDenomToggle={i => {
              const next = payload.denoms.map((d, k) => (k === i ? { ...d, on: !d.on } : d))
              void saveSettings({ denoms: next })
            }}
            onRoundingChange={cents => void patchPeriod({ roundingStepCents: cents })}
          />
        )}

        {(tab === 'checks' || tab === 'import' || tab === 'settings') && (
          <MethodNote>This tab lands in the next task.</MethodNote>
        )}
```

- [ ] **Step 4: Verify in the browser**

Reload `/tips`, switch to **Daily pools** — 14 cards, each showing both the day's sales and its tips with the basis in use emphasised, the peak day gold-bordered, and any day missing the basis figure red-bordered and labelled `NO DATA`. Flip the basis selector in the header from *net sales* to *tips collected* and confirm every day pool changes and the footer sentence follows. Switch to **Cash & envelopes** — envelope chips add up to each envelope, the Bank order total equals the envelope total, and toggling `$50` off redistributes into `$20`s. Confirm with `read_console_messages` that there are no errors, and screenshot both tabs.

- [ ] **Step 5: Commit**

```bash
git add src/components/tips/DailyPoolsTab.tsx src/components/tips/CashTab.tsx src/app/tips/page.tsx && git commit -m "feat(tips): daily pools and cash envelope tabs"
```

---

### Task 12: Checks and Import tabs

**Files:**
- Create: `src/components/tips/ChecksTab.tsx`, `src/components/tips/ImportTab.tsx`
- Modify: `src/app/tips/page.tsx` (mount both tabs)

**Interfaces:**
- Consumes: `AuditResult`, `FindingAction`, `TipPeriodPayload`, `hoursLabel`/`signedHours`/`money` (Task 10).
- Produces: `<ChecksTab audit split period punchTotal onFix />`, `<ImportTab periodId period onImported readOnly />`

- [ ] **Step 1: Write the Checks tab**

Create `src/components/tips/ChecksTab.tsx`:

```tsx
'use client'
import type { AuditResult, FindingAction } from '@/lib/tips/audit'
import type { SplitResult } from '@/lib/tips/types'
import type { TipPeriodPayload } from '@/lib/tips/types'
import { hoursLabel, money, signedHours } from './kit'

export function ChecksTab({
  audit, split, period, punchTotal, scopeLabel, readOnly, onFix,
}: {
  audit: AuditResult
  split: SplitResult
  period: TipPeriodPayload['period']
  punchTotal: number
  scopeLabel: string
  readOnly: boolean
  onFix: (action: FindingAction) => void
}) {
  const { counts } = audit

  return (
    <div className="grid grid-cols-[1fr_350px] gap-5 items-start">
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 mb-2.5">
          {counts.error || counts.warn
            ? [counts.error ? `${counts.error} TO FIX` : '', counts.warn ? `${counts.warn} TO REVIEW` : ''].filter(Boolean).join(' · ')
            : 'NOTHING TO FIX'}
          {' · '}{counts.shifts} SHIFTS MATCHED · {hoursLabel(counts.inPool)} PAID
          {counts.missingHours >= 0.005 && (
            <span className="text-red-text"> · {hoursLabel(counts.missingHours)} UNACCOUNTED</span>
          )}
        </div>

        {audit.findings.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-12 px-5 bg-paper border border-line rounded-xl text-center">
            <span className="w-[34px] h-[34px] rounded-full bg-green-soft text-green-text grid place-items-center text-[15px] font-bold mb-0.5">✓</span>
            <span className="text-[15px] font-semibold tracking-[-0.02em]">Everything reconciles</span>
            <span className="font-mono text-[10.5px] text-ink-3">
              {counts.shifts} shifts · {hoursLabel(counts.inPool)} · {money(split.distributedTotal)} distributed to the cent
            </span>
          </div>
        ) : (
          audit.findings.map(f => (
            <div
              key={f.id}
              className={`grid grid-cols-[auto_1fr_auto] gap-[13px] items-start bg-paper border border-line rounded-md px-4 py-3.5 mb-2.5 border-l-[3px] ${
                f.severity === 'error' ? 'border-l-red' : f.severity === 'warn' ? 'border-l-gold' : 'border-l-line-2'
              }`}
            >
              <span className={`w-[18px] h-[18px] rounded-full grid place-items-center text-[11px] font-bold text-paper mt-px ${
                f.severity === 'error' ? 'bg-red' : f.severity === 'warn' ? 'bg-gold' : 'bg-ink-4'
              }`}>
                {f.severity === 'info' ? 'i' : '!'}
              </span>
              <span>
                <span className="block text-[13.5px] font-semibold tracking-[-0.012em] mb-[3px]">{f.title}</span>
                <span className="block text-[12.5px] text-ink-3 leading-[1.5] text-pretty">{f.detail}</span>
              </span>
              <span className="flex gap-1.5 items-center shrink-0">
                {(f.actions ?? []).map(a => (
                  <button
                    key={a.label}
                    disabled={readOnly && a.kind !== 'goto'}
                    onClick={() => onFix(a)}
                    className={`px-[11px] py-1.5 rounded text-[12px] font-medium whitespace-nowrap border disabled:opacity-40 ${
                      a.ghost ? 'border-transparent text-ink-3 hover:bg-bg-2 hover:text-ink' : 'border-line bg-paper text-ink-2 hover:border-ink-3'
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-3.5">
        <div className="bg-paper border border-line rounded-xl p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Hours reconciliation</h3>
          <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">every hour on the clock file, and where it went</p>
          {audit.ledger.map(row => (
            <div
              key={row.label}
              className={`grid grid-cols-[1fr_auto] gap-2.5 items-baseline py-1.5 text-[12.5px] ${
                row.lead ? 'font-semibold text-ink' : row.subtotal ? 'font-medium border-t border-line mt-1 pt-[9px]' : 'text-ink-2'
              } ${row.muted ? 'text-ink-4' : ''} ${row.bad ? 'text-red-text' : ''} ${row.warn ? '' : ''} ${
                row.closed !== undefined ? 'border-t border-ink mt-1.5 pt-2.5' : ''
              }`}
            >
              <span>
                {row.label}
                {row.note && <small className="block font-mono text-[9.5px] text-ink-4 mt-px">{row.note}</small>}
              </span>
              <span className={`font-mono text-[12.5px] ${row.lead ? 'font-semibold text-[14px]' : ''} ${
                row.bad ? 'text-red-text font-semibold' : row.warn ? 'text-gold-2 font-semibold' : row.muted ? 'text-ink-4' : 'text-ink'
              }`}>
                {row.lead || row.subtotal ? hoursLabel(row.value) : signedHours(row.value)}
                {row.closed === true && <span className="text-green-text font-mono text-[10px] ml-1.5">✓</span>}
              </span>
            </div>
          ))}
          <div className="mt-3 px-3 py-2.5 rounded bg-bg-2 font-mono text-[10.5px] text-ink-3 leading-[1.6] [&_b]:text-ink [&_b]:font-semibold">
            {counts.missingHours >= 0.005 ? (
              <>
                <b>{hoursLabel(counts.missingHours)} of clocked kitchen labour is being left out</b> —{' '}
                {counts.lostPeople.slice(0, 3).join(', ')}
                {counts.lostPeople.length > 3 ? ` +${counts.lostPeople.length - 3} more` : ''}. Settle that before paying this period.
              </>
            ) : Math.abs(counts.unexplained) >= 0.005 ? (
              <><b>{hoursLabel(Math.abs(counts.unexplained))} unexplained</b> — do not pay this period until it closes.</>
            ) : (
              <>Every hour on the clock file is either paid or accounted for above. <b>Nothing is missing.</b></>
            )}
          </div>
        </div>

        <div className="bg-paper border border-line rounded-xl p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Source files</h3>
          <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">what this period was calculated from</p>
          {[
            {
              name: period.clockFileName ?? 'No clocks workbook imported',
              meta: period.clockFileName
                ? `${counts.shifts + 0} matched shifts · ${hoursLabel(punchTotal)} on file · ${period.clockImportedAt?.slice(0, 16).replace('T', ' ') ?? ''}`
                : 'Hours must be typed by hand until one is imported',
            },
            {
              name: period.salesFileName ?? `Sales from the app · ${scopeLabel}`,
              meta: period.salesFileName
                ? `Overriding the app · ${period.salesImportedAt?.slice(0, 16).replace('T', ' ') ?? ''}`
                : 'Live SalesEntry rows, Toast-wins de-duplicated',
            },
            { name: 'Matched by Clock ID', meta: 'names are never used to match hours to people' },
          ].map(row => (
            <div key={row.name} className="grid grid-cols-[auto_1fr] gap-2.5 py-2 border-b border-line last:border-b-0 items-start">
              <span className="text-ink-4 mt-px">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>
              </span>
              <span>
                <span className="font-mono text-[10.5px] text-ink break-all leading-[1.45] block">{row.name}</span>
                <small className="font-mono text-[9.5px] text-ink-4 mt-0.5 block">{row.meta}</small>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Write the Import tab**

Create `src/components/tips/ImportTab.tsx`:

```tsx
'use client'
import { useRef, useState } from 'react'
import type { TipPeriodPayload } from '@/lib/tips/types'
import { MethodNote } from './kit'

type Kind = 'sales' | 'clocks'
type Status = { tone: 'idle' | 'ok' | 'err'; message: string }

export function ImportTab({
  periodId, period, readOnly, onImported,
}: {
  periodId: string
  period: TipPeriodPayload['period']
  readOnly: boolean
  onImported: () => void
}) {
  const [status, setStatus] = useState<Record<Kind, Status>>({
    sales: { tone: 'idle', message: '' },
    clocks: { tone: 'idle', message: '' },
  })
  const [dragging, setDragging] = useState<Kind | null>(null)

  const upload = async (kind: Kind, file: File) => {
    setStatus(s => ({ ...s, [kind]: { tone: 'idle', message: `Reading ${file.name}…` } }))
    const body = new FormData()
    body.append('file', file)
    body.append('kind', kind)
    const res = await fetch(`/api/tips/periods/${periodId}/import`, { method: 'POST', body })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setStatus(s => ({ ...s, [kind]: { tone: 'err', message: json.error ?? 'That workbook could not be read.' } }))
      return
    }
    const sum = json.summary ?? {}
    setStatus(s => ({
      ...s,
      [kind]: {
        tone: 'ok',
        message: kind === 'sales'
          ? `Read ${sum.days} days · $${Number(sum.total).toLocaleString('en-CA', { minimumFractionDigits: 2 })} net sales`
          : `Read ${sum.shifts} shifts · ${sum.hours} h · ${sum.people} people` +
            (sum.strangers ? ` · ${sum.strangers} not on the roster — see Checks` : '') +
            (sum.outside ? ` · ${sum.outside} dated outside the period` : ''),
      },
    }))
    onImported()
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        <DropCard
          kind="sales"
          title="Sales summary"
          pill={period.salesFileName ? 'OVERRIDING THE APP' : 'USING APP SALES'}
          pillTone={period.salesFileName ? 'warn' : 'ok'}
          sub="SalesSummary_….xlsx — reads the “Sales by day” sheet. Only needed for days the app has no sales for."
          status={status.sales}
          dragging={dragging === 'sales'}
          readOnly={readOnly}
          onDragState={d => setDragging(d ? 'sales' : null)}
          onFile={f => void upload('sales', f)}
        />
        <DropCard
          kind="clocks"
          title="Clocks summary"
          pill={period.clockFileName ? `IMPORTED` : 'NOT IMPORTED'}
          pillTone={period.clockFileName ? 'ok' : 'warn'}
          sub="Clocks Summary_….xlsx — every punch, matched to the roster by Clock ID."
          status={status.clocks}
          dragging={dragging === 'clocks'}
          readOnly={readOnly}
          onDragState={d => setDragging(d ? 'clocks' : null)}
          onFile={f => void upload('clocks', f)}
        />
      </div>

      <MethodNote>
        <b>Hours are matched to people by Clock ID, never by name</b>, so a spelling change in the POS
        cannot silently drop somebody. Anything that does not match lands on the Checks tab before it
        can affect a payout. Re-importing the clocks workbook replaces every punch in this period and
        clears the exclusion list.
      </MethodNote>
    </div>
  )
}

function DropCard({
  kind, title, pill, pillTone, sub, status, dragging, readOnly, onDragState, onFile,
}: {
  kind: Kind
  title: string
  pill: string
  pillTone: 'ok' | 'warn'
  sub: string
  status: Status
  dragging: boolean
  readOnly: boolean
  onDragState: (dragging: boolean) => void
  onFile: (file: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const ok = status.tone === 'ok'

  return (
    <div className="bg-paper border border-line rounded-xl p-5">
      <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">
        {title}
        <span className={`ml-1.5 font-mono text-[10px] uppercase px-2.5 py-[3px] rounded-full font-medium ${pillTone === 'ok' ? 'bg-green-soft text-green-text' : 'bg-gold-soft text-gold-2'}`}>{pill}</span>
      </h3>
      <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">{sub}</p>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => input.current?.click()}
        onDragOver={e => { e.preventDefault(); onDragState(true) }}
        onDragLeave={() => onDragState(false)}
        onDrop={e => {
          e.preventDefault(); onDragState(false)
          const f = e.dataTransfer.files?.[0]
          if (f) onFile(f)
        }}
        className={`w-full flex flex-col items-center justify-center gap-[5px] min-h-[132px] rounded border border-dashed p-4 text-center transition-colors disabled:opacity-50 ${
          ok ? 'border-solid border-green bg-[#f7fdf9]' : dragging ? 'border-gold bg-[#fffdf6]' : 'border-line-2 bg-bg hover:border-gold hover:bg-[#fffdf6]'
        }`}
      >
        <span className={ok ? 'text-green-text' : dragging ? 'text-gold-2' : 'text-ink-4'}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 15h6M9 18h4" />
          </svg>
        </span>
        <span className="text-[13px] font-medium tracking-[-0.01em]">Drop the {kind === 'sales' ? 'sales' : 'clocks'} workbook</span>
        <span className="font-mono text-[10px] text-ink-4">or click to choose · .xlsx</span>
      </button>
      <input ref={input} type="file" accept=".xlsx" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
      {status.message && (
        <p className={`mt-2.5 font-mono text-[10.5px] ${status.tone === 'ok' ? 'text-green-text' : status.tone === 'err' ? 'text-red-text' : 'text-ink-3'}`}>
          {status.message}
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Mount both tabs**

In `src/app/tips/page.tsx`, add the imports and replace the remaining placeholder:

```tsx
import { ChecksTab } from '@/components/tips/ChecksTab'
import { ImportTab } from '@/components/tips/ImportTab'
```

```tsx
        {tab === 'checks' && (
          <ChecksTab
            audit={audit} split={split} period={payload.period}
            punchTotal={payload.punchTotal} scopeLabel={payload.sales.scopeLabel}
            readOnly={readOnly} onFix={applyFix}
          />
        )}

        {tab === 'import' && periodId && (
          <ImportTab
            periodId={periodId} period={payload.period} readOnly={readOnly}
            onImported={() => void loadPeriod(periodId)}
          />
        )}

        {tab === 'settings' && (
          <MethodNote>This tab lands in the next task.</MethodNote>
        )}
```

- [ ] **Step 4: Verify the round trip in the browser**

On `/tips` → **Import data**, drop the fixture workbook `Clocks Summary_ Fergie's Cafe 2026-07-12 to 2026-07-25.xlsx`. Expected: a green drop zone reading `Read 118 shifts · 1013.84 h · N people`, the Checks badge appears in the tab bar, and the Split table fills with hours. Then open **Checks** — the ledger's "Clocked in the hours file" row should read `1013.84 h` and the bottom "Paid in this pool" row should carry a green ✓ once every stranded code is either added or excluded. Confirm no console errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/tips/ChecksTab.tsx src/components/tips/ImportTab.tsx src/app/tips/page.tsx && git commit -m "feat(tips): reconciliation checks and workbook import tabs"
```

---

### Task 13: Tip settings tab (roster, roles, pool basis, and the sales scope picker)

**Files:**
- Create: `src/components/tips/SettingsTab.tsx`
- Modify: `src/app/tips/page.tsx` (mount the tab, fetch locations + revenue centers)

**Interfaces:**
- Consumes: `/api/tips/settings`, `/api/tips/roles`, `/api/tips/roster`, `/api/locations`, `/api/revenue-centers`.
- Produces: `<SettingsTab payload split settings locations revenueCenters onSaveSettings onSaveRole onAddRole onDeleteRole onSaveRoster onAddEmployee />`

**The sales scope picker is the heart of this task.** It renders as its own card, above the pool rules, and states the resolved scope in plain language: *"Tips for **Kitchen**. Pool funded by **Cafe · all revenue centers**."* — so the manager can see at a glance that the two are different on purpose.

- [ ] **Step 1: Confirm the two lookup endpoints exist and their shapes**

```bash
ls src/app/api/locations src/app/api/revenue-centers && curl -s localhost:3000/api/locations | head -c 300 && echo && curl -s localhost:3000/api/revenue-centers | head -c 300
```

Expected: both return JSON arrays with at least `id` and `name`. If either returns a wrapped object (`{ locations: [...] }`), adjust the `fetchLookups` mapper in Step 3 to unwrap it — do **not** change the endpoints.

- [ ] **Step 2: Write the settings tab**

Create `src/components/tips/SettingsTab.tsx`:

```tsx
'use client'
import { useState } from 'react'
import type { SplitResult, TipRoleDef } from '@/lib/tips/types'
import type { TipPeriodPayload } from '@/lib/tips/types'
import { RoleSelect, initials, money } from './kit'

export interface TipSettingsDto {
  poolBasis: 'NET_SALES' | 'TIPS_COLLECTED'
  includeAutoGratuity: boolean
  poolRatePct: number
  /** Prefill for new roster rows only — the live cap is per person. */
  defaultDailyHourCap: number | null
  rewardTiers: number[]
  roundingStepCents: number
  periodDays: number
  periodStartDow: number
  salesSourceMode: 'LOCATION' | 'RC'
  salesLocationId: string | null
  salesRcIds: string[]
  poolRevenueCenterId: string | null
  salesScopeLabel: string
}

export interface LookupOption { id: string; name: string; locationId?: string }

const GRID = 'minmax(180px,1.4fr) 68px 78px 74px 100px 50px 74px 48px 26px'

export function SettingsTab({
  payload, split, settings, locations, revenueCenters,
  onSaveSettings, onSaveRole, onAddRole, onDeleteRole, onSaveRoster, onAddEmployee, readOnly,
}: {
  payload: TipPeriodPayload
  split: SplitResult
  settings: TipSettingsDto
  locations: LookupOption[]
  revenueCenters: LookupOption[]
  readOnly: boolean
  onSaveSettings: (patch: Partial<TipSettingsDto>) => void
  onSaveRole: (id: string, patch: { name?: string; multiplier?: number }) => void
  onAddRole: () => void
  onDeleteRole: (id: string) => void
  onSaveRoster: (cookId: string, patch: Record<string, unknown>) => void
  onAddEmployee: () => void
}) {
  const tipBy = new Map(split.people.map(p => [p.cookId, p]))
  const usage = new Map<string, number>()
  payload.roster.forEach(p => { if (p.roleId) usage.set(p.roleId, (usage.get(p.roleId) ?? 0) + 1) })
  const poolRc = revenueCenters.find(rc => rc.id === payload.period.revenueCenterId)

  return (
    <div className="grid grid-cols-[1fr_330px] gap-5 items-start">
      {/* ── roster ─────────────────────────────────────────────────────────── */}
      <div>
        <div className="grid grid-cols-[1fr_auto] gap-2.5 items-center mb-3.5">
          <div className="font-mono text-[10.5px] text-ink-3">
            {payload.roster.length} PEOPLE ON THE ROSTER · {payload.roster.filter(p => !p.onPool).length} OFF POOL
          </div>
          <button onClick={onAddEmployee} disabled={readOnly} className="inline-flex items-center gap-[7px] px-3.5 py-[9px] rounded border border-line bg-paper text-[13px] font-medium text-ink-2 hover:border-ink-3 disabled:opacity-40">
            <span className="text-ink-3">＋</span>Add employee
          </button>
        </div>

        <div className="bg-paper border border-line rounded-xl overflow-hidden">
          <div className="grid items-center gap-2 px-[18px] py-[11px] bg-bg-2 border-b border-line font-mono text-[10.5px] text-ink-3 uppercase tracking-[0.02em]" style={{ gridTemplateColumns: GRID }}>
            <span>Employee</span><span>Code</span><span>Wage</span>
            <span title="Contracted shift length — hours above it are not paid tips">Cap</span>
            <span>Role</span>
            <span className="text-right">Hours</span><span className="text-right">Tips</span>
            <span className="text-center">On pool</span><span />
          </div>
          {payload.roster.map(p => {
            const t = tipBy.get(p.cookId)
            return (
              <div key={p.cookId} className={`grid items-center gap-2 px-[18px] py-2 border-b border-line last:border-b-0 text-[13.5px] ${p.onPool ? '' : 'bg-[#fbfbfa]'}`} style={{ gridTemplateColumns: GRID }}>
                <span className="flex items-center gap-2 min-w-0">
                  <span className={`w-7 h-7 rounded-full bg-bg-2 border border-line grid place-items-center font-mono text-[10px] font-semibold text-ink-2 shrink-0 ${p.onPool ? '' : 'opacity-50'}`}>{initials(p.name)}</span>
                  <span className="grid gap-px min-w-0 flex-1">
                    <span className="text-[13px] font-medium truncate">{p.name}</span>
                    <input
                      defaultValue={p.lastName ?? ''} placeholder="Surname" disabled={readOnly}
                      onBlur={e => onSaveRoster(p.cookId, { lastName: e.target.value })}
                      className="font-mono text-[10px] text-ink-3 bg-transparent border border-transparent rounded-md px-[7px] py-0.5 outline-none hover:border-line focus:border-gold focus:bg-paper"
                    />
                  </span>
                </span>
                <input
                  defaultValue={p.clockId ?? ''} placeholder="—" disabled={readOnly}
                  onBlur={e => onSaveRoster(p.cookId, { clockId: e.target.value })}
                  className="font-mono text-[11.5px] text-ink-3 bg-transparent border border-transparent rounded-md px-[7px] py-[5px] outline-none w-full min-w-0 hover:border-line focus:border-gold focus:bg-paper"
                />
                <span className="flex items-center gap-px font-mono text-[11px] text-ink-4">
                  $<input
                    type="number" step="0.25" min="0" defaultValue={p.wage ?? ''} disabled={readOnly}
                    onBlur={e => onSaveRoster(p.cookId, { wage: e.target.value === '' ? null : e.target.value })}
                    className="w-[42px] font-mono text-[12px] text-right bg-transparent border border-transparent rounded-md px-1 py-[5px] outline-none text-ink hover:border-line focus:border-gold focus:bg-paper [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  /><em className="not-italic">/h</em>
                </span>
                {/* Contracted shift length — 10 h for some of the crew, 8 h for
                    others. Blank means this person is uncapped. */}
                <span className="flex items-center gap-px font-mono text-[11px] text-ink-4">
                  <input
                    type="number" step="0.5" min="1" max="24" placeholder="—"
                    defaultValue={p.dailyHourCap ?? ''} disabled={readOnly}
                    onBlur={e => onSaveRoster(p.cookId, { dailyHourCap: e.target.value === '' ? null : e.target.value })}
                    className="w-[42px] font-mono text-[12px] text-right bg-transparent border border-transparent rounded-md px-1 py-[5px] outline-none text-ink hover:border-line focus:border-gold focus:bg-paper [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  /><em className="not-italic">h</em>
                </span>
                <RoleSelect value={p.roleId} roles={payload.roles} onChange={id => onSaveRoster(p.cookId, { tipRoleId: id })} className="w-full" />
                <span className="font-mono text-[12.5px] text-right text-ink-3">{t ? `${t.hoursTotal.toFixed(1)} h` : '—'}</span>
                <span className={`font-mono text-[12.5px] text-right ${t ? 'text-gold-2 font-semibold' : 'text-ink-4'}`}>{t ? money(t.tip) : '—'}</span>
                <span className="flex justify-center">
                  <button
                    disabled={readOnly}
                    onClick={() => onSaveRoster(p.cookId, { onTipPool: !p.onPool })}
                    title="On the tip pool"
                    className={`w-[30px] h-[18px] rounded-full relative shrink-0 ${p.onPool ? 'bg-green' : 'bg-line-2'}`}
                  >
                    <span className={`absolute top-0.5 w-3.5 h-3.5 bg-paper rounded-full shadow-sm transition-all ${p.onPool ? 'left-3.5' : 'left-0.5'}`} />
                  </button>
                </span>
                <span />
              </div>
            )
          })}
        </div>
        <div className="mt-[18px] font-mono text-[10.5px] text-ink-3 flex justify-between">
          <span>Codes match the POS employee number · wage is reference only, it never affects the split</span>
          <span>Cap = contracted shift length, blank = uncapped · toggle off to keep someone on the roster but out of the pool</span>
        </div>
      </div>

      {/* ── rail ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3.5">
        {/* THE SALES SCOPE PICKER */}
        <div className="bg-paper border border-line rounded-xl p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Which sales fund this pool</h3>
          <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">
            deliberately separate from the crew&rsquo;s own revenue center · sets both the sales and the tips the pool reads
          </p>

          <div className="rounded-md bg-bg-2 px-3 py-2.5 mb-3.5 text-[12.5px] text-ink-2 leading-[1.5]">
            Tips for <b className="font-semibold text-ink">{poolRc?.name ?? payload.period.revenueCenterName}</b>.
            Pool funded by <b className="font-semibold text-gold-2">{settings.salesScopeLabel}</b>,
            sized as <b className="font-semibold text-ink">{settings.poolRatePct}% of {settings.poolBasis === 'TIPS_COLLECTED' ? 'the tips collected' : 'net sales'}</b>.
          </div>

          <div className="flex items-center justify-between gap-2.5 py-[9px] border-b border-line">
            <span className="text-[13px] text-ink-2">Basis<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">where the net sales come from</small></span>
            <select
              value={settings.salesSourceMode}
              disabled={readOnly}
              onChange={e => onSaveSettings({ salesSourceMode: e.target.value as 'LOCATION' | 'RC' })}
              className="font-mono text-[11px] border border-line bg-paper rounded px-2.5 py-1.5 text-ink-2 cursor-pointer outline-none hover:border-ink-3"
            >
              <option value="LOCATION">A whole location</option>
              <option value="RC">Chosen revenue centers</option>
            </select>
          </div>

          {settings.salesSourceMode === 'LOCATION' ? (
            <div className="flex items-center justify-between gap-2.5 py-[9px] border-b border-line">
              <span className="text-[13px] text-ink-2">Location<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">every active RC underneath it</small></span>
              <select
                value={settings.salesLocationId ?? ''}
                disabled={readOnly}
                onChange={e => onSaveSettings({ salesLocationId: e.target.value || null })}
                className="font-mono text-[11px] border border-line bg-paper rounded px-2.5 py-1.5 text-ink-2 cursor-pointer outline-none hover:border-ink-3 max-w-[170px]"
              >
                <option value="">— pick a location</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="py-[9px] border-b border-line">
              <span className="text-[13px] text-ink-2 block mb-2">Revenue centers<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">tick every one whose sales fund the pool</small></span>
              <div className="flex flex-col gap-1 max-h-[180px] overflow-y-auto">
                {revenueCenters.map(rc => {
                  const on = settings.salesRcIds.includes(rc.id)
                  return (
                    <label key={rc.id} className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer">
                      <input
                        type="checkbox" checked={on} disabled={readOnly}
                        onChange={() => onSaveSettings({
                          salesRcIds: on ? settings.salesRcIds.filter(id => id !== rc.id) : [...settings.salesRcIds, rc.id],
                        })}
                        className="accent-gold"
                      />
                      {rc.name}
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2.5 py-[9px]">
            <span className="text-[13px] text-ink-2">Crew&rsquo;s revenue center<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">where new periods are opened</small></span>
            <select
              value={settings.poolRevenueCenterId ?? ''}
              disabled={readOnly}
              onChange={e => onSaveSettings({ poolRevenueCenterId: e.target.value || null })}
              className="font-mono text-[11px] border border-line bg-paper rounded px-2.5 py-1.5 text-ink-2 cursor-pointer outline-none hover:border-ink-3 max-w-[170px]"
            >
              <option value="">— pick a revenue center</option>
              {revenueCenters.map(rc => <option key={rc.id} value={rc.id}>{rc.name}</option>)}
            </select>
          </div>
        </div>

        {/* roles & multipliers */}
        <div className="bg-paper border border-line rounded-xl p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Roles &amp; multipliers</h3>
          <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">every hour is weighted by the person&rsquo;s role before the day pool is divided</p>
          {payload.roles.map((r: TipRoleDef) => (
            <div key={r.id} className="grid grid-cols-[1fr_76px_26px_24px] gap-2 items-center py-[5px] border-b border-line last:border-b-0">
              <input
                defaultValue={r.name} placeholder="Role name" disabled={readOnly}
                onBlur={e => onSaveRole(r.id, { name: e.target.value })}
                className="text-[13px] bg-transparent border border-transparent rounded-md px-[7px] py-[5px] outline-none hover:border-line focus:border-gold focus:bg-paper"
              />
              <span className="flex items-center gap-0.5 font-mono text-[11px] text-ink-4 border border-line rounded-md px-1.5 py-[3px] bg-paper focus-within:border-gold">
                ×<input
                  type="number" step="0.05" min="0" max="5" defaultValue={r.multiplier} disabled={readOnly}
                  onBlur={e => onSaveRole(r.id, { multiplier: parseFloat(e.target.value) })}
                  className="w-full font-mono text-[12px] font-semibold bg-transparent border-none outline-none text-right text-ink [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
              </span>
              <span className="font-mono text-[10.5px] text-ink-4 text-right">{usage.get(r.id) ?? 0}</span>
              <button
                onClick={() => onDeleteRole(r.id)} disabled={readOnly || payload.roles.length < 2} title="Delete role"
                className="w-6 h-6 rounded-md text-ink-4 text-[15px] leading-none grid place-items-center hover:bg-red-soft hover:text-red-text disabled:opacity-30"
              >×</button>
            </div>
          ))}
          <div className="flex justify-between items-center mt-3 gap-2.5">
            <span className="font-mono text-[10.5px] text-ink-4">
              {payload.roles.length} roles · {payload.roster.filter(p => p.onPool).length} on pool
            </span>
            <button onClick={onAddRole} disabled={readOnly} className="font-mono text-[10.5px] text-ink-3 border border-dashed border-line-2 rounded-full px-2.5 py-1 hover:border-gold hover:text-gold-2 disabled:opacity-40">
              ＋ Add role
            </button>
          </div>
        </div>

        {/* pool rules */}
        <div className="bg-paper border border-line rounded-xl p-5">
          <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Pool rules</h3>
          <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">defaults applied to every new period</p>

          {/* THE POOL BASIS. Front of house keeps the customer's tips; the
              kitchen pool is a withdrawal from that pot. This picks how the
              withdrawal is sized — off sales, or off the pot itself. */}
          <div className="flex items-center justify-between gap-2.5 py-[9px] border-b border-line">
            <span className="text-[13px] text-ink-2">
              Pool basis
              <small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">what the rate is a percentage of</small>
            </span>
            <select
              value={settings.poolBasis}
              disabled={readOnly}
              onChange={e => onSaveSettings({ poolBasis: e.target.value as TipSettingsDto['poolBasis'] })}
              className="font-mono text-[11px] border border-line bg-paper rounded px-2.5 py-1.5 text-ink-2 cursor-pointer outline-none hover:border-ink-3"
            >
              <option value="NET_SALES">Net sales</option>
              <option value="TIPS_COLLECTED">Tips collected</option>
            </select>
          </div>
          <p className="font-mono text-[9.5px] text-ink-4 leading-[1.5] pb-2 border-b border-line">
            {settings.poolBasis === 'TIPS_COLLECTED'
              ? 'The kitchen takes this share of the tips customers actually left. The tip-out can never outrun the pot.'
              : 'The kitchen pool is sized off sales and drawn out of the front-of-house tip pot. Watch the tip-out % on the Split tab — a slow tipping week can leave the pool larger than the pot.'}
          </p>

          <div className="flex items-center justify-between gap-2.5 py-[9px] border-b border-line">
            <span className="text-[13px] text-ink-2">
              Auto-gratuity counts as tips
              <small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">service charges flagged as gratuity in Toast</small>
            </span>
            <button
              disabled={readOnly}
              onClick={() => onSaveSettings({ includeAutoGratuity: !settings.includeAutoGratuity })}
              className={`w-[30px] h-[18px] rounded-full relative shrink-0 ${settings.includeAutoGratuity ? 'bg-green' : 'bg-line-2'}`}
              aria-label="Count auto-gratuity as tips"
            >
              <span className={`absolute top-0.5 w-3.5 h-3.5 bg-paper rounded-full shadow-sm transition-all ${settings.includeAutoGratuity ? 'left-3.5' : 'left-0.5'}`} />
            </button>
          </div>

          <NumberRow
            label="Pool rate"
            hint={settings.poolBasis === 'TIPS_COLLECTED' ? 'share of the tip pot' : 'share of net sales'}
            suffix="%"
            value={settings.poolRatePct} step={0.5} min={0}
            max={settings.poolBasis === 'TIPS_COLLECTED' ? 100 : 15}
            readOnly={readOnly}
            onCommit={v => onSaveSettings({ poolRatePct: v ?? 0 })}
          />
          <NumberRow
            label="Default shift cap"
            hint="prefill for new people only — each person's cap lives on their row"
            suffix="h"
            value={settings.defaultDailyHourCap} step={0.5} min={1} max={16} readOnly={readOnly}
            onCommit={v => onSaveSettings({ defaultDailyHourCap: v })}
          />
          <RewardTiers tiers={settings.rewardTiers} readOnly={readOnly} onChange={t => onSaveSettings({ rewardTiers: t })} />
        </div>
      </div>
    </div>
  )
}

function NumberRow({
  label, hint, suffix, value, step, min, max, readOnly, onCommit,
}: {
  label: string; hint: string; suffix: string
  value: number | null; step: number; min: number; max: number; readOnly: boolean
  onCommit: (v: number | null) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2.5 py-[9px] border-b border-line last:border-b-0">
      <span className="text-[13px] text-ink-2">{label}<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">{hint}</small></span>
      <span className="inline-flex items-center gap-[3px] font-mono text-[11px] text-ink-4 border border-line rounded-md px-2 py-1 bg-paper focus-within:border-gold">
        <input
          type="number" step={step} min={min} max={max} defaultValue={value ?? ''} placeholder="—" disabled={readOnly}
          onBlur={e => {
            const v = parseFloat(e.target.value)
            onCommit(isFinite(v) ? v : null)
          }}
          className="w-11 font-mono text-[12.5px] font-semibold bg-transparent border-none outline-none text-right text-ink [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        {suffix}
      </span>
    </div>
  )
}

function RewardTiers({
  tiers, readOnly, onChange,
}: { tiers: number[]; readOnly: boolean; onChange: (tiers: number[]) => void }) {
  const [draft, setDraft] = useState(tiers)
  const commit = (next: number[]) => {
    const clean = [...new Set(next.filter(n => isFinite(n) && n > 1))].sort((a, b) => a - b)
    setDraft(clean); onChange(clean)
  }
  return (
    <div className="flex flex-col items-start gap-2 py-[9px]">
      <span className="text-[13px] text-ink-2">Reward multipliers<small className="block font-mono text-[9.5px] text-ink-4 mt-0.5">offered on each day in the person detail</small></span>
      <span className="flex flex-wrap gap-1.5 items-center">
        {draft.map((t, i) => (
          <span key={i} className="inline-flex items-center gap-px font-mono text-[11px] text-gold-2 bg-gold-soft rounded-full pl-[9px] pr-[5px] py-[3px] font-semibold">
            ×<input
              type="number" step="0.05" min="1" max="5" defaultValue={t} disabled={readOnly}
              onBlur={e => commit(draft.map((v, k) => (k === i ? parseFloat(e.target.value) : v)))}
              className="w-[34px] font-mono text-[11.5px] font-semibold bg-transparent border-none outline-none text-gold-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <button disabled={readOnly} onClick={() => commit(draft.filter((_, k) => k !== i))} className="w-4 h-4 text-[12px] leading-none grid place-items-center rounded hover:bg-paper/70">×</button>
          </span>
        ))}
      </span>
      <button
        disabled={readOnly || draft.length >= 5}
        onClick={() => commit([...draft, Math.round((Math.max(1, ...draft) + 0.25) * 100) / 100])}
        className="font-mono text-[10.5px] text-ink-3 border border-dashed border-line-2 rounded-full px-2.5 py-1 hover:border-gold hover:text-gold-2 disabled:opacity-40"
      >
        ＋ Add tier
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Mount the tab and fetch the lookups**

In `src/app/tips/page.tsx`, add:

```tsx
import { SettingsTab, type LookupOption, type TipSettingsDto } from '@/components/tips/SettingsTab'
```

Add state and a loader beside the existing ones:

```tsx
  const [settings, setSettings] = useState<TipSettingsDto | null>(null)
  const [locations, setLocations] = useState<LookupOption[]>([])
  const [revenueCenters, setRevenueCenters] = useState<LookupOption[]>([])

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/tips/settings', { cache: 'no-store' })
    if (res.ok) setSettings(await res.json())
  }, [])

  useEffect(() => {
    void loadSettings()
    ;(async () => {
      const [locRes, rcRes] = await Promise.all([
        fetch('/api/locations', { cache: 'no-store' }),
        fetch('/api/revenue-centers', { cache: 'no-store' }),
      ])
      // Unwrap if either endpoint returns { locations } / { revenueCenters }.
      const unwrap = (j: unknown, key: string): LookupOption[] =>
        Array.isArray(j) ? (j as LookupOption[]) : ((j as Record<string, LookupOption[]>)?.[key] ?? [])
      if (locRes.ok) setLocations(unwrap(await locRes.json(), 'locations'))
      if (rcRes.ok) setRevenueCenters(unwrap(await rcRes.json(), 'revenueCenters'))
    })()
  }, [loadSettings])
```

Update `saveSettings` (added in Task 11) to refresh the settings DTO too:

```tsx
  const saveSettings = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true)
    const res = await fetch('/api/tips/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (res.ok) setSettings(await res.json())
    else setError((await res.json()).error ?? 'Could not save settings')
    if (periodId) await loadPeriod(periodId)
    setBusy(false)
  }, [periodId, loadPeriod])
```

Replace the settings placeholder with:

```tsx
        {tab === 'settings' && settings && (
          <SettingsTab
            payload={payload} split={split} settings={settings}
            locations={locations} revenueCenters={revenueCenters} readOnly={readOnly}
            onSaveSettings={patch => void saveSettings(patch as Record<string, unknown>)}
            onSaveRole={(id, patch) => {
              void fetch(`/api/tips/roles/${id}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
              }).then(() => periodId && loadPeriod(periodId))
            }}
            onAddRole={() => {
              void fetch('/api/tips/roles', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'New role', multiplier: 1 }),
              }).then(() => periodId && loadPeriod(periodId))
            }}
            onDeleteRole={id => {
              void fetch(`/api/tips/roles/${id}`, { method: 'DELETE' })
                .then(async r => { if (!r.ok) setError((await r.json()).error ?? 'Could not delete that role') })
                .then(() => periodId && loadPeriod(periodId))
            }}
            onSaveRoster={(cookId, patch) => {
              void fetch(`/api/tips/roster/${cookId}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
              }).then(async r => { if (!r.ok) setError((await r.json()).error ?? 'Could not save that change') })
                .then(() => periodId && loadPeriod(periodId))
            }}
            onAddEmployee={() => setError('Add new kitchen staff in Setup → Kitchen crew, then give them a clock ID here.')}
          />
        )}
```

> `onAddEmployee` deliberately points at `/setup/kitchen-crew`: creating a cook from scratch (name + initials + station) is an ADMIN action on the shared prep roster. The Checks tab's **Add to roster** action is the MANAGER path, and it only fires for a clock ID that actually appears in the imported file.

- [ ] **Step 4: Verify the scope really is independent, and that caps are individual**

In the browser: **Tip settings** → set one person's **Cap** to 8 and another's to 10, then check the Split tab pays each of them to their own cap on a 12-hour day (8.00 and 10.00 in the Hours column, not 8 and 8). Blank one of them and confirm they go back to their full clocked hours. Then → set the sales *Basis* to **A whole location** and pick the Cafe location, while *Crew's revenue center* stays on Kitchen. The summary line must read `Tips for Kitchen. Pool funded by Cafe · all revenue centers, sized as 5% of net sales.` Switch to **Daily pools** and confirm the per-day sales now reflect every RC under Cafe, not just Kitchen. Then flip the scope to **Chosen revenue centers**, tick only Kitchen, and confirm the daily numbers drop. Check `read_console_messages` for errors and screenshot the settings rail.

- [ ] **Step 5: Verify the two pool bases against each other**

Still on **Tip settings**, with a period that has tip data:

1. Leave *Pool basis* on **Net sales** at 5%. Note the pool total and the `TIP-OUT TO KITCHEN` KPI — say `$6,239` and `31%`.
2. Switch *Pool basis* to **Tips collected** and set the rate to that same `31`. The pool total must land within a few dollars of step 1, and the tip-out KPI must read ~`31%`. That is the same withdrawal expressed two ways, and is the clearest proof the wiring is right.
3. Push the sales-based rate up until the pool exceeds the tip pot. The Checks tab must raise the blocking `overdraw` error and **Mark period paid** must refuse with it.
4. Toggle *Auto-gratuity counts as tips* off and confirm the tip pot drops by the gratuity total **without** a Toast re-sync — that is the whole reason the two columns are stored separately.

- [ ] **Step 6: Commit**

```bash
git add src/components/tips/SettingsTab.tsx src/app/tips/page.tsx && git commit -m "feat(tips): tip settings — roster, roles, pool basis and the sales scope picker"
```

---

### Task 14: Navigation, route gating, and docs

**Files:**
- Modify: `src/components/Navigation.tsx`, `src/middleware.ts`, `src/app/setup/page.tsx`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `/tips` reachable from the sidebar for MANAGER+, blocked in middleware for anyone below.

- [ ] **Step 1: Add the nav group**

In `src/components/Navigation.tsx`, import `Banknote` from `lucide-react` alongside the other icons, then insert a new group between the `INBOX` and `LIBRARY` groups:

```tsx
  {
    label: 'TEAM',
    items: [
      { href: '/tips', label: 'Tip payouts', icon: Banknote, minRole: 'MANAGER' },
    ],
  },
```

- [ ] **Step 2: Gate the route**

In `src/middleware.ts`, change line 13:

```ts
const MANAGER_PREFIXES = ['/reports', '/pass', '/cost', '/variance', '/signals', '/tips']
```

- [ ] **Step 3: Add the setup card**

In `src/app/setup/page.tsx`, import `Banknote` and add to the `cards` array after the kitchen-crew entry:

```tsx
  { href: '/tips',                  label: 'Tip payouts',      icon: Banknote, description: 'Pool rate, role multipliers, and which sales fund the pool.', built: true },
```

- [ ] **Step 4: Document the subsystem**

In `CLAUDE.md`, add a row to the **Page → API map** table after the `/sales` row:

```markdown
| `/tips` (MANAGER+) | `/api/tips/{settings,roles,roster,periods}` — periods, punches, split, envelopes |
```

Then add to **Other subsystems**:

```markdown
- **Tip payouts** — `/tips`: a persisted 14-day kitchen tip pool. `TipPeriod` owns the run (basis, rate, cap, rounding, imported `TipPunch` rows, `TipDayAdjustment` overrides, and a frozen `snapshot` once PAID). The roster is `Cook` extended with `clockId` / `wage` / `tipRoleId` / `onTipPool` — hours match on `clockId` only, never on name. **Two things are configurable and deliberately independent of each other and of `TipPeriod.revenueCenterId`:** the *scope* (`TipSettings.salesSourceMode` LOCATION | RC — a Kitchen pool is normally funded by the whole Cafe location) and the *basis* (`poolBasis` NET_SALES | TIPS_COLLECTED — the kitchen pool is a withdrawal from the FOH tip pot, sized either off sales or off the pot itself). A workbook import overrides individual days. All split maths and the reconciliation live in pure libs (`src/lib/tips/{engine,audit,period}.ts`, covered by `npm test`) so the page recomputes in the browser as the rate changes; the server re-runs the same functions via `src/lib/tips/build.ts` to freeze a payment and build the export. **A period with unresolved audit errors cannot be marked paid** — including `overdraw`, raised when a sales-sized pool exceeds the tips customers actually left.
- **Customer tips on sales** — `SalesEntry.tipsCollected` (payment tips) and `.autoGratuity` (service charges flagged `gratuity`) are written by the Toast sync from `Check.payments[].tipAmount` and `Check.appliedServiceCharges[]`, which were always in the `ordersBulk` response and simply not modelled. **Both are nullable on purpose: `null` = no tip data, `0` = genuinely no tips**, and the tip payout treats the two very differently. They are stored separately so `TipSettings.includeAutoGratuity` can be flipped at read time without a re-sync. A tip belongs to the *check*, so it is apportioned across revenue centers by that check's routed revenue (`checkTipTotals` in `src/lib/toast/client.ts`); anything unattributable is logged, never dropped.
```

- [ ] **Step 5: Full verification**

```bash
npm test && npm run lint && npm run build 2>&1 | tail -40
```

Expected: all vitest suites pass; ESLint clean; build succeeds with every `/api/tips/*` route listed as `ƒ (Dynamic)` and `/tips` listed as a route.

Then in the browser, log in as a STAFF user (or temporarily drop your role) and confirm `/tips` redirects rather than rendering, and that `Tip payouts` is absent from the sidebar.

- [ ] **Step 6: Commit**

```bash
git add src/components/Navigation.tsx src/middleware.ts src/app/setup/page.tsx CLAUDE.md && git commit -m "feat(tips): sidebar entry, MANAGER gating, setup card and docs"
```

---

## Self-Review

**Spec coverage — every element of `app/Tips.html` mapped to a task:**

| Mock element | Task |
|---|---|
| `.cost-chrome` strip (period / net sales / pool rate / kitchen pool) | 10 |
| Header: period stepper, `#rate-in`, `#balance-pill`, Export, Mark paid | 10 (period stepper → see gap below) |
| KPI row (`#k-pool` hero, team, weighted hours, avg rate) | 10 |
| Split tab: sortable header, day strip, role pill, share bar, footer totals | 10 |
| `.detail` expanded person panel (2 weeks, hour inputs, reward tiers) | 10 |
| `#alert-bar` top-3 findings | 10 |
| `#cap-in` daily cap, `#reset-hours` | 10 |
| Daily pools tab (`#daygrid`, peak card, `#days-total`) | 11 |
| Cash tab (`#envs`, `#round-seg`, `#bk-rows`, `#drift`) | 11 |
| Checks tab (`#find-rows`, `#ledger-rows`, `#src-rows`, tab badge) | 12 |
| Import tab (two drop zones, messages, pills) | 12 |
| Settings tab (roster table, roles, pool rules, reward tiers) | 13 |
| `tips-audit.js` findings + fix actions | 4, 12 |
| `tips-xlsx.js` workbook reading | 5 |
| `shell.js` sidebar entry (`Tip payouts`, `cash` icon) | 14 |
| `styles.css` tokens | Global Constraints (all already in `tailwind.config.ts`) |

**Beyond the mock — the pool basis and the FOH tip pot:**

| Requirement | Task |
|---|---|
| `poolBasis` NET_SALES \| TIPS_COLLECTED, frozen onto the period at open | 1, 8 |
| Engine takes a `basis` series and does not know which it is | 3 |
| Audit names the basis, blocks on a missing basis figure, reports the tip-out | 4 |
| `SalesEntry.tipsCollected` + `.autoGratuity`, both nullable | 1 |
| Tips pulled from Toast (`Check.payments[].tipAmount`, gratuity service charges) | 6A |
| Tips apportioned across revenue centers by each check's routed revenue | 6A |
| Manual sales entry can carry tips | 6A |
| Tips read through the same configurable scope as sales | 6 |
| `includeAutoGratuity` applied at read time, no re-sync needed | 6, 7, 13 |
| Basis selector in the page header + in Tip settings | 10, 13 |
| Tip-out %, FOH remainder, and the `overdraw` block | 4, 10 |
| Tips column read from the Sales Summary workbook when present | 5, 9 |
| Basis and tip figures in the payroll export and the frozen snapshot | 9 |

**Known gaps, deliberately deferred — do not treat as oversights:**

1. **Period navigation (`‹ ›` stepper).** Task 10 loads the most recent period and Task 8 exposes `previousPeriodStart`/`nextPeriodStart` and the period list, but the page has no stepper UI yet. Add it as a follow-up: two buttons calling `POST /api/tips/periods` with the stepped `startDate`, then `loadPeriod` on the returned id. Everything it needs already exists.
2. **Paste-instead-of-drop fallback** (`<details class="pastewrap">` in the mock). Dropped: the workbook path covers the real flow, and a paste parser is a second, untested ingestion route into payroll numbers.
3. **`posMap` editing UI.** The column is written and read (Task 7's roster POST maps a clock Position to a role), but there is no editor. New people fall back to the last role, which the Checks tab flags as reviewable.
4. **Mobile.** `/tips` renders a "desktop only" card below `md`. The mock has no mobile design to port.

**Placeholder scan:** clean — every step carries the code or the exact command. Two steps intentionally ask the implementer to *check and adapt* rather than assume: Task 6 Step 4 (the `server-only` alias in vitest, only if the import fails) and Task 13 Step 1 (unwrapping `/api/locations` if it returns an object). Both state the expected shape and the fallback.

**Type consistency:** `TipPerson.cookId` is the person key everywhere (never `id`); `SplitPerson.envelopeCents` is cents everywhere (never dollars); `FindingAction.kind` values are exactly `addPerson | ignoreCode | onPool | setCode | goto` in `audit.ts` (Task 4), the page's `applyFix` (Task 10), and `ChecksTab` (Task 12); `effectiveHours(person, day)` takes exactly two arguments in `engine.ts`, `audit.ts`, `kit.tsx` and `SplitTab.tsx` — if you find yourself passing a cap, the cap is in the wrong place. `loadSettings` is a server helper exported from `src/app/api/tips/settings/route.ts` **and** a client callback name inside `page.tsx` — different modules, no collision, but do not import one into the other.

**Basis naming, checked end to end.** `SplitInput.basis` (Task 3) — **not** `sales`; the field was deliberately renamed so nothing can accidentally feed net sales to a tips-based period. `AuditInput` carries all four of `basis`, `poolBasis`, `sales` and `tipsCollected`, because the tip-out findings need the pot even when the pool is sized off sales. The missing-day list is `missingBasisDays` everywhere (Tasks 4, 8, 9, 10) — the old `missingSalesDays` name survives **only** inside `sales.ts` as one half of `DailyTotals`, alongside `missingTipDays`. Finding ids renamed with it: `nosales` → `nobasis`, `zerosales` → `zerobasis`; the new ones are `overdraw`, `bigtakeout`, `takeout`, `notips`.

**Two signals, one block.** Gold means *rewarded*, red means *capped*, and they are independent — a day can be both, so nothing may collapse them into a precedence chain. `DayStrip` renders a both-day as two half-height children (gold over red) inside one bordered box; the person-detail card carries the same pair as a split left rail. `DayStripLegend` is the single source of the wording — if the colours ever change, change them there, not in prose. Deliberate deviation from the mock: `tips.js` wrote `cls = rw ? 'on rw' : capped ? 'on cap' : 'on'`, so a rewarded-and-capped day rendered pure gold and the withheld hours were invisible.

**Cap naming, checked end to end.** The live cap is `Cook.dailyHourCap` → `TipPerson.dailyHourCap` → `SplitPerson.dailyHourCap` (inherited), which is what makes a PAID period's `snapshot` record each person's cap at the moment they were paid. `TipSettings.defaultDailyHourCap` is the prefill and is **the only place the word "default" appears** — it is never read during a split. `TipPeriod` has no cap column at all; if a task references `period.dailyHourCap`, that task is stale. The Split toolbar's cap control was replaced by the read-only `capSummary()` string, and editing moved to two places that both PATCH `/api/tips/roster/[id]`: the person detail on the Split tab, and the Cap column in the Tip settings roster.

**One trap worth stating plainly:** `tipsCollected` is `Array<number | null>`, not `number[]`. A `null` day means the app has no tip data; a `0` day means the customers left nothing. Collapsing them with `?? 0` at the wrong layer silently turns "we don't know" into "nobody tipped", which is exactly the failure the nullable column exists to prevent. The only legitimate `?? 0` is in `selectBasis` / the payload's `basis` construction, where the day is *already* recorded in `missingBasisDays` and will raise a blocking error.

**One resolver, two callers.** `resolveRoster` in `src/lib/tips/roster.ts` (Task 8) is the only place clock punches and per-day adjustments become a `TipPerson[]`. Both the page payload route and `build.ts`'s freeze/export path import it. Do not inline a second copy: the page's numbers and the numbers frozen at payment must come from the same fold, or a drift between them changes what people are paid without anything failing.

