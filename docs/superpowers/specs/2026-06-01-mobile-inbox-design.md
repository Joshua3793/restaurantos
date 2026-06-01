# Mobile Unified Inbox — Design

**Date:** 2026-06-01
**Status:** Approved (pending spec review)
**Scope:** Mobile only (`block sm:hidden`). The desktop `/invoices` V2 layout is unchanged.

## Problem

The `/invoices` page is a desktop "V2" redesign rendered at every breakpoint. On a phone it falls apart:
- The KPI strip is a horizontal-scroll row of ~280px desktop cards; the first card's text is mangled/clipped.
- A giant title + verbose subtitle + Inbox/History toggle waste vertical space.
- Oversized empty/alert boxes.
- The History view (`InvoiceListV2`) is a sortable/bulk-select table — unusable on mobile.

The Controla OS handoff design (`m-inbox.jsx`, `m-capture.jsx`) defines a mobile-native **Inbox**: a single feed that unifies invoices with price/variance/exception signals, filterable by chips, with drill-in detail and a reused review flow.

## Decisions (locked)

- **Unified Inbox** (not invoice-only): the mobile feed merges invoice sessions + signals.
- **Mobile only**: desktop `/invoices` is untouched (dual-renderer).
- **Nav**: rename the mobile bottom-tab label "Invoices" → "Inbox". The "Signals" tab is left as-is.

## Data sources (both already exist — no backend changes)

- Invoice sessions: `/api/invoices/sessions` (already fetched in the page as `sessions: SessionSummary[]`).
- Signals: `/api/signals` → `{ signals: Signal[], counts }`. `Signal` has `rule`, `severity`, `title`, `body`, `impactValue`, `verbLabel/verbHref`, `status`, `createdAt`, `itemId`, `recipeId`.

### Category mapping → chips

| Chip | Source |
|---|---|
| **Invoices** | sessions with status REVIEW / PROCESSING / UPLOADING / APPROVING |
| **Exceptions** | sessions with status ERROR (OCR/match failures) |
| **Prices** | signals with rule `PRICE_SPIKE`, `RECIPE_DRIFT` |
| **Variance** | signals with rule `COUNT_OVERDUE`, `WASTAGE_SPIKE` |
| **All** | everything above |

Signals with other rules (e.g. `MENU_PUZZLE`) fall under "All" only (no dedicated chip), shown as generic signal cards. APPLIED/SNOOZED/DISMISSED signals are excluded from the open feed.

## Architecture

`src/app/invoices/page.tsx`: wrap the existing desktop content (`InboxSubNav`, `PageHead`, `InvoiceKpiStripV2`, `InboxViewV2`/`InvoiceListV2`) in a `hidden sm:block` container. Add a `block sm:hidden` `<MobileInbox …>` fed by the page's `sessions` plus a new `signals` state. The `InvoiceReviewDrawer`, `InvoiceUploadModal`, polling, and handlers are shared (mounted once, used by both renderers).

### New unit: `src/lib/invoices/inbox-items.ts`
Pure normalizer. `toInboxItems(sessions, signals): InboxItem[]` and `INBOX_CHIPS` / category helpers.

```ts
type InboxCategory = 'invoices' | 'exceptions' | 'prices' | 'variance' | 'other'
interface InboxItem {
  id: string
  kind: 'invoice' | 'signal'
  category: InboxCategory
  tone: 'gold' | 'red' | 'ink' | 'ink3'   // accent
  icon: string                            // lucide name
  title: string                           // "Sysco · Mon 26 May" | signal.title
  meta: string                            // "INVOICE #4421 · 14 LINES · $1,284" | rule/body
  badge?: string                          // "92%" OCR (invoices)
  impact?: string                         // "+$0.34" (signals)
  ageMs: number                           // for sort + "Xh ago"
  raw: SessionSummary | Signal            // escape hatch for tap handlers
}
```
Sort: open/needs-action first, then by `ageMs` desc (oldest first per the design eyebrow "oldest 14h ago"). Counts per category drive the chips.

