// The page scanner's image work, written against an OpenCV.js `cv` instance so
// it runs unchanged in the browser worker (scan.worker.ts) and in Node for
// tuning. No DOM. Every Mat is freed in a finally block — OpenCV.js memory is
// manual, and a leak per frame would crash a phone within a minute.
//
// What it does, and why (the server already runs normalize + a mild sharpen on
// every page before reading, so this stage does NOT sharpen again):
//   1. findPage   — locate the paper's four corners on a small copy.
//   2. flatten    — perspective-correct the page to a straight rectangle, from
//                   the FULL-resolution frame, so the small print keeps every pixel.
//   3. evenLight  — divide out the lighting (shadows, phone shade, yellow cast)
//                   so the paper is white and the ink dark, colour kept.
//   4. assess     — blur / too dark / glare / page cut off / too far, for the
//                   retake warning.

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  type Quad, type Pt, type Seg, orderQuad, isPlausiblePage, quadArea, scaleQuad, cornerAngles,
  groupLines, quadFromLines, edgeSupport, sideContrast, inkInside, quadDelta,
  touchesEdge, warpSize, insetQuad,
} from './geometry'

type CV = any

/** Long side of the copy used to find the page (preview frames arrive about this size). */
export const DETECT_LONG = 480
/** Long side of the flattened page. The server reads at 2500 px, so more is waste. */
export const OUTPUT_LONG = 2500

export interface RGBAImage { width: number; height: number; data: Uint8ClampedArray }

export interface Quality {
  /** Text sharpness, higher = sharper (variance of the Laplacian at a fixed scale). */
  sharpness: number
  /** Median paper brightness 0–255 before evening the light. */
  paper: number
  /** Share of the page that is blown-out white (glare). */
  glare: number
  /** Page area as a share of the photo. */
  coverage: number
  cutOff: boolean
  pageFound: boolean
}

export type Issue = 'blurry' | 'dark' | 'glare' | 'cutoff' | 'nopage' | 'far'

/** Thresholds — tuned on real invoice photos (scripts/doc-scan-tune.ts). */
export const LIMITS = {
  minSharpness: 60,
  minPaper: 95,
  maxGlare: 0.025,
  minCoverage: 0.22,
}

export function issuesFor(q: Quality): Issue[] {
  const out: Issue[] = []
  if (!q.pageFound) out.push('nopage')
  if (q.cutOff) out.push('cutoff')
  if (q.sharpness < LIMITS.minSharpness) out.push('blurry')
  if (q.paper < LIMITS.minPaper) out.push('dark')
  if (q.glare > LIMITS.maxGlare) out.push('glare')
  if (q.pageFound && q.coverage < LIMITS.minCoverage) out.push('far')
  return out
}

function matToQuadPts(cv: CV, m: any): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < m.rows; i++) pts.push({ x: m.data32S[i * 2], y: m.data32S[i * 2 + 1] })
  return pts
}

/** Reduce a contour to 4 corners: approxPolyDP on its hull with a growing tolerance. */
function contourToQuad(cv: CV, contour: any): Quad | null {
  const hull = new cv.Mat()
  const approx = new cv.Mat()
  try {
    cv.convexHull(contour, hull, false, true)
    const peri = cv.arcLength(hull, true)
    for (const eps of [0.015, 0.02, 0.03, 0.045, 0.06, 0.08]) {
      cv.approxPolyDP(hull, approx, eps * peri, true)
      if (approx.rows === 4) return orderQuad(matToQuadPts(cv, approx))
      if (approx.rows < 4) break
    }
    return null
  } finally {
    hull.delete(); approx.delete()
  }
}

/**
 * How page-like a quad is, 0–1-ish: big, square-cornered, inside the frame,
 * its sides run along edges in the photo (`support`) and — the deciding
 * factor — each side has paper inside and something else outside
 * (`contrast`), which is what tells the page's edge from a printed box. A quad pinned to the frame edge is usually table + paper
 * merged, so it scores lower than a page that sits wholly in view.
 */
