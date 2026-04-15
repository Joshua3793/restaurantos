import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { Resend } from 'resend'

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

function pct(n: number) { return `${n.toFixed(1)}%` }

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const toEmail: string = body.email ?? process.env.DIGEST_EMAIL ?? ''

  if (!toEmail) {
    return NextResponse.json({ error: 'No recipient email. Pass { email } or set DIGEST_EMAIL env var.' }, { status: 400 })
  }
  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: 'RESEND_API_KEY not configured. Add it to your .env file.' }, { status: 400 })
  }
  const resend = new Resend(process.env.RESEND_API_KEY)

  // ── Gather data ─────────────────────────────────────────────────────────────
  const now    = new Date()
  const oneWeekAgo = new Date(now); oneWeekAgo.setDate(now.getDate() - 7)
  const twoWeeksAgo = new Date(now); twoWeeksAgo.setDate(now.getDate() - 14)

  const [
    allItems,
    thisWeekSales,
    lastWeekSales,
    thisWeekWastage,
    activeMenuRecipes,
    recentInvoices,
  ] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { isActive: true },
      select: { id: true, itemName: true, stockOnHand: true, pricePerBaseUnit: true, lastCountDate: true },
    }),
    prisma.salesEntry.findMany({
      where: { date: { gte: oneWeekAgo } },
      select: { totalRevenue: true, foodSalesPct: true },
    }),
    prisma.salesEntry.findMany({
      where: { date: { gte: twoWeeksAgo, lt: oneWeekAgo } },
      select: { totalRevenue: true, foodSalesPct: true },
    }),
    prisma.wastageLog.findMany({
      where: { date: { gte: oneWeekAgo } },
      select: { costImpact: true, reason: true },
    }),
    prisma.recipe.findMany({
      where: { isActive: true, type: 'MENU' },
      include: {
        ingredients: {
          include: {
            inventoryItem: { select: { pricePerBaseUnit: true, baseUnit: true } },
          },
        },
      },
      take: 50,
    }),
    prisma.invoice.findMany({
      where: { createdAt: { gte: oneWeekAgo } },
      include: {
        lineItems: {
          include: {
            inventoryItem: { select: { itemName: true, pricePerBaseUnit: true } },
          },
        },
        supplier: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ])

  // ── Compute metrics ──────────────────────────────────────────────────────────
  const thisRevenue = thisWeekSales.reduce((s, e) => s + Number(e.totalRevenue), 0)
  const lastRevenue = lastWeekSales.reduce((s, e) => s + Number(e.totalRevenue), 0)
  const revenueChange = lastRevenue > 0 ? ((thisRevenue - lastRevenue) / lastRevenue) * 100 : 0

  const totalWastageCost = thisWeekWastage.reduce((s, w) => s + Number(w.costImpact), 0)

  // Inventory value
  const inventoryValue = allItems.reduce((s, i) => s + Number(i.stockOnHand) * Number(i.pricePerBaseUnit), 0)

  // Out of stock items (never null lastCountDate + stockOnHand <= 0)
  const outOfStock = allItems.filter(i => i.lastCountDate !== null && Number(i.stockOnHand) <= 0)

  // High food cost recipes (> 35%)
  const highCostRecipes = activeMenuRecipes
    .map(r => {
      const cost = r.ingredients.reduce((s, ing) => {
        if (!ing.inventoryItem) return s
        return s + Number(ing.qtyBase) * Number(ing.inventoryItem.pricePerBaseUnit)
      }, 0)
      const price = r.menuPrice ? Number(r.menuPrice) : null
      const fc = price && price > 0 ? (cost / price) * 100 : null
      return { name: r.name, foodCostPct: fc }
    })
    .filter(r => r.foodCostPct !== null && r.foodCostPct > 35)
    .sort((a, b) => (b.foodCostPct ?? 0) - (a.foodCostPct ?? 0))
    .slice(0, 5)

  // Price changes from invoices this week
  const priceChanges: Array<{ itemName: string; oldPrice: number; newPrice: number; changePct: number }> = []
  for (const invoice of recentInvoices) {
    for (const li of invoice.lineItems) {
      if (!li.inventoryItem) continue
      const oldPrice = Number(li.inventoryItem.pricePerBaseUnit)
      const newPrice = Number(li.unitPrice)
      if (oldPrice > 0 && Math.abs(newPrice - oldPrice) / oldPrice > 0.05) {
        priceChanges.push({
          itemName: li.inventoryItem.itemName,
          oldPrice,
          newPrice,
          changePct: ((newPrice - oldPrice) / oldPrice) * 100,
        })
      }
    }
  }
  const topPriceChanges = priceChanges
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 5)

  // ── Build HTML email ─────────────────────────────────────────────────────────
  const weekLabel = `${oneWeekAgo.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <!-- Header -->
  <div style="background:#1e3a5f;border-radius:16px;padding:28px 32px;margin-bottom:20px">
    <div style="font-size:11px;color:#93c5fd;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">Weekly Digest</div>
    <div style="font-size:22px;font-weight:700;color:#fff">Fergie&rsquo;s Kitchen</div>
    <div style="font-size:13px;color:#93c5fd;margin-top:4px">${weekLabel}</div>
  </div>

  <!-- Revenue row -->
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">
    <div style="background:#fff;border-radius:12px;padding:16px;border:1px solid #e5e7eb">
      <div style="font-size:10px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Revenue</div>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-top:4px">${formatCurrency(thisRevenue)}</div>
      <div style="font-size:11px;margin-top:2px;color:${revenueChange >= 0 ? '#16a34a' : '#dc2626'}">${revenueChange >= 0 ? '▲' : '▼'} ${Math.abs(revenueChange).toFixed(1)}% vs last week</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:16px;border:1px solid #e5e7eb">
      <div style="font-size:10px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Inventory Value</div>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-top:4px">${formatCurrency(inventoryValue)}</div>
    </div>
    <div style="background:${totalWastageCost > 100 ? '#fef2f2' : '#fff'};border-radius:12px;padding:16px;border:1px solid ${totalWastageCost > 100 ? '#fecaca' : '#e5e7eb'}">
      <div style="font-size:10px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Wastage Cost</div>
      <div style="font-size:20px;font-weight:700;color:${totalWastageCost > 100 ? '#dc2626' : '#111827'};margin-top:4px">${formatCurrency(totalWastageCost)}</div>
    </div>
  </div>

  ${outOfStock.length > 0 ? `
  <!-- Out of stock -->
  <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #e5e7eb;margin-bottom:16px">
    <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:12px">⚠ Out of Stock (${outOfStock.length} items)</div>
    ${outOfStock.slice(0, 8).map(i => `
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px">
      <span style="color:#374151">${i.itemName}</span>
      <span style="color:#dc2626;font-weight:600">OUT</span>
    </div>`).join('')}
  </div>` : ''}

  ${highCostRecipes.length > 0 ? `
  <!-- High food cost -->
  <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #e5e7eb;margin-bottom:16px">
    <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:12px">🔴 High Food Cost Recipes (&gt;35%)</div>
    ${highCostRecipes.map(r => `
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px">
      <span style="color:#374151">${r.name}</span>
      <span style="color:#dc2626;font-weight:700">${pct(r.foodCostPct!)}</span>
    </div>`).join('')}
  </div>` : ''}

  ${topPriceChanges.length > 0 ? `
  <!-- Price changes -->
  <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #e5e7eb;margin-bottom:16px">
    <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:12px">📦 Price Changes This Week</div>
    ${topPriceChanges.map(p => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px">
      <span style="color:#374151">${p.itemName}</span>
      <span>
        <span style="color:#6b7280">${formatCurrency(p.oldPrice)}</span>
        <span style="color:#9ca3af;margin:0 4px">→</span>
        <span style="color:${p.changePct > 0 ? '#dc2626' : '#16a34a'};font-weight:600">${formatCurrency(p.newPrice)} (${p.changePct > 0 ? '+' : ''}${p.changePct.toFixed(1)}%)</span>
      </span>
    </div>`).join('')}
  </div>` : ''}

  <!-- Footer -->
  <div style="text-align:center;padding:16px 0;font-size:11px;color:#9ca3af">
    Sent by CONTROLA OS · Fergie&rsquo;s Kitchen<br>
    <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}" style="color:#3b82f6">Open Dashboard</a>
  </div>

</div>
</body>
</html>`

  const { data, error } = await resend.emails.send({
    from: process.env.DIGEST_FROM ?? 'CONTROLA OS <onboarding@resend.dev>',
    to: toEmail,
    subject: `Weekly Digest — ${weekLabel}`,
    html,
  })

  if (error) return NextResponse.json({ error: error.message ?? JSON.stringify(error) }, { status: 500 })
  return NextResponse.json({ success: true, id: data?.id })
}
