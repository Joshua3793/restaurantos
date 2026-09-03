import { describe, it, expect } from 'vitest'
import { blobRefFromUrl } from '@/lib/invoice-files'

describe('blobRefFromUrl', () => {
  it('extracts the UploadThing key from a utfs.io URL', () => {
    expect(blobRefFromUrl('https://utfs.io/f/abc123DEF')).toEqual({ kind: 'uploadthing', key: 'abc123DEF' })
  })

  it('extracts the key from an app-scoped ufs.sh URL and strips the query string', () => {
    expect(blobRefFromUrl('https://uq5g86ss41.ufs.sh/f/k-9_x?token=1')).toEqual({ kind: 'uploadthing', key: 'k-9_x' })
  })

  it('maps a local upload path to a confined relative path', () => {
    expect(blobRefFromUrl('/uploads/invoices/1725000000-inv.jpg'))
      .toEqual({ kind: 'local', relPath: 'uploads/invoices/1725000000-inv.jpg' })
  })

  it('refuses local paths that try to leave the upload directory', () => {
    expect(blobRefFromUrl('/uploads/invoices/../../.env')).toBeNull()
    expect(blobRefFromUrl('/uploads/invoices/sub/dir.jpg')).toBeNull()
    expect(blobRefFromUrl('/uploads/other/x.jpg')).toBeNull()
  })

  it('returns null for data URIs, foreign hosts, and garbage', () => {
    expect(blobRefFromUrl('data:image/jpeg;base64,AAAA')).toBeNull()
    expect(blobRefFromUrl('https://evil.example.com/f/abc')).toBeNull()
    expect(blobRefFromUrl('https://utfs.io/nope/abc')).toBeNull()
    expect(blobRefFromUrl('https://utfs.io/f/')).toBeNull()
    expect(blobRefFromUrl('')).toBeNull()
    expect(blobRefFromUrl('not a url')).toBeNull()
  })
})
