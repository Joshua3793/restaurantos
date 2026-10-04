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

/** One (supplierId, text) key: its rules sorted kept-first (highest useCount,
 *  then latest lastUsed, then id) and the alias row the backfill builds. */
export interface AliasGroup { supplierId: string; text: string; rules: BackfillRule[]; row: AliasRow }

export interface BackfillPlan {
  rows: AliasRow[]
  groups: AliasGroup[]
  /** keys where several rules collapsed into one alias (the kept rule first) */
  collisions: { supplierId: string; text: string; kept: BackfillRule; folded: BackfillRule[]; differentItems: boolean }[]
  unresolved: { rule: BackfillRule; reason: UnresolvedReason }[]
  skipped: { rule: BackfillRule; reason: SkipReason }[]
  /** supplier codes that land on more than one item for one supplier (information only) */
  sharedCodes: { supplierId: string; code: string; itemIds: string[] }[]
}

const lc = (s: string) => s.trim().toLowerCase()
const dec = (v: DecimalLike): string | null => (v == null ? null : String(v))
const codeOf = (r: BackfillRule): string | null => normItemCode(r.supplierItemCode) || null
type Pack = Pick<AliasRow, 'packQty' | 'packSize' | 'packUOM'>
const packOf = (r: BackfillRule): Pack =>
  ({ packQty: dec(r.invoicePackQty), packSize: dec(r.invoicePackSize), packUOM: r.invoicePackUOM ?? null })
const packIsSet = (p: { packQty: DecimalLike; packSize: DecimalLike; packUOM: string | null }) =>
  p.packQty != null || p.packSize != null || !!(p.packUOM ?? '').trim()
const ruleHasPack = (r: BackfillRule) => packIsSet(packOf(r))

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
  const planned: AliasGroup[] = []
  const collisions: BackfillPlan['collisions'] = []
  for (const g of groups.values()) {
    // Highest useCount wins; ties → most recently used, then id for stability.
    const sorted = [...g.rules].sort((a, b) =>
      b.useCount - a.useCount || b.lastUsed.getTime() - a.lastUsed.getTime() || a.id.localeCompare(b.id))
    const kept = sorted[0]
    // The kept rule may carry no code/pack while a folded spelling of the SAME
    // item does: borrow it (first by useCount) rather than lose it. Never from
    // a folded rule on another item — that code names a different product.
    const sameItem = sorted.filter(r => r.inventoryItemId === kept.inventoryItemId)
    const codeSrc = sameItem.find(r => codeOf(r))
    const packSrc = sameItem.find(ruleHasPack)
    const row: AliasRow = {
      inventoryItemId: kept.inventoryItemId,
      supplierId: g.supplierId,
      text: g.text,
      rawText: kept.rawDescription,
      supplierItemCode: codeSrc ? codeOf(codeSrc) : null,
      ...(packSrc ? packOf(packSrc) : packOf(kept)),
      source: 'BACKFILL',
      useCount: g.rules.reduce((s, r) => s + r.useCount, 0),
      lastUsed: new Date(Math.max(...g.rules.map(r => r.lastUsed.getTime()))),
    }
    rows.push(row)
    planned.push({ supplierId: g.supplierId, text: g.text, rules: sorted, row })
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

  return { rows, groups: planned, collisions, unresolved, skipped, sharedCodes }
}

// ── Catch-up (--update) ──────────────────────────────────────────────────────
// Invoices approved between the backfill and the matcher switch still wrote
// InvoiceMatchRule. This re-reads the rules against the aliases already there.

export interface ExistingAlias {
  id: string
  supplierId: string
  text: string
  inventoryItemId: string
  rawText: string
  supplierItemCode: string | null
  packQty: DecimalLike
  packSize: DecimalLike
  packUOM: string | null
  useCount: number
  lastUsed: Date
}

export type AliasUpdateData = Partial<Pick<AliasRow,
  'inventoryItemId' | 'rawText' | 'supplierItemCode' | 'packQty' | 'packSize' | 'packUOM' | 'useCount' | 'lastUsed'>>

export interface AliasUpdate {
  id: string
  supplierId: string
  text: string
  /** 'newer rule' — a rule on this key was used after the alias; 'fill' — only
   *  a missing code/pack was filled from a rule on the alias's own item. */
  reason: 'newer rule' | 'fill'
  itemChanged: boolean
  data: AliasUpdateData
}

/**
 * Plan the catch-up against the aliases already in the table, per key
 * (supplierId, normalised text) — pass `planAliasBackfill(..).groups`:
 *  - no alias on the key → create the backfill row as before;
 *  - a rule on the key used AFTER the alias (lastUsed strictly newer) → the
 *    newest such rule wins: item, wording, code (when it has one), pack (when
 *    it has one), lastUsed; useCount becomes the key's summed count when larger;
 *  - either way, a NULL code / empty pack is filled from the first rule (by
 *    useCount) on the alias's resulting item that has one.
 * Only fields that actually change are written; a key with none is left alone.
 */
export function planAliasUpdates(
  groups: AliasGroup[],
  existingAliases: ExistingAlias[],
): { creates: AliasRow[]; updates: AliasUpdate[] } {
  const byKey = new Map(existingAliases.map(a => [`${a.supplierId}\u0000${a.text}`, a]))
  const creates: AliasRow[] = []
  const updates: AliasUpdate[] = []

  for (const g of groups) {
    const e = byKey.get(`${g.supplierId}\u0000${g.text}`)
    if (!e) { creates.push(g.row); continue }

    const data: AliasUpdateData = {}
    let itemId = e.inventoryItemId
    let code = e.supplierItemCode || null
    let pack: { packQty: DecimalLike; packSize: DecimalLike; packUOM: string | null } =
      { packQty: e.packQty, packSize: e.packSize, packUOM: e.packUOM }

    const newest = g.rules
      .filter(r => r.lastUsed.getTime() > e.lastUsed.getTime())
      .sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime() || b.useCount - a.useCount || a.id.localeCompare(b.id))[0]
    if (newest) {
      itemId = newest.inventoryItemId
      if (itemId !== e.inventoryItemId) data.inventoryItemId = itemId
      if (newest.rawDescription !== e.rawText) data.rawText = newest.rawDescription
      if (codeOf(newest)) code = codeOf(newest)
      if (ruleHasPack(newest)) pack = packOf(newest)
      const summed = g.rules.reduce((s, r) => s + r.useCount, 0)
      if (summed > e.useCount) data.useCount = summed
      data.lastUsed = newest.lastUsed
    }

    // g.rules is kept-first, i.e. by useCount — the fill takes the first one.
    const sameItem = g.rules.filter(r => r.inventoryItemId === itemId)
    if (!code) code = sameItem.map(codeOf).find(Boolean) ?? null
    if (!packIsSet(pack)) { const src = sameItem.find(ruleHasPack); if (src) pack = packOf(src) }

    if (code !== (e.supplierItemCode || null)) data.supplierItemCode = code
    const next = { packQty: dec(pack.packQty), packSize: dec(pack.packSize), packUOM: pack.packUOM ?? null }
    if (next.packQty !== dec(e.packQty) || next.packSize !== dec(e.packSize) || next.packUOM !== (e.packUOM ?? null)) {
      Object.assign(data, next)
    }

    if (Object.keys(data).length === 0) continue
    updates.push({
      id: e.id, supplierId: g.supplierId, text: g.text,
      reason: newest ? 'newer rule' : 'fill',
      itemChanged: itemId !== e.inventoryItemId,
      data,
    })
  }
  return { creates, updates }
}
