/**
 * Unit of Measure definitions and conversion utilities.
 * Used for recipe ingredient cost calculations — both server-side and client-side.
 */

export interface UomGroup {
  label: string
  base: string
  units: { label: string; toBase: number }[]
}

export const UOM_GROUPS: UomGroup[] = [
  {
    label: 'Weight',
    base: 'g',
    units: [
      { label: 'mg',  toBase: 0.001 },
      { label: 'g',   toBase: 1 },
      { label: 'kg',  toBase: 1000 },
      { label: 'oz',  toBase: 28.3495 },
      { label: 'lb',  toBase: 453.592 },
    ],
  },
  {
    label: 'Volume',
    base: 'ml',
    units: [
      { label: 'ml',    toBase: 1 },
      { label: 'cl',    toBase: 10 },
      { label: 'dl',    toBase: 100 },
      { label: 'l',     toBase: 1000 },
      { label: 'tsp',   toBase: 4.92892 },
      { label: 'tbsp',  toBase: 14.7868 },
      { label: 'fl oz', toBase: 29.5735 },
      { label: 'cup',   toBase: 236.588 },
      { label: 'pt',    toBase: 473.176 },
      { label: 'qt',    toBase: 946.353 },
    ],
  },
  {
    label: 'Count',
    base: 'each',
    units: [
      { label: 'each',    toBase: 1 },
      { label: 'pcs',     toBase: 1 },
      { label: 'slice',   toBase: 1 },
      { label: 'bunch',   toBase: 1 },
      { label: 'portion', toBase: 1 },
      { label: 'serve',   toBase: 1 },
      { label: 'batch',   toBase: 1 },
    ],
  },
]

/** Flat list of every unit for dropdowns */
export const ALL_UNITS = UOM_GROUPS.flatMap(g =>
  g.units.map(u => ({ label: u.label, group: g.label, toBase: u.toBase }))
)

/**
 * Convert `qty` from `fromUnit` to `toUnit`.
 * Returns the original qty unchanged if the units are incompatible or unrecognised.
 */
export function convertQty(qty: number, fromUnit: string, toUnit: string): number {
  if (!fromUnit || !toUnit) return qty
  const from = fromUnit.trim().toLowerCase()
  const to   = toUnit.trim().toLowerCase()
  if (from === to) return qty

  for (const group of UOM_GROUPS) {
    const fromDef = group.units.find(u => u.label.toLowerCase() === from)
    const toDef   = group.units.find(u => u.label.toLowerCase() === to)
    if (fromDef && toDef) {
      // qty × toBase(from) → qty in group base, then ÷ toBase(to) → target unit
      return (qty * fromDef.toBase) / toDef.toBase
    }
  }

  // Different or unrecognised groups — pass through unchanged
  return qty
}

/** Return the group name ('Weight' | 'Volume' | 'Count') for a unit, or null. */
export function getUnitGroup(unit: string): string | null {
  const u = unit.trim().toLowerCase()
  for (const group of UOM_GROUPS) {
    if (group.units.some(gu => gu.label.toLowerCase() === u)) return group.label
  }
  return null
}
