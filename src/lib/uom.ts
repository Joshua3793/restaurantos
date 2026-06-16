/**
 * Unit of Measure definitions and conversion utilities.
 * Used for recipe ingredient cost calculations — both server-side and client-side.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH
 * ─────────────────────────────────────────────────────────────────────────────
 * `UNIT_FACTORS` below is the ONE canonical table of unit → base-unit conversion
 * factors for the whole app. Every other unit construct derives from it:
 *   - `UOM_GROUPS` (dropdown lists)            → toBase read from UNIT_FACTORS
 *   - `convertQty` / `getUnitGroup`            → look up UNIT_FACTORS
 *   - `utils.ts` `UNIT_CONV` / `getUnitConv`   → derived from UNIT_FACTORS
 *   - `utils.ts` `getUnitDimension`            → derived from UNIT_FACTORS
 *
 * Historically there were TWO independent tables (here and in utils.ts) that
 * drifted apart — `convertQty` silently passed `mg`/`lt`/`gal` through
 * unconverted (a latent 1000× cost error), while `pt`/`qt` existed here but had
 * no factor in utils. Keep additions in UNIT_FACTORS only.
 */

export type UnitDimension = 'weight' | 'volume' | 'count'

/** Canonical conversion factors — the single source of truth. Keyed by canonical token. */
export const UNIT_FACTORS: Record<string, { dim: UnitDimension; toBase: number }> = {
  // weight — base unit: g
  mg: { dim: 'weight', toBase: 0.001 },
  g:  { dim: 'weight', toBase: 1 },
  kg: { dim: 'weight', toBase: 1000 },
  oz: { dim: 'weight', toBase: 28.3495 },
  lb: { dim: 'weight', toBase: 453.592 },
  // volume — base unit: ml
  ml:      { dim: 'volume', toBase: 1 },
  cl:      { dim: 'volume', toBase: 10 },
  dl:      { dim: 'volume', toBase: 100 },
  l:       { dim: 'volume', toBase: 1000 },
  tsp:     { dim: 'volume', toBase: 4.92892 },
  tbsp:    { dim: 'volume', toBase: 14.7868 },
  'fl oz': { dim: 'volume', toBase: 29.5735 },
  cup:     { dim: 'volume', toBase: 236.588 },
  pt:      { dim: 'volume', toBase: 473.176 },
  qt:      { dim: 'volume', toBase: 946.353 },
  gal:     { dim: 'volume', toBase: 3785.41 },
  // count — base unit: each (all 1:1, except dozen = 12 fixed)
  each:    { dim: 'count', toBase: 1 },
  pcs:     { dim: 'count', toBase: 1 },
  slice:   { dim: 'count', toBase: 1 },
  bunch:   { dim: 'count', toBase: 1 },
  portion: { dim: 'count', toBase: 1 },
  serve:   { dim: 'count', toBase: 1 },
  batch:   { dim: 'count', toBase: 1 },
  plate:   { dim: 'count', toBase: 1 },    // menu presentation units (1 = one serving)
  bowl:    { dim: 'count', toBase: 1 },
  dozen:   { dim: 'count', toBase: 12 },   // fixed multiplier, not pack-dependent → measurement
}

/**
 * Container / purchase units with NO fixed conversion factor — a "case" or "box"
 * only resolves to base units through an item's pack structure
 * (qtyPerPurchaseUnit × packSize × packUOM), or to 1 "each" when there is no pack.
 * They are KNOWN units (never "unknown"/silent-1) but must convert via pack, never
 * via getUnitConv. Keep these canonical tokens; map spelling variants in UOM_CANON.
 */
export const CONTAINER_UNITS: ReadonlySet<string> = new Set([
  'case', 'pack', 'box', 'bag', 'tray', 'jug', 'sleeve', 'pallet',
  'clamshell', 'flat', 'carton', 'tin',
])

/**
 * Maps every spelling/abbreviation a unit might appear as → one canonical token,
 * so conversion always resolves regardless of source (invoice OCR, CSV import,
 * legacy data). Keeps distinct units within a dimension (g≠kg≠lb); only collapses
 * spelling/case (GR/GRAM→g, LTR/LT/LITRE→l, KG→kg, EA/CT/PC→each…).
 */
