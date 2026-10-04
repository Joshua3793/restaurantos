// Copies the old InvoiceMatchRule rows into ItemSupplierAlias (Stage 3). The
// rule's supplier STRING is resolved to a Supplier id (exact name, then a
// SupplierAlias spelling, both case-insensitive); rules for merged or
// recipe-made items are skipped; spellings that normalise alike under one
// supplier fold into one alias (highest useCount kept, counts summed).
//   DRY RUN (default):  npx tsx scripts/backfill-item-supplier-aliases.ts
//   APPLY:              npx tsx scripts/backfill-item-supplier-aliases.ts --apply
//   CATCH-UP:           npx tsx scripts/backfill-item-supplier-aliases.ts --apply --update
// Re-runnable: keys that already exist are never re-created (createMany skipDuplicates).
// --update (catch-up for invoices approved between the backfill and the matcher
// switch, which still wrote InvoiceMatchRule): an alias whose key has a rule
// used AFTER it takes that rule's item, wording, code, pack and date (useCount
// = the key's summed count when larger), and a NULL code / empty pack is filled
// from a rule on the alias's own item — see planAliasUpdates. Without --update
// those updates are only counted. Every --apply backs up first (the rules AND
// the existing alias rows). Writes docs/audits/2026-10-aliases/backfill-report.md
// on every run.
// WHEN: run the CATCH-UP (dry run first, then --apply --update) right after the
// Stage 3 deploy reaches production, so invoices approved under the old matcher
// up to that moment are carried over before anyone relies on the wordings.
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import { planAliasBackfill, planAliasUpdates, type BackfillRule, type AliasUpdate } from '../src/lib/alias-backfill'

