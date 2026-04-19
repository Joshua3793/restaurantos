export interface AllergenDef {
  key: string   // matches DB value e.g. "Wheat/Gluten"
  label: string // full display name
  abbr: string  // 3-letter badge label
  bg: string    // Tailwind bg class (kept for reference)
  hex: string   // inline background color — avoids Tailwind purge issues
  dark: boolean // true → white text, false → dark text
}

export const ALLERGENS: AllergenDef[] = [
  { key: 'Wheat/Gluten', label: 'Wheat / Gluten', abbr: 'GLU', bg: 'bg-amber-500',  hex: '#f59e0b', dark: true  },
  { key: 'Milk',         label: 'Milk',            abbr: 'MLK', bg: 'bg-sky-500',    hex: '#0ea5e9', dark: true  },
  { key: 'Eggs',         label: 'Eggs',            abbr: 'EGG', bg: 'bg-yellow-400', hex: '#facc15', dark: false },
  { key: 'Peanuts',      label: 'Peanuts',         abbr: 'PNT', bg: 'bg-orange-500', hex: '#f97316', dark: true  },
  { key: 'Tree Nuts',    label: 'Tree Nuts',       abbr: 'NUT', bg: 'bg-stone-500',  hex: '#78716c', dark: true  },
  { key: 'Sesame',       label: 'Sesame',          abbr: 'SES', bg: 'bg-lime-500',   hex: '#84cc16', dark: true  },
  { key: 'Soy',          label: 'Soy',             abbr: 'SOY', bg: 'bg-green-600',  hex: '#16a34a', dark: true  },
  { key: 'Fish',         label: 'Fish',            abbr: 'FSH', bg: 'bg-teal-500',   hex: '#14b8a6', dark: true  },
  { key: 'Shellfish',    label: 'Shellfish',       abbr: 'SHL', bg: 'bg-red-500',    hex: '#ef4444', dark: true  },
]

export const ALLERGEN_MAP = Object.fromEntries(ALLERGENS.map(a => [a.key, a]))
