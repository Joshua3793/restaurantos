/**
 * Seed CAFE brunch MENU recipes from the Toast Product Mix (2026-06-01..06-10)
 * + Summer 2026 menu PDF.
 *
 * Goal: create one MENU recipe per product-mix BRUNCH item, using the EXACT
 * product-mix item name (so Toast sales fuzzy-matching is 100% accurate),
 * placed into the existing MENU categories under the CAFE revenue center.
 *
 * Idempotent: re-running updates category / price / notes in place and never
 * creates duplicates. Names are matched on (name, type=MENU, revenueCenter=CAFE).
 *
 * Run:  npx tsx scripts/seed-cafe-brunch-menu.ts
 */
import { prisma } from '../src/lib/prisma'

const CAFE_RC = 'cmotfsu2m0000k3kjied8k2gd'

// Existing MENU RecipeCategory ids
const CAT = {
  Signatures: 'a5a89d92-0c1b-4474-8f51-9d7e087725ec',
  Handhelds: 'e7bdd1f6-7cd7-4e11-b286-7d46e93f8869',
  Sides: 'b2a0dcbc-7da2-48f3-82f8-6406f7acb65e',
  Sweets: 'd3202881-8ce1-4399-a8e5-0e63f04c24a9',
  Kids: '2ae34339-1201-4bd2-bdb8-64b3c75f68cc',
} as const

type Item = {
  name: string // EXACT product-mix name — drives fuzzy match
  category: keyof typeof CAT
  price: number | null // PDF menu price where known, else product-mix avg
  notes?: string // PDF description
}

// name === exact "Item, open item" value from the Product Mix "All levels" sheet
const ITEMS: Item[] = [
  // ---- Brunch group → split across Signatures / Handhelds / Sweets by PDF section ----
  { name: 'The Coastal Benedict', category: 'Signatures', price: 27, notes: 'sockeye salmon lox · dill-caper crème fraîche · buttermilk biscuit · poached eggs · hollandaise · salmon skin chicharron · crispy hash' },
  { name: 'Dubliner Benny', category: 'Signatures', price: 26, notes: 'stout bacon jam · smoked cheddar · pickled apples · buttermilk biscuits · poached eggs · hollandaise · crispy onions · mustard ‘caviar’ · crispy hash' },
  { name: 'Pulled Pork Ranchero', category: 'Signatures', price: 26, notes: '18 hour smoked pork in adobo · crispy hash · beans · two fried eggs · feta cheese · charred corn salsa · tortilla chips · house hot sauce' },
  { name: 'Shakshuka', category: 'Signatures', price: 25, notes: 'spicy tomato & nduja sauce · chili & fennel sausage · baked eggs · goat cheese cream · grilled pita · zhoug' },
  { name: 'Elaho', category: 'Signatures', price: 26, notes: 'two fried eggs · bacon · grilled halloumi · breakfast sausage · crispy hash · sourdough toast · bean puree (add black pudding 3)' },
  { name: 'Forager Tartine', category: 'Signatures', price: 19, notes: 'sourdough · mushroom ragout · pickled crosnes · stinging nettle pesto · plant-based yolk · radish · vegan parm' },
  { name: 'Caesar Salad', category: 'Signatures', price: 24, notes: 'romaine & baby kale · parmesan · smoked croutons · cashew caesar vinaigrette · crispy capers · bacon · kelp (vegan version available)' },
  { name: 'Texas Brisket', category: 'Handhelds', price: 28, notes: 'smoked brisket · sweet potato & jalapeño bun · beef tallow aioli · pickled red onions · coleslaw mix · pickles · hand-cut fries' },
  { name: 'Smash Burger', category: 'Handhelds', price: 27, notes: 'Cleveland Meats patty with house spice rub · aioli · havarti · pickles · BBQ sauce · crispy onions · lettuce · tomato · hand-cut fries' },
  { name: 'Cheekye Sandwich', category: 'Handhelds', price: 25, notes: 'sourdough english muffins · bacon · tomato aioli · fried egg · smashed avocado · cheddar · crispy hash' },
  { name: 'French Toast', category: 'Sweets', price: 23, notes: 'two brioche toast · strawberry compote · vanilla crème pâtissière · coffee-maple syrup · matcha honey tuile · white chocolate snow' },
  { name: '1/2  French Toast', category: 'Sweets', price: 12, notes: 'one brioche toast · strawberry compote · vanilla crème pâtissière · coffee-maple syrup · matcha honey tuile · white chocolate snow' },
  { name: 'Biscuit & Jam', category: 'Sweets', price: 7, notes: 'buttermilk biscuit · smoked honey-miso butter · house jam' },
  { name: 'Plate of Sides', category: 'Sides', price: null },

  // ---- Sides group → Sides category (à la carte) ----
  { name: '1 Egg', category: 'Sides', price: 2.5 },
  { name: '2 Eggs', category: 'Sides', price: 4.75 },
  { name: 'Side 1/2 avo', category: 'Sides', price: 3.5 },
  { name: 'Side Pulled Pork', category: 'Sides', price: 6.5 },
  { name: 'Side Sausage', category: 'Sides', price: 5 },
  { name: 'Side Bacon', category: 'Sides', price: 5 },
  { name: 'Black Pudding', category: 'Sides', price: 5 },
  { name: 'Side Biscuit', category: 'Sides', price: 2.5 },
  { name: 'Side Toast', category: 'Sides', price: 3.5 },
  { name: 'Side GF Bread', category: 'Sides', price: 4.5 },
  { name: 'Side Flat Bread', category: 'Sides', price: 2 },
  { name: 'Side Butter', category: 'Sides', price: 0 },
  { name: 'Side Hash', category: 'Sides', price: 3 },
  { name: 'Side Fries', category: 'Sides', price: 3 },
  { name: 'Side Greens', category: 'Sides', price: 5 },
  { name: 'Side Halloumi', category: 'Sides', price: 5.5 },
  { name: 'Side fruits', category: 'Sides', price: 5 },

  // ---- Sauces group → Sides category (no Sauces MENU category exists) ----
  { name: 'Side - Hollandaise', category: 'Sides', price: 3.5 },
  { name: 'Side - Maple', category: 'Sides', price: 1 },
  { name: 'Side - Rosso Aioli', category: 'Sides', price: 2.5 },
  { name: 'Hot Sauce', category: 'Sides', price: 1 },
  { name: 'Mayo', category: 'Sides', price: 1 },

  // ---- Kids group → Kids category ----
  { name: 'Wolf Cub Brekkie', category: 'Kids', price: 12.5, notes: 'assorted fresh fruit · french toast · crispy hash · bacon · one scramble egg (add half sausage 2.5 / half avocado 3.5)' },
  { name: 'Grilled Cheese', category: 'Kids', price: 12.5, notes: 'brioche bread · melted cheese · hand-cut fries (add bacon 3 / half avocado 3.5)' },
  { name: 'Side kids french toast', category: 'Kids', price: 3.5 },

  // ---- Features group → Sweets category (bakery) ----
  { name: 'Chocolate Croissant', category: 'Sweets', price: 6 },
  { name: 'Croissant Plain', category: 'Sweets', price: 6 },
  { name: 'Bread Puddin', category: 'Sweets', price: 12 },
]

