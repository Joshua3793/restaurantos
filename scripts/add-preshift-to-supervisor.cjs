// One-off (2026-11-18): Pre-shift was retired (#202). Its opening checks move
// onto the SUPERVISOR station's opening list. Safe to re-run: stops if the
// categories already exist. Dry run unless APPLY=1.
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const STATION = '99e87a87-974b-4040-9289-6188d72dddeb' // SUPERVISOR, Kitchen
const PLAN = [
  { name: 'Safety', items: [
    { title: 'Probe thermometer calibrated', howTo: 'Ice / boil check, daily.', isBlocker: true },
    { title: 'Sanitiser buckets made & dated', howTo: 'All stations.', isBlocker: true },
  ] },
  { name: 'Service readiness', items: [
    { title: '86 board confirmed with floor', howTo: 'Agree off-menu items before doors.' },
    { title: 'Specials tasted & briefed to floor', howTo: "Tonight's additions." },
    { title: 'Allergen tickets reviewed', howTo: 'Coeliac, nut, shellfish.' },
    { title: 'POS open & printers tested', howTo: 'Kitchen and bar dockets.' },
    { title: 'Dining room & patio set', howTo: 'Covers laid, stations stocked.' },
  ] },
]
;(async () => {
  const st = await p.checklistStation.findUnique({ where: { id: STATION }, select: { name: true, isActive: true } })
  if (!st || !st.isActive) throw new Error('SUPERVISOR station not found / inactive')
  const existing = await p.checklistCategory.findMany({ where: { stationId: STATION, phase: 'OPEN', isActive: true }, select: { name: true } })
  const clash = existing.filter(c => PLAN.some(x => x.name.toLowerCase() === c.name.toLowerCase()))
  console.log(`${st.name} opening now has ${existing.length} categories:`, existing.map(c => c.name))
  if (clash.length) { console.log('Already there — nothing to do.'); return p.$disconnect() }
  for (const c of PLAN) console.log(`+ ${c.name}: ${c.items.map(i => i.title + (i.isBlocker ? ' [must]' : '')).join(' | ')}`)
  if (process.env.APPLY !== '1') { console.log('DRY RUN — set APPLY=1 to write.'); return p.$disconnect() }
  await p.$transaction(async tx => {
    for (const [ci, c] of PLAN.entries()) {
      const cat = await tx.checklistCategory.create({ data: { stationId: STATION, phase: 'OPEN', name: c.name, sortOrder: existing.length + ci } })
      await tx.checklistItem.createMany({ data: c.items.map((i, ii) => ({
        categoryId: cat.id, title: i.title, howTo: i.howTo, isBlocker: !!i.isBlocker, answer: 'TICK', days: 127, sortOrder: ii,
      })) })
    }
  })
  const after = await p.checklistItem.count({ where: { isActive: true, category: { stationId: STATION, phase: 'OPEN', isActive: true } } })
  console.log(`Written. ${st.name} opening now has ${after} jobs.`)
  await p.$disconnect()
})().catch(async e => { console.error(e); await p.$disconnect(); process.exit(1) })
