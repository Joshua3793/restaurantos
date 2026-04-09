import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // Clean up
  await prisma.wastageLog.deleteMany()
  await prisma.recipeIngredient.deleteMany()
  await prisma.recipeCategory.deleteMany()
  await prisma.invoiceLineItem.deleteMany()
  await prisma.invoice.deleteMany()
  await prisma.inventoryItem.deleteMany()
  await prisma.supplier.deleteMany()
  await prisma.salesEntry.deleteMany()

  // Suppliers
  const sysco = await prisma.supplier.create({ data: { name: 'Sysco', contactName: 'John Smith', phone: '604-555-0101', email: 'orders@sysco.ca', orderPlatform: 'Online Portal', cutoffDays: 'Tuesday, Thursday', deliveryDays: 'Wednesday, Friday' } })
  const snowCap = await prisma.supplier.create({ data: { name: 'Snow Cap', contactName: 'Mary Johnson', phone: '604-555-0102', email: 'orders@snowcap.ca', orderPlatform: 'Phone', cutoffDays: 'Monday', deliveryDays: 'Tuesday' } })
  const legendsHaul = await prisma.supplier.create({ data: { name: 'Legends Haul', contactName: 'Bob Williams', phone: '604-555-0103', email: 'bob@legendshaul.ca', orderPlatform: 'Email', cutoffDays: 'Wednesday', deliveryDays: 'Thursday' } })
  const twoRivers = await prisma.supplier.create({ data: { name: 'Two Rivers', contactName: 'Alice Brown', phone: '604-555-0104', email: 'orders@tworivers.ca', orderPlatform: 'Online Portal', cutoffDays: 'Monday, Wednesday', deliveryDays: 'Tuesday, Thursday' } })
  const intercity = await prisma.supplier.create({ data: { name: 'Intercity', contactName: 'David Lee', phone: '604-555-0105', email: 'orders@intercity.ca', orderPlatform: 'Phone', cutoffDays: 'Friday', deliveryDays: 'Monday' } })
  const brewCreek = await prisma.supplier.create({ data: { name: 'Brew Creek Farm', contactName: 'Sarah Green', phone: '604-555-0106', email: 'sarah@brewcreekfarm.ca', orderPlatform: 'Email', cutoffDays: 'Thursday', deliveryDays: 'Saturday' } })
  const northArm = await prisma.supplier.create({ data: { name: 'North Arm Farms', contactName: 'Mike Taylor', phone: '604-555-0107', email: 'mike@northarmfarms.ca', orderPlatform: 'Phone', cutoffDays: 'Wednesday', deliveryDays: 'Friday' } })
  const seaSky = await prisma.supplier.create({ data: { name: 'Sea to Sky Mushrooms', contactName: 'Linda Chen', phone: '604-555-0108', email: 'linda@seatoskymushrooms.ca', orderPlatform: 'Email', cutoffDays: 'Tuesday', deliveryDays: 'Wednesday' } })

  // Helper function
  function calcPPBU(purchasePrice: number, qtyPerPurchaseUnit: number, conversionFactor: number) {
    return purchasePrice / (qtyPerPurchaseUnit * conversionFactor)
  }

  // Inventory Items
  const sourdough = await prisma.inventoryItem.create({ data: { itemName: 'Sourdough Loaf', category: 'BREAD', supplierId: legendsHaul.id, purchaseUnit: 'loaf', qtyPerPurchaseUnit: 1, purchasePrice: 4.50, baseUnit: 'g', conversionFactor: 800, pricePerBaseUnit: calcPPBU(4.50, 1, 800), stockOnHand: 12, abbreviation: 'SD-LOAF', location: 'Bread Rack' } })
  const brioche = await prisma.inventoryItem.create({ data: { itemName: 'Brioche Bun', category: 'BREAD', supplierId: legendsHaul.id, purchaseUnit: 'dozen', qtyPerPurchaseUnit: 12, purchasePrice: 9.60, baseUnit: 'each', conversionFactor: 1, pricePerBaseUnit: calcPPBU(9.60, 12, 1), stockOnHand: 36, abbreviation: 'BRIO-BUN', location: 'Bread Rack' } })
  const butter = await prisma.inventoryItem.create({ data: { itemName: 'Butter Unsalted', category: 'DAIRY', supplierId: snowCap.id, purchaseUnit: 'kg block', qtyPerPurchaseUnit: 1, purchasePrice: 8.50, baseUnit: 'g', conversionFactor: 1000, pricePerBaseUnit: calcPPBU(8.50, 1, 1000), stockOnHand: 5, abbreviation: 'BUT-UN', location: 'Walk-in Cooler' } })
  const heavyCream = await prisma.inventoryItem.create({ data: { itemName: 'Heavy Cream 35%', category: 'DAIRY', supplierId: snowCap.id, purchaseUnit: '2L carton', qtyPerPurchaseUnit: 1, purchasePrice: 7.20, baseUnit: 'ml', conversionFactor: 2000, pricePerBaseUnit: calcPPBU(7.20, 1, 2000), stockOnHand: 8, abbreviation: 'HVY-CRM', location: 'Walk-in Cooler' } })
  const parmigiano = await prisma.inventoryItem.create({ data: { itemName: 'Parmigiano Reggiano', category: 'DAIRY', supplierId: sysco.id, purchaseUnit: 'kg', qtyPerPurchaseUnit: 1, purchasePrice: 32.00, baseUnit: 'g', conversionFactor: 1000, pricePerBaseUnit: calcPPBU(32.00, 1, 1000), stockOnHand: 3, abbreviation: 'PARM-REG', location: 'Walk-in Cooler' } })
  const pastaFlour = await prisma.inventoryItem.create({ data: { itemName: 'Pasta Flour 00', category: 'DRY', supplierId: sysco.id, purchaseUnit: '25kg bag', qtyPerPurchaseUnit: 1, purchasePrice: 42.00, baseUnit: 'g', conversionFactor: 25000, pricePerBaseUnit: calcPPBU(42.00, 1, 25000), stockOnHand: 2, abbreviation: 'FLOUR-00', location: 'Dry Storage' } })
  const oliveoil = await prisma.inventoryItem.create({ data: { itemName: 'Extra Virgin Olive Oil', category: 'DRY', supplierId: sysco.id, purchaseUnit: '4L tin', qtyPerPurchaseUnit: 1, purchasePrice: 38.00, baseUnit: 'ml', conversionFactor: 4000, pricePerBaseUnit: calcPPBU(38.00, 1, 4000), stockOnHand: 6, abbreviation: 'EVOO', location: 'Dry Storage' } })
  const arborio = await prisma.inventoryItem.create({ data: { itemName: 'Arborio Rice', category: 'DRY', supplierId: sysco.id, purchaseUnit: '5kg bag', qtyPerPurchaseUnit: 1, purchasePrice: 18.00, baseUnit: 'g', conversionFactor: 5000, pricePerBaseUnit: calcPPBU(18.00, 1, 5000), stockOnHand: 4, abbreviation: 'ARBOR-R', location: 'Dry Storage' } })
  const salmon = await prisma.inventoryItem.create({ data: { itemName: 'Atlantic Salmon Fillet', category: 'FISH', supplierId: twoRivers.id, purchaseUnit: 'kg', qtyPerPurchaseUnit: 1, purchasePrice: 24.00, baseUnit: 'g', conversionFactor: 1000, pricePerBaseUnit: calcPPBU(24.00, 1, 1000), stockOnHand: 8, abbreviation: 'SAL-ATL', location: 'Fish Cooler' } })
  const halibut = await prisma.inventoryItem.create({ data: { itemName: 'Pacific Halibut', category: 'FISH', supplierId: twoRivers.id, purchaseUnit: 'kg', qtyPerPurchaseUnit: 1, purchasePrice: 38.00, baseUnit: 'g', conversionFactor: 1000, pricePerBaseUnit: calcPPBU(38.00, 1, 1000), stockOnHand: 4, abbreviation: 'HAL-PAC', location: 'Fish Cooler' } })
  const beefTenderloin = await prisma.inventoryItem.create({ data: { itemName: 'Beef Tenderloin', category: 'MEAT', supplierId: intercity.id, purchaseUnit: 'kg', qtyPerPurchaseUnit: 1, purchasePrice: 55.00, baseUnit: 'g', conversionFactor: 1000, pricePerBaseUnit: calcPPBU(55.00, 1, 1000), stockOnHand: 6, abbreviation: 'BEEF-TEN', location: 'Meat Cooler' } })
  const duckBreast = await prisma.inventoryItem.create({ data: { itemName: 'Duck Breast', category: 'MEAT', supplierId: intercity.id, purchaseUnit: 'kg', qtyPerPurchaseUnit: 1, purchasePrice: 28.00, baseUnit: 'g', conversionFactor: 1000, pricePerBaseUnit: calcPPBU(28.00, 1, 1000), stockOnHand: 5, abbreviation: 'DUCK-BR', location: 'Meat Cooler' } })
  const chickenThigh = await prisma.inventoryItem.create({ data: { itemName: 'Chicken Thigh Boneless', category: 'MEAT', supplierId: sysco.id, purchaseUnit: 'kg', qtyPerPurchaseUnit: 1, purchasePrice: 9.50, baseUnit: 'g', conversionFactor: 1000, pricePerBaseUnit: calcPPBU(9.50, 1, 1000), stockOnHand: 15, abbreviation: 'CHKN-TH', location: 'Meat Cooler' } })
  const demiGlace = await prisma.inventoryItem.create({ data: { itemName: 'Demi Glace', category: 'PREPD', supplierId: sysco.id, purchaseUnit: '1L container', qtyPerPurchaseUnit: 1, purchasePrice: 22.00, baseUnit: 'ml', conversionFactor: 1000, pricePerBaseUnit: calcPPBU(22.00, 1, 1000), stockOnHand: 10, abbreviation: 'DEMI-GL', location: 'Walk-in Cooler' } })
  const tomatoes = await prisma.inventoryItem.create({ data: { itemName: 'Roma Tomatoes', category: 'PROD', supplierId: northArm.id, purchaseUnit: 'flat (20lbs)', qtyPerPurchaseUnit: 1, purchasePrice: 28.00, baseUnit: 'g', conversionFactor: 9072, pricePerBaseUnit: calcPPBU(28.00, 1, 9072), stockOnHand: 3, abbreviation: 'TOM-ROM', location: 'Produce Cooler' } })
  const garlic = await prisma.inventoryItem.create({ data: { itemName: 'Garlic', category: 'PROD', supplierId: northArm.id, purchaseUnit: '5lb bag', qtyPerPurchaseUnit: 1, purchasePrice: 12.00, baseUnit: 'g', conversionFactor: 2268, pricePerBaseUnit: calcPPBU(12.00, 1, 2268), stockOnHand: 5, abbreviation: 'GAR', location: 'Produce Cooler' } })
  const shallots = await prisma.inventoryItem.create({ data: { itemName: 'Shallots', category: 'PROD', supplierId: brewCreek.id, purchaseUnit: 'kg', qtyPerPurchaseUnit: 1, purchasePrice: 6.50, baseUnit: 'g', conversionFactor: 1000, pricePerBaseUnit: calcPPBU(6.50, 1, 1000), stockOnHand: 4, abbreviation: 'SHALT', location: 'Produce Cooler' } })
  const mushrooms = await prisma.inventoryItem.create({ data: { itemName: 'King Oyster Mushrooms', category: 'PROD', supplierId: seaSky.id, purchaseUnit: 'kg', qtyPerPurchaseUnit: 1, purchasePrice: 18.00, baseUnit: 'g', conversionFactor: 1000, pricePerBaseUnit: calcPPBU(18.00, 1, 1000), stockOnHand: 3, abbreviation: 'MUSH-KO', location: 'Produce Cooler' } })
  const dishSoap = await prisma.inventoryItem.create({ data: { itemName: 'Commercial Dish Soap', category: 'CHM', supplierId: sysco.id, purchaseUnit: '4L jug', qtyPerPurchaseUnit: 1, purchasePrice: 18.00, baseUnit: 'ml', conversionFactor: 4000, pricePerBaseUnit: calcPPBU(18.00, 1, 4000), stockOnHand: 8, abbreviation: 'SOAP-DS', location: 'Chemical Storage' } })
  const sanitizer = await prisma.inventoryItem.create({ data: { itemName: 'Food Safe Sanitizer', category: 'CHM', supplierId: sysco.id, purchaseUnit: '4L jug', qtyPerPurchaseUnit: 1, purchasePrice: 24.00, baseUnit: 'ml', conversionFactor: 4000, pricePerBaseUnit: calcPPBU(24.00, 1, 4000), stockOnHand: 6, abbreviation: 'SANIT', location: 'Chemical Storage' } })
  const eggs = await prisma.inventoryItem.create({ data: { itemName: 'Free Range Eggs', category: 'DAIRY', supplierId: brewCreek.id, purchaseUnit: 'flat (30)', qtyPerPurchaseUnit: 30, purchasePrice: 15.00, baseUnit: 'each', conversionFactor: 1, pricePerBaseUnit: calcPPBU(15.00, 30, 1), stockOnHand: 90, abbreviation: 'EGG-FR', location: 'Walk-in Cooler' } })
  const chickenStock = await prisma.inventoryItem.create({ data: { itemName: 'Chicken Stock', category: 'PREPD', supplierId: sysco.id, purchaseUnit: '4L bag', qtyPerPurchaseUnit: 1, purchasePrice: 12.00, baseUnit: 'ml', conversionFactor: 4000, pricePerBaseUnit: calcPPBU(12.00, 1, 4000), stockOnHand: 20, abbreviation: 'CHK-STK', location: 'Walk-in Cooler' } })
  const whiteWine = await prisma.inventoryItem.create({ data: { itemName: 'White Wine (cooking)', category: 'DRY', supplierId: sysco.id, purchaseUnit: '750ml bottle', qtyPerPurchaseUnit: 1, purchasePrice: 12.00, baseUnit: 'ml', conversionFactor: 750, pricePerBaseUnit: calcPPBU(12.00, 1, 750), stockOnHand: 12, abbreviation: 'WINE-WH', location: 'Dry Storage' } })

  // Invoices
  const invoice1 = await prisma.invoice.create({
    data: {
      supplierId: sysco.id,
      invoiceDate: new Date('2026-03-28'),
      invoiceNumber: 'SYS-2026-0328',
      totalAmount: 245.50,
      status: 'COMPLETE',
    }
  })

  await prisma.invoiceLineItem.createMany({
    data: [
      { invoiceId: invoice1.id, inventoryItemId: butter.id, qtyPurchased: 5, unitPrice: 8.50, lineTotal: 42.50 },
      { invoiceId: invoice1.id, inventoryItemId: heavyCream.id, qtyPurchased: 6, unitPrice: 7.20, lineTotal: 43.20 },
      { invoiceId: invoice1.id, inventoryItemId: parmigiano.id, qtyPurchased: 3, unitPrice: 32.00, lineTotal: 96.00 },
      { invoiceId: invoice1.id, inventoryItemId: arborio.id, qtyPurchased: 2, unitPrice: 18.00, lineTotal: 36.00 },
      { invoiceId: invoice1.id, inventoryItemId: oliveoil.id, qtyPurchased: 1, unitPrice: 38.00, lineTotal: 38.00 },
    ]
  })

  const invoice2 = await prisma.invoice.create({
    data: {
      supplierId: twoRivers.id,
      invoiceDate: new Date('2026-04-01'),
      invoiceNumber: 'TR-2026-0401',
      totalAmount: 380.00,
      status: 'PENDING',
    }
  })

  await prisma.invoiceLineItem.createMany({
    data: [
      { invoiceId: invoice2.id, inventoryItemId: salmon.id, qtyPurchased: 8, unitPrice: 24.00, lineTotal: 192.00 },
      { invoiceId: invoice2.id, inventoryItemId: halibut.id, qtyPurchased: 5, unitPrice: 38.00, lineTotal: 190.00 },
    ]
  })

  // Wastage Logs
  await prisma.wastageLog.createMany({
    data: [
      { inventoryItemId: salmon.id, date: new Date('2026-04-01'), qtyWasted: 200, unit: 'g', reason: 'SPOILAGE', costImpact: 200 * (24.00 / 1000), loggedBy: 'Chef Marco', notes: 'End of service trim' },
      { inventoryItemId: mushrooms.id, date: new Date('2026-04-01'), qtyWasted: 150, unit: 'g', reason: 'PREP_TRIM', costImpact: 150 * (18.00 / 1000), loggedBy: 'Chef Marco' },
      { inventoryItemId: tomatoes.id, date: new Date('2026-03-31'), qtyWasted: 500, unit: 'g', reason: 'SPOILAGE', costImpact: 500 * (28.00 / 9072), loggedBy: 'Sous Chef Lisa', notes: 'Overripe' },
      { inventoryItemId: chickenThigh.id, date: new Date('2026-03-30'), qtyWasted: 300, unit: 'g', reason: 'BURNT', costImpact: 300 * (9.50 / 1000), loggedBy: 'Chef Marco' },
      { inventoryItemId: heavyCream.id, date: new Date('2026-03-29'), qtyWasted: 250, unit: 'ml', reason: 'EXPIRED', costImpact: 250 * (7.20 / 2000), loggedBy: 'Sous Chef Lisa' },
    ]
  })

  // Sales entries
  const salesDates = [
    { date: '2026-03-28', revenue: 4250, pct: 0.72, covers: 85 },
    { date: '2026-03-29', revenue: 5100, pct: 0.70, covers: 102 },
    { date: '2026-03-30', revenue: 3800, pct: 0.71, covers: 76 },
    { date: '2026-03-31', revenue: 4600, pct: 0.69, covers: 92 },
    { date: '2026-04-01', revenue: 5200, pct: 0.73, covers: 104 },
    { date: '2026-04-02', revenue: 6100, pct: 0.68, covers: 122 },
    { date: '2026-04-03', revenue: 4900, pct: 0.71, covers: 98 },
  ]

  for (const s of salesDates) {
    await prisma.salesEntry.create({
      data: { date: new Date(s.date), totalRevenue: s.revenue, foodSalesPct: s.pct, covers: s.covers }
    })
  }

  console.log('Seed completed successfully!')
}

main().catch(console.error).finally(() => prisma.$disconnect())
