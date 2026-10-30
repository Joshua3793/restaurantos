// Starter station lists + the pure builder that turns them (and an RC's old
// opening / end-of-day items) into createMany rows. No Prisma, safe anywhere.
import { EVERY_DAY } from './rules'

export type StarterItem = {
  title: string
  howTo?: string
  isBlocker?: boolean
  answer?: 'TICK' | 'NUMBER'
  unit?: string
  safeMin?: number
  safeMax?: number
}
export type StarterCategory = { name: string; items: StarterItem[] }
export type StarterStation = {
  key: string
  name: string
  color: string
  isShared: boolean
  open: StarterCategory[]
  close: StarterCategory[]
}

type Extra = Omit<StarterItem, 'title' | 'isBlocker'>
/** Blocker item. */
const b = (title: string, x: Extra = {}): StarterItem => ({ title, isBlocker: true, ...x })
/** Ordinary item. */
const t = (title: string, x: Extra = {}): StarterItem => ({ title, ...x })
/** °C reading item. */
const temp = (title: string, range: { safeMin?: number; safeMax?: number }, x: Extra = {}, blocker = true): StarterItem => ({
  title, isBlocker: blocker, answer: 'NUMBER', unit: '°C', ...range, ...x,
})

/** Splits flat items into the two categories of a phase (blockers first). */
function phase(blockerName: string, restName: string, items: StarterItem[]): StarterCategory[] {
  const blockers = items.filter(i => i.isBlocker)
  const rest = items.filter(i => !i.isBlocker)
  return [
    { name: blockerName, items: blockers },
    { name: restName, items: rest },
  ].filter(c => c.items.length > 0)
}
const open = (items: StarterItem[]) => phase('Before doors', 'Set-up', items)
const close = (items: StarterItem[]) => phase('Before you leave', 'Clean down', items)

export const STARTER_STATIONS: ReadonlyArray<StarterStation> = [
  {
    key: 'kitchen', name: 'Whole kitchen', color: '#71717a', isShared: true,
    open: open([
      b('Hood fans on'),
      b('Handwash sinks stocked', { howTo: 'Soap, paper towel, warm water' }),
      temp('Walk-in temp', { safeMax: 4 }),
      temp('Freezer temp', { safeMax: -18 }),
      b('Sanitizer buckets set', { howTo: 'Test strip reads 200 ppm' }),
      t("Read last night's handover"),
      t("Check today's deliveries"),
    ]),
    close: close([
      b('Gas off at every station'),
      temp('Walk-in door shut, temp logged', { safeMax: 4 }),
      b('All food covered, labelled, dated'),
      t('Floors swept & mopped'),
      t('Garbage, compost, recycling out'),
      t('Lights off, back door locked'),
    ]),
  },
  {
    key: 'grill', name: 'Grill', color: '#dc2626', isShared: false,
    open: open([
      b('Flat-top on & seasoned', { howTo: '350 °F · scrape, thin coat of oil' }),
      temp('Lowboy temp', { safeMin: 0, safeMax: 4 }, { howTo: 'Probe the middle shelf, not the door' }),
      t('Proteins pulled from walk-in'),
      t('Line fridge stocked to par'),
      t('Sauces portioned & dated'),
      t('Tools & towels set'),
    ]),
    close: close([
      b('Grill off & gas shut'),
      b('Lowboy food wrapped, labelled, dated'),
      b("Tomorrow's proteins pulled to thaw"),
      t('Flat-top bricked & oiled'),
      t('Grease tray emptied'),
      t('Order gaps written'),
    ]),
  },
  {
    key: 'fryer', name: 'Fryer', color: '#ca8a04', isShared: false,
    open: open([
      b('Fryer on · oil level & colour checked', { howTo: 'Change it if dark or foaming' }),
      t('Baskets clean, hooks set'),
      t('Fries & breaded items to par'),
      t('Salt & seasoning station full'),
    ]),
    close: close([
      b('Fryer off'),
      t('Oil filtered', { howTo: 'Changed it? Say so in the handover' }),
      t('Baskets degreased'),
      t('Station & floor degreased'),
    ]),
  },
  {
    key: 'saute', name: 'Sauté / hot line', color: '#ea580c', isShared: false,
    open: open([
      temp('Hot hold temp', { safeMin: 60 }),
      b('Sauces reheated to 74 °C'),
      t('Steam table on, water topped'),
      t('Mise to par'),
      t('Pans, ladles, tongs stocked'),
    ]),
    close: close([
      b('Sauces cooled to 4 °C, labelled', { howTo: 'Two-stage: 60→21 °C in 2 h, 21→4 °C in 4 h' }),
      b('Burners off'),
      t('Steam table drained & off'),
      t('Grates soaked'),
      t('Station wiped & sanitized'),
    ]),
  },
  {
    key: 'garde', name: 'Garde manger', color: '#16a34a', isShared: false,
    open: open([
      temp('Lowboy temp', { safeMin: 0, safeMax: 4 }),
      b('Slicer guard checked'),
      t('Greens washed & spun'),
      t('Dressings dated'),
      t('Colour-coded boards set'),
    ]),
    close: close([
      b('Slicer broken down & sanitized'),
      b('Cut fruit & greens covered, dated'),
      t('Toss past-date items'),
      t('Boards & bins to dish'),
    ]),
  },
  {
    key: 'pastry', name: 'Pastry', color: '#db2777', isShared: false,
    open: open([
      b('Mixer guard checked'),
      t('Ovens preheated'),
      t('Proofer set'),
      t('Butter & eggs pulled'),
      t('Bake list read'),
    ]),
    close: close([
      b('Ovens off'),
      b('Doughs wrapped, labelled'),
      t('Mixer & bowls cleaned'),
      t("Tomorrow's pulls to thaw"),
    ]),
  },
  {
    key: 'dish', name: 'Dish', color: '#0d9488', isShared: false,
    open: open([
      temp('Dish machine wash temp', { safeMin: 60 }),
      temp('Dish machine rinse temp', { safeMin: 82 }),
      b('Sanitizer in 3-sink set'),
      t('Chemicals stocked'),
      t('Racks sorted'),
    ]),
    close: close([
      b('Machine drained & cleaned'),
      t('Curtains & screens cleaned'),
      t('Floor drains cleared'),
      t('Mats out to wash'),
    ]),
  },
  {
    key: 'lead', name: 'Lead / pass', color: '#2563eb', isShared: false,
    open: open([
      b('Every station started'),
      t('Post the prep list'),
      t('Check flagged problems'),
      t('Pass stocked: tickets, plates'),
    ]),
    close: close([
      b('Every station signed off'),
      b('Alarm set'),
      t('Waste logged'),
      t('Write the kitchen handover'),
    ]),
  },
]

