/**
 * The payout history stored in `TipPeriod.snapshot`.
 *
 * PURE — no Prisma, no `server-only`, so both the route handlers and the tests
 * can use it directly. Route files may only export HTTP handlers, which is why
 * this lives here rather than beside the pay route.
 *
 * WHY A HISTORY AT ALL. Cash physically leaves the building at pay time. A
 * period can be reopened, edited and paid again, and each of those is a real,
 * separate disbursement that somebody signed for. The previous shape stored a
 * single flat `{paidAt, split, audit, …}` object, so:
 *   - reopen nulled `TipPeriod.paidByName` and the snapshot never carried it,
 *     which erased who authorised the disbursement after ONE reopen; and
 *   - the next pay overwrote the snapshot wholesale, destroying the only
 *     record of what was actually handed out in envelopes the first time.
 * Both are payroll-record losses, so the history is bounded and ordered rather
 * than a single slot. `TipPeriod.snapshot` is a Json column, so this is a
 * restructure of what is stored — no schema migration.
 */
import type { TipPayoutRecord, TipPeriodSnapshot } from './types'

/**
 * Total payouts retained (`history` + `current`). A period paid this many
 * times is already pathological; the cap stops one runaway period from growing
 * an unbounded Json blob, and `trimmed` records what fell off.
 */
export const MAX_PAYOUT_HISTORY = 10

const EMPTY: TipPeriodSnapshot = { version: 1, current: null, history: [], trimmed: 0 }

/** A record-shaped object, or null. Used to sniff the stored Json defensively. */
function asObject(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

/**
 * Normalizes whatever is in the Json column into the v1 shape.
 *
 * A snapshot written before this history existed is a FLAT payout object with
 * no `version` — periods paid under that shape are already in the live
 * database, so it is migrated on read into payout #1. It has no `paidByName`
 * (that is the bug being fixed), so the authoriser reads as null rather than
 * being invented: an unknown authoriser must look unknown.
 *
 * `current` vs the row's status is NOT reconciled here. The caller owns that:
 * `readSnapshot` is a pure decoder, and the pay/reopen writers below are the
 * only things that move a payout between `current` and `history`.
 */
export function readSnapshot(raw: unknown): TipPeriodSnapshot | null {
  const obj = asObject(raw)
  if (!obj) return null

  if (obj.version === 1) {
    const history = Array.isArray(obj.history) ? (obj.history as TipPayoutRecord[]) : []
    return {
      version: 1,
      current: (asObject(obj.current) as unknown as TipPayoutRecord | null) ?? null,
      history,
      trimmed: Number(obj.trimmed) || 0,
    }
  }

  // Legacy flat payout (pre-history). Only migrate if it actually looks like
  // one — an unrecognisable blob is safer reported as "no snapshot" than
  // presented to a manager as a payout record.
  if (!obj.split) return null
  const legacy = {
    seq: 1,
    paidAt: typeof obj.paidAt === 'string' ? obj.paidAt : new Date(0).toISOString(),
    paidByName: null,
    ...obj,
  } as unknown as TipPayoutRecord
  return { version: 1, current: legacy, history: [], trimmed: 0 }
}

/** The payouts in chronological order, oldest first. `current` is always last. */
export function payoutsInOrder(snap: TipPeriodSnapshot | null): TipPayoutRecord[] {
  if (!snap) return []
  return snap.current ? [...snap.history, snap.current] : [...snap.history]
}

/** The next `seq` — one past the highest ever issued, so numbers are never reused. */
export function nextSeq(snap: TipPeriodSnapshot | null): number {
  const all = payoutsInOrder(snap)
  return all.reduce((max, p) => Math.max(max, Number(p.seq) || 0), snap?.trimmed ?? 0) + 1
}

/**
 * Records a new payout as the one in force, pushing any previous `current`
 * onto `history`. Never destroys an earlier payout except via the cap, which
 * is counted in `trimmed`.
 */
export function appendPayout(
  raw: unknown,
  record: Omit<TipPayoutRecord, 'seq'>,
): TipPeriodSnapshot {
  const snap = readSnapshot(raw) ?? EMPTY
  const history = snap.current ? [...snap.history, snap.current] : [...snap.history]
  const current: TipPayoutRecord = { seq: nextSeq(snap), ...record }

  // Cap counts current too, so `history` may hold at most MAX - 1.
  let trimmed = snap.trimmed
  while (history.length > MAX_PAYOUT_HISTORY - 1) {
    history.shift()
    trimmed += 1
  }
  return { version: 1, current, history, trimmed }
}

/**
 * Reopen: the payout stays on the record, it just stops being the one in
 * force. `current` going null is what makes the period stop LOOKING paid to
 * anything reading the snapshot — the old code left a fully populated frozen
 * payout hanging off a DRAFT period.
 */
export function reopenSnapshot(raw: unknown): TipPeriodSnapshot | null {
  const snap = readSnapshot(raw)
  if (!snap) return null
  if (!snap.current) return snap
  return { ...snap, current: null, history: [...snap.history, snap.current] }
}
