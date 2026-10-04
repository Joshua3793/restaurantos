// Stage 3 one-time rename — APPLY. Reads docs/audits/2026-10-rename/proposals.json
// (the `proposed` value as the owner left it — edit the JSON to change a name)
// and, for each item: writes `itemName` (+ bumps `lastUpdated`) and keeps the old
// wording as its primary supplier's alias (source 'RENAME'). Nothing else changes:
// no prices, no stock, no recipes (recipe lines point at the item by id).
//   DRY RUN (default):  npx tsx scripts/apply-item-renames.ts
//   APPLY:              npx tsx scripts/apply-item-renames.ts --apply
//   Narrow:             --only <id,id,...>   |   --skip <id,id,...>
// ONLY run --apply after the owner has approved proposals.md.
// Backup: item-renames-backup-<stamp>.json in the cwd (id + old name per item).
import fs from 'fs'
import { prisma } from '../src/lib/prisma'
import { normaliseAliasText } from '../src/lib/alias-text'

const APPLY = process.argv.includes('--apply')
const PROPOSALS = 'docs/audits/2026-10-rename/proposals.json'

interface Proposal { id: string; current: string; proposed: string; category: string; supplier: string }

function idList(flag: string): Set<string> | null {
  const i = process.argv.indexOf(flag)
  if (i < 0) return null
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) throw new Error(`${flag} needs a comma-separated list of item ids`)
  return new Set(v.split(',').map(s => s.trim()).filter(Boolean))
}

async function main() {
  const only = idList('--only')
  const skip = idList('--skip')
  const all: Proposal[] = JSON.parse(fs.readFileSync(PROPOSALS, 'utf-8'))
  for (const set of [only, skip]) {
    for (const id of set ?? []) if (!all.some(p => p.id === id)) throw new Error(`id ${id} is not in ${PROPOSALS}`)
  }
  const chosen = all.filter(p => (!only || only.has(p.id)) && !(skip?.has(p.id)))
  console.log(`${all.length} proposal(s) in ${PROPOSALS}; ${chosen.length} selected${only ? ` (--only ${only.size})` : ''}${skip ? ` (--skip ${skip.size})` : ''}`)

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: chosen.map(p => p.id) } },
    select: {
      id: true, itemName: true, isActive: true, mergedIntoId: true,
      supplierPrices: { where: { isPrimary: true }, select: { supplierId: true, supplierName: true } },
    },
  })
  const byId = new Map(items.map(i => [i.id, i]))

  type Plan = { p: Proposal; oldName: string; newName: string; supplierId: string | null; supplierName: string | null }
  const plans: Plan[] = []
  let refused = 0
  for (const p of chosen) {
    const item = byId.get(p.id)
    const newName = (p.proposed ?? '').trim()
    const why =
      !item ? 'item not found' :
      !item.isActive || item.mergedIntoId ? 'item is inactive or merged' :
      !newName ? 'no proposed name' :
      item.itemName !== p.current ? `name changed since the proposal (now "${item.itemName}")` :
      newName === item.itemName ? 'proposed name is the same as the current one' :
      null
    if (why) { refused++; console.log(`  SKIP  ${p.id} "${p.current}" — ${why}`); continue }
    const primary = item!.supplierPrices[0] ?? null
    plans.push({ p, oldName: item!.itemName, newName, supplierId: primary?.supplierId ?? null, supplierName: primary?.supplierName ?? null })
  }

  for (const x of plans) {
    const alias = x.supplierId ? `alias kept under ${x.supplierName}` : 'no primary box — no alias'
    console.log(`  ${APPLY ? 'RENAME' : 'would rename'}  "${x.oldName}" → "${x.newName}" · ${alias}`)
  }

  if (!APPLY) {
    console.log(`DRY RUN — ${plans.length} rename(s), ${refused} skipped. Re-run with --apply to write.`)
    return
  }

  const backup = `item-renames-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  fs.writeFileSync(backup, JSON.stringify({ renames: plans.map(x => ({ id: x.p.id, oldName: x.oldName, newName: x.newName, aliasSupplierId: x.supplierId })) }, null, 2))
  console.log(`backup written: ${backup} (${plans.length} item(s))`)

  let renamed = 0
  let aliases = 0
  for (const x of plans) {
    const now = new Date()
    const text = normaliseAliasText(x.oldName)
    const [, created] = await prisma.$transaction([
      prisma.inventoryItem.update({ where: { id: x.p.id }, data: { itemName: x.newName, lastUpdated: now } }),
      prisma.itemSupplierAlias.createMany({
        data: x.supplierId && text
          ? [{ inventoryItemId: x.p.id, supplierId: x.supplierId, text, rawText: x.oldName, source: 'RENAME' }]
          : [],
        skipDuplicates: true,
      }),
    ])
    renamed++
    aliases += created.count
    console.log(`  done  "${x.oldName}" → "${x.newName}"${created.count ? ' + alias' : x.supplierId ? ' (alias already present)' : ''}`)
  }
  console.log(`${renamed} item(s) renamed, ${aliases} alias row(s) created, ${refused} skipped · backup ${backup}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
