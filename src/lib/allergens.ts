// src/lib/allergens.ts
export interface AllergenDef {
  key: string      // matches DB value e.g. "Wheat/Gluten"
  label: string    // full display name
  abbr: string     // 3-letter badge label
  bg: string       // Tailwind bg class (must be full class name for purge safety)
  text: string     // Tailwind text class for tooltip contrast
}

export const ALLERGENS: AllergenDef[] = [
  { key: 'Wheat/Gluten', label: 'Wheat / Gluten', abbr: 'GLU', bg: 'bg-amber-500',  text: 'text-white' },
  { key: 'Milk',         label: 'Milk',            abbr: 'MLK', bg: 'bg-sky-500',    text: 'text-white' },
  { key: 'Eggs',         label: 'Eggs',            abbr: 'EGG', bg: 'bg-yellow-400', text: 'text-gray-900' },
  { key: 'Peanuts',      label: 'Peanuts',         abbr: 'PNT', bg: 'bg-orange-500', text: 'text-white' },
  { key: 'Tree Nuts',    label: 'Tree Nuts',       abbr: 'NUT', bg: 'bg-stone-500',  text: 'text-white' },
  { key: 'Sesame',       label: 'Sesame',          abbr: 'SES', bg: 'bg-lime-500',   text: 'text-white' },
  { key: 'Soy',          label: 'Soy',             abbr: 'SOY', bg: 'bg-green-600',  text: 'text-white' },
  { key: 'Fish',         label: 'Fish',            abbr: 'FSH', bg: 'bg-teal-500',   text: 'text-white' },
  { key: 'Shellfish',    label: 'Shellfish',       abbr: 'SHL', bg: 'bg-red-500',    text: 'text-white' },
]

export const ALLERGEN_MAP = Object.fromEntries(ALLERGENS.map(a => [a.key, a]))
