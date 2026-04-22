# Invoices Page Redesign — Phase 1 Design

## Goal

Transform the invoices page from a basic OCR session list into a Purchasing & Accounts Payable Dashboard: compact KPI strip on top, enhanced invoice list with status tabs and search below, and a right-side drawer for reviewing and approving invoices inline.

## Scope

**Phase 1 (this spec):** KPI Dashboard strip + Enhanced Invoice Management (list, drawer, search, tabs).  
**Phase 2 (later):** Supplier Intelligence, export/sync integrations.

---

## Architecture

### Component split

The existing `src/app/invoices/page.tsx` (2,391 lines) becomes a thin orchestrator. All UI is extracted into focused components:

| File | Responsibility |
|---|---|
| `src/app/invoices/page.tsx` | Thin shell — holds `selectedSessionId` state, renders KPI strip + list + drawer + upload modal |
| `src/components/invoices/InvoiceKpiStrip.tsx` | Compact 5-card KPI bar across the top of the page |
| `src/components/invoices/InvoiceList.tsx` | Status tabs, search input, invoice rows grid |
| `src/components/invoices/InvoiceDrawer.tsx` | Right-side slide panel containing the full review/approve flow |
| `src/components/invoices/InvoiceUploadModal.tsx` | Upload flow extracted from existing page — logic unchanged |

One new API route: `src/app/api/invoices/kpis/route.ts`.

All existing API routes (`/api/invoices/sessions`, `/api/invoices/sessions/[id]/process`, `/api/invoices/sessions/[id]/approve`, `/api/invoices/sessions/[id]/reject`) are unchanged.

---

## Components

### InvoiceKpiStrip

Compact horizontal bar, ~64px tall. Five cards in a flex row:

1. **This Week** — sum of approved `InvoiceSession.total` in the current ISO week. Shows % change vs prior week (green ↑ / red ↓).
2. **This Month** — sum of approved totals in the current calendar month + invoice count.
3. **Price Alerts** — count of unacknowledged `PriceAlert` rows. Card is amber-tinted when count > 0.
4. **Awaiting Approval** — count of `InvoiceSession` where `status = 'REVIEW'`. Card is blue-tinted when count > 0.
5. **Top Spend** — mini horizontal bar chart showing top 3 inventory categories by `InvoiceLineItem` spend this month.

Fetches from `GET /api/invoices/kpis` on mount. Refetches after any approve/reject action via a callback from the drawer.

### InvoiceList

Full-width below the KPI strip.

**Toolbar:**
- Status tab pills: All | Review `(n)` | Approved | Rejected. Badge on Review tab shows count. Active tab has white bg + shadow.
- Search input: filters by `supplierName` or `invoiceNumber`, client-side.
- Upload button: opens `InvoiceUploadModal`.

**Invoice rows** (CSS grid, 6 columns):
- Supplier name + invoice number + amber alert indicator if unacknowledged price alerts exist
- Invoice date
- Total amount
- Line item count
- Status badge (Review = amber, Approved = green, Rejected = red, Processing = gray)
- `⋯` menu (Delete action; extensible for Phase 2)

Rows with `status = 'REVIEW'` have an amber (`#fffbeb`) background tint.

Clicking a row sets `selectedSessionId` on the parent, opening the drawer. Data comes from the existing `/api/invoices/sessions` endpoint; tabs and search filter client-side.

### InvoiceDrawer

Fixed right panel, 480px wide, with a semi-transparent backdrop (`bg-black/40`). Animates in with `translate-x-full → translate-x-0` (150ms ease-out). Closes on backdrop click or X button.

On mobile (`< sm`): renders as a bottom sheet (same pattern as count page — `fixed inset-0 z-50 flex items-end`).

**Internal states** (mirrors existing review flow):
- `PROCESSING` — spinner, "Processing invoice…" message
- `REVIEW` — scan items list with supplier match corrections, price change indicators (existing UI, relocated here)
- `DONE` — Approved or Rejected summary with Close button. Also used when opening an already-approved or already-rejected session row from the list.

Footer has Approve and Reject buttons (existing API calls). After approve/reject:
1. Drawer closes.
2. List row status badge updates (refetch sessions).
3. KPI strip refetches.

### InvoiceUploadModal

Extracted from the existing page with no logic changes. Same upload → OCR → processing flow. On completion, session list refetches and drawer opens to the new session if it's in REVIEW.

---

## New API: GET /api/invoices/kpis

Returns all KPI data in a single request.

**Response shape:**
```ts
{
  weekSpend: number           // sum of approved session totals, current ISO week
  weekSpendChangePct: number  // % change vs prior ISO week (positive = up)
  monthSpend: number          // sum of approved session totals, current calendar month
  monthInvoiceCount: number   // count of approved sessions this month
  priceAlertCount: number     // unacknowledged PriceAlert rows
  awaitingApprovalCount: number // InvoiceSession where status = 'REVIEW'
  topCategories: Array<{
    category: string
    spend: number
  }>                          // top 3 categories by InvoiceLineItem spend this month
}
```

**Queries:**
- Week/month spend: `InvoiceSession` where `status = 'APPROVED'` and `approvedAt` in range, `_sum { total }`
- Price alerts: `PriceAlert` where `acknowledged = false`, `_count`
- Awaiting approval: `InvoiceSession` where `status = 'REVIEW'`, `_count`
- Top categories: `InvoiceLineItem` joined to `InventoryItem.category`, grouped by category, summed by `lineTotal`, current month, top 3

---

## Data flow

```
page.tsx
  ├── selectedSessionId (state)
  ├── sessions (state)                               ← GET /api/invoices/sessions (fetched here)
  ├── <InvoiceKpiStrip onRefresh={refetchKpis} />   ← GET /api/invoices/kpis
  ├── <InvoiceList
  │     sessions={sessions}
  │     onSelect={setSelectedSessionId} />
  ├── <InvoiceDrawer
  │     sessionId={selectedSessionId}
  │     onClose={() => setSelectedSessionId(null)}
  │     onApproveOrReject={() => { refetchSessions(); refetchKpis(); }} />
  └── <InvoiceUploadModal
        onComplete={refetchSessions} />
```

`page.tsx` owns both fetches (sessions + KPIs) so it controls refetch timing after mutations. Sessions are passed as a prop to `InvoiceList` — the list does no fetching of its own. After any mutation (approve/reject/delete/upload complete), the relevant fetches are re-triggered via callbacks.

---

## Error handling

- KPI fetch failure: strip shows `—` for each value with a muted style. No error thrown to the user.
- Session list fetch failure: existing error state (unchanged).
- Approve/reject failure: existing toast/error handling (unchanged), drawer stays open.

---

## Mobile

- KPI strip: scrollable horizontally on small screens (`overflow-x-auto`, cards have `min-width`).
- Invoice list: on mobile, rows collapse to a card layout (supplier name + status badge on one line, total + date on a second line). Same dual-renderer pattern as count page (`block sm:hidden` / `hidden sm:block`).
- Drawer: bottom sheet on mobile, right panel on desktop.
