// Returned by GET /api/suppliers (augmented)
export interface SupplierAlias {
  id: string
  name: string
}

export interface SupplierSummary {
  id: string
  name: string
  contactName: string | null
  phone: string | null
  email: string | null
  orderPlatform: string | null
  cutoffDays: string | null
  deliveryDays: string | null
  monthSpend: number
  prevMonthSpend: number
  invoiceCount: number
  _count: { inventory: number }
  aliases: SupplierAlias[]
}

// Returned by GET /api/suppliers/[id]/intelligence
export interface PriceChange {
  itemName: string
  oldPrice: number
  newPrice: number
  pctChange: number  // positive = increase
  date: string       // ISO date string
}

export interface SuppliedItem {
  id: string
  itemName: string
  pricePerBaseUnit: number
  baseUnit: string
}

export interface SupplierIntelligence {
  monthSpend: number
  monthSpendChangePct: number
  yearSpend: number
  yearInvoiceCount: number
  lastApprovedAt: string | null
  priceChanges: PriceChange[]
  items: SuppliedItem[]
}

// Form data for add/edit
export interface SupplierForm {
  name: string
  contactName: string
  phone: string
  email: string
  orderPlatform: string
  cutoffDays: string
  deliveryDays: string
  aliases: string[]  // local alias names for the form
}
