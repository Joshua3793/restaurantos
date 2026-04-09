import { createUploadthing, type FileRouter } from 'uploadthing/next'

const f = createUploadthing()

export const ourFileRouter = {
  invoiceUploader: f({
    image:              { maxFileSize: '16MB', maxFileCount: 10 },
    'application/pdf':  { maxFileSize: '16MB', maxFileCount: 10 },
    'text/csv':         { maxFileSize: '4MB',  maxFileCount: 10 },
  })
    .middleware(async () => ({}))
    .onUploadComplete(async ({ file }) => ({ url: file.ufsUrl })),
} satisfies FileRouter

export type OurFileRouter = typeof ourFileRouter
