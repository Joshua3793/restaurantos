export type SessionStatus = 'UPLOADING' | 'PROCESSING' | 'REVIEW' | 'APPROVED' | 'REJECTED'
export type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
export type LineItemAction = 'PENDING' | 'UPDATE_PRICE' | 'ADD_SUPPLIER' | 'CREATE_NEW' | 'SKIP'

export interface ScanFile {
  id: string
  fileName: string
  fileType: string
  ocrStatus: string
}

export interface InventoryMatch {
  id: string
  itemName: string
  purchaseUnit: string
  pricePerBaseUnit: number
  purchasePrice: number
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
  baseUnit: string
}

export interface ScanItem {
  id: string
  rawDescription: string
  rawQty: number | null
  rawUnit: string | null
  rawUnitPrice: number | null
  rawLineTotal: number | null
  matchedItemId: string | null
  matchedItem: InventoryMatch | null
  matchConfidence: MatchConfidence
  matchScore: number
  action: LineItemAction
  approved: boolean
  isNewItem: boolean
  newItemData: string | null
  previousPrice: number | null
  newPrice: number | null
  priceDiffPct: number | null
  formatMismatch: boolean
  invoicePackQty: number | null
  invoicePackSize: number | null
  invoicePackUOM: string | null
  needsFormatConfirm: boolean
}

// Full session — returned by GET /api/invoices/sessions/[id]
export interface Session {
  id: string
  status: SessionStatus
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  total: string | null
  files: ScanFile[]
  scanItems: ScanItem[]
  priceAlerts: unknown[]
  recipeAlerts: unknown[]
  createdAt: string
}

// Summary — returned by GET /api/invoices/sessions (uses _count, not full arrays)
export interface SessionSummary {
  id: string
  status: SessionStatus
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  total: string | null
  createdAt: string
  _count: {
    scanItems: number
    priceAlerts: number
    recipeAlerts: number
  }
}

export interface ApproveResult {
  ok: boolean
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
