// Readable prep amounts and grid stepping. A leaf module (imports only uom.ts)
// so prep-plan.ts and prep-smart.ts can both use it without an import cycle.

import { canonicalUom, UNIT_FACTORS } from './uom'

interface Disp { factor: number; label: string; decimals: number }

/** How to print an amount of `unit` whose largest value is `q`:
 *  g ≥ 1000 → kg, ml ≥ 1000 → L, a tiny kg / L drops to g / ml,
 *  litres print as "L", base g / ml round to whole numbers. */
function displayFor(q: number, unit: string): Disp {
  const u = canonicalUom(unit) || (unit || '').toLowerCase()
  const a = Math.abs(q)
  if (u === 'g') return a >= 1000 ? { factor: 1 / 1000, label: 'kg', decimals: 1 } : { factor: 1, label: 'g', decimals: a < 10 ? 1 : 0 }
  if (u === 'ml') return a >= 1000 ? { factor: 1 / 1000, label: 'L', decimals: 1 } : { factor: 1, label: 'ml', decimals: a < 10 ? 1 : 0 }
  if (u === 'kg') return a > 0 && a < 0.1 ? { factor: 1000, label: 'g', decimals: 0 } : { factor: 1, label: 'kg', decimals: 1 }
  if (u === 'l') return a > 0 && a < 0.1 ? { factor: 1000, label: 'ml', decimals: 0 } : { factor: 1, label: 'L', decimals: 1 }
  const f = UNIT_FACTORS[u]
  return { factor: 1, label: unit, decimals: f && f.dim !== 'count' ? 1 : 2 }
}

const num = (q: number, decimals: number) =>
  q.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 0 })

/** "17.1 kg" (17055 g), "2 kg", "900 g", "0.5 L", "49 each", "1.5 batch". */
export function fmtAmount(q: number, unit: string): string {
  const d = displayFor(q, unit)
  return `${num(q * d.factor, d.decimals)} ${d.label}`
}

/** "17.1 of 2 kg" — both numbers in the unit the larger one reads best in. */
export function fmtAmountOf(have: number, need: number, unit: string): string {
  const d = displayFor(Math.max(Math.abs(have), Math.abs(need)), unit)
  return `${num(have * d.factor, d.decimals)} of ${num(need * d.factor, d.decimals)} ${d.label}`
}

const EPS = 1e-9

/** + lands on the next multiple of `step`, − on the one below, never under one
 *  step: 1.3 → 1.5 → 2 (step ½); 1.3 − → 1 → ½. */
export function stepOnGrid(val: number, step: number, dir: 1 | -1): number {
  const k = val / step
  const next = dir === 1 ? (Math.floor(k + EPS) + 1) * step : (Math.ceil(k - EPS) - 1) * step
  return +Math.max(step, next).toFixed(2)
}

export function onGrid(val: number, step: number): boolean {
  const k = val / step
  return Math.abs(k - Math.round(k)) < 1e-6
}
