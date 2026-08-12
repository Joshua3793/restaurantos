/**
 * READ-ONLY worklist: items whose stored pack format disagrees with the pack
 * their invoices describe.
 *
 * DELIBERATELY NOT A MIGRATION. `packFormatsDisagree` (src/lib/item-model.ts)
 * documents, with measured evidence, that the data cannot say which side is
 * stale: OCR often reports packQty 1 when the invoice prints only the container
 * size, so the LINE understates a case the item has right — and equally the
 * item's chain may simply be old. The approve route already refuses to guess and
 * skips the price write for a human. This script does the same: it assembles the
 * evidence for both sides, prices the consequence, and hands a human an ordered
 * list of decisions. It writes nothing.
 *
 * Uses the app's own helpers at the documented 25% tolerance, so what it flags is
 * exactly what approve refuses to price.
 *
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *     scripts/audit-packchain-worklist.ts [> docs/audits/packchain-worklist.md]
 */
try {
  process.loadEnvFile()
} catch (err) {
  console.error('Failed to load .env:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

import { prisma } from '@/lib/prisma'
import {
  PRICING_SELECT, asChainItem, basePerPurchase, pricePerBaseUnit,
  invoicePackBaseTotal, packFormatsDisagree,
  type PackLink,
} from '@/lib/item-model'

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(x) ? x : 0
}
const money = (v: number) => `$${v.toFixed(2)}`
const ppbStr = (v: number, unit: string) => v >= 0.1 ? `$${v.toFixed(2)}/${unit}` : `$${v.toFixed(4)}/${unit}`
const round = (v: number) => Math.round(v * 100) / 100

/** "1 case = 16 each · 1 each = 946 ml" — each link names what ONE of it holds. */
function describeChain(chain: PackLink[], baseUnit: string): string {
  return (chain ?? []).map((l, i) => {
    const holds = i === chain.length - 1 ? baseUnit : chain[i + 1].unit
    return `1 ${l.unit} = ${n(l.per)} ${holds}`
  }).join(' · ')
}

/**
 * Which side looks stale. NOT a decision — a triage order, so 43 undifferentiated
 * judgement calls become a few small piles.
 *
 * The strongest signal is an INTEGER ratio with packQty 1 on every line: that is
 * precisely the pattern packFormatsDisagree documents — the invoice printed one
 * container of an n-pack, so the item's larger case is probably right and the LINE
 * is the understatement. An item claiming LESS than the invoice cannot be that,
 * and a suspiciously round 1000 g / 1 each total is the shape of a default nobody
 * ever filled in.
 */
type Verdict = 'OCR_UNDERSTATED' | 'ITEM_STALE' | 'PACK_CHANGED' | 'UNCLEAR'

function triage(itemBaseTotal: number, claims: Claim[]): { verdict: Verdict; why: string } {
  if (claims.length > 1) {
    return { verdict: 'PACK_CHANGED', why: `invoices disagree with each other (${claims.length} distinct packs) — read them by date` }
  }
  const c = claims[0]
  const ratio = itemBaseTotal / c.baseTotal
  const nearInt = Math.abs(ratio - Math.round(ratio)) < 0.02
  if (ratio > 1.5 && nearInt && c.allPackQtyOne) {
    return { verdict: 'OCR_UNDERSTATED', why: `item = exactly ${Math.round(ratio)} × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a ${Math.round(ratio)}-pack` }
  }
  if (ratio < 1) {
    return { verdict: 'ITEM_STALE', why: `the invoice's container is ${(1 / ratio).toFixed(2)}× BIGGER than the item's whole case — the item cannot be an under-read of the invoice` }
  }
  return { verdict: 'UNCLEAR', why: `item is ${ratio.toFixed(2)}× the invoice — neither a clean multiple nor smaller; needs the physical pack` }
}

/** Loose supplier match: offers store the canonical name ("Sysco"), invoice
 *  sessions carry the raw OCR variant ("Sysco Canada, Inc. - Vancouver"). */
function sameSupplier(a: string, b: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z]/g, '')
  const [x, y] = [norm(a), norm(b)]
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x))
}

