# Supplier Alias Matching & Self-Learning Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the suppliers page showing no spend/invoice data by introducing a `SupplierAlias` table that maps OCR-extracted invoice supplier names to `Supplier` records, with a self-learning mechanism that builds aliases whenever the user manually assigns an invoice to a supplier.

---

## Problem

`InvoiceSession.supplierName` holds the raw OCR string (e.g. `"ACECARD FOOD GROUP LTD"`). `InvoiceSession.supplierId` is a nullable FK. The suppliers page aggregates spend by `supplierId` — so any session where `supplierId` is null contributes nothing. Since user-entered supplier names (e.g. `"Acecard"`) never exactly match OCR strings, `supplierId` stays null and the page shows zeros.

---

## Architecture

### New model: `SupplierAlias`

```prisma
model SupplierAlias {
  id         String   @id @default(cuid())
  supplierId String
  supplier   Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  name       String   // OCR-extracted string, e.g. "ACECARD FOOD GROUP LTD"
  createdAt  DateTime @default(now())

  @@unique([supplierId, name])
}
```

Add `aliases SupplierAlias[]` relation to `Supplier`.

`Supplier.name` is **unchanged** — it remains the user's preferred display label (e.g. "Legends Haul"). Aliases are the invoice-side names that map to it. A supplier can have many aliases.

---

### Shared lib: `src/lib/supplier-matcher.ts` (new)

Two functions only:

```ts
// Case-insensitive lookup. Returns supplierId or null.
matchSupplierByName(invoiceName: string): Promise<string | null>

// Upserts (supplierId, invoiceName) into SupplierAlias. No-op on blank/null name.
learnAlias(supplierId: string, invoiceName: string): Promise<void>
```

---

### Auto-link on OCR

After OCR completes and writes `supplierName` to the session (in `sessions/[id]/process/route.ts`), immediately call `matchSupplierByName(supplierName)`. If found, write `supplierId` to the session in the same update. Result: zero user effort for known suppliers.

---

### Learn on manual assignment

When the user selects or changes a supplier in the invoice review drawer:

1. `PATCH /api/invoices/sessions/[id]` accepts `{ supplierId: string }`.
2. Route updates `session.supplierId`.
3. Route calls `learnAlias(supplierId, session.supplierName)`.

Every future invoice from that same OCR name auto-links instantly.

---

### Create new supplier from invoice drawer

When no supplier match exists:
- Amber banner: *"Invoice from [OCR name] — link to a supplier"*
- Combobox bottom option: **"+ Create '[OCR name]' as new supplier"**
- Inline mini-form: `name` pre-filled with OCR string (editable), optional contact fields
- On save: `POST /api/suppliers`, then `PATCH session`, alias auto-learned

---

## Data Flow Summary

```
OCR extracts "ACECARD FOOD GROUP LTD"
  → matchSupplierByName("ACECARD FOOD GROUP LTD")
    → found alias → set supplierId = "legends_haul_id"   ✓ auto
    → not found   → supplierId = null, show amber banner  ✗ needs user

User picks "Legends Haul" from combobox
  → PATCH session { supplierId: "legends_haul_id" }
  → learnAlias("legends_haul_id", "ACECARD FOOD GROUP LTD")
    → SupplierAlias row created

Next invoice from "ACECARD FOOD GROUP LTD"
  → matchSupplierByName → hits alias → auto-links ✓
```

---

## Files Changed

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `SupplierAlias` model; add `aliases` relation to `Supplier` |
| `prisma/migrations/…` | Generated migration |
| `src/lib/supplier-matcher.ts` | **New**: `matchSupplierByName`, `learnAlias` |
| `src/app/api/invoices/sessions/[id]/process/route.ts` | After OCR writes `supplierName`, call `matchSupplierByName` and write `supplierId` |
| `src/app/api/invoices/sessions/[id]/route.ts` | Add `PATCH` handler: update `supplierId`, call `learnAlias` |
| `src/app/api/suppliers/route.ts` | Include `aliases` in GET response; accept `aliases[]` in POST |
| `src/app/api/suppliers/[id]/route.ts` | Include `aliases` in GET; accept alias array diff in PUT |
| `src/app/api/suppliers/[id]/aliases/route.ts` | **New**: `POST` to add a single alias |
| `src/app/api/suppliers/[id]/aliases/[aliasId]/route.ts` | **New**: `DELETE` to remove a single alias |
| `src/components/suppliers/types.ts` | Add `aliases: { id: string; name: string }[]` to `SupplierSummary` |
| `src/components/suppliers/SupplierFormModal.tsx` | Add "Invoice Names" tag-input section |
| `src/components/suppliers/SupplierDetail.tsx` | Show aliases as chips in dark header |
| `src/components/suppliers/SupplierList.tsx` | Show first alias as gray subtitle on list items |
| `src/components/invoices/InvoiceDrawer.tsx` | Add supplier selector strip with auto-match / manual / create-new states |

---

## Invoice Drawer — Supplier Selector

At the top of the session review panel (above scan items), a single compact strip:

**Auto-matched:**
```
[building icon]  Legends Haul   ✓ auto-matched     [Change ▾]
```

**Manually linked:**
```
[building icon]  Legends Haul   (linked)            [Change ▾]
```

**Unlinked:**
```
⚠  Invoice from "ACECARD FOOD GROUP LTD" — link to a supplier  [Link →]
```

"Change" / "Link →" opens a searchable combobox over all suppliers (display name + alias count as subtitle). Bottom row: **`+ Create "ACECARD FOOD GROUP LTD" as new supplier`**.

The create flow opens a small modal with `name` pre-filled (editable). On submit: creates supplier, patches session, learns alias.

---

## Supplier Form — Invoice Names Section

Below existing fields in `SupplierFormModal`, add an **"Invoice Names"** section:

- Tag list of existing aliases with `×` remove buttons.
- `+ Add name` text input to manually add a new alias.
- On save: POST new aliases, DELETE removed aliases.

---

## Supplier Detail Header

Below the supplier name in the dark header, show aliases as small monospace chips:

```
Legends Haul
ACECARD FOOD GROUP LTD  ×    ACECARD FOODS INC  ×
```

---

## Session PATCH Endpoint

`PATCH /api/invoices/sessions/[id]`
Body: `{ supplierId: string }`

1. Load session to get `supplierName`.
2. `UPDATE session SET supplierId = $supplierId`.
3. `learnAlias(supplierId, session.supplierName)`.
4. Return updated session.

---

## Error Handling

- `matchSupplierByName(null | "")` → return null immediately.
- `learnAlias(id, null | "")` → no-op.
- Duplicate alias upsert → silently ignored via `@@unique` constraint.
- Removing an alias that old sessions matched against → allowed; existing sessions keep their `supplierId`.

---

## Out of Scope

- Retroactively back-filling `supplierId` on already-approved sessions with `supplierId = null`. Users can manually re-link if needed.
- Fuzzy matching (e.g. Levenshtein distance). Exact case-insensitive match is sufficient because aliases are trained from real OCR output.
- Renaming `Supplier.name`. It stays as the user's display label.
