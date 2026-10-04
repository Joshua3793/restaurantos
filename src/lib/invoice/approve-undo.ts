// Undo records for an invoice approval. Approve captures, per row it touches,
// the state BEFORE its first write (`prev`) and AFTER its last (`next`) through
// ONE canonical selector per kind; DELETE restores `prev` only while the row
// still equals `next`. Pure except UndoCollector.flush (Prisma writes).
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'

// MATCH_RULE is LEGACY: records written before the alias table (Stage 3) still
// carry it and must keep parsing, but nothing captures it any more and rollback
// treats it as a labelled no-op. Supplier wordings are recorded as ALIAS.
export type UndoKind = 'OFFER' | 'ITEM' | 'MATCH_RULE' | 'ALIAS' | 'ITEM_CREATED'
export type Canon = Record<string, unknown>
type Db = Prisma.TransactionClient | typeof prisma

const OFFER_FIELDS = ['packQty', 'packSize', 'packUOM', 'packChain', 'pricing', 'supplierId', 'supplierItemCode', 'isPrimary', 'lastInvoiceSessionId'] as const
const ITEM_FIELDS = ['packChain', 'pricing', 'densityGPerMl'] as const
// The field set legacy MATCH_RULE records were written with (InvoiceMatchRule).
// Kept only so `currentFieldsOnly` still reads those old records.
const RULE_FIELDS = ['rawDescription', 'supplierName', 'inventoryItemId', 'invoicePackQty', 'invoicePackSize', 'invoicePackUOM', 'supplierItemCode'] as const
// ItemSupplierAlias. `useCount` is state on purpose: a later invoice that uses
// the wording again moves it, so the rollback leaves that alias alone
// ('changed-since') instead of deleting a wording another invoice relied on.
const ALIAS_FIELDS = ['inventoryItemId', 'supplierId', 'text', 'rawText', 'supplierItemCode', 'packQty', 'packSize', 'packUOM', 'useCount'] as const
const DECIMAL_FIELDS = new Set(['packQty', 'packSize', 'densityGPerMl', 'invoicePackQty', 'invoicePackSize'])

export const OFFER_SELECT = Object.fromEntries(OFFER_FIELDS.map(f => [f, true])) as Record<(typeof OFFER_FIELDS)[number], true>
export const ITEM_SELECT = Object.fromEntries(ITEM_FIELDS.map(f => [f, true])) as Record<(typeof ITEM_FIELDS)[number], true>
export const ALIAS_SELECT = Object.fromEntries(ALIAS_FIELDS.map(f => [f, true])) as Record<(typeof ALIAS_FIELDS)[number], true>

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
export type AliasRowLike = Record<string, unknown>

// The columns each kind's records cover TODAY. A record written before a column
// was retired (`InventoryItem.purchasePrice`, `InventorySupplierPrice.lastPrice`)
// still carries it in prev/next: rollback compares and restores through
// `currentFieldsOnly`, so an old record behaves exactly like a new one and a
// retired column is never written back.
const FIELDS_OF: Record<UndoKind, ReadonlySet<string>> = {
  OFFER: new Set(OFFER_FIELDS),
  ITEM: new Set(ITEM_FIELDS),
  ITEM_CREATED: new Set(ITEM_FIELDS),
  MATCH_RULE: new Set(RULE_FIELDS),
  ALIAS: new Set(ALIAS_FIELDS),
}

export function currentFieldsOnly(kind: UndoKind, state: Canon): Canon {
  const out: Canon = {}
  for (const [k, v] of Object.entries(state)) if (FIELDS_OF[kind].has(k)) out[k] = v
  return out
}

export const offerState = (row: OfferRowLike): Canon => canon(row, OFFER_FIELDS)
export const itemState = (row: ItemRowLike): Canon => canon(row, ITEM_FIELDS)
export const aliasState = (row: AliasRowLike): Canon => canon(row, ALIAS_FIELDS)

/**
 * What the approve route should record for an offer it just upserted, given
 * whether the PRE-upsert `findUnique` read actually succeeded.
 *
 * That read is wrapped in a `.catch` because a transient failure must never
 * fail the approval — but treating a failed read the same as "no existing
 * row" is a data-loss hazard: the upsert still runs (and may UPDATE a row
 * that predates this invoice), and `existing == null` would make the caller
 * think it just CREATED that row, recording `prev: null` — so a later
 * rollback would DELETE a supplier offer this approval never created. When
 * the read fails we genuinely don't know the prior state, so the only safe
 * choice is to record nothing for that offer this run (`{ kind: 'none' }`);
 * the write itself is never affected.
 */
export type OfferCaptureAction =
  | { kind: 'before'; id: string; prev: Canon }
  | { kind: 'created'; id: string }
  | { kind: 'none' }

