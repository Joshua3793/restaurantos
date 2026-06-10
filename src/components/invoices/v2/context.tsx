'use client'
// DrawerContext — shared state for the invoice review drawer.
// Provider is built in Phase 5. This file defines the shape and the hook.

import { createContext, useContext } from 'react'
import type { ScanItem } from '@/components/invoices/types'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import type { ReconcileResult } from './composites'
import type { FilterKey, SortMode } from '@/lib/invoice/filters'

export interface DrawerContextValue {
  // ── Server-sourced data ────────────────────────────────────────────────────
  lines: ScanItem[]
  revenueCenters: RevenueCenter[]

  // ── Client-side staged edits ───────────────────────────────────────────────
  editedLines: Map<string, Partial<ScanItem>>

  // ── UI state ───────────────────────────────────────────────────────────────
  expandedLineIds: Set<string>
  flashingLineIds: Set<string>        // temporary flash highlight after goToTask
  activeFilters: Set<FilterKey>
  sortMode: SortMode
  pickingLinkForId: string | null     // which line's link picker is open
  modeWritebackItems: Set<string>     // lines where user wants to update product default mode
  acknowledgedPriceLines: Set<string> // lines where the user accepted the price change
  acknowledgedConfLines: Set<string>  // lines where the user confirmed a low-trust line

  // ── Reconciliation result ──────────────────────────────────────────────────
  reconciliation: ReconcileResult | null

  // ── Computed helpers ───────────────────────────────────────────────────────
  /** Returns server line with staged edits applied. */
  getEffectiveLine: (id: string) => ScanItem
  /** Looks up the full RevenueCenter for a line's revenueCenterId. */
  getItemRc: (id: string) => RevenueCenter | null

  // ── Line mutations ─────────────────────────────────────────────────────────
  updateLine: (id: string, patch: Partial<ScanItem>) => void
  clearLineEdits: (id: string) => void

  // ── Expand / collapse ──────────────────────────────────────────────────────
  toggleExpand: (id: string, forceOpen?: boolean) => void

  // ── Revenue center ─────────────────────────────────────────────────────────
  setLineRc: (id: string, rc: RevenueCenter | null) => void

  // ── Link picker ────────────────────────────────────────────────────────────
  startLinkPicker: (id: string) => void
  closeLinkPicker: () => void

  // ── Create new inventory item modal ───────────────────────────────────────
  openCreateNew: (item: ScanItem) => void

  // ── Edit linked inventory item ─────────────────────────────────────────────
  openInventoryEdit: (inventoryItemId: string) => void

  // ── Mode writeback checkbox ────────────────────────────────────────────────
  toggleModeWriteback: (id: string) => void

  // ── Price-change acknowledgement (resolves the price .issue) ───────────────
  acknowledgePrice: (id: string) => void

  // ── Low-trust line confirmation (resolves the conf .issue) ─────────────────
  acknowledgeConf: (id: string) => void

  // ── Active bbox for image highlight ────────────────────────────────────────
  activeBboxItemId: string | null     // which line card is expanded + has a bbox
  /** Mobile: switch the drawer to the image tab with this line's row highlighted. */
  showLineOnImage: (id: string) => void

  // ── Filters / sort ─────────────────────────────────────────────────────────
  toggleFilter: (k: FilterKey) => void
  setSortMode: (m: SortMode) => void
}

export const DrawerContext = createContext<DrawerContextValue | null>(null)

export function useDrawerContext(): DrawerContextValue {
  const ctx = useContext(DrawerContext)
  if (!ctx) throw new Error('useDrawerContext must be called inside <InvoiceReviewDrawer>')
  return ctx
}
