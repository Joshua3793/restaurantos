// Nav destinations, extracted from Navigation.tsx so a .ts unit test can assert
// they agree with route-access.ts. Deliberately carries NO clearance fields:
// what a user may open is derived from `href` via requiredClearance(), which is
// the same call middleware makes. One table, no drift.
import {
  Sun, Package, FileText, Trash2, BarChart3, BookOpen, UtensilsCrossed,
  ShoppingBag, Settings, ChefHat, Truck, ClipboardList, Activity, Building2,
  Zap, Flame, Thermometer, Clock, Banknote,
} from 'lucide-react'

export type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number | string; color?: string }>
  exact?: boolean
  badgeKey?: 'invoicesReview' | 'priceAlerts'
}

export type NavGroup = {
  label: string
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    label: 'TODAY',
    items: [
      { href: '/pass',       label: 'Pass',       icon: Sun },
      { href: '/preshift',   label: 'Pre-shift',  icon: Flame },
      { href: '/prep',       label: 'Prep',       icon: ChefHat },
      { href: '/count',      label: 'Count',      icon: ClipboardList },
      { href: '/temps',      label: 'Temps',      icon: Thermometer },
      { href: '/end-of-day', label: 'End-of-day', icon: Clock },
    ],
  },
  {
    label: 'INBOX',
    items: [
      { href: '/invoices', label: 'Invoices', icon: FileText, badgeKey: 'invoicesReview' },
    ],
  },
  {
    label: 'TEAM',
    items: [
      { href: '/tips', label: 'Tip payouts', icon: Banknote },
    ],
  },
  {
    label: 'LIBRARY',
    items: [
      { href: '/inventory', label: 'Inventory', icon: Package },
      { href: '/recipes',   label: 'Recipes',   icon: BookOpen },
      { href: '/menu',      label: 'Menu',      icon: UtensilsCrossed },
    ],
  },
  {
    label: 'INSIGHTS',
    items: [
      { href: '/reports',  label: 'Reports',  icon: BarChart3 },
      { href: '/variance', label: 'Variance', icon: Activity },
      { href: '/signals',  label: 'Signals',  icon: Zap },
      { href: '/sales',    label: 'Sales',    icon: ShoppingBag },
      { href: '/wastage',  label: 'Wastage',  icon: Trash2 },
    ],
  },
]

export const setupItems: NavItem[] = [
  { href: '/setup',                 label: 'Setup',           icon: Settings, exact: true },
  { href: '/setup/suppliers',       label: 'Suppliers',       icon: Truck },
  { href: '/setup/revenue-centers', label: 'Revenue centers', icon: Building2 },
]

/** Every destination the menu offers, groups first then setup. */
export const allNavItems: NavItem[] = [
  ...navGroups.flatMap(g => g.items),
  ...setupItems,
]

/**
 * Human name of the page at `pathname` — used by the no-access screen to say
 * "You can't open Pass" instead of echoing a raw path. Longest matching href
 * wins so '/setup/suppliers' resolves to Suppliers, not to the Setup hub.
 */
export function navLabelFor(pathname: string): string | null {
  let bestHref = ''
  let bestLabel: string | null = null
  for (const item of allNavItems) {
    const hit = pathname === item.href || pathname.startsWith(item.href + '/')
    if (hit && item.href.length > bestHref.length) {
      bestHref = item.href
      bestLabel = item.label
    }
  }
  return bestLabel
}