const UOM_CANON: Record<string, string> = {
  // weight
  g: 'g', gr: 'g', grm: 'g', gm: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', '#': 'lb',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  mg: 'mg',
  // volume
  ml: 'ml', mls: 'ml', milliliter: 'ml', millilitre: 'ml',
  l: 'l', lt: 'l', ltr: 'l', ltrs: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l',
  cl: 'cl', dl: 'dl', gal: 'gal', gallon: 'gal',
  floz: 'fl oz', 'fl oz': 'fl oz', 'fl.oz': 'fl oz',
  tsp: 'tsp', teaspoon: 'tsp', tbsp: 'tbsp', tablespoon: 'tbsp',
  cup: 'cup', cups: 'cup', pt: 'pt', pint: 'pt', qt: 'qt', quart: 'qt',
  // count
  each: 'each', ea: 'each', ct: 'each', cnt: 'each', count: 'each',
  pc: 'each', pcs: 'each', piece: 'each', pieces: 'each',
  un: 'each', unit: 'each', units: 'each',
  slice: 'slice', bunch: 'bunch', batch: 'batch',
  portion: 'portion', portions: 'portion',
  serve: 'serve', serving: 'serve', servings: 'serve',
  plate: 'plate', plates: 'plate', bowl: 'bowl', bowls: 'bowl',
  dozen: 'dozen', dozens: 'dozen', doz: 'dozen', dz: 'dozen',
  // container / purchase units (resolve via pack structure, not a factor)
  case: 'case', cases: 'case', cs: 'case',
  pack: 'pack', packs: 'pack', pk: 'pack', pkg: 'pack', pkgs: 'pack',
  box: 'box', boxes: 'box',
  bag: 'bag', bags: 'bag',
  tray: 'tray', trays: 'tray',
  jug: 'jug', jugs: 'jug',
  sleeve: 'sleeve', sleeves: 'sleeve',
  pallet: 'pallet', pallets: 'pallet',
  clamshell: 'clamshell', clam: 'clamshell',
  flat: 'flat', flats: 'flat',
  carton: 'carton', cartons: 'carton', ctn: 'carton',
  tin: 'tin', tins: 'tin',
}

/** Normalize a unit string to its canonical token (case/abbreviation-insensitive). */
export function canonicalUom(uom: string | null | undefined): string {
  if (!uom) return ''
  const k = uom.trim().toLowerCase().replace(/\.$/, '')
  return UOM_CANON[k] ?? k
}

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement surface — classify + guard so an unrecognized unit can never
// silently become factor 1 ("each") in conversion math.
// ─────────────────────────────────────────────────────────────────────────────

export type UnitKind = 'measurement' | 'container' | 'unknown'

/**
 * Classify a unit (after canonicalization):
 *  - 'measurement' → has a fixed factor (UNIT_FACTORS); converts via getUnitConv/convertQty
 *  - 'container'   → pack-dependent (CONTAINER_UNITS); converts via the item's pack structure
 *  - 'unknown'     → not in the backbone; must be flagged/rejected, never silently treated as 1
 */
export function unitKind(uom: string | null | undefined): UnitKind {
  const c = canonicalUom(uom)
  if (UNIT_FACTORS[c]) return 'measurement'
  if (CONTAINER_UNITS.has(c)) return 'container'
  return 'unknown'
}

/** True when the unit resolves to the backbone (measurement or container). */
export function isKnownUnit(uom: string | null | undefined): boolean {
  return unitKind(uom) !== 'unknown'
}

/** Thrown by assertKnownUnit when a unit is outside the backbone. */
export class UnitError extends Error {
  constructor(public readonly uom: string, public readonly field?: string) {
    super(`Unrecognized unit '${uom}'${field ? ` for ${field}` : ''}. Use a known measurement or container unit.`)
    this.name = 'UnitError'
  }
}

/**
 * Validate + normalize a unit for storage in a conversion column. Returns the
 * canonical token; throws UnitError if the unit is unknown. Use at write-time on
 * controlled inputs (forms, CSV import) so bad units are rejected, not persisted.
 */
export function assertKnownUnit(uom: string | null | undefined, field?: string): string {
  const c = canonicalUom(uom)
  if (!isKnownUnit(c)) throw new UnitError((uom ?? '').toString().trim(), field)
  return c
}

/**
 * Tokenize ANY count-side UOM (countUOM / selectedUom), tolerant of legacy display
 * strings, PRESERVING measurement units. If the value is already a known token
 * (measurement or container — e.g. 'kg', 'batch', 'each', 'case', 'CS'), keep it.
 * Otherwise it's a display string: return the first CONTAINER word found anywhere
 * ("25kg bag" → 'bag', "case (6×2.84 l)" → 'case'), else 'each'.
 *
 * Unlike purchaseUnitToken, this keeps 'kg'/'l'/'lb'/… intact — you legitimately
 * COUNT in a measurement unit, so these columns must retain it.
 */
