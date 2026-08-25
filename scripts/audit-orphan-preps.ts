/**
 * READ-ONLY audit: what is NOT on the menu?
 *
 * Sales are the ONLY thing that draws stock down through recipes:
 *   SaleLineItem → MENU recipe → its ingredients (and, recursively, any PREP
 *   recipe those ingredients resolve to) → InventoryItem consumption.
 * So a PREP recipe that no MENU dish reaches is never consumed by a sale. Prep
 * logs keep adding its yield (PREP_OUT) and nothing ever takes it away, which
 * is exactly how a theoretical on-hand climbs away from reality — the "faulty
 * stock" symptom of a dish you forgot to build on the menu.
 *
 * Reachability follows BOTH edges the consumption walker follows
 * (src/lib/count-expected.ts expandRecipeIngredients):
 *   1. RecipeIngredient.linkedRecipeId          — direct recipe link
 *   2. RecipeIngredient.inventoryItemId         — the PREP recipe's own linked
 *                                                 InventoryItem (syncPrepToInventory)
 * Roots are ACTIVE MENU recipes. Anything not reached is reported.
 *
 * Run:
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-orphan-preps.ts
 *
 * Writes NOTHING.
 */
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, stockValue } from '../src/lib/item-model'

const money = (n: number) => `$${n.toFixed(2)}`

type Reason = 'never-referenced' | 'orphan-chain'

