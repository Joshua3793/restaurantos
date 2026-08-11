/**
 * Put every item touched by `repair-inventory-formats.ts --apply` back exactly
 * as it was, from that run's backup file.
 *
 *   dry run:  npx ts-node -r tsconfig-paths/register scripts/revert-inventory-repair.ts docs/audits/repair-backup-<stamp>.json
 *   apply:    ... scripts/revert-inventory-repair.ts docs/audits/repair-backup-<stamp>.json --apply
 *
 * The backup records packChain, pricing and countUnit per item — the three
 * fields the repair writes — so a revert is a straight restore, not a guess.
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit, type PackLink } from '../src/lib/item-model'

const APPLY = process.argv.includes('--apply')
const FILE = process.argv.find((a) => a.endsWith('.json'))

interface Entry {
  id: string; name: string
  packChain: PackLink[]; pricing: unknown; countUnit: string; ppbDisplay: string
}

async function main() {
  if (!FILE) {
    console.error('Usage: revert-inventory-repair.ts <repair-backup-*.json> [--apply]')
    process.exit(1)
  }
  const p = path.resolve(process.cwd(), FILE)
  const entries: Entry[] = JSON.parse(fs.readFileSync(p, 'utf8'))
  console.log(`${APPLY ? 'REVERTING' : 'DRY RUN — would revert'} ${entries.length} items from ${path.basename(p)}\n`)

  for (const e of entries) {
    const live = await prisma.inventoryItem.findUnique({ where: { id: e.id } })
    if (!live) { console.log(`  MISSING  ${e.name} (item no longer exists — skipped)`); continue }
    const nowPpb = pricePerBaseUnit(asChainItem(live))
    console.log(`  ${e.name.padEnd(34)} now ${JSON.stringify(live.packChain)} → back to ${JSON.stringify(e.packChain)}  (${e.ppbDisplay})`)
    void nowPpb
    if (!APPLY) continue
    await prisma.inventoryItem.update({
      where: { id: e.id },
      data: {
        packChain: e.packChain as unknown as object,
        pricing: e.pricing as object,
        countUnit: e.countUnit,
        lastUpdated: new Date(),
      },
    })
  }
  if (APPLY) console.log(`\nReverted ${entries.length} items.`)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
