import { describe, it, expect } from 'vitest'
import { normalizeBarcode, barcodeVariants } from '@/lib/barcode'

describe('normalizeBarcode', () => {
  it('trims and accepts 6–32 letters, digits, dashes', () => {
    expect(normalizeBarcode(' 012345678905 ')).toBe('012345678905')
    expect(normalizeBarcode('SYS-1234')).toBe('SYS-1234')
  })
  it('rejects short, long, spaced or non-string codes', () => {
    expect(normalizeBarcode('12345')).toBeNull()
    expect(normalizeBarcode('1'.repeat(33))).toBeNull()
    expect(normalizeBarcode('123 456')).toBeNull()
    expect(normalizeBarcode(12345678)).toBeNull()
  })
})

describe('barcodeVariants', () => {
  it('pairs a UPC-A with its EAN-13 spelling, both ways', () => {
    expect(barcodeVariants('012345678905')).toEqual(['012345678905', '0012345678905'])
    expect(barcodeVariants('0012345678905')).toEqual(['0012345678905', '012345678905'])
  })
  it('leaves other codes alone', () => {
    expect(barcodeVariants('5000000000001')).toEqual(['5000000000001'])
    expect(barcodeVariants('96385074')).toEqual(['96385074'])
  })
})
