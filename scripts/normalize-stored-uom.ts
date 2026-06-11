// Relabel stored pack UOMs to their canonical token (GR→g, LTR→l, KG→kg, EA→each…)
// for display/consistency. Pure relabel — canonicalUom keeps the same unit, just
// standardizes spelling/case, so values/meaning are unchanged. Dry by default.
import { prisma } from '../src/lib/prisma'
import { canonicalUom } from '../src/lib/utils'
const APPLY = process.env.APPLY === '1'
async function main() {
  // Inventory items: packUOM only (baseUnit uses SI g/ml — handled separately).
  const items = await prisma.inventoryItem.findMany({ where:{ isActive:true }, select:{ id:true, itemName:true, packUOM:true } })
  const itemFix = items.filter(i => i.packUOM && canonicalUom(i.packUOM) !== i.packUOM)
  console.log(`Inventory packUOM relabels: ${itemFix.length}`)
  for (const i of itemFix) console.log(`  ${i.itemName}: '${i.packUOM}' → '${canonicalUom(i.packUOM)}'`)

  // Scan items still pending review (REVIEW/PENDING sessions) — clean their UOMs.
  const lines = await prisma.invoiceScanItem.findMany({
    where:{ session:{ status:{ in:['REVIEW','UPLOADING','PROCESSING','PENDING'] } } },
    select:{ id:true, rawDescription:true, invoicePackUOM:true, rateUOM:true, totalQtyUOM:true },
  })
  const lineFix = lines.filter(l =>
    (l.invoicePackUOM && canonicalUom(l.invoicePackUOM)!==l.invoicePackUOM) ||
    (l.rateUOM && canonicalUom(l.rateUOM)!==l.rateUOM) ||
    (l.totalQtyUOM && canonicalUom(l.totalQtyUOM)!==l.totalQtyUOM))
  console.log(`\nReview-session scan-item UOM relabels: ${lineFix.length}`)
  for (const l of lineFix) console.log(`  ${(l.rawDescription??'').slice(0,26)}: pack '${l.invoicePackUOM}'→'${canonicalUom(l.invoicePackUOM)}'`)

  if (!APPLY) { console.log('\nDry run. APPLY=1 to write.'); return }
  for (const i of itemFix) await prisma.inventoryItem.update({ where:{id:i.id}, data:{ packUOM: canonicalUom(i.packUOM) } })
  for (const l of lineFix) await prisma.invoiceScanItem.update({ where:{id:l.id}, data:{
    invoicePackUOM: l.invoicePackUOM ? canonicalUom(l.invoicePackUOM) : l.invoicePackUOM,
    rateUOM: l.rateUOM ? canonicalUom(l.rateUOM) : l.rateUOM,
    totalQtyUOM: l.totalQtyUOM ? canonicalUom(l.totalQtyUOM) : l.totalQtyUOM,
  }})
  console.log(`\nApplied ${itemFix.length} item + ${lineFix.length} scan-item relabels.`)
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})
