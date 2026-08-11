import { describe, it, expect } from 'vitest'
import { navGroups, setupItems, allNavItems, navLabelFor } from '../nav-items'
import { requiredClearance } from '../route-access'

// The clearance each nav destination is expected to need. This is written out
// by hand ON PURPOSE: if someone changes ROUTE_CLEARANCE without thinking about
// the menu, this table disagrees and the test fails.
const EXPECTED: Record<string, string | null> = {
  '/pass': 'MANAGER',
  '/preshift': null,
  '/prep': null,
  '/count': null,
  '/temps': null,
  '/end-of-day': 'LEAD',
  '/invoices': null,
  '/tips': 'MANAGER',
  '/inventory': null,
  '/recipes': null,
  '/menu': null,
  '/reports': 'MANAGER',
  '/variance': 'MANAGER',
  '/signals': 'MANAGER',
  '/sales': null,
  '/wastage': null,
  '/setup': 'ADMIN',
  '/setup/suppliers': 'ADMIN',
  '/setup/revenue-centers': 'ADMIN',
}

describe('nav tables', () => {
  it('exposes every group item and setup item in allNavItems', () => {
    const fromGroups = navGroups.flatMap(g => g.items)
    expect(allNavItems).toHaveLength(fromGroups.length + setupItems.length)
  })

  it('gives every item a non-empty href, label and icon', () => {
    for (const item of allNavItems) {
      expect(item.href.startsWith('/')).toBe(true)
      expect(item.label.length).toBeGreaterThan(0)
      expect(item.icon).toBeTruthy()
    }
  })

  it('has no duplicate hrefs', () => {
    const hrefs = allNavItems.map(i => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})

// THE REGRESSION GUARD. The original defect was two clearance tables that
// disagreed: the sidebar advertised Pass/Reports/Variance/Signals/Suppliers/
// Revenue centers to Staff, and middleware bounced them right back out.
describe('nav <-> middleware clearance parity', () => {
  it('covers every nav href in the expectation table', () => {
    for (const item of allNavItems) {
      expect(EXPECTED).toHaveProperty(item.href)
    }
  })

  it('resolves every nav href to the clearance middleware enforces', () => {
    for (const item of allNavItems) {
      expect(requiredClearance(item.href)).toBe(EXPECTED[item.href])
    }
  })
})

describe('navLabelFor', () => {
  it('names the page behind a gated path', () => {
    expect(navLabelFor('/pass')).toBe('Pass')
    expect(navLabelFor('/end-of-day')).toBe('End-of-day')
    expect(navLabelFor('/setup/revenue-centers')).toBe('Revenue centers')
  })

  it('prefers the most specific match', () => {
    // '/setup/suppliers' must resolve to Suppliers, not to the Setup hub.
    expect(navLabelFor('/setup/suppliers')).toBe('Suppliers')
  })

  it('resolves a child path to its parent nav entry', () => {
    expect(navLabelFor('/reports/waste')).toBe('Reports')
  })

  it('returns null for a path no nav item owns', () => {
    expect(navLabelFor('/nowhere')).toBeNull()
  })
})
