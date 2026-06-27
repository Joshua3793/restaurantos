/**
 * One-off repair: `PrepItem.isOnList` historically stayed `true` after an item
 * was completed — only *removing* ever cleared it. That left finished items
 * stuck showing "On list" in Smart Prep forever.
 *
 * New rule: `isOnList` tracks whether an item is actionable on the current list.
 * Completing (DONE/PARTIAL) or removing (SKIPPED) clears it; starting/resetting
 * re-arms it.
 *
 * Fix: for every item with `isOnList = true`, look at its LATEST prep log. If that
 * log is terminal (DONE / PARTIAL / SKIPPED), the item was completed or removed and
 * never re-armed → clear `isOnList`. Items whose latest action is NOT_STARTED /
 * IN_PROGRESS (genuinely pending) are left on the list.
 *
 * Dry-run by default. Set APPLY=1 to write.
 */
import { prisma } from '../src/lib/prisma'

const TERMINAL = new Set(['DONE', 'PARTIAL', 'SKIPPED'])

async function main() {
  const apply = process.env.APPLY === '1'
  const items = await prisma.prepItem.findMany({
    where: { isOnList: true },
    select: { id: true, name: true },
  })

  const toClear: { id: string; name: string; status: string }[] = []
  for (const item of items) {
    const latest = await prisma.prepLog.findFirst({
      where: { prepItemId: item.id },
      orderBy: [{ logDate: 'desc' }, { createdAt: 'desc' }],
      select: { status: true },
    })
    if (latest && TERMINAL.has(latest.status)) {
      toClear.push({ id: item.id, name: item.name, status: latest.status })
    }
  }

  console.log(`${items.length} items currently on the list.`)
  console.log(`${toClear.length} have a terminal latest log → will be cleared:`)
  for (const c of toClear) console.log(`  - ${c.name} (latest: ${c.status})`)

  if (!apply) {
    console.log('\nDry run. Set APPLY=1 to write.')
    return
  }
  if (toClear.length > 0) {
    const res = await prisma.prepItem.updateMany({
      where: { id: { in: toClear.map(c => c.id) } },
      data: { isOnList: false },
    })
    console.log(`\nCleared isOnList on ${res.count} items.`)
  }
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
