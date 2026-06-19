// Keep public/pdf.worker.min.mjs in sync with the installed pdfjs-dist version.
// Runs on postinstall so the worker can never drift from the pdfjs API version.
const fs = require('fs')
try {
  const src = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
  fs.mkdirSync('public', { recursive: true })
  fs.copyFileSync(src, 'public/pdf.worker.min.mjs')
  console.log('[copy-pdf-worker] public/pdf.worker.min.mjs updated')
} catch (e) {
  console.warn('[copy-pdf-worker] skipped:', e.message)
}
