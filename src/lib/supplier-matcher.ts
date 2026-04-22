// src/lib/supplier-matcher.ts
// Case-insensitive supplier alias lookup and self-learning upsert.

import { prisma } from '@/lib/prisma'

/**
 * Look up a supplier by an OCR-extracted invoice name.
 * Searches SupplierAlias.name (case-insensitive) first,
 * then falls back to Supplier.name (case-insensitive).
 * Returns supplierId or null.
 */
export async function matchSupplierByName(invoiceName: string | null | undefined): Promise<string | null> {
  if (!invoiceName || !invoiceName.trim()) return null

  const normalized = invoiceName.trim()

  // 1. Check aliases first (most specific)
  const alias = await prisma.supplierAlias.findFirst({
    where: { name: { equals: normalized, mode: 'insensitive' } },
    select: { supplierId: true },
  })
  if (alias) return alias.supplierId

  // 2. Fall back to supplier name exact match (case-insensitive)
  const supplier = await prisma.supplier.findFirst({
    where: { name: { equals: normalized, mode: 'insensitive' } },
    select: { id: true },
  })
  return supplier?.id ?? null
}

/**
 * Upsert (supplierId, invoiceName) into SupplierAlias.
 * No-op on blank/null name. Duplicate rows are silently ignored.
 */
export async function learnAlias(supplierId: string, invoiceName: string | null | undefined): Promise<void> {
  if (!supplierId || !supplierId.trim()) return
  if (!invoiceName || !invoiceName.trim()) return

  const normalized = invoiceName.trim()

  await prisma.supplierAlias.upsert({
    where: { supplierId_name: { supplierId, name: normalized } },
    create: { supplierId, name: normalized },
    update: {}, // already exists, no-op
  })
}