export function pageScore(q: Quad, w: number, h: number, support: number, contrast: number): number {
  const area = quadArea(q) / (w * h)
  const angles = cornerAngles(q)
  const square = Math.max(0, 1 - angles.reduce((s, a) => s + Math.abs(a - 90), 0) / 4 / 40)
  const pinned = q.filter(p => p.x <= w * 0.012 || p.y <= h * 0.012 || p.x >= w * 0.988 || p.y >= h * 0.988).length
  // Support and contrast are pass marks, not prizes: once a side clearly sits
  // on an edge between two surfaces, more doesn't help — size decides, because
  // the page is the BIGGEST such rectangle (printed boxes are inside it).
  const sup = Math.min(1, support / 0.45)
  const con = Math.min(1, contrast / 0.35)
  return area * (0.6 + 0.4 * square) * (0.3 + 0.7 * sup) * con * con * (pinned === 0 ? 1 : pinned <= 2 ? 0.6 : 0.4)
}

/** Candidate quads from a binary image's contours (plausible pages only). */
function quadsFromBinary(cv: CV, bin: any, w: number, h: number, mode: number, out: Quad[]) {
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    cv.findContours(bin, contours, hierarchy, mode, cv.CHAIN_APPROX_SIMPLE)
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i)
      try {
        if (cv.contourArea(c) < 0.1 * w * h) continue
        const q = contourToQuad(cv, c)
        if (q && isPlausiblePage(q, w, h) && quadArea(q) <= 0.97 * w * h) out.push(q)
      } finally {
        c.delete()
      }
    }
  } finally {
    contours.delete(); hierarchy.delete()
  }
}

/**
 * Candidate quads from straight lines: the page's four sides are long
 * straight edges even where one side is faint against the table, so pair the
 * strongest near-horizontal lines with the strongest near-vertical ones.
 */
function quadsFromLines(cv: CV, edges: any, w: number, h: number, out: Quad[]) {
  const lines = new cv.Mat()
  try {
    const minLen = 0.12 * Math.min(w, h)
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 30, minLen, 12)
    const segs: Seg[] = []
    for (let i = 0; i < lines.rows; i++) {
      const d = lines.data32S
      segs.push({ a: { x: d[i * 4], y: d[i * 4 + 1] }, b: { x: d[i * 4 + 2], y: d[i * 4 + 3] } })
    }
    const { horizontal, vertical } = groupLines(segs, 8)
    const H = horizontal.slice(0, 7), V = vertical.slice(0, 7)
    for (let i = 0; i < H.length; i++) for (let j = i + 1; j < H.length; j++) {
      for (let k = 0; k < V.length; k++) for (let l = k + 1; l < V.length; l++) {
        const q = quadFromLines(H[i], H[j], V[k], V[l], w, h)
        if (q && isPlausiblePage(q, w, h) && quadArea(q) <= 0.97 * w * h) out.push(q)
      }
    }
  } finally {
    lines.delete()
  }
}

/**
 * Find the page on an RGBA image of any size. Works on a ≤ DETECT_LONG copy
 * and returns corners in the input's pixel coordinates, or null.
 * Candidates come from three methods on two channels (grey, and "whiteness" =
 * min of R,G,B, which separates white paper from beige wood): edge contours,
 * the bright paper blob, and paired straight lines. Each candidate is scored
 * by how well its four sides sit on real edges (pageScore); best wins.
 */
