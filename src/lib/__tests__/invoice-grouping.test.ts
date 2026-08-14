import { describe, it, expect } from 'vitest'
import {
  proposeGroups,
  normalizeInvoiceNumber,
  normalizeSupplierName,
  fileKind,
  type GroupingFile,
  type PeekMeta,
} from '@/lib/invoice-grouping'

let n = 0
function photo(meta: Partial<PeekMeta> | null, error?: string): GroupingFile {
  n++
  const peekMeta: PeekMeta | null = meta === null && !error
    ? null
    : {
        supplierName: meta?.supplierName ?? null,
        invoiceDate: meta?.invoiceDate ?? null,
        invoiceNumber: meta?.invoiceNumber ?? null,
        ...(error ? { error } : {}),
      }
  return { id: `f${n}`, fileName: `p${n}.jpg`, fileType: 'image/jpeg', peekMeta }
}
function pdf(meta: Partial<PeekMeta> | null): GroupingFile {
  n++
  return {
    id: `f${n}`, fileName: `doc${n}.pdf`, fileType: 'application/pdf',
    peekMeta: meta ? { supplierName: meta.supplierName ?? null, invoiceDate: meta.invoiceDate ?? null, invoiceNumber: meta.invoiceNumber ?? null } : null,
  }
}
function csv(): GroupingFile {
  n++
  return { id: `f${n}`, fileName: `export${n}.csv`, fileType: 'text/csv', peekMeta: null }
}

describe('normalizers', () => {
  it('invoice numbers: case, separators, leading zeros collapse', () => {
    expect(normalizeInvoiceNumber('INV-00123')).toBe('INV00123')
    expect(normalizeInvoiceNumber('inv 00123')).toBe('INV00123')
    expect(normalizeInvoiceNumber('00123')).toBe('123')
    expect(normalizeInvoiceNumber('  ')).toBeNull()
    expect(normalizeInvoiceNumber(null)).toBeNull()
  })
  it('supplier names: case/whitespace collapse', () => {
    expect(normalizeSupplierName('  Sysco   Canada ')).toBe('sysco canada')
    expect(normalizeSupplierName('')).toBeNull()
    expect(normalizeSupplierName(null)).toBeNull()
  })
  it('fileKind classifies by type then extension', () => {
    expect(fileKind('image/jpeg', 'a.jpg')).toBe('photo')
    expect(fileKind('application/pdf', 'a.pdf')).toBe('pdf')
    expect(fileKind('application/octet-stream', 'a.pdf')).toBe('pdf')
    expect(fileKind('text/csv', 'a.csv')).toBe('csv')
    expect(fileKind('application/octet-stream', 'a.csv')).toBe('csv')
  })
})

describe('proposeGroups', () => {
  it('same supplier+number merge; different numbers split', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      photo({ supplierName: 'Sysco', invoiceNumber: 'A2' }),
    ]
    const { groups, unassigned } = proposeGroups(files)
    expect(groups.map(g => g.fileIds.length)).toEqual([2, 1])
    expect(unassigned).toEqual([])
  })

  it('continuation: null number joins preceding group when supplier matches or is null', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      photo({ supplierName: 'Sysco', invoiceNumber: null }),
      photo({ supplierName: null, invoiceNumber: null }),
    ]
    const { groups } = proposeGroups(files)
    expect(groups).toHaveLength(1)
    expect(groups[0].fileIds).toHaveLength(3)
  })

  it('supplier switch with null number starts a NEW group', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      photo({ supplierName: 'GFS', invoiceNumber: null }),
    ]
    const { groups } = proposeGroups(files)
    expect(groups).toHaveLength(2)
    expect(groups[1].supplierName).toBe('GFS')
    expect(groups[1].invoiceNumber).toBeNull()
  })

  it('non-adjacent same-number photos still merge, order preserved within group', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }), // f?_a
      photo({ supplierName: 'GFS', invoiceNumber: 'B9' }),
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }), // f?_c
    ]
    const { groups } = proposeGroups(files)
    expect(groups).toHaveLength(2)
    expect(groups[0].fileIds).toEqual([files[0].id, files[2].id])
  })

  it('number match with a null supplier on one side still merges and backfills', () => {
    const files = [
      photo({ supplierName: null, invoiceNumber: 'A1' }),
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1', invoiceDate: '2026-08-14' }),
    ]
    const { groups } = proposeGroups(files)
    expect(groups).toHaveLength(1)
    expect(groups[0].supplierName).toBe('Sysco')
    expect(groups[0].invoiceDate).toBe('2026-08-14')
  })

  it('PDF and CSV are always their own group, even with matching metadata', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      pdf({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      csv(),
    ]
    const { groups } = proposeGroups(files)
    expect(groups).toHaveLength(3)
    expect(groups.map(g => g.kind)).toEqual(['photos', 'pdf', 'csv'])
  })

  it('errored peek joins the preceding group (behaves as all-null continuation)', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      photo(null, 'Claude returned an empty response'),
    ]
    const { groups, unassigned } = proposeGroups(files)
    expect(groups).toHaveLength(1)
    expect(groups[0].fileIds).toHaveLength(2)
    expect(unassigned).toEqual([])
  })

  it('errored peek with NO preceding group goes to unassigned', () => {
    const files = [
      photo(null, 'unreadable'),
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
    ]
    const { groups, unassigned } = proposeGroups(files)
    expect(unassigned).toEqual([files[0].id])
    expect(groups).toHaveLength(1)
  })

  it('all-null (non-errored) first photo starts an unknown group rather than unassigned', () => {
    const files = [photo({ supplierName: null, invoiceNumber: null })]
    const { groups, unassigned } = proposeGroups(files)
    expect(groups).toHaveLength(1)
    expect(unassigned).toEqual([])
  })

  it('single photo → single group', () => {
    const { groups } = proposeGroups([photo({ supplierName: 'Sysco', invoiceNumber: 'A1' })])
    expect(groups).toHaveLength(1)
  })

  it('continuation survives an intervening PDF: lastPhoto is not reset by non-photos', () => {
    const files = [
      photo({ supplierName: 'Sysco', invoiceNumber: 'A1' }),
      pdf({ supplierName: 'GFS', invoiceNumber: 'B7' }),
      photo({ supplierName: null, invoiceNumber: null }),
    ]
    const { groups, unassigned } = proposeGroups(files)
    expect(groups).toHaveLength(2)
    expect(groups[0].kind).toBe('photos')
    expect(groups[0].fileIds).toEqual([files[0].id, files[2].id])
    expect(groups[1].kind).toBe('pdf')
    expect(unassigned).toEqual([])
  })
})
