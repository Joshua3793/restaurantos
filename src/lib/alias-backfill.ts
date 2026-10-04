// Pure planner for scripts/backfill-item-supplier-aliases.ts: turns the old
// InvoiceMatchRule rows into ItemSupplierAlias rows. No DB access here.
import { normaliseAliasText } from '@/lib/alias-text'
import { normItemCode } from '@/lib/invoice/line-format'

export type DecimalLike = number | string | { toString(): string } | null

export interface BackfillRule {
  id: string
  rawDescription: string
  supplierName: string
  inventoryItemId: string
  useCount: number
  lastUsed: Date
  invoicePackQty: DecimalLike
  invoicePackSize: DecimalLike
  invoicePackUOM: string | null
  supplierItemCode: string | null
  item: { itemName: string; isActive: boolean; mergedIntoId: string | null; hasRecipe: boolean }
}

export interface NamedSupplier { id: string; name: string }
export interface NamedSupplierAlias { supplierId: string; name: string }

export interface AliasRow {
  inventoryItemId: string
  supplierId: string
  text: string
  rawText: string
  supplierItemCode: string | null
  packQty: string | null
  packSize: string | null
  packUOM: string | null
  source: 'BACKFILL'
  useCount: number
  lastUsed: Date
}

export type UnresolvedReason = 'no supplier' | 'unknown supplier' | 'ambiguous supplier' | 'blank wording'
export type SkipReason = 'merged item' | 'recipe-made item'

export interface BackfillPlan {
  rows: AliasRow[]
  /** keys where several rules collapsed into one alias (the kept rule first) */
  collisions: { supplierId: string; text: string; kept: BackfillRule; folded: BackfillRule[]; differentItems: boolean }[]
  unresolved: { rule: BackfillRule; reason: UnresolvedReason }[]
  skipped: { rule: BackfillRule; reason: SkipReason }[]
  /** supplier codes that land on more than one item for one supplier (information only) */
  sharedCodes: { supplierId: string; code: string; itemIds: string[] }[]
}

const lc = (s: string) => s.trim().toLowerCase()
const dec = (v: DecimalLike): string | null => (v == null ? null : String(v))

/** Supplier string → id: exact Supplier.name (case-insensitive), else exact
 *  SupplierAlias.name (case-insensitive). Two candidates ⇒ ambiguous. */
export function makeSupplierResolver(suppliers: NamedSupplier[], aliases: NamedSupplierAlias[]) {
  const byName = new Map<string, Set<string>>()
  for (const s of suppliers) {
    const k = lc(s.name)
    if (!byName.has(k)) byName.set(k, new Set())
    byName.get(k)!.add(s.id)
  }
  const byAlias = new Map<string, Set<string>>()
  for (const a of aliases) {
    const k = lc(a.name)
    if (!byAlias.has(k)) byAlias.set(k, new Set())
    byAlias.get(k)!.add(a.supplierId)
  }
  return (name: string): { supplierId: string } | { reason: UnresolvedReason } => {
    const k = lc(name ?? '')
    if (!k) return { reason: 'no supplier' }
    const hit = byName.get(k) ?? byAlias.get(k)
    if (!hit) return { reason: 'unknown supplier' }
    if (hit.size > 1) return { reason: 'ambiguous supplier' }
    return { supplierId: [...hit][0] }
  }
}

export function planAliasBackfill(
  rules: BackfillRule[],
  suppliers: NamedSupplier[],
  supplierAliases: NamedSupplierAlias[],
): BackfillPlan {
  const resolve = makeSupplierResolver(suppliers, supplierAliases)
  const unresolved: BackfillPlan['unresolved'] = []
  const skipped: BackfillPlan['skipped'] = []
  const groups = new Map<string, { supplierId: string; text: string; rules: BackfillRule[] }>()

  for (const rule of rules) {
    if (rule.item.mergedIntoId) { skipped.push({ rule, reason: 'merged item' }); continue }
    if (rule.item.hasRecipe) { skipped.push({ rule, reason: 'recipe-made item' }); continue }
    const r = resolve(rule.supplierName)
    if ('reason' in r) { unresolved.push({ rule, reason: r.reason }); continue }
    const text = normaliseAliasText(rule.rawDescription)
    if (!text) { unresolved.push({ rule, reason: 'blank wording' }); continue }
    const key = `${r.supplierId}\u0000${text}`
    if (!groups.has(key)) groups.set(key, { supplierId: r.supplierId, text, rules: [] })
    groups.get(key)!.rules.push(rule)
  }

  const rows: AliasRow[] = []
  const collisions: BackfillPlan['collisions'] = []
  for (const g of groups.values()) {
    // Highest useCount wins; ties → most recently used, then id for stability.
    const sorted = [...g.rules].sort((a, b) =>
      b.useCount - a.useCount || b.lastUsed.getTime() - a.lastUsed.getTime() || a.id.localeCompare(b.id))
    const kept = sorted[0]
    rows.push({
      inventoryItemId: kept.inventoryItemId,
      supplierId: g.supplierId,
      text: g.text,
      rawText: kept.rawDescription,
      supplierItemCode: normItemCode(kept.supplierItemCode) || null,
      packQty: dec(kept.invoicePackQty),
      packSize: dec(kept.invoicePackSize),
      packUOM: kept.invoicePackUOM ?? null,
      source: 'BACKFILL',
      useCount: g.rules.reduce((s, r) => s + r.useCount, 0),
      lastUsed: new Date(Math.max(...g.rules.map(r => r.lastUsed.getTime()))),
    })
    if (sorted.length > 1) {
      collisions.push({
        supplierId: g.supplierId, text: g.text, kept, folded: sorted.slice(1),
        differentItems: sorted.some(r => r.inventoryItemId !== kept.inventoryItemId),
      })
    }
  }

  const codeItems = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.supplierItemCode) continue
    const k = `${row.supplierId}\u0000${row.supplierItemCode}`
    if (!codeItems.has(k)) codeItems.set(k, new Set())
    codeItems.get(k)!.add(row.inventoryItemId)
  }
  const sharedCodes = [...codeItems.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([k, ids]) => { const [supplierId, code] = k.split('\u0000'); return { supplierId, code, itemIds: [...ids] } })

  return { rows, collisions, unresolved, skipped, sharedCodes }
}