export type OldItem = {
  section: string
  title: string
  meta: string | null
  isBlocker: boolean
  sortOrder: number
}

export type StationRow = {
  id: string; revenueCenterId: string; name: string; color: string
  isShared: boolean; sortOrder: number
}
export type CategoryRow = {
  id: string; stationId: string; phase: 'OPEN' | 'CLOSE'; name: string; sortOrder: number
}
export type ItemRow = {
  id: string; categoryId: string; title: string; howTo: string | null
  isBlocker: boolean; answer: 'TICK' | 'NUMBER'; unit: string | null
  safeMin: number | null; safeMax: number | null; days: number; sortOrder: number
}
export type SeedRows = { stations: StationRow[]; categories: CategoryRow[]; items: ItemRow[] }

/** Old flat rows -> categories grouped by section, first appearance by sortOrder. */
function fromOld(old: OldItem[]): StarterCategory[] {
  const sorted = [...old].sort((a, c) => a.sortOrder - c.sortOrder)
  const cats: StarterCategory[] = []
  for (const o of sorted) {
    let cat = cats.find(c => c.name === o.section)
    if (!cat) { cat = { name: o.section, items: [] }; cats.push(cat) }
    cat.items.push({ title: o.title, howTo: o.meta ?? undefined, isBlocker: o.isBlocker })
  }
  return cats
}

/**
 * Plain createMany data for one RC's first open. Ids are deterministic so two
 * first-opens at once collide on skipDuplicates instead of double-seeding.
 * The shared station takes the RC's old lists per phase when it has any.
 */
export function buildSeed(rcId: string, oldOpen: OldItem[], oldClose: OldItem[]): SeedRows {
  const rows: SeedRows = { stations: [], categories: [], items: [] }
  STARTER_STATIONS.forEach((s, si) => {
    const stationId = `chk-${rcId}-${s.key}`
    rows.stations.push({
      id: stationId, revenueCenterId: rcId, name: s.name, color: s.color,
      isShared: s.isShared, sortOrder: si,
    })
    const phases: Array<['OPEN' | 'CLOSE', StarterCategory[]]> = [
      ['OPEN', s.isShared && oldOpen.length > 0 ? fromOld(oldOpen) : s.open],
      ['CLOSE', s.isShared && oldClose.length > 0 ? fromOld(oldClose) : s.close],
    ]
    for (const [ph, cats] of phases) {
      cats.forEach((c, ci) => {
        const categoryId = `${stationId}-${ph}-${ci}`
        rows.categories.push({ id: categoryId, stationId, phase: ph, name: c.name, sortOrder: ci })
        c.items.forEach((it, ii) => {
          rows.items.push({
            id: `${categoryId}-${ii}`,
            categoryId,
            title: it.title,
            howTo: it.howTo ?? null,
            isBlocker: it.isBlocker ?? false,
            answer: it.answer ?? 'TICK',
            unit: it.unit ?? null,
            safeMin: it.safeMin ?? null,
            safeMax: it.safeMax ?? null,
            days: EVERY_DAY,
            sortOrder: ii,
          })
        })
      })
    }
  })
  return rows
}
