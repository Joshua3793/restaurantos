import { describe, it, expect } from 'vitest'
import { fileKind, groupScanFiles, isAllowedScanUrl, STUCK_AFTER_MS } from '../recipe-scan/scan-files'
import { maxDuration } from '@/app/api/recipe-scans/[id]/process/route'

describe('scan files', () => {
  it('photos read together, every document alone, unknown files skipped', () => {
    const f = (fileName: string, fileType: string) => ({ fileName, fileType })
    const groups = groupScanFiles([
      f('p1.jpg', 'image/jpeg'), f('sauces.pdf', 'application/pdf'), f('p2.png', 'image/png'),
      f('stocks.docx', ''), f('dressings.xlsx', ''), f('list.csv', 'text/csv'), f('notes.txt', 'text/plain'),
    ])
    expect(groups.map(g => [g.kind, g.files.map(x => x.fileName)])).toEqual([
      ['image', ['p1.jpg', 'p2.png']],
      ['pdf', ['sauces.pdf']],
      ['docx', ['stocks.docx']],
      ['sheet', ['dressings.xlsx']],
      ['sheet', ['list.csv']],
    ])
    expect(fileKind('text/plain', 'notes.txt')).toBeNull()
  })

  it('only our own storage is fetched', () => {
    expect(isAllowedScanUrl('https://utfs.io/f/abc123')).toBe(true)
    expect(isAllowedScanUrl('https://app1.ufs.sh/f/abc123')).toBe(true)
    expect(isAllowedScanUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isAllowedScanUrl('https://evil.example.com/f/abc')).toBe(false)
    expect(isAllowedScanUrl('http://169.254.169.254/latest')).toBe(false)
    expect(isAllowedScanUrl(42)).toBe(false)
  })
})

describe('stuck timer', () => {
  it('outlasts the longest a read is allowed to run, so a live read is never marked stuck', () => {
    expect(STUCK_AFTER_MS).toBe(6 * 60 * 1000)
    expect(STUCK_AFTER_MS).toBeGreaterThan(maxDuration * 1000)
  })
})
