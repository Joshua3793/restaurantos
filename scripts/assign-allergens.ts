/**
 * One-off: assign allergens to raw inventory items based on item name + general
 * food knowledge, then let the app's canonical syncPrepToInventory() propagate
 * allergens onto every PREP recipe's linked PREPD inventory item (inheritance).
 *
 * Allergen vocabulary is fixed by src/lib/allergens.ts (Health Canada priority list):
 *   Wheat/Gluten, Milk, Eggs, Peanuts, Tree Nuts, Sesame, Soy, Fish, Shellfish,
 *   Mustard, Sulphites
 * Notes on the Canadian list vs FDA:
 *   - Coconut is NOT a Health Canada priority tree nut -> left unmarked.
 *   - Mustard and Sulphites ARE Canadian priority allergens -> flagged.
 *   - Sulphites flagged at "moderate" breadth (well-established sources only).
 *   - Celery is NOT a Canadian priority allergen -> left unmarked.
 *
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/assign-allergens.ts
 */
import { prisma } from '../src/lib/prisma'
import { syncPrepToInventory } from '../src/lib/recipeCosts'

// Per-item allergen assignments, keyed by exact itemName. Items not listed here
// carry no allergens (produce, plain spices, oils, salts, sugars, most meats…).
const A = {
  WHEAT: 'Wheat/Gluten',
  MILK: 'Milk',
  EGGS: 'Eggs',
  TREENUTS: 'Tree Nuts',
  SESAME: 'Sesame',
  SOY: 'Soy',
  FISH: 'Fish',
  SHELLFISH: 'Shellfish',
  MUSTARD: 'Mustard',
  SULPHITES: 'Sulphites',
} as const

