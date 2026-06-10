export interface AllergenDef {
  key: string   // matches DB value e.g. "Wheat/Gluten"
  label: string // full display name
  abbr: string  // 3-letter badge label
  bg: string    // Tailwind bg class (kept for reference)
  hex: string   // inline background color — avoids Tailwind purge issues
  dark: boolean // true → white text, false → dark text
}

// Health Canada priority food allergens. "Shellfish" covers both crustaceans and
// molluscs; "Wheat/Gluten" covers all gluten cereals (wheat, rye, barley, oats,
// triticale). Mustard and Sulphites are Canadian priority allergens not on the
// US FDA top-9 list.
export const ALLERGENS: AllergenDef[] = [
  { key: 'Wheat/Gluten', label: 'Wheat / Gluten', abbr: 'GLU', bg: 'bg-gold',  hex: '#f59e0b', dark: true  },
  { key: 'Milk',         label: 'Milk',            abbr: 'MLK', bg: 'bg-blue',    hex: '#0ea5e9', dark: true  },
  { key: 'Eggs',         label: 'Eggs',            abbr: 'EGG', bg: 'bg-yellow-400', hex: '#facc15', dark: false },
  { key: 'Peanuts',      label: 'Peanuts',         abbr: 'PNT', bg: 'bg-gold', hex: '#f97316', dark: true  },
  { key: 'Tree Nuts',    label: 'Tree Nuts',       abbr: 'NUT', bg: 'bg-ink-3',  hex: '#78716c', dark: true  },
  { key: 'Sesame',       label: 'Sesame',          abbr: 'SES', bg: 'bg-green',   hex: '#84cc16', dark: true  },
  { key: 'Soy',          label: 'Soy',             abbr: 'SOY', bg: 'bg-green',  hex: '#16a34a', dark: true  },
  { key: 'Fish',         label: 'Fish',            abbr: 'FSH', bg: 'bg-green',   hex: '#14b8a6', dark: true  },
  { key: 'Shellfish',    label: 'Shellfish',       abbr: 'SHL', bg: 'bg-red',    hex: '#ef4444', dark: true  },
  { key: 'Mustard',      label: 'Mustard',         abbr: 'MUS', bg: 'bg-gold',  hex: '#b45309', dark: true  },
  { key: 'Sulphites',    label: 'Sulphites',       abbr: 'SUL', bg: 'bg-ink-3', hex: '#9333ea', dark: true  },
]

export const ALLERGEN_MAP = Object.fromEntries(ALLERGENS.map(a => [a.key, a]))