export function countUomToken(raw: string | null | undefined): string {
  const v = (raw ?? '').trim()
  if (!v) return 'each'
  if (isKnownUnit(v)) return canonicalUom(v)
  for (const w of v.toLowerCase().split(/[\s(),×x]+/).filter(Boolean)) {
    const c = canonicalUom(w)
    if (CONTAINER_UNITS.has(c)) return c
  }
  return 'each'
}

/**
 * The canonical UNIT TOKEN for an item's purchase unit. A purchase unit is a
 * CONTAINER-or-'each' concept (case / bag / tray / a single weighed block) — it is
 * NEVER a bare weight/volume measurement unit. A measurement unit stored here
 * collides with the weight/volume branch in convertCountQtyToBase (counting in 'kg'
 * would match `sel === purchaseUnit` and skip the measurement conversion), so we
 * normalize kg/g/lb/oz/l/ml/… to 'each' (a single measured unit). Count-dimension
 * tokens ('batch', 'dozen', 'each') and containers pass through unchanged.
 */
export function purchaseUnitToken(raw: string | null | undefined): string {
  const t = countUomToken(raw)
  const g = getUnitGroup(t)
  return g === 'Weight' || g === 'Volume' ? 'each' : t
}

export interface UomGroup {
  label: string
  base: string
  units: { label: string; toBase: number }[]
}

// Which units appear in each dropdown group, in display order. The toBase value
// is read from UNIT_FACTORS so these can never diverge from the conversion math.
const GROUP_UNITS: { label: string; base: string; units: string[] }[] = [
  { label: 'Weight', base: 'g',    units: ['g', 'kg', 'oz', 'lb'] },
  { label: 'Volume', base: 'ml',   units: ['ml', 'cl', 'dl', 'l', 'tsp', 'tbsp', 'fl oz', 'cup', 'pt', 'qt'] },
  { label: 'Count',  base: 'each', units: ['each', 'pcs', 'slice', 'bunch', 'portion', 'serve', 'batch'] },
]

export const UOM_GROUPS: UomGroup[] = GROUP_UNITS.map(g => ({
  label: g.label,
  base: g.base,
  units: g.units.map(u => ({ label: u, toBase: UNIT_FACTORS[u].toBase })),
}))

/** Flat list of every unit for dropdowns */
export const ALL_UNITS = UOM_GROUPS.flatMap(g =>
  g.units.map(u => ({ label: u.label, group: g.label, toBase: u.toBase }))
)

/**
 * Yield/portion unit choices for recipe forms — defined once so every recipe
 * select offers the same canonical tokens.
 * PREP recipes feed costing (convertQty / syncPrepToInventory), so their units
 * are canonical measured/count tokens only. MENU yield is display-only (each
 * resolves to count = 1 in the spine), so friendlier portion words are allowed.
 */
export const PREP_YIELD_UNITS = ['g', 'kg', 'ml', 'l', 'oz', 'lb', 'cup', 'each', 'portion', 'batch'] as const
export const MENU_YIELD_UNITS = ['portion', 'serving', 'plate', 'bowl', 'each', 'piece'] as const

/**
 * Convert `qty` from `fromUnit` to `toUnit`.
 * Units are canonicalized first (so 'LT', 'litre', 'GRAMS' all resolve).
 * Returns the original qty unchanged only if the units are in different
 * dimensions or are genuinely unrecognised.
 */
export function convertQty(qty: number, fromUnit: string, toUnit: string): number {
  if (!fromUnit || !toUnit) return qty
  const from = canonicalUom(fromUnit)
  const to   = canonicalUom(toUnit)
  if (from === to) return qty

  const fromDef = UNIT_FACTORS[from]
  const toDef   = UNIT_FACTORS[to]
  // Only convert within the same dimension; otherwise pass through unchanged.
  if (fromDef && toDef && fromDef.dim === toDef.dim) {
    return (qty * fromDef.toBase) / toDef.toBase
  }
  return qty
}

/** Return the group name ('Weight' | 'Volume' | 'Count') for a unit, or null. */
export function getUnitGroup(unit: string): string | null {
  const def = UNIT_FACTORS[canonicalUom(unit)]
  if (!def) return null
  return def.dim === 'weight' ? 'Weight' : def.dim === 'volume' ? 'Volume' : 'Count'
}
