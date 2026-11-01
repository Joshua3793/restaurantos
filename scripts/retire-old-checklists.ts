import { writeFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { buildSeed, type OldItem } from '../src/lib/checklists/starter'

// One-off: retire the old opening / end-of-day lists (OpenCheckItem, EodCheckItem
// and their tick tables) in favour of the station checklists.
//
//   copy            dry run — what each revenue center would get
//   copy --apply    copy the old items into the new lists, for every RC that has
//                   no stations yet: FOOD RCs get the starter stations with the old
//                   items as their whole-kitchen list (exactly what a first open did);
//                   any other RC with old items gets just the shared list, named
//                   "Whole bar". RCs that already have stations are left alone.
//   backup <file>   write every row of the four old tables to a JSON file
//
// The old tables are read with raw SQL so this still runs after their Prisma
// models are gone. Run with:
//   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/retire-old-checklists.ts copy

const OLD_TABLES = ['OpenCheckItem', 'OpenCheckTick', 'EodCheckItem', 'EodCheckEntry'] as const

async function oldItems(table: 'OpenCheckItem' | 'EodCheckItem', rcId: string): Promise<OldItem[]> {
  return prisma.$queryRawUnsafe<OldItem[]>(
    `SELECT "section", "title", "meta", "isBlocker", "sortOrder" FROM "${table}"
     WHERE "revenueCenterId" = $1 AND "isActive" = true ORDER BY "sortOrder" ASC`,
    rcId,
  )
}

async function copy(apply: boolean) {
  const rcs = await prisma.revenueCenter.findMany({ select: { id: true, name: true, type: true } })
  for (const rc of rcs) {
    const existing = await prisma.checklistStation.count({ where: { revenueCenterId: rc.id } })
    const [open, close] = await Promise.all([oldItems('OpenCheckItem', rc.id), oldItems('EodCheckItem', rc.id)])
    const food = (rc.type ?? 'FOOD') === 'FOOD'
    if (existing > 0) {
      console.log(`${rc.name}: already has ${existing} stations — left alone (old: ${open.length} opening, ${close.length} closing)`)
      continue
    }
    if (!food && open.length === 0 && close.length === 0) {
      console.log(`${rc.name}: not a kitchen and no old items — nothing to copy`)
      continue
    }
    let rows = buildSeed(rc.id, open, close)
    if (!food) {
      const shared = rows.stations.find(s => s.isShared)!
      // Only the phases the bar actually had a list for — never the kitchen's starter jobs.
      const keep = (phase: 'OPEN' | 'CLOSE') => (phase === 'OPEN' ? open.length : close.length) > 0
      const catIds = new Set(rows.categories.filter(c => c.stationId === shared.id && keep(c.phase)).map(c => c.id))
      rows = {
        stations: [{ ...shared, name: 'Whole bar' }],
        categories: rows.categories.filter(c => catIds.has(c.id)),
        items: rows.items.filter(i => catIds.has(i.categoryId)),
      }
    }
    console.log(`${rc.name}: ${apply ? 'copying' : 'would copy'} ${open.length} opening + ${close.length} closing old items → ${rows.stations.length} stations, ${rows.categories.length} categories, ${rows.items.length} items`)
    if (apply) {
      await prisma.$transaction([
        prisma.checklistStation.createMany({ data: rows.stations, skipDuplicates: true }),
        prisma.checklistCategory.createMany({ data: rows.categories, skipDuplicates: true }),
        prisma.checklistItem.createMany({ data: rows.items, skipDuplicates: true }),
      ])
    }
  }
}

async function backup(file: string) {
  const out: Record<string, unknown[]> = {}
  for (const t of OLD_TABLES) out[t] = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${t}"`)
  writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`wrote ${file}: ${OLD_TABLES.map(t => `${t} ${out[t].length}`).join(', ')}`)
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'copy') return copy(arg === '--apply')
  if (cmd === 'backup' && arg) return backup(arg)
  throw new Error('usage: copy [--apply] | backup <file>')
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
