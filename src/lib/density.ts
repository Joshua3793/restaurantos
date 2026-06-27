/**
 * Seed density library (grams per millilitre at service temperature). Used to
 * pre-fill the weight↔volume bridge when an invoice bills a measured good in the
 * OTHER dimension than the item tracks. Defaults only — every value is editable
 * per item (item.densityGPerMl) and a line that shows BOTH a weight and a volume
 * overrides the library. No name match → 1.00 flagged as an estimate, never a
 * silent guess. Values mirror the spec §04 density table.
 */
export type DensityHit = { gPerMl: number; source: 'library' | 'line' | 'fallback' }

// Keyword → density. Matched as a case-insensitive substring of the item name.
// Order matters only for display; lookup picks the LONGEST matching keyword so
// "sesame oil" beats a bare "oil" entry.
const DENSITY_LIBRARY: Record<string, number> = {
  // water-like
  water: 1.0, stock: 1.01, broth: 1.01, vinegar: 1.01, wine: 0.99,
  // dairy & egg
  'whole milk': 1.03, milk: 1.03, 'heavy cream': 0.99, cream: 0.99,
  'egg yolk': 1.03, 'egg white': 1.04, 'whole egg': 1.03, egg: 1.03,
  // juice & acidic
  'orange juice': 1.05, 'apple juice': 1.05, 'lemon juice': 1.03, 'lime juice': 1.03,
  lemon: 1.03, lime: 1.03, passata: 1.06, 'soy sauce': 1.17,
  // oils & fats
  'canola oil': 0.92, 'vegetable oil': 0.92, 'veg oil': 0.92, 'olive oil': 0.91,
  'sesame oil': 0.92, 'melted butter': 0.91, butter: 0.91, oil: 0.92,
  // syrups & sugar
  'simple syrup': 1.26, agave: 1.31, 'maple syrup': 1.33, maple: 1.33,
  molasses: 1.4, honey: 1.42, syrup: 1.26,
  // thick & emulsified (defaults provided; UI suggests weight-tracking)
  ketchup: 1.1, mustard: 1.05, mayonnaise: 0.91, mayo: 0.91,
}

const KEYWORDS_BY_LENGTH = Object.keys(DENSITY_LIBRARY).sort((a, b) => b.length - a.length)

// Whole-word, case-insensitive match for a keyword. `\b` anchors prevent
// bare-substring false positives ("egg" must NOT match "Eggplant", "water"
// must NOT match "Watermelon", "butter" must NOT match "Butternut"). Multi-word
// keywords like "egg yolk" still match across the internal space. Regex
// specials in the keyword are escaped (current keys have none — future-proofing).
function wordRe(kw: string): RegExp {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'i')
}

/** Best density default for an item, by name (category reserved for future use). */
export function lookupDensity(name: string, _category?: string | null): DensityHit {
  const n = name ?? ''
  for (const kw of KEYWORDS_BY_LENGTH) {
    if (wordRe(kw).test(n)) return { gPerMl: DENSITY_LIBRARY[kw], source: 'library' }
  }
  return { gPerMl: 1.0, source: 'fallback' }
}
