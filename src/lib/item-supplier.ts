// An item's supplier IS its primary supplier box's supplier (spec §2.3). The
// legacy `InventoryItem.supplierId` column drifted from the primary on 17 live
// items and was missing on 68 that had a box; it is no longer read or written.
// Spread PRIMARY_SUPPLIER_INCLUDE into a select/include, then withSupplier(row)
// to keep the `supplier` / `supplierId` shape every page already renders.
export const PRIMARY_SUPPLIER_INCLUDE = {
  supplierPrices: {
    where: { isPrimary: true },
    select: { supplierId: true, supplier: { select: { id: true, name: true } } },
    take: 1,
  },
} as const

export interface PrimarySupplierRow {
  supplierPrices?: Array<{ supplierId: string; supplier: { id: string; name: string } }> | null
}

export function withSupplier<T extends PrimarySupplierRow>(
  row: T,
): Omit<T, 'supplierPrices'> & { supplier: { id: string; name: string } | null; supplierId: string | null } {
  const { supplierPrices, ...rest } = row
  const primary = supplierPrices?.[0] ?? null
  return { ...rest, supplier: primary?.supplier ?? null, supplierId: primary?.supplierId ?? null }
}