const APPLY = process.argv.includes('--apply')
const UPDATE = process.argv.includes('--update')
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

  const existing = await prisma.itemSupplierAlias.findMany({
    select: {
      id: true, supplierId: true, text: true, inventoryItemId: true, rawText: true, supplierItemCode: true,
      packQty: true, packSize: true, packUOM: true, useCount: true, lastUsed: true,
    },
  })
  const { creates: toCreate, updates } = planAliasUpdates(plan.groups, existing)
  const newer = updates.filter(u => u.reason === 'newer rule')
  const updateSummary = `${updates.length} (newer rule: ${newer.length}, of which re-pointed to another item: ${updates.filter(u => u.itemChanged).length}; code/pack fill only: ${updates.length - newer.length}; codes filled: ${updates.filter(u => u.data.supplierItemCode && !existing.find(e => e.id === u.id)?.supplierItemCode).length})`
  const inactive = plan.rows.filter(r => rules.find(x => x.inventoryItemId === r.inventoryItemId)?.item.isActive === false).length
  const reasons = (xs: { reason: string }[]) =>
    Object.entries(xs.reduce<Record<string, number>>((m, x) => { m[x.reason] = (m[x.reason] ?? 0) + 1; return m }, {}))
      .map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
  const bySupplier = Object.entries(plan.rows.reduce<Record<string, number>>((m, r) => {
    const k = supplierName.get(r.supplierId) ?? r.supplierId; m[k] = (m[k] ?? 0) + 1; return m
  }, {})).sort((a, b) => b[1] - a[1])

  console.log(`InvoiceMatchRule rows read: ${rules.length}`)
  console.log(`Alias rows planned: ${plan.rows.length} (already present: ${plan.rows.length - toCreate.length}; to create: ${toCreate.length}; on inactive items: ${inactive})`)
  console.log(`Alias rows to update: ${updateSummary}${UPDATE ? '' : ' — counted only; pass --update to write them'}`)
  for (const [s, c] of bySupplier) console.log(`  ${s}: ${c}`)
  console.log(`Collisions (several rules → one alias): ${plan.collisions.length} (joining different items: ${plan.collisions.filter(c => c.differentItems).length}; rules folded: ${plan.collisions.reduce((s, c) => s + c.folded.length, 0)})`)
  console.log(`Skipped: ${plan.skipped.length} (${reasons(plan.skipped)})`)
  console.log(`Unresolved: ${plan.unresolved.length} (${reasons(plan.unresolved)})`)
  console.log(`Supplier codes on more than one item (information only): ${plan.sharedCodes.length}`)

  let created: number | null = null
  let updated: number | null = null
  let backup: string | null = null
  if (APPLY) {
    backup = `item-supplier-aliases-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    fs.writeFileSync(backup, JSON.stringify({
      invoiceMatchRules: raw.map(({ inventoryItem: _i, ...r }) => r),
      itemSupplierAliases: existing,
    }, null, 2))
    console.log(`backup written: ${backup} (${raw.length} InvoiceMatchRule rows, ${existing.length} ItemSupplierAlias rows)`)
    created = 0
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const res = await prisma.itemSupplierAlias.createMany({ data: toCreate.slice(i, i + CHUNK), skipDuplicates: true })
      created += res.count
    }
    console.log(`${created} alias row(s) created`)
    if (UPDATE) {
      // ORM updates (no raw SQL) batched per chunk — pooler-safe.
      updated = 0
      for (let i = 0; i < updates.length; i += CHUNK) {
        const res = await prisma.$transaction(updates.slice(i, i + CHUNK).map(u =>
          prisma.itemSupplierAlias.update({ where: { id: u.id }, data: u.data, select: { id: true } })))
        updated += res.length
      }
      console.log(`${updated} alias row(s) updated`)
    }
  } else {
    console.log('DRY RUN — re-run with --apply to write')
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const L: string[] = []
  L.push('# Supplier wordings backfill (InvoiceMatchRule → ItemSupplierAlias)', '')
  L.push(`Run: ${new Date().toISOString()} · mode: **${APPLY ? 'APPLY' : 'DRY RUN'}${UPDATE ? ' --update' : ''}** · script: \`scripts/backfill-item-supplier-aliases.ts\``, '')
  L.push('## Counts', '')
  L.push(`- InvoiceMatchRule rows read: ${rules.length}`)
  L.push(`- Alias rows planned: ${plan.rows.length} (already present: ${plan.rows.length - toCreate.length}; to create: ${toCreate.length}; on inactive items: ${inactive})`)
  L.push(`- Alias rows to update: ${updateSummary}${UPDATE ? '' : ' — counted only (no --update)'}`)
  if (created != null) L.push(`- **Alias rows created: ${created}**${backup ? ` · backup \`${backup}\`` : ''}`)
  if (updated != null) L.push(`- **Alias rows updated: ${updated}**`)
  L.push(`- Collisions: ${plan.collisions.length} (joining different items: ${plan.collisions.filter(c => c.differentItems).length}; rules folded: ${plan.collisions.reduce((s, c) => s + c.folded.length, 0)})`)
  L.push(`- Skipped: ${plan.skipped.length} (${reasons(plan.skipped)})`)
  L.push(`- Unresolved: ${plan.unresolved.length} (${reasons(plan.unresolved)})`)
  L.push(`- Supplier codes on more than one item: ${plan.sharedCodes.length}`, '')
  L.push('Aliases per supplier:', '')
  for (const [s, c] of bySupplier) L.push(`- ${cell(s)}: ${c}`)
  L.push('', '## Alias updates (rules learned since the backfill; code/pack fills)', '')
  L.push('| supplier | normalised text | reason | changes |', '|---|---|---|---|')
  const itemNameOf = new Map(rules.map(r => [r.inventoryItemId, r.item.itemName]))
  const change = (u: AliasUpdate) => Object.entries(u.data).map(([k, v]) =>
    k === 'inventoryItemId' ? `item → ${cell(itemNameOf.get(String(v)) ?? String(v))}`
      : `${k} → ${cell(v instanceof Date ? v.toISOString() : v == null ? 'null' : String(v))}`).join('<br>')
  for (const u of updates) L.push(`| ${cell(supplierName.get(u.supplierId))} | ${cell(u.text)} | ${u.reason}${u.itemChanged ? ' **(item changed)**' : ''} | ${change(u)} |`)
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