export function findPage(
  cv: CV,
  img: RGBAImage,
  debugCandidates?: { q: Quad; score: number }[],
  /** The page found a moment ago (same image size) — live preview only. */
  prev?: Quad | null,
): Quad | null {
  const src = cv.matFromImageData(img as any)
  const small = new cv.Mat()
  const rgb = new cv.Mat()
  const gray = new cv.Mat()
  const white = new cv.Mat()
  const chans = new cv.MatVector()
  const blur = new cv.Mat()
  const edges = new cv.Mat()
  const closed = new cv.Mat()
  const bin = new cv.Mat()
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
  const kernel7 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7))
  let allEdges: any = null
  try {
    const k = Math.min(1, DETECT_LONG / Math.max(img.width, img.height))
    const sw = Math.max(1, Math.round(img.width * k))
    const sh = Math.max(1, Math.round(img.height * k))
    cv.resize(src, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA)
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB)
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY)
    // "Whiteness" = the darkest of R, G, B. White paper is high in all three;
    // a beige wooden table or a brown box is low in blue.
    cv.split(rgb, chans)
    const r = chans.get(0), g = chans.get(1), b = chans.get(2)
    cv.min(r, g, white); cv.min(white, b, white)
    r.delete(); g.delete(); b.delete()
    allEdges = cv.Mat.zeros(sh, sw, cv.CV_8UC1)

    const cands: Quad[] = []
    for (const chan of [white, gray]) {
      cv.GaussianBlur(chan, blur, new cv.Size(5, 5), 0)

      // Edges — thresholds from the median so dim and bright photos both work.
      const med = median(blur)
      const lo = Math.max(8, 0.33 * med), hi = Math.min(255, Math.max(lo + 15, 0.8 * med))
      cv.Canny(blur, edges, lo, hi)
      cv.bitwise_or(allEdges, edges, allEdges)
      quadsFromLines(cv, edges, sw, sh, cands)
      cv.dilate(edges, closed, kernel, new cv.Point(-1, -1), 1)
      cv.morphologyEx(closed, closed, cv.MORPH_CLOSE, kernel7)
      quadsFromBinary(cv, closed, sw, sh, cv.RETR_LIST, cands)

      // The paper as the bright blob.
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kernel7)
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel7, new cv.Point(-1, -1), 2)
      quadsFromBinary(cv, bin, sw, sh, cv.RETR_EXTERNAL, cands)
    }
    if (!cands.length) return null

    // Score every candidate against the combined edge map (thickened by 1 px
    // so a side that is off by a pixel still counts).
    cv.dilate(allEdges, allEdges, kernel, new cv.Point(-1, -1), 1)
    const E: Uint8Array = allEdges.data
    cv.GaussianBlur(white, blur, new cv.Size(5, 5), 0)
    const W: Uint8Array = blur.data
    const ink = inkPoints(cv, gray)
    const prevSmall = prev ? scaleQuad(prev, sw / img.width, sh / img.height) : null
    let best: { q: Quad; score: number } | null = null
    for (const q of cands) {
      // A crop that leaves printing outside it (the totals under a table's
      // bottom line, say) is a box on the page, not the page.
      const inkShare = Math.min(1, inkInside(q, ink) / 0.96)
      let score = pageScore(q, sw, sh, edgeSupport(q, E, sw, sh), sideContrast(q, W, sw, sh)) * inkShare ** 6
      // Live preview: stick with the page found a moment ago unless something
      // clearly better turns up, so the outline doesn't flick between two
      // near-equal guesses (which would also keep restarting the auto-snap).
      if (prevSmall && quadDelta(q, prevSmall, sw, sh) < 0.03) score *= 1.25
      if (debugCandidates) debugCandidates.push({ q: scaleQuad(q, img.width / sw, img.height / sh), score })
      if (!best || score > best.score) best = { q, score }
    }
    if (!best || best.score < MIN_PAGE_SCORE) return null
    return scaleQuad(best.q, img.width / sw, img.height / sh)
  } finally {
    src.delete(); small.delete(); rgb.delete(); gray.delete(); white.delete(); chans.delete()
    blur.delete(); edges.delete(); closed.delete(); bin.delete(); kernel.delete(); kernel7.delete()
    if (allEdges) allEdges.delete()
  }
}

/**
 * Printed marks: small dark strokes on a lighter ground (a black-hat filter
 * picks out text and ruled lines but not broad shadows or a dark table),
 * thinned to at most ~3000 points.
 */
/**
 * Black-hat strength that counts as a printed mark. Deliberately low: missing
 * a faint line of print matters more than counting some table grain, because
 * the crop must never cut off the totals (a little table in the crop is harmless
 * to the reader; a missing line is not).
 */
const INK_LEVEL = 40

