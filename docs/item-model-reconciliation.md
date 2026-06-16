# Item-Model Branch Reconciliation & Column-Drop Guide

**Context:** `feat/item-model-redesign` (Tasks 1–14 done) carries a `schema.prisma` that is **behind the live Supabase DB**. Before dropping the legacy pricing columns (Tasks 15–17) the branch must be reconciled so `schema.prisma` reflects reality — otherwise a full-schema `prisma migrate diff` generates destructive DROPs against objects this branch's schema doesn't know about.

## The actual state (diagnosed 2026-06-16)

| Object in the **live DB** | In `main`? | In which branch? |
|---|---|---|
| `InventoryItem.isStocked` | ❌ | `feat/rc-partitioned-theoretical-stock` (PR #9) |
| `revenueCenterId` NOT NULL (PrepLog/SalesEntry/WastageLog) | ❌ | `feat/rc-partitioned-theoretical-stock` |
| `Toast*` tables, `toastGuid`, `SalesEntry.source` | ❌ | `feat/toast-integration` |
| `InventoryItem.dimension/packChain/pricing/countUnit` | ❌ | `feat/item-model-redesign` (this work — already applied to DB) |

**The DB = `main` + `rc-partitioned` migrations + `toast` migrations + this branch's additive migration.** No single branch's `schema.prisma` matches the DB. `feat/item-model-redesign` is **local-only** (not pushed).

## ⛔ Hard rules

- **Never run full-schema `prisma migrate diff` / `prisma migrate dev`** on this branch — it will emit `DROP`s for `isStocked`, `Toast*`, etc. to "rewind" the DB to the stale schema.
- **Hand-author every migration** and grep the SQL for `drop|delete|truncate` (on non-comment lines) before `prisma db execute`.
- **Snapshot before any data/column change.** The pre-backfill snapshot is at `ppb-snapshot-pre-backfill.json` (gitignored).

---

## Choose a reconciliation path

### Path A — Land the upstream branches to `main`, then rebase (RECOMMENDED for a clean history)

Use this if you intend to merge `rc-partitioned-theoretical-stock` and `toast-integration` anyway (their migrations are already in prod, so they *should* land). This yields a `schema.prisma` with proper Prisma relation names / `@map` / comments — `db pull` cannot reproduce those.

```bash
# 1. Get main to match the DB by merging the already-applied branches.
git checkout main && git pull
git merge --no-ff feat/rc-partitioned-theoretical-stock   # PR #9: isStocked + RC NOT NULL
git merge --no-ff feat/toast-integration                  # Toast tables/columns
#   Resolve any conflicts; do NOT run migrate dev — the DB already has these.
#   Mark their migrations applied if not tracked:
#     npx prisma migrate resolve --applied <each pending migration dir>

# 2. Rebase the item-model work onto the now-current main.
git checkout feat/item-model-redesign
git rebase main
#   Expect conflicts in prisma/schema.prisma (your 4 chain columns + Dimension enum
#   vs the incoming isStocked/Toast lines). KEEP BOTH — your additive lines AND theirs.
#   Also reconcile any reader/route files both sides touched.

# 3. Regenerate + verify nothing moved.
npx prisma generate
npm run build
npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/verify-item-model-parity.ts   # must print OK — 422 items match
```

After Path A, `schema.prisma` should contain: the legacy pricing columns, the 4 new chain columns, `isStocked`, the `Toast*` models, and the RC NOT-NULL constraints — matching the DB. Verify with the drift check in "Sanity check" below.

### Path B — `prisma db pull` (FAST, pragmatic; lossy on Prisma niceties)

Use this if you do NOT want to coordinate the other branches right now and just need this branch's schema to tell the truth so you can proceed to the drop.

```bash
git checkout feat/item-model-redesign

# 1. Back up the current schema (it has your hand-written comments).
cp prisma/schema.prisma prisma/schema.prisma.bak

# 2. Introspect the live DB into schema.prisma.
npx prisma db pull        # rewrites schema.prisma from the DB (includes isStocked,
                          # Toast*, your chain columns, RC NOT-NULL — everything)

# 3. REVIEW THE DIFF carefully — db pull renames implicit relations and drops @map/comments.
git diff prisma/schema.prisma
#   Re-add: the `Dimension` enum doc-comment, any @relation names that got renamed to
#   generic ones, and any @default you rely on. Cross-check against schema.prisma.bak.

# 4. Regenerate + verify.
npx prisma generate
npm run build
npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/verify-item-model-parity.ts
rm prisma/schema.prisma.bak   # once satisfied
```

**Caveat:** `db pull` will not re-create the `prisma/migrations` history; it only rewrites the model. That's fine here because migrations are already managed via the hand-authored `db execute` / `migrate resolve` workaround.

### Sanity check (after EITHER path) — schema now matches DB, additively

```bash
# This diff should now show NO changes (schema == DB). If it lists ADD COLUMNs you
# forgot to keep, re-add them; if it lists DROPs, your schema is STILL behind — stop.
npx prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource  prisma/schema.prisma \
  --script
```

---

## Then: Tasks 15–17 — remove dual-writes and DROP the columns

Only after reconciliation + a green parity check.

### 15. Remove dead writes & helpers
- In `inventory/route.ts`, `[id]/route.ts`, `approve/route.ts`, `inventory-import.ts`: delete the legacy field writes (`pricePerBaseUnit`, `conversionFactor`, `qtyUOM`, `innerQty`, `packSize`, `packUOM`, `priceType`, `qtyPerPurchaseUnit`, `purchaseUnit`, `countUOM`) — keep only the chain writes (`dimension/packChain/pricing/countUnit`) plus `baseUnit`.
- Delete now-unused helpers in `src/lib/utils.ts`: `calcPricePerBaseUnit`, `calcConversionFactor`, `deriveBaseUnit`. Keep `getUnitConv`, `getUnitDimension`, `isMeasuredUnit`, `compatibleCountUnits`, `priceDisplayScale`, `formatPricePerBase`.
- Delete the dead `editMode`/`editForm`/`handleSave` block in `src/app/inventory/page.tsx` (~lines 258, 558–598).
- `grep -rn "calcPricePerBaseUnit\|calcConversionFactor\|deriveBaseUnit" src/` → only the deleted-helper call sites should remain (fix them). `npm run build`.

### 16. Snapshot, then hand-author the DROP migration
```bash
# a. Snapshot ppb per item BEFORE dropping (so parity can be re-checked post-drop).
#    (Re-use the snapshot approach already in git history / ppb-snapshot-pre-backfill.json.)

# b. Hand-write the migration SQL — ONLY these columns, nothing else:
cat > prisma/migrations/<ts>_item_model_drop/migration.sql <<'SQL'
ALTER TABLE "InventoryItem"
  DROP COLUMN "pricePerBaseUnit",
  DROP COLUMN "conversionFactor",
  DROP COLUMN "qtyPerPurchaseUnit",
  DROP COLUMN "qtyUOM",
  DROP COLUMN "innerQty",
  DROP COLUMN "packSize",
  DROP COLUMN "packUOM",
  DROP COLUMN "priceType",
  DROP COLUMN "purchaseUnit",
  DROP COLUMN "countUOM";
-- KEEP: baseUnit, dimension, packChain, pricing, countUnit, stockOnHand, needsReview, purchasePrice?*
SQL

# c. Inspect (must list ONLY the InventoryItem columns above):
grep -iE "drop|alter" prisma/migrations/<ts>_item_model_drop/migration.sql

# d. Apply + record.
npx prisma db execute --file prisma/migrations/<ts>_item_model_drop/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied <ts>_item_model_drop
```
*`purchasePrice`: decide whether to keep it (a few price-alert/supplier readers may still read it) or move fully into `pricing.purchasePrice` — confirm with a grep before dropping it. The parity verifier reads `pricePerBaseUnit`, so update or retire it after this step (compare against the snapshot JSON instead).

Then remove the dropped columns from `prisma/schema.prisma`, `npx prisma generate`, `npm run build`.

### 17. Retire obsolete scripts
`git rm` the repair/audit scripts the design marks obsolete (corruption is now structurally impossible): `repair-pricing-corruption.ts`, `repair-baseunit-normalize.ts`, `repair-count-baseunit.ts`, `repair-count-uom.ts`, `normalize-stored-uom.ts`, `test-pricing-fix.ts`, and the `repair-prices` route (already a no-op). Leave stock/allocation scripts. `npm run build`.

---

## Don't forget
- **Push the branch / open a PR** — `feat/item-model-redesign` is currently local-only.
- The **`ItemOffer[]` multi-supplier model is deferred** (a separate follow-up); `InventorySupplierPrice` and its `pricePerBaseUnit` column are intentionally untouched.