interface Claim {
  baseTotal: number
  lines: number
  suppliers: Set<string>
  first: string
  last: string
  packs: Set<string>
  /** packQty === 1 on every line — the known OCR understatement pattern. */
  allPackQtyOne: boolean
  spend: number
  lastUnitPrice: number
}

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true, itemName: true, category: true, stockOnHand: true, isStocked: true,
      ...PRICING_SELECT,
      supplierPrices: {
        select: {
          supplierName: true, isPrimary: true, lastPrice: true,
          packQty: true, packSize: true, packUOM: true,
        },
      },
      invoiceLineItems: { select: { id: true }, take: 1 },
    },
  })

  const scanLines = await prisma.invoiceScanItem.findMany({
    where: {
      session: { status: 'APPROVED' },
      approved: true,
      splitToSessionId: null,
      matchedItemId: { not: null },
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] },
    },
    select: {
      matchedItemId: true, invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      rawUnitPrice: true, rawLineTotal: true, rawDescription: true,
      session: { select: { supplierName: true, invoiceDate: true } },
    },
  })

  const byItem = new Map<string, typeof scanLines>()
  for (const l of scanLines) {
    if (!l.matchedItemId) continue
    const arr = byItem.get(l.matchedItemId) ?? []
    arr.push(l)
    byItem.set(l.matchedItemId, arr)
  }

  // Recipe exposure: how many recipe lines read this item's spine price.
  const recipeUse = new Map<string, number>()
  for (const g of await prisma.recipeIngredient.groupBy({
    by: ['inventoryItemId'], _count: { _all: true },
  })) {
    if (g.inventoryItemId) recipeUse.set(g.inventoryItemId, g._count._all)
  }

  interface Row {
    id: string; name: string; category: string
    baseUnit: string; itemBaseTotal: number
    chainDesc: string; currentPpb: number
    claims: Claim[]
    stockValueNow: number; stockValueAlt: number
    recipeLines: number; spend: number
    primarySupplier: string | null
    /** Buying from someone other than the supplier whose offer sets the format. */
    supplierMismatch: boolean
    ratio: number
    priceFollowsChain: boolean
    verdict: Verdict
    why: string
  }
  const rows: Row[] = []

  for (const item of items) {
    const lines = byItem.get(item.id)
    if (!lines?.length) continue
    const chainItem = asChainItem(item)
    const baseUnit = chainItem.baseUnit
    const itemBaseTotal = basePerPurchase((item.packChain as PackLink[]) ?? [])
    if (!(itemBaseTotal > 0)) continue

    // Group the invoice lines by the pack total each one implies.
    const claims = new Map<number, Claim>()
    let disagreeing = 0
    for (const l of lines) {
      const invoiceBaseTotal = invoicePackBaseTotal({
        packQty:  l.invoicePackQty  != null ? Number(l.invoicePackQty)  : null,
        packSize: l.invoicePackSize != null ? Number(l.invoicePackSize) : null,
        packUOM:  l.invoicePackUOM,
      }, baseUnit)
      if (!(invoiceBaseTotal > 0)) continue
      if (!packFormatsDisagree(invoiceBaseTotal, itemBaseTotal).disagree) continue
      disagreeing++

      const key = round(invoiceBaseTotal)
      const date = l.session.invoiceDate ?? '?'
      const c = claims.get(key) ?? {
        baseTotal: key, lines: 0, suppliers: new Set<string>(), first: date, last: date,
        packs: new Set<string>(), allPackQtyOne: true, spend: 0, lastUnitPrice: 0,
      }
      c.lines++
      c.suppliers.add(l.session.supplierName ?? '?')
      c.packs.add(`${n(l.invoicePackQty)} × ${n(l.invoicePackSize)} ${l.invoicePackUOM}`)
      if (n(l.invoicePackQty) !== 1) c.allPackQtyOne = false
      c.spend += n(l.rawLineTotal)
      if (date >= c.last) { c.last = date; c.lastUnitPrice = n(l.rawUnitPrice) }
      if (date < c.first) c.first = date
      claims.set(key, c)
    }
    if (disagreeing === 0) continue

    const currentPpb = pricePerBaseUnit(chainItem)
    const sorted = [...claims.values()].sort((a, b) => b.lines - a.lines)
    const top = sorted[0]
    // A RATE-priced item derives $/base from its rate, NOT from the chain — the
    // pack format only drives the count readout and how much a receipt credits.
    // Showing a "price under the other claim" for those would be a lie.
    const pricing = chainItem.pricing
    const priceFollowsChain = pricing.mode === 'PACK'
    const price = pricing.mode === 'PACK' ? Number(pricing.purchasePrice || 0) : 0
    const altPpb = priceFollowsChain && top.baseTotal > 0 ? price / top.baseTotal : currentPpb
    const stock = n(item.stockOnHand)
    const primary = item.supplierPrices.find(o => o.isPrimary)?.supplierName ?? null

    rows.push({
      id: item.id, name: item.itemName, category: item.category,
      baseUnit, itemBaseTotal,
      chainDesc: describeChain((item.packChain as PackLink[]) ?? [], baseUnit),
      currentPpb,
      claims: sorted,
      stockValueNow: stock * currentPpb,
      stockValueAlt: stock * altPpb,
      recipeLines: recipeUse.get(item.id) ?? 0,
      spend: sorted.reduce((s, c) => s + c.spend, 0),
      primarySupplier: primary,
      supplierMismatch: !!primary && ![...top.suppliers].some(sup => sameSupplier(sup, primary)),
      ratio: itemBaseTotal / top.baseTotal,
      priceFollowsChain,
      ...triage(itemBaseTotal, sorted),
    })
  }

  // Order by what a wrong answer costs: spend through the item, then recipe reach.
  rows.sort((a, b) => (b.spend + Math.abs(b.stockValueNow - b.stockValueAlt) * 2)
                    - (a.spend + Math.abs(a.stockValueNow - a.stockValueAlt) * 2))

  console.log(`# Pack-format worklist\n`)
  console.log(`${rows.length} active items where the stored pack format and the invoice's pack`)
  console.log(`disagree by more than the 25% tolerance in \`packFormatsDisagree\`.\n`)
  console.log(`**Nothing here can be auto-repaired.** Either side may be the stale one and the`)
  console.log(`data does not say which — that is why \`approve\` skips the price write instead of`)
  console.log(`guessing. Each entry gives both claims, what the spine reads under each, and what`)
  console.log(`is riding on the answer. Decide per item, then fix the losing side.\n`)
  console.log(`Total spend through these items: ${money(rows.reduce((s, r) => s + r.spend, 0))}\n`)

  const LABEL: Record<Verdict, string> = {
    OCR_UNDERSTATED: 'Invoice likely understated — fix the LINE / teach the format',
    ITEM_STALE:      'Item format likely stale — fix the OFFER',
    PACK_CHANGED:    'Supplier pack changed — read by date',
    UNCLEAR:         'Needs the physical pack in hand',
  }
  console.log(`## Triage\n`)
  console.log(`| verdict | items | spend |`)
  console.log(`|---|---|---|`)
  for (const v of ['ITEM_STALE', 'OCR_UNDERSTATED', 'PACK_CHANGED', 'UNCLEAR'] as Verdict[]) {
    const g = rows.filter(r => r.verdict === v)
    if (!g.length) continue
    console.log(`| **${LABEL[v]}** | ${g.length} | ${money(g.reduce((s, r) => s + r.spend, 0))} |`)
  }
  const mismatched = rows.filter(r => r.supplierMismatch)
  console.log(`\nEvery one of these items has a **primary supplier offer**, so the durable fix is on`)
  console.log(`the OFFER's format — \`syncPrimaryOfferToItem\` rewrites the item chain from it, and an`)
  console.log(`item-only edit will be silently overwritten on the next approve.\n`)
  console.log(`**${mismatched.length} of ${rows.length} are buying from a supplier that is NOT the primary offer**`)
  console.log(`(${money(mismatched.reduce((s, r) => s + r.spend, 0))}). For those the two packs may both be correct —`)
  console.log(`each for its own supplier — and the real defect is that the item's format is inherited from a`)
  console.log(`supplier you have stopped buying from. Check that before touching any format.\n`)
  console.log(`---\n`)

  for (const [i, r] of rows.entries()) {
    console.log(`## ${i + 1}. ${r.name}  <sub>${r.category} · ${r.verdict}</sub>\n`)
    console.log(`| | claim | reads as |`)
    console.log(`|---|---|---|`)
    console.log(`| **item chain** | ${r.chainDesc} → **${round(r.itemBaseTotal)} ${r.baseUnit}** per case | ${ppbStr(r.currentPpb, r.baseUnit)} |`)
    for (const c of r.claims) {
      const alt = r.priceFollowsChain ? r.currentPpb * (r.itemBaseTotal / c.baseTotal) : r.currentPpb
      const flag = c.allPackQtyOne ? ' ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size' : ''
      console.log(`| **invoice** ×${c.lines} | ${[...c.packs].join(', ')} → **${c.baseTotal} ${r.baseUnit}** | ${r.priceFollowsChain ? ppbStr(alt, r.baseUnit) : 'unchanged'} |`)
      console.log(`| | <sub>${[...c.suppliers].join(', ')} · ${c.first} → ${c.last} · ${money(c.spend)}${flag}</sub> | |`)
    }
    console.log(``)
    console.log(`- **${r.why}**`)
    console.log(`- disagreement: **${r.ratio.toFixed(2)}×** (item ÷ invoice)`)
    if (!r.priceFollowsChain) {
      console.log(`- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong`)
      console.log(`  format instead corrupts the count readout and how much each receipt credits.`)
    }
    console.log(`- riding on it: **${r.recipeLines} recipe line${r.recipeLines === 1 ? '' : 's'}**`
              + ` · stock value ${money(r.stockValueNow)} → ${money(r.stockValueAlt)} if the invoice claim wins`)
    if (r.primarySupplier && r.supplierMismatch) {
      console.log(`- ⚠︎ **you are buying from ${[...r.claims[0].suppliers].join(', ')}, but the primary offer is ${r.primarySupplier}**.`)
      console.log(`  The item's format comes from ${r.primarySupplier}, so the two packs may BOTH be right for`)
      console.log(`  their own supplier. The fix is probably to make the supplier you actually buy from primary —`)
      console.log(`  not to rewrite ${r.primarySupplier}'s format.`)
    } else if (r.primarySupplier) {
      console.log(`- primary offer: **${r.primarySupplier}** — edit that offer's format`)
    }
    console.log(`- \`id=${r.id}\`\n`)
  }
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
