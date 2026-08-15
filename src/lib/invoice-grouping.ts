// Pure grouping logic for bulk invoice upload: given per-file quick-peek
// metadata, propose how a batch of uploaded files splits into invoices.
// No DB, no API — unit-tested in src/lib/__tests__/invoice-grouping.test.ts.
// Design: docs/superpowers/specs/2026-08-14-bulk-invoice-upload-design.md

export interface PeekMeta {
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  error?: string
}

export interface GroupingFile {
  id: string
  fileName: string
  fileType: string
  peekMeta: PeekMeta | null
}

export type GroupKind = 'photos' | 'pdf' | 'csv'

export interface ProposedGroup {
  fileIds: string[]
  kind: GroupKind
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
}

export interface GroupingProposal {
  groups: ProposedGroup[]
  unassigned: string[]
}

export function fileKind(fileType: string, fileName: string): 'photo' | 'pdf' | 'csv' {
  const ft = fileType.toLowerCase()
  const fn = fileName.toLowerCase()
  if (ft === 'text/csv' || fn.endsWith('.csv')) return 'csv'
  if (ft === 'application/pdf' || fn.endsWith('.pdf')) return 'pdf'
  return 'photo'
}

// Uppercase, drop separators, collapse leading zeros: "INV-00123" == "inv 00123".
export function normalizeInvoiceNumber(v: string | null): string | null {
  if (!v) return null
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '')
  return s.length ? s : null
}

export function normalizeSupplierName(v: string | null): string | null {
  if (!v) return null
  const s = v.toLowerCase().replace(/\s+/g, ' ').trim()
  return s.length ? s : null
}

interface PhotoGroupRec { idx: number; nSup: string | null; nNum: string | null }

export function proposeGroups(files: GroupingFile[]): GroupingProposal {
  const groups: ProposedGroup[] = []
  const unassigned: string[] = []
  const photoGroups: PhotoGroupRec[] = []
  // The most recent photo group, for the continuation-page heuristic. PDFs and
  // CSVs deliberately do NOT reset it: photos remain "adjacent" across them.
  let lastPhoto: PhotoGroupRec | null = null

  const newPhotoGroup = (f: GroupingFile, meta: PeekMeta | null, nSup: string | null, nNum: string | null) => {
    const idx = groups.push({
      fileIds: [f.id],
      kind: 'photos',
      supplierName: meta?.supplierName ?? null,
      invoiceNumber: meta?.invoiceNumber ?? null,
      invoiceDate: meta?.invoiceDate ?? null,
    }) - 1
    const rec: PhotoGroupRec = { idx, nSup, nNum }
    photoGroups.push(rec)
    lastPhoto = rec
  }

  for (const f of files) {
    const kind = fileKind(f.fileType, f.fileName)

    if (kind === 'csv') {
      groups.push({ fileIds: [f.id], kind: 'csv', supplierName: null, invoiceNumber: null, invoiceDate: null })
      continue
    }

    const meta = f.peekMeta && !f.peekMeta.error ? f.peekMeta : null

    if (kind === 'pdf') {
      groups.push({
        fileIds: [f.id],
        kind: 'pdf',
        supplierName: meta?.supplierName ?? null,
        invoiceNumber: meta?.invoiceNumber ?? null,
        invoiceDate: meta?.invoiceDate ?? null,
      })
      continue
    }

    // Photo. An errored (or missing) peek behaves as all-null metadata.
    const errored = !f.peekMeta || f.peekMeta.error != null
    const nSup = normalizeSupplierName(meta?.supplierName ?? null)
    const nNum = normalizeInvoiceNumber(meta?.invoiceNumber ?? null)

    if (nNum !== null) {
      // Same invoice number (compatible supplier) → same invoice, adjacency not required.
      const hit = photoGroups.find(p =>
        p.nNum === nNum && (p.nSup === nSup || p.nSup === null || nSup === null)
      )
      if (hit) {
        const g = groups[hit.idx]
        g.fileIds.push(f.id)
        if (g.supplierName == null && meta?.supplierName) { g.supplierName = meta.supplierName; hit.nSup = nSup }
        if (g.invoiceDate == null && meta?.invoiceDate) g.invoiceDate = meta.invoiceDate
        lastPhoto = hit
      } else {
        newPhotoGroup(f, meta, nSup, nNum)
      }
      continue
    }

    // No invoice number — continuation heuristic: join the preceding photo
    // group when this photo's supplier matches it, or is itself unreadable.
    if (lastPhoto && (nSup === null || nSup === lastPhoto.nSup)) {
      groups[lastPhoto.idx].fileIds.push(f.id)
      continue
    }

    if (nSup !== null) {
      // Supplier read but number wasn't, and it doesn't continue the previous
      // invoice → treat as a new invoice from that supplier.
      newPhotoGroup(f, meta, nSup, null)
      continue
    }

    if (!errored) {
      // Metadata genuinely all-null (peek succeeded, invoice just unreadable)
      // and nothing precedes it → its own "unknown invoice" card.
      newPhotoGroup(f, null, null, null)
      continue
    }

    // Peek errored and there is no preceding group to join.
    unassigned.push(f.id)
  }

  return { groups, unassigned }
}