### New components: `src/components/invoices/mobile/`
- **`MobileInbox.tsx`** — orchestrator. Props: `sessions`, `signals`, `onSelectSession(id)`, `onUploadClick`, `onScanClick?`, `onSignalAct(id, action)`. Holds the active chip + selected-signal state. Renders header + chips + the filtered card list + `SignalSheet`. Empty state per chip.
- **`InboxHeader.tsx`** (or inline) — compact: "Inbox" title, eyebrow "N items · oldest Xh ago", a right-aligned Upload/Scan button. Replaces the desktop `PageHead` + KPI strip on mobile.
- **`InboxChips.tsx`** — horizontal chip row (All / Invoices / Prices / Variance / Exceptions) with counts; active chip = ink fill.
- **`InboxInvoiceCard.tsx`** — left-accent card: 32px icon, supplier·date title, "#··· · N lines · $total" meta, OCR-% pill, "Xh ago". When the session has unmatched lines, an expandable `UNMATCHED · N` block listing them with an "Open scan / Review →" pair → `onSelectSession`. Tapping the card body → `onSelectSession` (opens the existing mobile-aware `InvoiceReviewDrawer`).
- **`InboxSignalCard.tsx`** — left-accent card: icon, title, rule/body meta, `impact` (mono, red for cost increases), age. Tap → opens `SignalSheet`.
- **`SignalSheet.tsx`** — bottom sheet (`fixed inset-0 z-50 flex items-end`, backdrop + `rounded-t-2xl` panel — the app's standard mobile sheet pattern). Shows the signal's headline metric, body, and (for price signals) affected recipes if derivable from the signal; actions **Apply / Snooze / Dismiss** wired to `onSignalAct` → `/api/signals` PATCH.

### Page wiring (`src/app/invoices/page.tsx`)
- Add `const [signals, setSignals] = useState<Signal[]>([])`; fetch in the existing `fetchSessions` flow (or a parallel `fetchSignals`) and on the same poll cadence.
- Add `const handleSignalAct = async (id, action) => { await fetch('/api/signals', { method:'PATCH', … }); fetchSignals() }` mirroring the Signals page.
- Wrap current return body's desktop pieces in `hidden sm:block`; add `<div className="block sm:hidden"><MobileInbox …/></div>`.

### Nav (`src/components/mobile/MobileTabBar.tsx`)
- Change the `/invoices` tab `label: 'Invoices'` → `'Inbox'`. Icon/badge unchanged.

## States
- Loading: skeleton cards (3–4) in the feed.
- Empty per chip: "All clear" / "No invoices in queue" / "No price alerts" / etc. — compact, single small card (not the giant boxes).
- Error: keep last data; the page's silent poll already handles transient failures.
- Card states: invoice with/without unmatched; signal critical (red) vs warn (gold) vs info.

## Reuse (explicitly not rebuilt)
- `InvoiceReviewDrawer` — already mobile-aware (`md:hidden` tabs, full-width, safe-area). Tapping an invoice opens it.
- `InvoiceUploadModal` / `useNativeScan` — capture entry point.
- `/api/invoices/sessions`, `/api/signals` (+ PATCH) — no backend changes.

## Out of scope
- Desktop `/invoices` layout, the History list, the camera viewfinder (native-only in the design), and the Signals page itself.

## Testing / verification
No unit suite — `npm run build` type-checks. Manual verification via preview at 390×844:
1. Inbox renders as a compact feed (no horizontal KPI scroll, no clipped cards).
2. Chips filter the feed; counts correct.
3. Invoice card → opens review drawer; unmatched block expands.
4. Price/variance signal → opens bottom sheet; Apply/Snooze/Dismiss hits `/api/signals` and updates the feed.
5. Upload/Scan entry works (web modal).
6. Desktop `/invoices` (≥640px) is visually unchanged.
7. Mobile bottom tab reads "Inbox".