async function main() {
  const recipes = await prisma.recipe.findMany({
    select: {
      id: true, name: true, type: true, isActive: true, inventoryItemId: true,
      category: { select: { name: true } },
      ingredients: { select: { inventoryItemId: true, linkedRecipeId: true } },
      _count: { select: { saleLineItems: true } },
      inventoryItem: {
        select: { id: true, itemName: true, stockOnHand: true, isStocked: true, ...PRICING_SELECT },
      },
    },
    orderBy: { name: 'asc' },
  })

  const byId = new Map(recipes.map(r => [r.id, r]))
  // A PREP recipe's linked InventoryItem is how most menu dishes reference it.
  const recipeByOutputItem = new Map<string, string>()
  for (const r of recipes) if (r.inventoryItemId) recipeByOutputItem.set(r.inventoryItemId, r.id)

  // ── reachability from the menu ──────────────────────────────────────────────
  const roots = recipes.filter(r => r.type === 'MENU' && r.isActive)
  const reached = new Set<string>()
  const stack = roots.map(r => r.id)
  while (stack.length) {
    const id = stack.pop()!
    if (reached.has(id)) continue
    reached.add(id)
    const r = byId.get(id)
    if (!r) continue
    for (const ing of r.ingredients) {
      if (ing.linkedRecipeId && byId.has(ing.linkedRecipeId)) stack.push(ing.linkedRecipeId)
      const viaItem = ing.inventoryItemId && recipeByOutputItem.get(ing.inventoryItemId)
      if (viaItem) stack.push(viaItem)
    }
  }

  // Who references each recipe at all (used to tell "nobody uses this" apart
  // from "its parent is the thing missing from the menu").
  const consumers = new Map<string, string[]>()
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      const target = ing.linkedRecipeId ?? (ing.inventoryItemId ? recipeByOutputItem.get(ing.inventoryItemId) : undefined)
      if (!target || target === r.id) continue
      const list = consumers.get(target) ?? []
      if (!list.includes(r.id)) list.push(r.id)
      consumers.set(target, list)
    }
  }

  const orphanPreps = recipes
    .filter(r => r.type === 'PREP' && r.isActive && !reached.has(r.id))
    .map(r => {
      const users = consumers.get(r.id) ?? []
      const reason: Reason = users.length === 0 ? 'never-referenced' : 'orphan-chain'
      const item = r.inventoryItem
      return {
        recipe: r,
        reason,
        users: users.map(id => byId.get(id)!.name),
        soh: item ? Number(item.stockOnHand) : 0,
        value: item && item.isStocked ? stockValue(asChainItem(item)) : 0,
      }
    })
    // Biggest drifting stock value first — that's where the count hurts most.
    .sort((a, b) => b.value - a.value || a.recipe.name.localeCompare(b.recipe.name))

  console.log(`# Not on the menu\n`)
  console.log(`${roots.length} active MENU recipes reach ${reached.size} recipes in total.`)
  console.log(`${recipes.filter(r => r.type === 'PREP' && r.isActive).length} active PREP recipes exist; `
            + `**${orphanPreps.length}** of them are unreachable from any menu dish.\n`)

  // ── 1. PREP recipes no menu dish reaches ────────────────────────────────────
  console.log(`## 1. PREP recipes not used by any menu dish\n`)
  if (!orphanPreps.length) {
    console.log(`_None — every active PREP recipe is reachable from an active menu dish._\n`)
  } else {
    const drifting = orphanPreps.filter(o => o.soh > 0)
    console.log(`These are never consumed by a sale. ${drifting.length} of them are carrying `
              + `stock right now (${money(drifting.reduce((s, o) => s + o.value, 0))}), which is `
              + `stock that can only ever go up.\n`)
    for (const o of orphanPreps) {
      const r = o.recipe
      console.log(`### ${r.name}  <sub>${r.category.name}</sub>`)
      if (o.reason === 'never-referenced') {
        console.log(`- **nothing references it** — no menu dish and no other recipe uses this prep.`)
        console.log(`  Either a menu dish is missing an ingredient line, or this prep is retired.`)
      } else {
        console.log(`- used by **${o.users.join(', ')}** — but *those* are unreachable from the menu too,`)
        console.log(`  so the break is further up the chain, not here. Fix the parent first.`)
      }
      if (r.inventoryItem) {
        console.log(`- stock item \`${r.inventoryItem.itemName}\`: on hand **${o.soh.toFixed(2)} `
                  + `${r.inventoryItem.baseUnit}**${r.inventoryItem.isStocked ? ` · ${money(o.value)}` : ' · not stocked'}`)
      } else {
        console.log(`- ⚠︎ no linked InventoryItem — this PREP recipe was never synced `
                  + `(\`/api/inventory/sync-prepd\`), so it cannot be an ingredient anywhere.`)
      }
      console.log(`- \`id=${r.id}\`\n`)
    }
  }

  // ── 2. prep items whose recipe is off the menu ──────────────────────────────
  const prepItems = await prisma.prepItem.findMany({
    where: { isActive: true },
    select: {
      id: true, name: true, category: true, station: true, parLevel: true, unit: true,
      linkedRecipeId: true,
      revenueCenter: { select: { name: true } },
    },
    orderBy: { name: 'asc' },
  })

  const strandedItems = prepItems.filter(p => !p.linkedRecipeId || !reached.has(p.linkedRecipeId))
  console.log(`## 2. Prep items whose output never reaches the menu\n`)
  if (!strandedItems.length) {
    console.log(`_None — every active prep item is linked to a recipe a menu dish reaches._\n`)
  } else {
    console.log(`${strandedItems.length} of ${prepItems.length} active prep items. `
              + `The kitchen preps these; nothing on the menu spends them.\n`)
    console.log(`| Prep item | Category · station | RC | Par | Why |`)
    console.log(`|---|---|---|---|---|`)
    for (const p of strandedItems) {
      const why = !p.linkedRecipeId
        ? '**no linked recipe** — prep is logged but no ingredients are drawn'
        : byId.has(p.linkedRecipeId)
          ? `recipe **${byId.get(p.linkedRecipeId)!.name}** is not on the menu (see §1)`
          : 'linked recipe missing'
      console.log(`| ${p.name} | ${p.category}${p.station ? ` · ${p.station}` : ''} `
                + `| ${p.revenueCenter?.name ?? '—'} | ${Number(p.parLevel)} ${p.unit} | ${why} |`)
    }
    console.log(``)
  }

  // ── 3. menu dishes that never sell ──────────────────────────────────────────
  // Same end result as §1 — the recipe exists but no sale ever walks it — so
  // it belongs in the same worklist even though the dish IS on the menu.
  const neverSold = recipes.filter(r => r.type === 'MENU' && r.isActive && r._count.saleLineItems === 0)
  console.log(`## 3. Menu dishes with no sales ever recorded\n`)
  if (!neverSold.length) {
    console.log(`_None — every active menu dish has at least one sale line._\n`)
  } else {
    console.log(`These reach their preps on paper, but no \`SaleLineItem\` has ever pointed at them, `
              + `so they have drawn nothing down. Usually an unmapped POS item.\n`)
    for (const r of neverSold) {
      console.log(`- **${r.name}** <sub>${r.category.name}</sub> · ${r.ingredients.length} ingredient lines · \`id=${r.id}\``)
    }
    console.log(``)
  }
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
