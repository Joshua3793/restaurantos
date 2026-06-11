import { prisma } from '../src/lib/prisma'
import { matchSupplierByName } from '../src/lib/supplier-matcher'
import { syncPrepToInventory } from '../src/lib/recipeCosts'
const APPLY = process.env.APPLY === '1'

async function main() {
  const prep = await prisma.recipe.findMany({ where:{ type:'PREP', inventoryItemId:{ not:null } }, select:{ id:true, inventoryItemId:true, name:true } })
  const prepIds = new Set(prep.map(r=>r.inventoryItemId!))

  const rules = await prisma.invoiceMatchRule.findMany({ include:{ inventoryItem:{ select:{ itemName:true } } } })

  // A) Rules pointing at a PREP output → delete (those items aren't purchasable).
  const prepRuleIds = rules.filter(r=>prepIds.has(r.inventoryItemId)).map(r=>r.id)
  console.log(`A) Rules → PREP items to DELETE: ${prepRuleIds.length}`)
  for (const r of rules.filter(r=>prepIds.has(r.inventoryItemId))) console.log(`   "${r.rawDescription}" [${r.supplierName}] → ${r.inventoryItem?.itemName}`)

  // B) Canonicalize supplierName for the rest; dedupe collisions on (canonical, rawDescription).
  const canonCache = new Map<string,string>()
  const canonOf = async (name:string) => {
    if (canonCache.has(name)) return canonCache.get(name)!
    const sid = await matchSupplierByName(name)
    let c = name
    if (sid) { const s = await prisma.supplier.findUnique({ where:{id:sid}, select:{name:true} }); if (s?.name) c = s.name }
    canonCache.set(name, c); return c
  }
  const live = rules.filter(r=>!prepIds.has(r.inventoryItemId))
  type Plan = { keepId:string; deleteIds:string[]; supplierName:string; useCount:number; rawDescription:string }
  const byKey = new Map<string, typeof live>()
  for (const r of live) {
    if (!r.supplierName) continue
    const canon = await canonOf(r.supplierName)
    const key = `${canon}||${r.rawDescription}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push({ ...r, supplierName: canon } as any)
  }
  const updates: { id:string; supplierName:string; useCount:number }[] = []
  const deletes: string[] = [...prepRuleIds]
  for (const [key, group] of byKey) {
    const canon = key.split('||')[0]
    group.sort((a,b)=> (b.supplierItemCode?1:0)-(a.supplierItemCode?1:0) || b.useCount-a.useCount)
    const keep = group[0]
    const sumUse = group.reduce((s,g)=>s+g.useCount,0)
    if (group.length>1 || keep.supplierName!==canon) {
      updates.push({ id:keep.id, supplierName:canon, useCount:sumUse })
      for (const g of group.slice(1)) deletes.push(g.id)
    }
  }
  console.log(`\nB) Rules to re-key→canonical: ${updates.length}, extra dupes to delete: ${deletes.length-prepRuleIds.length}`)
  for (const u of updates.slice(0,40)) console.log(`   keep ${u.id.slice(0,6)} → "${u.supplierName}" useCount ${u.useCount}`)

  // C) PREP items whose cost was overwritten by an approved invoice line → re-sync.
  const prepLinkedLines = await prisma.invoiceScanItem.findMany({ where:{ approved:true, matchedItem:{ recipe:{ type:'PREP' } } }, select:{ matchedItemId:true } })
  const damagedPrepRecipes = prep.filter(p => prepLinkedLines.some(l=>l.matchedItemId===p.inventoryItemId))
  console.log(`\nC) PREP items to re-sync (cost overwritten by invoice): ${damagedPrepRecipes.length}`)
  for (const p of damagedPrepRecipes) console.log(`   ${p.name}`)

  if (!APPLY) { console.log('\nDRY. APPLY=1 to write.'); return }
  if (deletes.length) await prisma.invoiceMatchRule.deleteMany({ where:{ id:{ in: deletes } } })
  for (const u of updates) await prisma.invoiceMatchRule.update({ where:{id:u.id}, data:{ supplierName:u.supplierName, useCount:u.useCount } }).catch(e=>console.error('skip',u.id, String(e).slice(0,80)))
  for (const p of damagedPrepRecipes) await syncPrepToInventory(p.id)
  console.log(`\nApplied: deleted ${deletes.length} rules, re-keyed ${updates.length}, re-synced ${damagedPrepRecipes.length} prep items.`)
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})