const MAP: Record<string, string[]> = {
  // ---- Fish (finfish + fish-derived) ----
  'Albacore tuna': [A.FISH],
  'Cod': [A.FISH],
  'Pacific Halibut': [A.FISH],
  'Salmon': [A.FISH],
  'Trout': [A.FISH],
  'Flaked SkipJack Tuna': [A.FISH],
  'Fish sauce': [A.FISH],                 // fermented anchovy
  'Worcestershire Sauce': [A.FISH],       // contains anchovy

  // ---- Shellfish (molluscs) ----
  'Oysters Kusshi': [A.SHELLFISH],
  'Scallops': [A.SHELLFISH],

  // ---- Milk / dairy ----
  'Butter': [A.MILK],
  'Buttermilk': [A.MILK],
  'Cheddar smoked': [A.MILK],
  'Cheddar whiite': [A.MILK],
  'Cream cheese': [A.MILK],
  'Cream whipped': [A.MILK],
  'Feta': [A.MILK],
  'Goats Cheese': [A.MILK],
  'Grana Padano': [A.MILK],
  'Greek Style Yogurt': [A.MILK],
  'Halloumi': [A.MILK],
  'Havarti cheese': [A.MILK],
  'Heavy Cream 35%': [A.MILK],
  'Mascarpone': [A.MILK],
  'Milk Condensed': [A.MILK],
  'Milk Whole HOMOGENIZED': [A.MILK],
  'Provolone': [A.MILK],
  'Ricotta': [A.MILK],
  'Sour Cream': [A.MILK],
  'Chocolate white': [A.MILK, A.SOY],     // cocoa butter + milk solids + soy lecithin

  // ---- Eggs ----
  'Free Run Eggs': [A.EGGS],
  'Liquid Egg Yolk': [A.EGGS],

  // ---- Wheat / Gluten (grains + baked/breaded) ----
  'All Purpose Flour': [A.WHEAT],
  'Whole Wheat Flour': [A.WHEAT],
  'dark rye flour': [A.WHEAT],            // rye = gluten cereal
  'Barley': [A.WHEAT],                    // barley = gluten cereal
  'Rolled oats': [A.WHEAT],               // oats grouped under gluten cereals (non-GF)
  'Feuilletine': [A.WHEAT],
  'Graham Crumbs': [A.WHEAT],
  'Pita Bread': [A.WHEAT],
  'Baguette': [A.WHEAT],
  'Spring roll wrappers': [A.WHEAT],      // wheat-based (cf. rice paper)
  'Naan Bread Round 8 in': [A.WHEAT, A.MILK],
  'Croissant Plain': [A.WHEAT, A.MILK, A.EGGS],
  'cruffins': [A.WHEAT, A.MILK, A.EGGS],
  'Pain au Chocolate': [A.WHEAT, A.MILK, A.EGGS],
  'Pastry shell chocolate': [A.WHEAT, A.MILK, A.EGGS],
  'PUFF PASTRY CROISSANT': [A.WHEAT, A.MILK],
  'Puff pastry sheet(pepridge farm)': [A.WHEAT],
  'Chicken Schnitzel': [A.WHEAT, A.EGGS], // breaded
  'Sausage Apple banger': [A.WHEAT],      // British bangers contain rusk/breadcrumb
  'Brioche Unsliced': [A.WHEAT, A.MILK, A.EGGS],
  'Burger Bun Sliced': [A.WHEAT, A.MILK, A.EGGS],
  'BREAD BRIOCHE CLBS 3/4IN SLCD': [A.WHEAT, A.MILK, A.EGGS],

  // ---- Gluten-free baked goods that still carry milk/egg ----
  'GF Brioche Bun': [A.MILK, A.EGGS],     // GF flour but brioche => butter + eggs

  // ---- Soy ----
  'Miso': [A.SOY],
  'Tamari Soy Sauce': [A.SOY],            // tamari = wheat-free soy
  'Gochujang': [A.SOY, A.WHEAT],          // fermented soybean + wheat/barley

  // ---- Sesame ----
  'Sesame Oil': [A.SESAME],
  'Sesame Seeds': [A.SESAME],
  'black seasame seed': [A.SESAME],
  'Tahini': [A.SESAME],

  // ---- Tree nuts (Health Canada list; coconut is NOT a priority tree nut) ----
  'Almond flavor': [A.TREENUTS],
  'Almond meal': [A.TREENUTS],
  'Almond slices': [A.TREENUTS],
  'Cashews': [A.TREENUTS],
  'Chestnut flour': [A.TREENUTS],     // botanical tree nut; kept for safety (not on HC priority list)
  'Hazelnuts': [A.TREENUTS],
  'Pecans': [A.TREENUTS],
  'Pine Nuts': [A.TREENUTS],
  'Walnuts': [A.TREENUTS],

  // ---- Mustard (Canadian priority allergen) ----
  'Mustard Dijon': [A.MUSTARD],
  'Mustard Seeds': [A.MUSTARD],
  'Mustard Seeds Ground': [A.MUSTARD],
  'Apple mustard': [A.MUSTARD],

  // ---- Sulphites (Canadian priority allergen; moderate breadth) ----
  'Red cooking wine': [A.SULPHITES],
  'White Wine Cooking': [A.SULPHITES],
  'Wine Red Cooking': [A.SULPHITES],
  'Vinegar Red Wine': [A.SULPHITES],
  'Vinegar White Wine': [A.SULPHITES],
  'Dried Diced Apricots': [A.SULPHITES],
  'Raisins': [A.SULPHITES],
  'Figs Dried': [A.SULPHITES],
  'Dried Porcini Mushroom': [A.SULPHITES],
  'Molasses': [A.SULPHITES],
  'Lemon Juice': [A.SULPHITES],
  'Lime Juice': [A.SULPHITES],
  'Yuzu juice': [A.SULPHITES],
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  // Recipe-output (PREPD) item ids inherit via sync — never hand-assign them.
  const prepRecipes = await prisma.recipe.findMany({
    where: { type: 'PREP' },
    select: { id: true, inventoryItemId: true },
  })
  const outputIds = new Set(
    prepRecipes.filter(r => r.inventoryItemId).map(r => r.inventoryItemId as string),
  )

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: { id: true, itemName: true, allergens: true },
  })

  // sanity: every key in MAP should match a real item name
  const names = new Set(items.map(i => i.itemName))
  const unmatched = Object.keys(MAP).filter(n => !names.has(n))
  if (unmatched.length) {
    console.log('WARNING — MAP keys with no matching item:', unmatched)
  }

  let updated = 0
  let cleared = 0
  for (const item of items) {
    if (outputIds.has(item.id)) continue // PREPD — inherits via sync
    const target = MAP[item.itemName] ?? []
    const before = [...item.allergens].sort()
    const after = [...target].sort()
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    if (target.length === 0) cleared++
    else updated++
    console.log(`${target.length ? 'SET ' : 'CLR '} ${item.itemName}  ->  [${target.join(', ')}]`)
    if (!dryRun) {
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { allergens: target } })
    }
  }
  console.log(`\nRaw items set: ${updated}, cleared: ${cleared}`)

  // Propagate to PREPD items via the app's canonical inheritance logic.
  if (!dryRun) {
    console.log('\nSyncing PREP recipes -> PREPD inventory allergens…')
    for (const r of prepRecipes) {
      await syncPrepToInventory(r.id)
    }
  }

  // Report final PREPD allergen state
  const prepd = await prisma.inventoryItem.findMany({
    where: { isActive: true, id: { in: [...outputIds] } },
    select: { itemName: true, allergens: true },
    orderBy: { itemName: 'asc' },
  })
  console.log('\nPREPD (inherited) allergens:')
  for (const p of prepd) {
    console.log(`  ${p.itemName}: [${p.allergens.join(', ')}]`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