async function main() {
  // 1) Rename the pre-existing "Coastal Benedict" → exact product-mix name so we
  //    update it in place instead of creating a duplicate.
  const legacy = await prisma.recipe.findFirst({
    where: { type: 'MENU', revenueCenterId: CAFE_RC, name: 'Coastal Benedict' },
  })
  if (legacy) {
    await prisma.recipe.update({ where: { id: legacy.id }, data: { name: 'The Coastal Benedict' } })
    console.log('renamed existing "Coastal Benedict" → "The Coastal Benedict"')
  }

  let created = 0
  let updated = 0
  for (const it of ITEMS) {
    const existing = await prisma.recipe.findFirst({
      where: { type: 'MENU', revenueCenterId: CAFE_RC, name: it.name },
    })
    const data = {
      categoryId: CAT[it.category],
      menuPrice: it.price,
      notes: it.notes ?? null,
    }
    if (existing) {
      await prisma.recipe.update({ where: { id: existing.id }, data })
      updated++
      console.log(`updated  [${it.category.padEnd(10)}] ${it.name}`)
    } else {
      await prisma.recipe.create({
        data: {
          name: it.name,
          type: 'MENU',
          revenueCenterId: CAFE_RC,
          categoryId: CAT[it.category],
          baseYieldQty: 1,
          yieldUnit: 'portion',
          menuPrice: it.price,
          notes: it.notes ?? null,
          isActive: true,
          steps: [],
        },
      })
      created++
      console.log(`created  [${it.category.padEnd(10)}] ${it.name}`)
    }
  }

  console.log(`\nDone. ${created} created, ${updated} updated, ${ITEMS.length} total.`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => process.exit(0))
