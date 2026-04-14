export type PrepPriority = '911' | 'NEEDED_TODAY' | 'LOW_STOCK' | 'LATER'

export const PREP_PRIORITY_ORDER: PrepPriority[] = ['911', 'NEEDED_TODAY', 'LOW_STOCK', 'LATER']

export const PREP_PRIORITY_META: Record<PrepPriority, {
  label: string
  badgeClass: string
  borderClass: string
  bgClass: string
  headingClass: string
  emoji: string
}> = {
  '911': {
    label: '911',
    emoji: '🔴',
    badgeClass: 'bg-red-100 text-red-700 font-bold',
    borderClass: 'border-l-4 border-red-500',
    bgClass: 'bg-red-50',
    headingClass: 'text-red-700',
  },
  'NEEDED_TODAY': {
    label: 'Needed Today',
    emoji: '🟠',
    badgeClass: 'bg-orange-100 text-orange-700',
    borderClass: 'border-l-4 border-orange-400',
    bgClass: 'bg-orange-50',
    headingClass: 'text-orange-700',
  },
  'LOW_STOCK': {
    label: 'Low Stock',
    emoji: '🟡',
    badgeClass: 'bg-amber-100 text-amber-700',
    borderClass: 'border-l-4 border-amber-400',
    bgClass: 'bg-amber-50',
    headingClass: 'text-amber-700',
  },
  'LATER': {
    label: 'Optional / Later',
    emoji: '⚪',
    badgeClass: 'bg-gray-100 text-gray-500',
    borderClass: '',
    bgClass: 'bg-white',
    headingClass: 'text-gray-500',
  },
}

export const PREP_STATUS_META: Record<string, { label: string; badgeClass: string }> = {
  NOT_STARTED: { label: 'Not Started', badgeClass: 'bg-gray-100 text-gray-500' },
  IN_PROGRESS: { label: 'In Progress', badgeClass: 'bg-blue-100 text-blue-700' },
  DONE:        { label: 'Done',        badgeClass: 'bg-green-100 text-green-700' },
  PARTIAL:     { label: 'Partial',     badgeClass: 'bg-amber-100 text-amber-700' },
  BLOCKED:     { label: 'Blocked',     badgeClass: 'bg-red-100 text-red-700' },
  SKIPPED:     { label: 'Skipped',     badgeClass: 'bg-gray-100 text-gray-400' },
}

export const PREP_CATEGORIES = ['MISC', 'SAUCE', 'DRESSING', 'PROTEIN', 'BAKED', 'GARNISH', 'BASE', 'PICKLED', 'DAIRY']
export const PREP_STATIONS   = ['Cold', 'Hot', 'Pastry', 'Butchery', 'Garde Manger']

/**
 * Compute the priority for a prep item.
 * manualOverride wins unconditionally.
 * minThreshold is the EARLY WARNING level — set above parLevel.
 */
export function computePriority(
  onHand: number,
  parLevel: number,
  minThreshold: number,
  targetToday: number | null,
  manualOverride: string | null,
): PrepPriority {
  if (manualOverride) return manualOverride as PrepPriority
  if (onHand <= 0 && parLevel > 0) return '911'
  if (targetToday !== null && onHand < targetToday) return '911'
  if (onHand < parLevel) return 'NEEDED_TODAY'
  if (minThreshold > 0 && onHand < minThreshold) return 'LOW_STOCK'
  return 'LATER'
}

/** max(parLevel - onHand, targetToday - onHand, 0) */
export function computeSuggestedQty(
  onHand: number,
  parLevel: number,
  targetToday: number | null,
): number {
  const base = parLevel - onHand
  if (targetToday !== null) return Math.max(targetToday - onHand, base, 0)
  return Math.max(base, 0)
}

/**
 * Compute the scale factor for ingredient deduction / output credit.
 * unit='batch' → scale = actualPrepQty (each batch = one recipe run)
 * unit matches recipe yieldUnit → scale = actualPrepQty / baseYieldQty
 * otherwise → scale = 1, unitMismatch = true
 */
export function computeScale(
  actualPrepQty: number,
  unit: string,
  recipeYieldUnit: string,
  recipeBaseYieldQty: number,
): { scale: number; unitMismatch: boolean } {
  if (unit === 'batch') return { scale: actualPrepQty, unitMismatch: false }
  if (unit === recipeYieldUnit && recipeBaseYieldQty > 0) {
    return { scale: actualPrepQty / recipeBaseYieldQty, unitMismatch: false }
  }
  return { scale: 1, unitMismatch: true }
}
