import { prisma } from '../src/lib/prisma'

// Default close-down checklist (checkbox/blocker only — temperature rows are
// handled by the reused Temps gate, NOT seeded here). Seeded per active RC,
// idempotently (skips an RC that already has items).
const DEFAULTS: { section: string; title: string; meta?: string; isBlocker?: boolean }[] = [
  { section: 'Food safety & close-down', title: 'Hot food blast-chilled & date-labelled', meta: 'stocks · sauces · 90 min rule' },
  { section: 'Food safety & close-down', title: 'Food-safety log signed off', meta: 'cleaning + temps · daily record', isBlocker: true },
  { section: 'Clean-down', title: 'Line & prep surfaces sanitised', meta: 'all stations · dated buckets emptied' },
  { section: 'Clean-down', title: 'Grill, fryer & flat-top cleaned', meta: 'oil filtered' },
  { section: 'Clean-down', title: 'Floors mopped · bins & recycling out', meta: 'kitchen + FOH' },
  { section: 'Clean-down', title: 'Dishwasher run, emptied & drained', meta: 'racks stacked for AM' },
  { section: 'Clean-down', title: 'Extraction, gas & equipment off', meta: 'safety-critical before lock-up', isBlocker: true },
  { section: 'Cash & POS close', title: 'Z-report run & filed', meta: 'POS end-of-day' },
  { section: 'Cash & POS close', title: 'Cash drawer counted & reconciled', meta: 'float held back' },
  { section: 'Cash & POS close', title: 'Tips pooled & recorded' },
  { section: 'Cash & POS close', title: 'Safe drop logged & sealed', meta: 'banking bag' },
  { section: 'Cash & POS close', title: 'Sales synced', meta: 'feeds cost + variance' },
  { section: 'Prep & storage for tomorrow', title: 'Proteins pulled to thaw for AM', meta: 'per tomorrow forecast' },
  { section: 'Prep & storage for tomorrow', title: 'Mise rotated FIFO · everything dated', meta: 'walk-ins + dry store' },
  { section: 'Prep & storage for tomorrow', title: '86 board updated for tomorrow' },
  { section: 'Prep & storage for tomorrow', title: 'Delivery & dry store secured', meta: 'AM drop area clear' },
  { section: 'Prep & storage for tomorrow', title: 'Alarm set & premises locked', meta: 'last one out', isBlocker: true },
]

async function main() {
  const rcs = await prisma.revenueCenter.findMany({ where: { isActive: true }, select: { id: true, name: true } })
  for (const rc of rcs) {
    const existing = await prisma.eodCheckItem.count({ where: { revenueCenterId: rc.id } })
    if (existing > 0) { console.log(`skip ${rc.name} (${existing} items)`); continue }
    await prisma.eodCheckItem.createMany({
      data: DEFAULTS.map((d, i) => ({
        revenueCenterId: rc.id,
        section: d.section,
        title: d.title,
        meta: d.meta ?? null,
        isBlocker: d.isBlocker ?? false,
        sortOrder: i,
      })),
    })
    console.log(`seeded ${DEFAULTS.length} items → ${rc.name}`)
  }
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