function inkPoints(cv: CV, gray: any): Pt[] {
  const hat = new cv.Mat()
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9))
  try {
    cv.morphologyEx(gray, hat, cv.MORPH_BLACKHAT, k)
    const d: Uint8Array = hat.data
    const w = hat.cols
    let count = 0
    for (let i = 0; i < d.length; i++) if (d[i] > INK_LEVEL) count++
    const step = Math.max(1, Math.ceil(count / 3000))
    const pts: Pt[] = []
    let seen = 0
    for (let i = 0; i < d.length; i++) {
      if (d[i] > INK_LEVEL && seen++ % step === 0) pts.push({ x: i % w, y: Math.floor(i / w) })
    }
    return pts
  } finally {
    hat.delete(); k.delete()
  }
}

/** Below this a "page" is guesswork — better to say none was found and let the cook frame it. */
export const MIN_PAGE_SCORE = 0.08

function median(gray8: any): number {
  const hist = new Uint32Array(256)
  const d: Uint8Array = gray8.data
  const step = Math.max(1, Math.floor(d.length / 40000))
  let n = 0
  for (let i = 0; i < d.length; i += step) { hist[d[i]]++; n++ }
  return percentileFromHist(hist, n, 0.5)
}

function percentileFromHist(hist: Uint32Array, n: number, p: number): number {
  let acc = 0
  const target = n * p
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v }
  return 255
}

function histogram(gray8: any): { hist: Uint32Array; n: number } {
  const hist = new Uint32Array(256)
  const d: Uint8Array = gray8.data
  const step = Math.max(1, Math.floor(d.length / 200000))
  let n = 0
  for (let i = 0; i < d.length; i += step) { hist[d[i]]++; n++ }
  return { hist, n }
}

/** Sharpness of a grey page: Laplacian variance at a fixed 1000 px width, so the score doesn't depend on resolution. */
function sharpnessOf(cv: CV, gray: any): number {
  const norm = new cv.Mat()
  const lap = new cv.Mat()
  const mean = new cv.Mat()
  const std = new cv.Mat()
  try {
    const k = 1000 / gray.cols
    cv.resize(gray, norm, new cv.Size(1000, Math.max(1, Math.round(gray.rows * k))), 0, 0, k < 1 ? cv.INTER_AREA : cv.INTER_LINEAR)
    cv.Laplacian(norm, lap, cv.CV_64F)
    cv.meanStdDev(lap, mean, std)
    const s = std.data64F[0]
    return s * s
  } finally {
    norm.delete(); lap.delete(); mean.delete(); std.delete()
  }
}

/**
 * Even out the lighting, channel by channel: estimate the paper's colour
 * everywhere (a closing that swallows the text, then a median that keeps
 * hard shadow edges), and divide each channel by its own estimate — shadows,
 * the phone's shade and blue/yellow casts go, the paper turns white, ink stays
 * dark and coloured stamps keep their colour. Each estimate is floored at
 * 55 % of its paper level so a big dark block (a black header bar, a logo) is
 * not "corrected" into a white smear.
 */
