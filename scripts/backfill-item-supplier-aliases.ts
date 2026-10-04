// Copies the old InvoiceMatchRule rows into ItemSupplierAlias (Stage 3). The
// rule's supplier STRING is resolved to a Supplier id (exact name, then a
// SupplierAlias spelling, both case-insensitive); rules for merged or
// recipe-made items are skipped; spellings that normalise alike under one
// supplier fold into one alias (highest useCount kept, counts summed).
//   DRY RUN (default):  npx tsx scripts/backfill-item-supplier-aliases.ts
//   APPLY:              npx tsx scripts/backfill-item-supplier-aliases.ts --apply
// Re-runnable: keys that already exist are skipped (createMany skipDuplicates).
// Writes docs/audits/2026-10-aliases/backfill-report.md on every run.
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import { planAliasBackfill, type BackfillRule } from '../src/lib/alias-backfill'

const APPLY = process.argv.includes('--apply')
const REPORT = 'docs/audits/2026-10-aliases/backfill-report.md'
const CHUNK = 200

const cell = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'

async function main() {
  const raw = await prisma.invoiceMatchRule.findMany({
    include: { inventoryItem: { select: { itemName: true, isActive: true, mergedIntoId: true, recipe: { select: { id: true } } } } },
    orderBy: [{ supplierName: 'asc' }, { rawDescription: 'asc' }],
  })
  const suppliers = await prisma.supplier.findMany({ select: { id: true, name: true } })
  const supplierAliases = await prisma.supplierAlias.findMany({ select: { supplierId: true, name: true } })
  const supplierName = new Map(suppliers.map(s => [s.id, s.name]))

  const rules: BackfillRule[] = raw.map(r => ({
    id: r.id, rawDescription: r.rawDescription, supplierName: r.supplierName, inventoryItemId: r.inventoryItemId,
    useCount: r.useCount, lastUsed: r.lastUsed,
    invoicePackQty: r.invoicePackQty, invoicePackSize: r.invoicePackSize, invoicePackUOM: r.invoicePackUOM,
    supplierItemCode: r.supplierItemCode,
    item: {
      itemName: r.inventoryItem.itemName, isActive: r.inventoryItem.isActive,
      mergedIntoId: r.inventoryItem.mergedIntoId, hasRecipe: r.inventoryItem.recipe != null,
    },
  }))
  const plan = planAliasBackfill(rules, suppliers, supplierAliases)

  const existing = await prisma.itemSupplierAlias.findMany({ select: { supplierId: true, text: true } })
  const existingKeys = new Set(existing.map(e => `${e.supplierId}\u0000${e.text}`))
  const toCreate = plan.rows.filter(r => !existingKeys.has(`${r.supplierId}\u0000${r.text}`))
  const inactive = plan.rows.filter(r => rules.find(x => x.inventoryItemId === r.inventoryItemId)?.item.isActive === false).length
  const reasons = (xs: { reason: string }[]) =>
    Object.entries(xs.reduce<Record<string, number>>((m, x) => { m[x.reason] = (m[x.reason] ?? 0) + 1; return m }, {}))
      .map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
  const bySupplier = Object.entries(plan.rows.reduce<Record<string, number>>((m, r) => {
    const k = supplierName.get(r.supplierId) ?? r.supplierId; m[k] = (m[k] ?? 0) + 1; return m
  }, {})).sort((a, b) => b[1] - a[1])

  console.log(`InvoiceMatchRule rows read: ${rules.length}`)
  console.log(`Alias rows planned: ${plan.rows.length} (already present: ${plan.rows.length - toCreate.length}; to create: ${toCreate.length}; on inactive items: ${inactive})`)
  for (const [s, c] of bySupplier) console.log(`  ${s}: ${c}`)
  console.log(`Collisions (several rules → one alias): ${plan.collisions.length} (joining different items: ${plan.collisions.filter(c => c.differentItems).length}; rules folded: ${plan.collisions.reduce((s, c) => s + c.folded.length, 0)})`)
  console.log(`Skipped: ${plan.skipped.length} (${reasons(plan.skipped)})`)
  console.log(`Unresolved: ${plan.unresolved.length} (${reasons(plan.unresolved)})`)
  console.log(`Supplier codes on more than one item (information only): ${plan.sharedCodes.length}`)

  let created: number | null = null
  let backup: string | null = null
  if (APPLY) {
    backup = `item-supplier-aliases-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    fs.writeFileSync(backup, JSON.stringify({ invoiceMatchRules: raw.map(({ inventoryItem: _i, ...r }) => r) }, null, 2))
    console.log(`backup written: ${backup} (${raw.length} InvoiceMatchRule rows)`)
    created = 0
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const res = await prisma.itemSupplierAlias.createMany({ data: toCreate.slice(i, i + CHUNK), skipDuplicates: true })
      created += res.count
    }
    console.log(`${created} alias row(s) created`)
  } else {
    console.log('DRY RUN — re-run with --apply to write')
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const L: string[] = []
  L.push('# Supplier wordings backfill (InvoiceMatchRule → ItemSupplierAlias)', '')
  L.push(`Run: ${new Date().toISOString()} · mode: **${APPLY ? 'APPLY' : 'DRY RUN'}** · script: \`scripts/backfill-item-supplier-aliases.ts\``, '')
  L.push('## Counts', '')
  L.push(`- InvoiceMatchRule rows read: ${rules.length}`)
  L.push(`- Alias rows planned: ${plan.rows.length} (already present: ${plan.rows.length - toCreate.length}; to create: ${toCreate.length}; on inactive items: ${inactive})`)
  if (created != null) L.push(`- **Alias rows created: ${created}**${backup ? ` · backup \`${backup}\`` : ''}`)
  L.push(`- Collisions: ${plan.collisions.length} (joining different items: ${plan.collisions.filter(c => c.differentItems).length}; rules folded: ${plan.collisions.reduce((s, c) => s + c.folded.length, 0)})`)
  L.push(`- Skipped: ${plan.skipped.length} (${reasons(plan.skipped)})`)
  L.push(`- Unresolved: ${plan.unresolved.length} (${reasons(plan.unresolved)})`)
  L.push(`- Supplier codes on more than one item: ${plan.sharedCodes.length}`, '')
  L.push('Aliases per supplier:', '')
  for (const [s, c] of bySupplier) L.push(`- ${cell(s)}: ${c}`)
  L.push('', '## Unresolved rules (not copied)', '')
  L.push('| rawDescription | supplierName | item | reason |', '|---|---|---|---|')
  for (const u of plan.unresolved) L.push(`| ${cell(u.rule.rawDescription)} | ${cell(u.rule.supplierName)} | ${cell(u.rule.item.itemName)} | ${u.reason} |`)
  L.push('', '## Skipped rules (merged or recipe-made item)', '')
  L.push('| rawDescription | supplierName | item | reason |', '|---|---|---|---|')
  for (const s of plan.skipped) L.push(`| ${cell(s.rule.rawDescription)} | ${cell(s.rule.supplierName)} | ${cell(s.rule.item.itemName)} | ${s.reason} |`)
  L.push('', '## Collisions (kept rule first; useCount summed)', '')
  L.push('| supplier | normalised text | kept (item · wording · uses) | folded (item · wording · uses) |', '|---|---|---|---|')
  for (const c of plan.collisions) {
    const f = (r: BackfillRule) => `${cell(r.item.itemName)} · ${cell(r.rawDescription)} · ${r.useCount}`
    L.push(`| ${cell(supplierName.get(c.supplierId))} | ${cell(c.text)} | ${f(c.kept)} | ${c.folded.map(f).join('<br>')}${c.differentItems ? ' **(different item)**' : ''} |`)
  }
  L.push('', '## Supplier codes on more than one item (information only)', '')
  L.push('| supplier | code | items |', '|---|---|---|')
  const itemName = new Map(rules.map(r => [r.inventoryItemId, r.item.itemName]))
  for (const s of plan.sharedCodes) L.push(`| ${cell(supplierName.get(s.supplierId))} | ${cell(s.code)} | ${s.itemIds.map(id => cell(itemName.get(id))).join('<br>')} |`)
  fs.mkdirSync(path.dirname(REPORT), { recursive: true })
  fs.writeFileSync(REPORT, L.join('\n') + '\n')
  console.log(`report written: ${REPORT}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
