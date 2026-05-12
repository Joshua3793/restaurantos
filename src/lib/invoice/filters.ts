// Filter and sort logic for the invoice line item list.

import type { ScanItem } from '@/components/invoices/types'
import {
  isCatchweight,
  hasModeMismatch,
  hasFormatMismatch,
  hasPriceChange,
  isUnlinked,
  hasMathCheck,
} from './predicates'

export type FilterKey =
  | 'priceDelta'
  | 'catchweight'
  | 'needsLink'
  | 'modeMismatch'
  | 'formatMismatch'
  | 'mathCheck'

export type SortMode = 'invoice' | 'priceDelta' | 'unlinked'

export function matchesFilter(item: ScanItem, filter: FilterKey): boolean {
  switch (filter) {
    case 'priceDelta':     return hasPriceChange(item)
    case 'catchweight':    return isCatchweight(item)
    case 'needsLink':      return isUnlinked(item)
    case 'modeMismatch':   return hasModeMismatch(item)
    case 'formatMismatch': return hasFormatMismatch(item)
    case 'mathCheck':      return hasMathCheck(item)
  }
}

export function sortComparator(mode: SortMode): (a: ScanItem, b: ScanItem) => number {
  switch (mode) {
    case 'invoice':
      return (a, b) => a.sortOrder - b.sortOrder
    case 'priceDelta':
      return (a, b) =>
        Math.abs(Number(b.priceDiffPct ?? 0)) - Math.abs(Number(a.priceDiffPct ?? 0))
    case 'unlinked':
      return (a, b) => {
        const aU = isUnlinked(a) ? 0 : 1
        const bU = isUnlinked(b) ? 0 : 1
        return aU - bU || a.sortOrder - b.sortOrder
      }
  }
}

// Returns counts for each filter key — drives chip badge numbers.
export function getFilterCounts(items: ScanItem[]): Record<FilterKey, number> {
  return {
    priceDelta:    items.filter(i => matchesFilter(i, 'priceDelta')).length,
    catchweight:   items.filter(i => matchesFilter(i, 'catchweight')).length,
    needsLink:     items.filter(i => matchesFilter(i, 'needsLink')).length,
    modeMismatch:  items.filter(i => matchesFilter(i, 'modeMismatch')).length,
    formatMismatch: items.filter(i => matchesFilter(i, 'formatMismatch')).length,
    mathCheck:     items.filter(i => matchesFilter(i, 'mathCheck')).length,
  }
}

// Returns the subset of filters that have at least one matching item,
// sorted by severity (danger first, then warn, then info).
export function getActiveFilters(items: ScanItem[]): FilterKey[] {
  const counts = getFilterCounts(items)
  const order: FilterKey[] = ['needsLink', 'mathCheck', 'formatMismatch', 'modeMismatch', 'priceDelta', 'catchweight']
  return order.filter(k => counts[k] > 0)
}

// Human-readable label for each filter chip.
export const FILTER_LABELS: Record<FilterKey, string> = {
  needsLink:     'Needs link',
  mathCheck:     'Math check',
  formatMismatch:'Format mismatch',
  modeMismatch:  'Mode mismatch',
  priceDelta:    'Price changed',
  catchweight:   'Catchweight',
}