function evenLight(cv: CV, rgba: any): any {
  const rgb = new cv.Mat()
  const chans = new cv.MatVector()
  const outChans = new cv.MatVector()
  const merged = new cv.Mat()
  const small = new cv.Mat()
  const bg = new cv.Mat()
  const bgFull = new cv.Mat()
  let kernel: any = null
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB)
    cv.split(rgb, chans)
    const k = 0.25
    const sw = Math.max(8, Math.round(rgb.cols * k)), sh = Math.max(8, Math.round(rgb.rows * k))
    const ks = Math.max(5, Math.round(Math.max(sw, sh) / 45)) | 1
    kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(ks, ks))
    for (let i = 0; i < 3; i++) {
      const c = chans.get(i)
      cv.resize(c, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA)
      // Closing (max then min filter) erases text but puts a shadow's edge
      // back where it was — a plain max filter would push the bright side
      // over the edge and leave a dark seam along it.
      cv.morphologyEx(small, bg, cv.MORPH_CLOSE, kernel)
      cv.medianBlur(bg, bg, ks)
      const { hist, n } = histogram(bg)
      const floor = Math.max(1, Math.round(percentileFromHist(hist, n, 0.9) * 0.55))
      const floorMat = new cv.Mat(bg.rows, bg.cols, cv.CV_8UC1, new cv.Scalar(floor))
      cv.max(bg, floorMat, bg)
      floorMat.delete()
      cv.resize(bg, bgFull, new cv.Size(rgb.cols, rgb.rows), 0, 0, cv.INTER_LINEAR)
      const o = new cv.Mat()
      cv.divide(c, bgFull, o, 255)
      outChans.push_back(o)
      c.delete(); o.delete()
    }
    cv.merge(outChans, merged)

    // Gentle black point: pull the darkest ink to black (≤ 1st percentile,
    // never more than 60) so faint thermal print gains contrast without
    // clipping the paper.
    const g2 = new cv.Mat()
    cv.cvtColor(merged, g2, cv.COLOR_RGB2GRAY)
    const h2 = histogram(g2)
    g2.delete()
    const black = Math.min(60, percentileFromHist(h2.hist, h2.n, 0.01))
    if (black > 0) merged.convertTo(merged, -1, 255 / (255 - black), (-black * 255) / (255 - black))

    const out = new cv.Mat()
    cv.cvtColor(merged, out, cv.COLOR_RGB2RGBA)
    return out
  } finally {
    rgb.delete(); chans.delete(); outChans.delete(); merged.delete()
    small.delete(); bg.delete(); bgFull.delete()
    if (kernel) kernel.delete()
  }
}

export interface ProcessResult {
  page: RGBAImage
  /** Corners used, in the input image's pixels (detected, given, or the inset fallback). */
  quad: Quad
  quality: Quality
}

/**
 * Full-resolution page processing: find (unless `quad` is given) → flatten →
 * even light → assess. `quad` is the user's corner fix from the editor.
 */
export function processPage(cv: CV, img: RGBAImage, quad?: Quad | null): ProcessResult {
  const detected = quad ? null : findPage(cv, img)
  const pageFound = !!(quad || detected)
  const used: Quad = quad ?? detected ?? insetQuad(img.width, img.height, 0)

  const src = cv.matFromImageData(img as any)
  const warped = new cv.Mat()
  const gray = new cv.Mat()
  let lit: any = null
  try {
    const { width, height } = warpSize(used, OUTPUT_LONG)
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, used.flatMap(p => [p.x, p.y]))
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1])
    const M = cv.getPerspectiveTransform(from, to)
    cv.warpPerspective(src, warped, M, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE)
    from.delete(); to.delete(); M.delete()

    cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY)
    const { hist, n } = histogram(gray)
    const paper = percentileFromHist(hist, n, 0.5)
    // Glare = blown-out patches on an otherwise normally lit page. A page whose
    // paper is itself near white (already a clean scan, or a bright exposure)
    // has nothing to compare against, so it never counts as glare.
    let blown = 0
    if (paper < 235) for (let v = 252; v < 256; v++) blown += hist[v]
    const sharpness = sharpnessOf(cv, gray)

    lit = evenLight(cv, warped)
    const page: RGBAImage = {
      width: lit.cols,
      height: lit.rows,
      data: new Uint8ClampedArray(lit.data),
    }
    return {
      page,
      quad: used,
      quality: {
        sharpness,
        paper,
        glare: blown / n,
        coverage: quadArea(used) / (img.width * img.height),
        cutOff: pageFound && touchesEdge(used, img.width, img.height),
        pageFound,
      },
    }
  } finally {
    src.delete(); warped.delete(); gray.delete()
    if (lit) lit.delete()
  }
}

/** Mean brightness of a small RGBA frame (cheap, for the "too dark" camera hint). */
export function frameBrightness(img: RGBAImage): number {
  const d = img.data
  let s = 0, n = 0
  const step = Math.max(4, Math.floor(d.length / 4 / 5000) * 4)
  for (let i = 0; i < d.length; i += step) { s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; n++ }
  return n ? s / n : 0
}
