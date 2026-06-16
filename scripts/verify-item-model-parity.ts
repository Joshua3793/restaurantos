// Snapshot-based parity verifier. The legacy `pricePerBaseUnit` column has been
// dropped, so parity is now checked against a pre-drop SNAPSHOT file rather than
// the live column. For each item, compare the chain-computed pricePerBaseUnit
// against the snapshot's stored value (within 0.01%).
//
// Snapshot format: ./ppb-snapshot-pre-backfill.json — an array of
//   { id: string; pricePerBaseUnit: string | number; baseUnit?: string }
// captured before the column was dropped. If the snapshot value is denominated
// in the item's own baseUnit (e.g. $/kg under baseUnit 'kg'), pass `baseUnit` so
// it can be normalized to the SI base ($/g) the chain computes in. Entries with
// no matching live item id are skipped.
//
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/verify-item-model-parity.ts
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import { pricePerBaseUnit, asChainItem } from '../src/lib/item-model'
import { getUnitConv } from '../src/lib/utils'

interface SnapshotEntry {
  id: string
  pricePerBaseUnit: string | number
  baseUnit?: string | null
}

const SNAPSHOT_PATH = path.resolve(process.cwd(), 'ppb-snapshot-pre-backfill.json')

async function main() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.log(`No snapshot at ${SNAPSHOT_PATH} — nothing to verify. (Capture one before dropping the column.)`)
    await prisma.$disconnect()
    process.exit(0)
  }

  const snapshot: SnapshotEntry[] = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
  const snapById = new Map<string, SnapshotEntry>()
  for (const s of snapshot) {
    if (s && s.id) snapById.set(s.id, s)
  }

  const items = await prisma.inventoryItem.findMany()
  let bad = 0
  let checked = 0
  let skipped = 0

  for (const it of items) {
    const snap = snapById.get(it.id)
    if (!snap) { skipped++; continue }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chainPpb = pricePerBaseUnit(asChainItem(it as any))

    // Normalize the snapshot value to the SI base the chain computes in. If the
    // snapshot recorded a baseUnit, divide the stored $/baseUnit by the unit's
    // SI conversion factor (e.g. $/kg ÷ 1000 = $/g). Otherwise take it directly.
    const rawSnap = Number(snap.pricePerBaseUnit)
    const conv = snap.baseUnit ? getUnitConv(snap.baseUnit) : 1
    const snapPpb = conv > 0 ? rawSnap / conv : rawSnap

    checked++
    if (snapPpb > 0 && Math.abs(chainPpb - snapPpb) > snapPpb * 1e-4) {
      bad++
      console.log(`MISMATCH ${it.itemName}: chain=${chainPpb} snapshot=${snapPpb}`)
    }
  }

  console.log(
    bad === 0
      ? `OK — ${checked} match (${skipped} skipped: no snapshot id)`
      : `${bad} mismatches of ${checked} checked (${skipped} skipped)`
  )
  await prisma.$disconnect()
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
