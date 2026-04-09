/**
 * Seeds recipe categories and sample recipes.
 * Run: npx tsx prisma/seed-recipes.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding recipe categories and recipes…')

  // ── Clean existing recipe data ─────────────────────────────────────────────
  await prisma.recipeIngredient.deleteMany()
  await prisma.recipe.deleteMany()
  await prisma.recipeCategory.deleteMany()

  // ── PREP Categories ────────────────────────────────────────────────────────
  const [saucesJams, basesStocks, bakedGoods, proteinsPrep, garnishes, desserts, conserved] = await Promise.all([
    prisma.recipeCategory.create({ data: { name: 'Sauces & Dressings', type: 'PREP', color: '#f97316', sortOrder: 0 } }),
    prisma.recipeCategory.create({ data: { name: 'Base Preparations', type: 'PREP', color: '#14b8a6', sortOrder: 1 } }),
    prisma.recipeCategory.create({ data: { name: 'Baked Goods', type: 'PREP', color: '#eab308', sortOrder: 2 } }),
    prisma.recipeCategory.create({ data: { name: 'Proteins', type: 'PREP', color: '#ef4444', sortOrder: 3 } }),
    prisma.recipeCategory.create({ data: { name: 'Garnishes & Accompaniments', type: 'PREP', color: '#22c55e', sortOrder: 4 } }),
    prisma.recipeCategory.create({ data: { name: 'Desserts', type: 'PREP', color: '#ec4899', sortOrder: 5 } }),
    prisma.recipeCategory.create({ data: { name: 'Conserved & Pickles', type: 'PREP', color: '#8b5cf6', sortOrder: 6 } }),
  ])

  // ── MENU Categories ────────────────────────────────────────────────────────
  const [brunch, mains, startersSides, catering] = await Promise.all([
    prisma.recipeCategory.create({ data: { name: 'Brunch', type: 'MENU', color: '#3b82f6', sortOrder: 0 } }),
    prisma.recipeCategory.create({ data: { name: 'Mains', type: 'MENU', color: '#8b5cf6', sortOrder: 1 } }),
    prisma.recipeCategory.create({ data: { name: 'Starters & Sides', type: 'MENU', color: '#22c55e', sortOrder: 2 } }),
    prisma.recipeCategory.create({ data: { name: 'Catering', type: 'MENU', color: '#ec4899', sortOrder: 3 } }),
  ])

  // ── Fetch existing inventory items ─────────────────────────────────────────
  const items = await prisma.inventoryItem.findMany()
  const find = (name: string) => items.find(i => i.itemName.toLowerCase().includes(name.toLowerCase()))

  const butter   = find('butter')
  const garlic   = find('garlic')
  const arborio  = find('arborio')
  const mushroom = find('mushroom') || find('oyster')
  const shallots = find('shallot')
  const parm     = find('parmigiano') || find('parmesan') || find('grana')
  const cream    = find('cream')
  const evoo     = find('olive')
  const eggs     = find('egg')
  const salmon   = find('salmon')
  const chicken  = find('chicken stock') || find('chickenStock')

  // ── Helper: create PREP recipe + PREPD inventory item ─────────────────────
  async function createPrepRecipe(data: {
    name: string
    categoryId: string
    baseYieldQty: number
    yieldUnit: string
    portionSize?: number
    portionUnit?: string
    notes?: string
    ingredients: Array<{ itemId: string | undefined; qtyBase: number; unit: string }>
  }) {
    // Create or upsert PREPD inventory item
    const existingInv = await prisma.inventoryItem.findFirst({
      where: { itemName: data.name, category: 'PREPD' }
    })
    const invItem = existingInv ?? await prisma.inventoryItem.create({
      data: {
        itemName: data.name,
        category: 'PREPD',
        purchaseUnit: data.yieldUnit,
        qtyPerPurchaseUnit: data.baseYieldQty,
        purchasePrice: 0,
        baseUnit: data.yieldUnit,
        packSize: 1,
        packUOM: data.yieldUnit,
        countUOM: data.yieldUnit,
        conversionFactor: 1,
        pricePerBaseUnit: 0,
        stockOnHand: 0,
        abbreviation: data.name.substring(0, 8).toUpperCase().replace(/\s/g, ''),
      }
    })

    const recipe = await prisma.recipe.create({
      data: {
        name: data.name,
        type: 'PREP',
        categoryId: data.categoryId,
        baseYieldQty: data.baseYieldQty,
        yieldUnit: data.yieldUnit,
        portionSize: data.portionSize ?? null,
        portionUnit: data.portionUnit ?? null,
        isActive: true,
        notes: data.notes ?? null,
        inventoryItemId: invItem.id,
      }
    })

    // Create ingredients (skip missing items)
    const validIngredients = data.ingredients.filter(i => !!i.itemId)
    if (validIngredients.length > 0) {
      await prisma.recipeIngredient.createMany({
        data: validIngredients.map((i, idx) => ({
          recipeId: recipe.id,
          inventoryItemId: i.itemId!,
          qtyBase: i.qtyBase,
          unit: i.unit,
          sortOrder: idx,
        }))
      })
    }

    // Compute total cost and update PREPD item
    const ings = await prisma.recipeIngredient.findMany({
      where: { recipeId: recipe.id },
      include: { inventoryItem: true }
    })
    const totalCost = ings.reduce((s, i) => s + Number(i.qtyBase) * Number(i.inventoryItem?.pricePerBaseUnit ?? 0), 0)
    const pricePerBaseUnit = data.baseYieldQty > 0 ? totalCost / data.baseYieldQty : 0
    await prisma.inventoryItem.update({
      where: { id: invItem.id },
      data: { purchasePrice: totalCost, pricePerBaseUnit }
    })

    console.log(`  ✓ PREP: ${data.name} — totalCost=$${totalCost.toFixed(2)}, ${validIngredients.length} ingredients`)
    return recipe
  }

  // ── PREP RECIPES ──────────────────────────────────────────────────────────

  // Buttermilk Biscuits
  const biscuits = await createPrepRecipe({
    name: 'Buttermilk Biscuits',
    categoryId: bakedGoods.id,
    baseYieldQty: 50,
    yieldUnit: 'each',
    portionSize: 1,
    portionUnit: 'each',
    notes: 'Classic flaky biscuits — bulk bake, freeze extras',
    ingredients: [
      { itemId: find('flour')?.id ?? find('pasta flour')?.id, qtyBase: 1000, unit: 'g' },
      { itemId: butter?.id, qtyBase: 400, unit: 'g' },
      { itemId: cream?.id, qtyBase: 600, unit: 'ml' },
      { itemId: eggs?.id, qtyBase: 2, unit: 'each' },
    ]
  })

  // Hollandaise
  const hollandaise = await createPrepRecipe({
    name: 'Hollandaise',
    categoryId: saucesJams.id,
    baseYieldQty: 2500,
    yieldUnit: 'ml',
    portionSize: 80,
    portionUnit: 'ml',
    notes: 'Classic butter emulsion sauce. Keep warm in bain-marie.',
    ingredients: [
      { itemId: butter?.id, qtyBase: 1500, unit: 'g' },
      { itemId: eggs?.id, qtyBase: 12, unit: 'each' },
      { itemId: shallots?.id, qtyBase: 60, unit: 'g' },
    ]
  })

  // Bacon Jam
  const baconJam = await createPrepRecipe({
    name: 'Bacon Jam',
    categoryId: saucesJams.id,
    baseYieldQty: 3000,
    yieldUnit: 'g',
    portionSize: 40,
    portionUnit: 'g',
    notes: 'Slow-cooked bacon jam. Refrigerate up to 2 weeks.',
    ingredients: [
      { itemId: shallots?.id, qtyBase: 500, unit: 'g' },
      { itemId: garlic?.id, qtyBase: 60, unit: 'g' },
    ]
  })

  // Al Forno Sauce
  const alFornoSauce = await createPrepRecipe({
    name: 'Al Forno Sauce',
    categoryId: saucesJams.id,
    baseYieldQty: 5000,
    yieldUnit: 'ml',
    portionSize: 150,
    portionUnit: 'ml',
    notes: 'Tomato base with nduja. Freeze in portions.',
    ingredients: [
      { itemId: garlic?.id, qtyBase: 100, unit: 'g' },
      { itemId: evoo?.id, qtyBase: 200, unit: 'ml' },
    ]
  })

  // Beef Jus
  const beefJus = await createPrepRecipe({
    name: 'Beef Jus',
    categoryId: basesStocks.id,
    baseYieldQty: 10000,
    yieldUnit: 'ml',
    portionSize: 80,
    portionUnit: 'ml',
    notes: 'Roast bones 45min at 220°C. Simmer 8 hours.',
    ingredients: [
      { itemId: garlic?.id, qtyBase: 100, unit: 'g' },
      { itemId: shallots?.id, qtyBase: 400, unit: 'g' },
    ]
  })

  // Garlic Butter
  const garlicButter = await createPrepRecipe({
    name: 'Garlic Butter',
    categoryId: basesStocks.id,
    baseYieldQty: 2000,
    yieldUnit: 'g',
    portionSize: 30,
    portionUnit: 'g',
    notes: 'Compound butter. Roll in cling film and freeze.',
    ingredients: [
      { itemId: butter?.id, qtyBase: 1800, unit: 'g' },
      { itemId: garlic?.id, qtyBase: 120, unit: 'g' },
    ]
  })

  // ── MENU RECIPES ─────────────────────────────────────────────────────────

  async function createMenuRecipe(data: {
    name: string
    categoryId: string
    portionSize: number
    portionUnit: string
    menuPrice: number
    notes?: string
    ingredients: Array<{
      invItemId?: string
      linkedRecipeId?: string
      qtyBase: number
      unit: string
    }>
  }) {
    const recipe = await prisma.recipe.create({
      data: {
        name: data.name,
        type: 'MENU',
        categoryId: data.categoryId,
        baseYieldQty: data.portionSize,
        yieldUnit: data.portionUnit,
        portionSize: data.portionSize,
        portionUnit: data.portionUnit,
        menuPrice: data.menuPrice,
        isActive: true,
        notes: data.notes ?? null,
      }
    })

    const validIng = data.ingredients.filter(i => i.invItemId || i.linkedRecipeId)
    if (validIng.length > 0) {
      await prisma.recipeIngredient.createMany({
        data: validIng.map((i, idx) => ({
          recipeId: recipe.id,
          inventoryItemId: i.invItemId ?? null,
          linkedRecipeId: i.linkedRecipeId ?? null,
          qtyBase: i.qtyBase,
          unit: i.unit,
          sortOrder: idx,
        }))
      })
    }

    console.log(`  ✓ MENU: ${data.name} — price=$${data.menuPrice}, ${validIng.length} ingredients`)
    return recipe
  }

  // Eggs Benedict
  await createMenuRecipe({
    name: 'Eggs Benedict',
    categoryId: brunch.id,
    portionSize: 1,
    portionUnit: 'plate',
    menuPrice: 19,
    notes: 'Served with seasonal side salad.',
    ingredients: [
      { linkedRecipeId: biscuits.id, qtyBase: 2, unit: 'each' },
      { invItemId: eggs?.id, qtyBase: 2, unit: 'each' },
      { linkedRecipeId: hollandaise.id, qtyBase: 80, unit: 'ml' },
    ]
  })

  // Mushroom Risotto
  await createMenuRecipe({
    name: 'Mushroom Risotto',
    categoryId: mains.id,
    portionSize: 1,
    portionUnit: 'plate',
    menuPrice: 26,
    notes: 'Finish with truffle oil for VIP.',
    ingredients: [
      { invItemId: arborio?.id, qtyBase: 120, unit: 'g' },
      { invItemId: mushroom?.id, qtyBase: 180, unit: 'g' },
      { invItemId: parm?.id, qtyBase: 30, unit: 'g' },
      { invItemId: butter?.id, qtyBase: 20, unit: 'g' },
      { invItemId: shallots?.id, qtyBase: 40, unit: 'g' },
    ]
  })

  // Pan Seared Salmon
  await createMenuRecipe({
    name: 'Pan Seared Salmon',
    categoryId: mains.id,
    portionSize: 1,
    portionUnit: 'plate',
    menuPrice: 34,
    notes: 'Serve with seasonal vegetables and potato.',
    ingredients: [
      { invItemId: salmon?.id, qtyBase: 220, unit: 'g' },
      { linkedRecipeId: garlicButter.id, qtyBase: 30, unit: 'g' },
    ]
  })

  // Garlic Butter Biscuit (starter)
  await createMenuRecipe({
    name: 'House Biscuit',
    categoryId: startersSides.id,
    portionSize: 2,
    portionUnit: 'each',
    menuPrice: 8,
    notes: 'Served warm with Garlic Butter.',
    ingredients: [
      { linkedRecipeId: biscuits.id, qtyBase: 2, unit: 'each' },
      { linkedRecipeId: garlicButter.id, qtyBase: 30, unit: 'g' },
    ]
  })

  // Suppress unused-variable warnings for categories not used in sample recipes
  void garnishes; void desserts; void conserved

  console.log('\n✓ Recipe seed complete!')
  console.log('  PREP categories:', 7)
  console.log('  MENU categories:', 4)
  console.log('  PREP recipes:', 6)
  console.log('  MENU recipes:', 4)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
