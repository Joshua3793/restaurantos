// Copy browser-side engine files out of node_modules into public/ on every
// install, so they can never drift from the installed package versions:
//   • public/pdf.worker.min.mjs  — pdfjs-dist worker (invoice PDF previews)
//   • public/vendor/opencv.js    — OpenCV.js for the browser page scanner
//     (src/lib/doc-scan/scan.worker.ts loads it on demand; ~11 MB, gitignored)
const fs = require('fs')

function copy(spec, dest) {
  try {
    const src = require.resolve(spec)
    fs.mkdirSync(require('path').dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    console.log(`[copy-pdf-worker] ${dest} updated`)
  } catch (e) {
    console.warn(`[copy-pdf-worker] ${dest} skipped:`, e.message)
  }
}

copy('pdfjs-dist/build/pdf.worker.min.mjs', 'public/pdf.worker.min.mjs')
copy('@techstark/opencv-js/dist/opencv.js', 'public/vendor/opencv.js')
