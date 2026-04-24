import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

export async function POST(req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status })
    throw e
  }

  try {
    const body = await req.json()
    const { messages, rcId, isDefault } = body as {
      messages: { role: 'user' | 'assistant'; content: string }[]
      rcId?: string
      isDefault?: boolean
    }

    if (!messages || !Array.isArray(messages)) {
      return new Response('Invalid messages', { status: 400 })
    }

    const now = new Date()
    const thisWeekStart = new Date(now)
    thisWeekStart.setDate(now.getDate() - 7)
    const lastWeekStart = new Date(now)
    lastWeekStart.setDate(now.getDate() - 14)

    const rcFilter = rcId && !isDefault ? { revenueCenterId: rcId } : {}
    const rcFilterWithDefault = rcId
      ? isDefault
        ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
        : { revenueCenterId: rcId }
      : {}

    const [
      inventoryItems,
      invoiceSessions,
      priceAlerts,
      recipes,
      salesThisWeek,
      salesLastWeek,
      wastageThisWeek,
      lastCount,
    ] = await Promise.all([
      prisma.inventoryItem.findMany({
        where: { isActive: true },
        select: {
          id: true,
          itemName: true,
          category: true,
          stockOnHand: true,
          purchasePrice: true,
          pricePerBaseUnit: true,
          lastCountDate: true,
          supplierId: true,
          supplier: { select: { name: true } },
        },
        orderBy: { stockOnHand: 'asc' },
      }),
      prisma.invoiceSession.findMany({
        where: rcFilterWithDefault,
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { _count: { select: { scanItems: true, priceAlerts: true } } },
      }),
      prisma.priceAlert.findMany({
        where: { acknowledged: false },
        include: { inventoryItem: { select: { itemName: true } } },
        take: 10,
      }),
      prisma.recipe.findMany({
        where: { type: 'MENU', isActive: true },
        select: {
          id: true,
          name: true,
          menuPrice: true,
          ingredients: {
            select: {
              qtyBase: true,
              inventoryItem: { select: { pricePerBaseUnit: true, baseUnit: true } },
            },
          },
        },
        take: 50,
      }),
      prisma.salesEntry.aggregate({
        where: { date: { gte: thisWeekStart }, ...rcFilter },
        _sum: { totalRevenue: true },
      }),
      prisma.salesEntry.aggregate({
        where: { date: { gte: lastWeekStart, lt: thisWeekStart }, ...rcFilter },
        _sum: { totalRevenue: true },
      }),
      prisma.wastageLog.aggregate({
        where: { date: { gte: thisWeekStart }, ...rcFilter },
        _sum: { costImpact: true },
      }),
      prisma.countSession.findFirst({
        where: rcFilterWithDefault,
        orderBy: { startedAt: 'desc' },
        include: { _count: { select: { lines: true } } },
      }),
    ])

    // Derive inventory stats
    const totalItems = inventoryItems.length
    const outOfStockItems = inventoryItems.filter(i => Number(i.stockOnHand) <= 0)
    const totalValue = inventoryItems.reduce(
      (sum, i) => sum + Number(i.stockOnHand) * Number(i.pricePerBaseUnit),
      0,
    )

    // Top 5 categories by count
    const categoryCounts: Record<string, number> = {}
    for (const item of inventoryItems) {
      categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1
    }
    const topCategories = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, count]) => `${cat} (${count})`)

    // Invoice stats
    const awaitingReview = invoiceSessions.filter(s => s.status === 'REVIEW').length
    const unackAlerts = priceAlerts.length

    // Recent sessions summary
    const recentSessionLines = invoiceSessions
      .slice(0, 5)
      .map(s => `  • ${s.supplierName ?? 'Unknown supplier'} — ${s.status}${s.total ? ` — ${formatCurrency(Number(s.total))}` : ''}`)
      .join('\n')

    // Compute food cost % for each recipe
    const recipesWithCost = recipes.map(r => {
      const totalCost = r.ingredients.reduce((sum, ing) => {
        if (!ing.inventoryItem) return sum
        return sum + Number(ing.qtyBase) * Number(ing.inventoryItem.pricePerBaseUnit)
      }, 0)
      const menuPrice = r.menuPrice ? Number(r.menuPrice) : null
      const foodCostPct = menuPrice && menuPrice > 0 ? (totalCost / menuPrice) * 100 : null
      return { name: r.name, foodCostPct }
    })

    // High food cost recipes
    const highFoodCostRecipes = recipesWithCost
      .filter(r => r.foodCostPct !== null && r.foodCostPct > 35)
      .sort((a, b) => (b.foodCostPct ?? 0) - (a.foodCostPct ?? 0))
      .slice(0, 5)

    // Sales
    const thisWeekRevenue = Number(salesThisWeek._sum.totalRevenue ?? 0)
    const lastWeekRevenue = Number(salesLastWeek._sum.totalRevenue ?? 0)
    const wastageAmount = Number(wastageThisWeek._sum.costImpact ?? 0)

    // Last count
    const lastCountStr = lastCount
      ? `${lastCount.label} on ${new Date(lastCount.startedAt).toLocaleDateString()} (${lastCount.status}, ${lastCount._count.lines} lines)`
      : 'No counts yet'

    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

    const systemPrompt = `You are CONTROLA, an intelligent assistant built into Fergie's OS — a restaurant back-office management platform. You help the team understand how to use the system and answer questions about the restaurant's current data.

## App Features
- **Inventory**: Manage all ingredients and supplies. Track stock on hand, purchase prices, suppliers, storage areas. Items are organized by category. Supports RC-based stock allocations.
- **Invoice Scanner**: Upload supplier invoices (photo/PDF/CSV). Claude OCR extracts line items, fuzzy-matches them to inventory items. User reviews matches, approves/rejects. On approval, inventory prices are updated and price/recipe alerts are fired.
- **Recipes**: Two types — PREP (produces an inventory item, e.g. a sauce) and MENU (what gets sold). Costed automatically using ingredient prices. Food cost % = total ingredient cost / menu price.
- **Stock Count**: Create count sessions to physically count inventory. System calculates expected quantity using theoretical consumption (sales − purchases − wastage). Shows variance.
- **Prep List**: Daily prep planning. Items have par levels and yield targets.
- **Sales**: Log daily sales by menu item. Feeds into theoretical usage and food cost reports.
- **Wastage**: Log waste events with cost impact.
- **Reports**: Stock value, theoretical usage, price alerts history, food cost trends.
- **Revenue Centers (RCs)**: Multiple profit centers (e.g. Restaurant, Catering). Each has its own stock allocation and can be counted/invoiced separately.
- **Settings**: Email digest, Revenue Center management.

## Current Data Snapshot (as of ${dateStr})
**Inventory**: ${totalItems} active items | ${outOfStockItems.length} out of stock | Total value: ${formatCurrency(totalValue)}
Top categories: ${topCategories.join(', ')}
Out of stock items: ${outOfStockItems.slice(0, 5).map(i => i.itemName).join(', ') || 'None'}

**Invoices**: ${awaitingReview} awaiting review | ${unackAlerts} unacknowledged price alerts
Recent sessions:
${recentSessionLines || '  None'}

**Recipes**: ${recipes.length} menu recipes | High food cost (>35%): ${highFoodCostRecipes.length > 0 ? highFoodCostRecipes.map(r => `${r.name} (${r.foodCostPct!.toFixed(1)}%)`).join(', ') : 'None'}

**Sales**: This week ${formatCurrency(thisWeekRevenue)} | Last week ${formatCurrency(lastWeekRevenue)}

**Wastage this week**: ${formatCurrency(wastageAmount)}

**Last count**: ${lastCountStr}

## Guidelines
- Be concise and practical. Use bullet points for lists.
- When referencing data, be specific (use actual numbers from the snapshot above).
- For how-to questions, give step-by-step instructions.
- If asked about something not in the data, say so clearly.
- Keep responses under 300 words unless the question requires more detail.
- You can suggest actions (e.g. "You should approve the 3 invoices awaiting review").`

    const conversationMessages = messages.filter(m => m.content.trim())

    const stream = client.messages.stream({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: conversationMessages,
    })

    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta'
            ) {
              controller.enqueue(encoder.encode(event.delta.text))
            }
          }
        } finally {
          controller.close()
        }
      },
    })

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (err) {
    console.error('[chat] error:', err)
    return new Response('Internal server error', { status: 500 })
  }
}
