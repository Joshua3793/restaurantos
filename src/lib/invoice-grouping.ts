// Pure grouping logic for bulk invoice upload: given per-file quick-peek
// metadata, propose how a batch of uploaded files splits into invoices.
// No DB, no API — unit-tested in src/lib/__tests__/invoice-grouping.test.ts.
// Design: docs/superpowers/specs/2026-08-14-bulk-invoice-upload-design.md
//     v2: docs/superpowers/specs/2026-08-15-bulk-grouping-v2-design.md
//         (structure-first: pageType outranks digits; low-confidence numbers
//         are ignored — one misread dot-matrix digit must never split or
//         merge invoices. No fuzzy digit matching, ever: same-supplier
//         invoices are often sequential.)

export type PeekPageType = 'first_page' | 'continuation' | 'unknown'
export type PeekConfidence = 'high' | 'low'

export interface PeekMeta {
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  // v2 structure-first fields. Optional: metas without them (v1 cache, CSV
  // placeholders) behave exactly like v1 — pageType 'unknown', number trusted.
  pageType?: PeekPageType
  supplierConfidence?: PeekConfidence
  numberConfidence?: PeekConfidence
  /** Peek pipeline version that produced this meta (PEEK_VERSION in invoice-ocr.ts). */
  v?: number
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

  // Both helpers RETURN the group record and the caller assigns `lastPhoto`
  // directly — TypeScript does not track assignments made inside closures, so
  // an assignment in here would leave `lastPhoto` narrowed to its `null`
  // initializer at every read site.
  const newPhotoGroup = (f: GroupingFile, meta: PeekMeta | null, nSup: string | null, nNum: string | null): PhotoGroupRec => {
    const idx = groups.push({
      fileIds: [f.id],
      kind: 'photos',
      supplierName: meta?.supplierName ?? null,
      invoiceNumber: meta?.invoiceNumber ?? null,
      invoiceDate: meta?.invoiceDate ?? null,
    }) - 1
    const rec: PhotoGroupRec = { idx, nSup, nNum }
    photoGroups.push(rec)
    return rec
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
    // A low-confidence number is treated as absent: it can never create or
    // join a group. Absent confidence (v1 metas) defaults to trusted.
    const nNum = (meta?.numberConfidence ?? 'high') === 'high'
      ? normalizeInvoiceNumber(meta?.invoiceNumber ?? null)
      : null
    const pageType: PeekPageType = meta?.pageType ?? 'unknown'

    const joinGroup = (rec: PhotoGroupRec): PhotoGroupRec => {
      const g = groups[rec.idx]
      g.fileIds.push(f.id)
      if (g.supplierName == null && meta?.supplierName) { g.supplierName = meta.supplierName; rec.nSup = nSup }
      if (g.invoiceDate == null && meta?.invoiceDate) g.invoiceDate = meta.invoiceDate
      return rec
    }

    if (pageType === 'continuation') {
      // Structural signal outranks digits: a continuation page always joins
      // the preceding photo group when the supplier is compatible — matching,
      // or unreadable on either side (backfill the group's supplier then).
      if (lastPhoto && (nSup === null || lastPhoto.nSup === null || nSup === lastPhoto.nSup)) {
        lastPhoto = joinGroup(lastPhoto)
        continue
      }
      // Continuation with nothing compatible before it → its own group.
      lastPhoto = newPhotoGroup(f, meta, nSup, nNum)
      continue
    }

    if (pageType === 'first_page') {
      // A first page starts a new invoice — unless a trusted number says it's
      // a retake of one already seen (non-adjacent merge). It never
      // continuation-joins: two same-supplier invoices stay separate.
      const hit = nNum !== null
        ? photoGroups.find(p => p.nNum === nNum && (p.nSup === nSup || p.nSup === null || nSup === null))
        : undefined
      lastPhoto = hit ? joinGroup(hit) : newPhotoGroup(f, meta, nSup, nNum)
      continue
    }

    // pageType 'unknown' → the v1 algorithm, unchanged below.
    if (nNum !== null) {
      // Same invoice number (compatible supplier) → same invoice, adjacency not required.
      const hit = photoGroups.find(p =>
        p.nNum === nNum && (p.nSup === nSup || p.nSup === null || nSup === null)
      )
      lastPhoto = hit ? joinGroup(hit) : newPhotoGroup(f, meta, nSup, nNum)
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
      lastPhoto = newPhotoGroup(f, meta, nSup, null)
      continue
    }

    if (!errored) {
      // Metadata genuinely all-null (peek succeeded, invoice just unreadable)
      // and nothing precedes it → its own "unknown invoice" card.
      lastPhoto = newPhotoGroup(f, null, null, null)
      continue
    }

    // Peek errored and there is no preceding group to join.
    unassigned.push(f.id)
  }

  return { groups, unassigned }
}
