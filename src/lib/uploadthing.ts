import { createUploadthing, type FileRouter } from 'uploadthing/next'
import { UploadThingError } from 'uploadthing/server'
import { requireSession, AuthError } from '@/lib/auth'

const f = createUploadthing()

export const ourFileRouter = {
  invoiceUploader: f({
    image:              { maxFileSize: '16MB', maxFileCount: 10 },
    'application/pdf':  { maxFileSize: '16MB', maxFileCount: 10 },
    'text/csv':         { maxFileSize: '4MB',  maxFileCount: 10 },
  })
    .middleware(async () => ({}))
    .onUploadComplete(async ({ file }) => ({ url: file.ufsUrl })),

  // Recipe Scan: photos, a PDF, Word or Excel/CSV — managers only.
  recipeScanUploader: f({
    image:              { maxFileSize: '16MB', maxFileCount: 10 },
    'application/pdf':  { maxFileSize: '16MB', maxFileCount: 10 },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                        { maxFileSize: '16MB', maxFileCount: 10 },
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
                        { maxFileSize: '16MB', maxFileCount: 10 },
    'text/csv':         { maxFileSize: '16MB', maxFileCount: 10 },
  })
    .middleware(async () => {
      try { await requireSession('MANAGER') }
      catch (e) {
        if (e instanceof AuthError) throw new UploadThingError(e.message)
        throw e
      }
      return {}
    })
    .onUploadComplete(async ({ file }) => ({ url: file.ufsUrl })),

  // One optional photo on a waste entry or a flagged checklist job — any signed-in cook.
  // The client shrinks it first (~1600 px JPEG), so 8 MB is a generous ceiling.
  photoUploader: f({
    image: { maxFileSize: '8MB', maxFileCount: 1 },
  })
    .middleware(async () => {
      try { await requireSession() }
      catch (e) {
        if (e instanceof AuthError) throw new UploadThingError(e.message)
        throw e
      }
      return {}
    })
    .onUploadComplete(async ({ file }) => ({ url: file.ufsUrl })),
} satisfies FileRouter

export type OurFileRouter = typeof ourFileRouter
