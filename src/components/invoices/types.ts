export type SessionStatus = 'UPLOADING' | 'PROCESSING' | 'REVIEW' | 'APPROVING' | 'APPROVED' | 'REJECTED' | 'ERROR'
export type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
export type LineItemAction = 'PENDING' | 'UPDATE_PRICE' | 'ADD_SUPPLIER' | 'CREATE_NEW' | 'SKIP'

export interface ScanFile {
  id: string
  fileName: string
  fileType: string
  fileUrl: string
  ocrStatus: string
}

export interface InventoryMatch {
  id: string
  itemName: string
  purchaseUnit: string
  pricePerBaseUnit: string
  purchasePrice: string
  qtyPerPurchaseUnit: string
  packSize: string
  packUOM: string
  baseUnit: string
  priceType: string
  qtyUOM: string
  innerQty: string | null
  supplierPrices?: Array<{
    id: string
    supplierName: string
    supplierId: string | null
    lastPrice: string | number          // Prisma Decimal serialises as string
    pricePerBaseUnit: string | number
    packQty: string | number | null
    packSize: string | number | null
    packUOM: string | null
    isPrimary: boolean
    packChain?: unknown
    pricing?: unknown
  }>
}

export type PricingMode = 'per_case' | 'per_weight' | 'unknown'
export type PricingModeSignal =
  | 'explicit_per_column'
  | 'price_uom_is_weight'
  | 'weight_column_present'
  | 'math_inference'
  | 'default_case'
  | 'indeterminate'

export interface ScanItem {
  id: string
  rawDescription: string
  rawQty: string | null
  rawUnit: string | null
  rawUnitPrice: string | null
  rawLineTotal: string | null
  matchedItemId: string | null
  matchedItem: InventoryMatch | null
  matchConfidence: MatchConfidence
  matchScore: number
  action: LineItemAction
  approved: boolean
  isNewItem: boolean
  newItemData: string | null
  previousPrice: string | null
  newPrice: string | null
  priceDiffPct: string | null
  formatMismatch: boolean
  applyInvoiceFormat?: boolean
  invoicePackQty: string | null
  invoicePackSize: string | null
  invoicePackUOM: string | null
  needsFormatConfirm: boolean
  rawPriceType: 'CASE' | 'PKG' | 'UOM' | null
  totalQty: string | null
  totalQtyUOM: string | null
  revenueCenterId?: string | null
  sortOrder: number
  ocrConfidence?: 'low' | 'medium' | 'high' | null
  ocrNotes?: string | null
  // ── Mode-aware OCR fields (from mode-first OCR schema) ─────────────────────
  pricingMode?: PricingMode | null
  pricingModeSignal?: PricingModeSignal | null
  qtyOrdered?: string | null
  qtyOrderedUOM?: string | null
  rate?: string | null
  rateUOM?: string | null
  isCatchweight?: boolean
  nominalWeight?: string | null
  lineCategory?: string | null
  supplierItemCode?: string | null
  taxFlag?: string | null
  lineTaxAmount?: string | null
  bbox?: { page: number; x: number; y: number; w: number; h: number } | null
}

// Full session — returned by GET /api/invoices/sessions/[id]
export interface Session {
  id: string
  status: SessionStatus
  supplierId: string | null
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  poNumber?: string | null
  subtotal: string | null
  tax: string | null
  discount?: string | null
  fuelSurcharge?: string | null
  freight?: string | null
  minimumOrderFee?: string | null
  gst?: string | null
  hst?: string | null
  pst?: string | null
  otherCharges?: Array<{ label: string; amount: number }> | null
  total: string | null
  files: ScanFile[]
  scanItems: ScanItem[]
  priceAlerts: Array<{
    id: string
    inventoryItemId: string
    previousPrice: string | number
    newPrice: string | number
    changePct: string | number
    direction: string
    acknowledged: boolean
    inventoryItem: { id: string; itemName: string }
  }>
  recipeAlerts: Array<{
    id: string
    recipeId: string
    previousCost: string | number
    newCost: string | number
    changePct: string | number
    newFoodCostPct: string | number | null
    exceededThreshold: boolean
    acknowledged: boolean
    recipe: { id: string; name: string; menuPrice: string | number | null }
  }>
  createdAt: string
  revenueCenterId?: string | null
  parentSessionId?: string | null
  errorMessage?: string | null
}

// Summary — returned by GET /api/invoices/sessions (uses _count, not full arrays)
export interface SessionSummary {
  id: string
  status: SessionStatus
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  total: string | null
  files: Array<{ id: string; fileName: string; ocrStatus: string }>
  createdAt: string
  _count: {
    scanItems: number
    priceAlerts: number
    recipeAlerts: number
  }
  revenueCenterId?: string | null
  parentSessionId?: string | null
  errorMessage?: string | null
}

export interface ApproveResult {
  ok: boolean
  queued?: boolean
  itemsUpdated: number
  newItemsCreated: number
  priceAlerts: number
  recipeAlerts: number
}

export interface KpiData {
  weekSpend: number
  weekSpendChangePct: number
  monthSpend: number
  monthInvoiceCount: number
  priceAlertCount: number
  awaitingApprovalCount: number
  topCategories: Array<{ category: string; spend: number }>
}
