// Tune the page scanner on real photos, in Node:
//   npx tsx scripts/doc-scan-tune.ts <in-dir> <out-dir>
// For each JPEG: finds the page, flattens, evens the light, prints the quality
// numbers, writes <name>.out.jpg (the page the reader would get) and
// <name>.quad.jpg (the photo with the found corners drawn).
/* eslint-disable @typescript-eslint/no-explicit-any -- OpenCV.js ships no types */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { processPage, issuesFor } from '../src/lib/doc-scan/pipeline'

async function loadCv(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cv = require('@techstark/opencv-js')
  if (cv.Mat) return cv
  // The module is a thenable that resolves to itself — strip `then` before
  // handing it to a real Promise or `await` would loop forever.
  return new Promise(res => cv.then((c: any) => { delete c.then; res(c) }))
}

async function main() {
  const [inDir, outDir] = process.argv.slice(2)
  fs.mkdirSync(outDir, { recursive: true })
  const cv = await loadCv()
  for (const f of fs.readdirSync(inDir).filter(n => /\.jpe?g$/i.test(n)).sort()) {
    const { data, info } = await sharp(path.join(inDir, f)).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const img = { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) }
    const t = Date.now()
    const r = processPage(cv, img)
    const ms = Date.now() - t
    const q = r.quality
    console.log(`${f.padEnd(12)} ${info.width}x${info.height} → ${r.page.width}x${r.page.height}  sharp=${q.sharpness.toFixed(0)} paper=${q.paper} glare=${(q.glare * 100).toFixed(1)}% cover=${(q.coverage * 100).toFixed(0)}% found=${q.pageFound} cut=${q.cutOff}  issues=[${issuesFor(q).join(',')}] ${ms}ms`)
    const base = f.replace(/\.jpe?g$/i, '')
    await sharp(Buffer.from(r.page.data.buffer), { raw: { width: r.page.width, height: r.page.height, channels: 4 } })
      .jpeg({ quality: 90 }).toFile(path.join(outDir, `${base}.out.jpg`))
    const pts = r.quad.map(p => `${p.x},${p.y}`).join(' ')
    const th = Math.round(info.height * 700 / info.width)
    const svg = `<svg width="700" height="${th}" viewBox="0 0 ${info.width} ${info.height}" preserveAspectRatio="none"><polygon points="${pts}" fill="none" stroke="lime" stroke-width="8"/></svg>`
    await sharp(Buffer.from(data), { raw: { width: info.width, height: info.height, channels: 4 } })
      .resize(700, th, { fit: 'fill' }).composite([{ input: Buffer.from(svg) }]).jpeg().toFile(path.join(outDir, `${base}.quad.jpg`))
  }
}
main().catch(e => { console.error(e); process.exit(1) })