export function offerCaptureFor(
  readOk: boolean,
  existing: (OfferRowLike & { id: string }) | null,
  upserted: { id: string } | null
): OfferCaptureAction {
  if (!readOk) return { kind: 'none' }
  if (existing) return { kind: 'before', id: existing.id, prev: offerState(existing) }
  if (upserted) return { kind: 'created', id: upserted.id }
  return { kind: 'none' }
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export function canonEqual(a: Canon | null, b: Canon | null): boolean {
  if (a === null || b === null) return a === b
  return stable(a) === stable(b)
}

// `lastNext` is the Canon this collector last PERSISTED for the entry — absent
// (`undefined`) until the first successful create. It is how a later flush
// tells "already has a row, refresh it if next moved" apart from "next never
// resolved on the first attempt, leave it alone" (the latter matches the
// entry's original give-up-on-first-miss behaviour; a row that truly
// disappeared between capture and flush was never a case this collector
// recovered from).
type Entry = { kind: UndoKind; targetId: string; prev: Canon | null; flushed: boolean; lastNext?: Canon }

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

  /**
   * Re-read `next` for EVERY touched target — flushed or not — through its
   * selector. A not-yet-flushed entry is written for the first time
   * (`createMany`, `skipDuplicates` so a race with another flush can't throw);
   * an already-flushed entry whose row moved since its last persisted `next`
   * gets that `next` refreshed in place (`updateMany`, `prev` untouched) — the
   * fix for two lines in one invoice touching the same offer/item: line 1's
   * flush would otherwise leave a stale `next₁` that line 2's write no longer
   * matches, so DELETE would skip a row this approval DID fully unwind.
   */
  async flush(): Promise<number> {
    const all = [...this.entries.values()]
    if (all.length === 0) return 0

    const idsFor = (kinds: UndoKind[]) => all.filter(e => kinds.includes(e.kind)).map(e => e.targetId)
    const offerIds = idsFor(['OFFER'])
    const itemIds = idsFor(['ITEM', 'ITEM_CREATED'])
    const aliasIds = idsFor(['ALIAS'])

    const [offers, items, aliases] = await Promise.all([
      offerIds.length
        ? this.db.inventorySupplierPrice.findMany({ where: { id: { in: offerIds } }, select: { id: true, ...OFFER_SELECT } })
        : Promise.resolve([]),
      itemIds.length
        ? this.db.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, ...ITEM_SELECT } })
        : Promise.resolve([]),
      aliasIds.length
        ? this.db.itemSupplierAlias.findMany({ where: { id: { in: aliasIds } }, select: { id: true, ...ALIAS_SELECT } })
        : Promise.resolve([]),
    ])

    const nextOf = (e: Entry): Canon | null => {
      if (e.kind === 'OFFER') {
        const r = offers.find((o: { id: string }) => o.id === e.targetId)
        return r ? offerState(r) : null
      }
      if (e.kind === 'ALIAS') {
        const r = aliases.find((o: { id: string }) => o.id === e.targetId)
        return r ? aliasState(r) : null
      }
      // Nothing captures MATCH_RULE any more; an entry of that kind has no
      // row to read and is never written.
      if (e.kind === 'MATCH_RULE') return null
      const r = items.find((o: { id: string }) => o.id === e.targetId)
      return r ? itemState(r) : null
    }

    const toCreate: {
      sessionId: string
      kind: UndoKind
      targetId: string
      prev: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue
      next: Prisma.InputJsonValue
    }[] = []
    const toUpdate: { kind: UndoKind; targetId: string; next: Canon }[] = []

    for (const e of all) {
      const next = nextOf(e)
      if (next) {
        if (!e.flushed) {
          toCreate.push({
            sessionId: this.sessionId,
            kind: e.kind,
            targetId: e.targetId,
            // Prisma: a nullable Json column takes a sentinel, not a plain
            // `null`/`undefined`, which the generated client's types reject.
            // DbNull is SQL NULL — "this row did not exist before the approval",
            // which reads back as JS `null` and is what the planner tests for.
            // JsonNull would store the JSON scalar `null`: a present value,
            // invisible to a `{ prev: null }` filter.
            prev: e.prev === null ? Prisma.DbNull : (e.prev as Prisma.InputJsonValue),
            next: next as Prisma.InputJsonValue,
          })
          e.lastNext = next
        } else if (e.lastNext !== undefined && !canonEqual(e.lastNext, next)) {
          toUpdate.push({ kind: e.kind, targetId: e.targetId, next })
          e.lastNext = next
        }
      }
      e.flushed = true
    }

    if (toCreate.length) await this.db.invoiceApproveUndo.createMany({ data: toCreate, skipDuplicates: true })
    for (const u of toUpdate) {
      await this.db.invoiceApproveUndo.updateMany({
        where: { sessionId: this.sessionId, kind: u.kind, targetId: u.targetId },
        data: { next: u.next as Prisma.InputJsonValue },
      })
    }
    return toCreate.length + toUpdate.length
  }
}
