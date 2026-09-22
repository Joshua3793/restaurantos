// Undo records for an invoice approval. Approve captures, per row it touches,
// the state BEFORE its first write (`prev`) and AFTER its last (`next`) through
// ONE canonical selector per kind; DELETE restores `prev` only while the row
// still equals `next`. Pure except UndoCollector.flush (Prisma writes).
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'

export type UndoKind = 'OFFER' | 'ITEM' | 'MATCH_RULE' | 'ITEM_CREATED'
export type Canon = Record<string, unknown>
type Db = Prisma.TransactionClient | typeof prisma

const OFFER_FIELDS = ['lastPrice', 'packQty', 'packSize', 'packUOM', 'packChain', 'pricing', 'supplierId', 'supplierItemCode', 'isPrimary', 'lastInvoiceSessionId'] as const
const ITEM_FIELDS = ['packChain', 'pricing', 'purchasePrice', 'densityGPerMl'] as const
const RULE_FIELDS = ['rawDescription', 'supplierName', 'inventoryItemId', 'invoicePackQty', 'invoicePackSize', 'invoicePackUOM', 'supplierItemCode'] as const
const DECIMAL_FIELDS = new Set(['lastPrice', 'packQty', 'packSize', 'purchasePrice', 'densityGPerMl', 'invoicePackQty', 'invoicePackSize'])

export const OFFER_SELECT = Object.fromEntries(OFFER_FIELDS.map(f => [f, true])) as Record<(typeof OFFER_FIELDS)[number], true>
export const ITEM_SELECT = Object.fromEntries(ITEM_FIELDS.map(f => [f, true])) as Record<(typeof ITEM_FIELDS)[number], true>
export const RULE_SELECT = Object.fromEntries(RULE_FIELDS.map(f => [f, true])) as Record<(typeof RULE_FIELDS)[number], true>

/**
 * Plain, sorted, Decimal-free: the same input always canonicalises identically.
 * Json-column values are round-tripped through JSON so a Prisma.Decimal nested
 * inside one (there are none in the fields above today) would serialize via its
 * own toJSON() rather than crash, instead of surviving as a class instance.
 */
function canon(row: Record<string, unknown>, fields: readonly string[]): Canon {
  const out: Canon = {}
  for (const f of [...fields].sort()) {
    const v = row[f]
    if (v === undefined || v === null) out[f] = null
    else if (DECIMAL_FIELDS.has(f)) out[f] = Number(v as Prisma.Decimal | number | string)
    else out[f] = JSON.parse(JSON.stringify(v)) // Json columns: strip Prisma wrappers, keep structure
  }
  return out
}

export type OfferRowLike = Record<string, unknown>
export type ItemRowLike = Record<string, unknown>
export type RuleRowLike = Record<string, unknown>

export const offerState = (row: OfferRowLike): Canon => canon(row, OFFER_FIELDS)
export const itemState = (row: ItemRowLike): Canon => canon(row, ITEM_FIELDS)
export const ruleState = (row: RuleRowLike): Canon => canon(row, RULE_FIELDS)

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export function canonEqual(a: Canon | null, b: Canon | null): boolean {
  if (a === null || b === null) return a === b
  return stable(a) === stable(b)
}

type Entry = { kind: UndoKind; targetId: string; prev: Canon | null; flushed: boolean }

export class UndoCollector {
  private entries = new Map<string, Entry>()

  constructor(
    private sessionId: string,
    private db: Db = prisma
  ) {}

  /** Call BEFORE the first write to a target. Later calls for the same target are ignored. */
  before(kind: UndoKind, targetId: string, prev: Canon): void {
    const k = `${kind}|${targetId}`
    if (!this.entries.has(k)) this.entries.set(k, { kind, targetId, prev, flushed: false })
  }

  /** A row this approval created (its id is known only after the create). */
  created(kind: UndoKind, targetId: string): void {
    const k = `${kind}|${targetId}`
    if (!this.entries.has(k)) this.entries.set(k, { kind, targetId, prev: null, flushed: false })
  }

  /** Read `next` for every unflushed entry through its selector and write the records. */
  async flush(): Promise<number> {
    const pending = [...this.entries.values()].filter(e => !e.flushed)
    if (pending.length === 0) return 0

    const idsFor = (kinds: UndoKind[]) => pending.filter(e => kinds.includes(e.kind)).map(e => e.targetId)
    const offerIds = idsFor(['OFFER'])
    const itemIds = idsFor(['ITEM', 'ITEM_CREATED'])
    const ruleIds = idsFor(['MATCH_RULE'])

    const [offers, items, rules] = await Promise.all([
      offerIds.length
        ? this.db.inventorySupplierPrice.findMany({ where: { id: { in: offerIds } }, select: { id: true, ...OFFER_SELECT } })
        : Promise.resolve([]),
      itemIds.length
        ? this.db.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, ...ITEM_SELECT } })
        : Promise.resolve([]),
      ruleIds.length
        ? this.db.invoiceMatchRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, ...RULE_SELECT } })
        : Promise.resolve([]),
    ])

    const nextOf = (e: Entry): Canon | null => {
      if (e.kind === 'OFFER') {
        const r = offers.find((o: { id: string }) => o.id === e.targetId)
        return r ? offerState(r) : null
      }
      if (e.kind === 'MATCH_RULE') {
        const r = rules.find((o: { id: string }) => o.id === e.targetId)
        return r ? ruleState(r) : null
      }
      const r = items.find((o: { id: string }) => o.id === e.targetId)
      return r ? itemState(r) : null
    }

    const data = pending.flatMap(e => {
      const next = nextOf(e)
      if (!next) return []
      const row: {
        sessionId: string
        kind: UndoKind
        targetId: string
        prev: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue
        next: Prisma.InputJsonValue
      } = {
        sessionId: this.sessionId,
        kind: e.kind,
        targetId: e.targetId,
        // Prisma: a nullable Json column takes Prisma.JsonNull for SQL NULL —
        // passing a plain `null`/`undefined` is rejected by the generated client's types.
        prev: e.prev === null ? Prisma.JsonNull : (e.prev as Prisma.InputJsonValue),
        next: next as Prisma.InputJsonValue,
      }
      return [row]
    })

    if (data.length) await this.db.invoiceApproveUndo.createMany({ data, skipDuplicates: true })
    pending.forEach(e => {
      e.flushed = true
    })
    return data.length
  }
}
