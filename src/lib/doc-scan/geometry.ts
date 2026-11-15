// Pure geometry for the in-browser page scanner (no DOM, no OpenCV) — shared by
// the scanner worker, the camera overlay and the corner editor, and covered by
// src/lib/__tests__/doc-scan-geometry.test.ts.

export interface Pt { x: number; y: number }
/** Page corners, always in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt]

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * Order four arbitrary corner points TL, TR, BR, BL. Sorts around the
 * centroid by angle, then rotates the list so the corner nearest the image's
 * top-left (smallest x + y) comes first — stable for pages tilted up to ~45°.
 */
export function orderQuad(pts: Pt[]): Quad {
  if (pts.length !== 4) throw new Error('orderQuad needs 4 points')
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4
  // Clockwise on screen (y down): increasing atan2 angle.
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  let start = 0
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i
  }
  const q = [0, 1, 2, 3].map(i => sorted[(start + i) % 4])
  return [q[0], q[1], q[2], q[3]]
}

export function quadArea(q: Quad): number {
  let s = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

/** True when every turn goes the same way (no bow-tie / dented quads). */
export function isConvex(q: Quad): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (cross === 0) return false
    const s = Math.sign(cross)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** Interior angles in degrees, one per corner. */
export function cornerAngles(q: Quad): number[] {
  return q.map((p, i) => {
    const prev = q[(i + 3) % 4], next = q[(i + 1) % 4]
    const v1 = { x: prev.x - p.x, y: prev.y - p.y }
    const v2 = { x: next.x - p.x, y: next.y - p.y }
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1)
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
  })
}

/**
 * Is this a plausible photographed page? Convex, big enough, every corner
 * between 50° and 130° (a page seen at an angle, not a sliver or an arrowhead).
 */
export function isPlausiblePage(q: Quad, imgW: number, imgH: number, minAreaFrac = 0.12): boolean {
  if (!isConvex(q)) return false
  if (quadArea(q) < minAreaFrac * imgW * imgH) return false
  return cornerAngles(q).every(a => a >= 50 && a <= 130)
}

export function scaleQuad(q: Quad, sx: number, sy: number = sx): Quad {
  return q.map(p => ({ x: p.x * sx, y: p.y * sy })) as Quad
}

/** Largest corner movement between two quads, as a fraction of the frame diagonal. */
export function quadDelta(a: Quad, b: Quad, frameW: number, frameH: number): number {
  const diag = Math.hypot(frameW, frameH) || 1
  return Math.max(...a.map((p, i) => dist(p, b[i]))) / diag
}

/** A corner within `marginFrac` of the frame edge — the page is probably cut off. */
export function touchesEdge(q: Quad, w: number, h: number, marginFrac = 0.012): boolean {
  const mx = w * marginFrac, my = h * marginFrac
  return q.some(p => p.x <= mx || p.y <= my || p.x >= w - mx || p.y >= h - my)
}

/**
 * Output size of the flattened page: the longer of each pair of opposite
 * edges, capped so the long side is at most `maxLong` and never upscaled.
 */
export function warpSize(q: Quad, maxLong: number): { width: number; height: number } {
  const w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]))
  const h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]))
  const k = Math.min(1, maxLong / Math.max(w, h, 1))
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

/** A quad inset from the frame edges — the starting crop when no page was found. */
export function insetQuad(w: number, h: number, frac = 0.06): Quad {
  const x0 = w * frac, y0 = h * frac, x1 = w - x0, y1 = h - y0
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
}

export function clampQuad(q: Quad, w: number, h: number): Quad {
  return q.map(p => ({ x: Math.max(0, Math.min(w, p.x)), y: Math.max(0, Math.min(h, p.y)) })) as Quad
}

// ─── Straight lines (page sides) ──────────────────────────────────────────────

export interface Seg { a: Pt; b: Pt }
/** An infinite line in normal form x·cosθ + y·sinθ = rho, with how much edge backs it. */
export interface Line { theta: number; rho: number; weight: number }

function segToLine(s: Seg): Line {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y
  const len = Math.hypot(dx, dy)
  // Normal direction, folded into [0, π).
  let theta = Math.atan2(dx, -dy)
  if (theta < 0) theta += Math.PI
  if (theta >= Math.PI) theta -= Math.PI
  const rho = s.a.x * Math.cos(theta) + s.a.y * Math.sin(theta)
  return { theta, rho, weight: len }
}

/**
 * Merge segments that lie on the same straight line (within 4° and `tol`
 * px) and split them into near-horizontal and near-vertical sides (each
 * within 35°), strongest first.
 */
export function groupLines(segs: Seg[], tol: number): { horizontal: Line[]; vertical: Line[] } {
  const merged: Line[] = []
  for (const s of segs) {
    const l = segToLine(s)
    const hit = merged.find(m => {
      let dTheta = Math.abs(m.theta - l.theta)
      let rho = l.rho
      if (dTheta > Math.PI / 2) { dTheta = Math.PI - dTheta; rho = -rho }
      return dTheta < (4 * Math.PI) / 180 && Math.abs(m.rho - rho) < tol
    })
    if (hit) hit.weight += l.weight
    else merged.push({ ...l })
  }
  merged.sort((a, b) => b.weight - a.weight)
  const deg = (t: number) => (t * 180) / Math.PI
  // theta is the normal's angle: a horizontal side has a vertical normal (θ ≈ 90°).
  return {
    horizontal: merged.filter(l => Math.abs(deg(l.theta) - 90) <= 35),
    vertical: merged.filter(l => deg(l.theta) <= 35 || deg(l.theta) >= 145),
  }
}

export function intersect(l1: Line, l2: Line): Pt | null {
  const c1 = Math.cos(l1.theta), s1 = Math.sin(l1.theta)
  const c2 = Math.cos(l2.theta), s2 = Math.sin(l2.theta)
  const det = c1 * s2 - s1 * c2
  if (Math.abs(det) < 1e-6) return null
  return { x: (l1.rho * s2 - l2.rho * s1) / det, y: (c1 * l2.rho - c2 * l1.rho) / det }
}

/** Quad from two horizontal + two vertical lines; null if a corner lands well outside the frame. */
export function quadFromLines(h1: Line, h2: Line, v1: Line, v2: Line, w: number, h: number): Quad | null {
  const pts = [intersect(h1, v1), intersect(h1, v2), intersect(h2, v2), intersect(h2, v1)]
  if (pts.some(p => !p)) return null
  const slack = 0.02 * Math.max(w, h)
  if (pts.some(p => p!.x < -slack || p!.y < -slack || p!.x > w + slack || p!.y > h + slack)) return null
  return clampQuad(orderQuad(pts as Pt[]), w, h)
}

/**
 * Share of the quad's outline that sits on edge pixels (`edges` = one byte
 * per pixel, non-zero on an edge). Samples every 2 px along each side,
 * skipping the 5 % next to each corner; returns the WEAKEST side's share, so
 * a quad with one side running across bare table scores low.
 */
export function edgeSupport(q: Quad, edges: Uint8Array, w: number, h: number): number {
  let weakest = 1
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    const len = dist(a, b)
    const n = Math.max(4, Math.floor(len / 2))
    let hit = 0, total = 0
    for (let j = 0; j <= n; j++) {
      const t = j / n
      if (t < 0.05 || t > 0.95) continue
      const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t)
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      total++
      if (edges[y * w + x]) hit++
    }
    // A side running along the frame border has no edge to find; count it
    // as half-supported (the page may simply be cut off there).
    const onBorder = (Math.max(a.x, b.x) <= 2 || Math.min(a.x, b.x) >= w - 3 || Math.max(a.y, b.y) <= 2 || Math.min(a.y, b.y) >= h - 3)
    const share = onBorder ? 0.5 : total ? hit / total : 0
    weakest = Math.min(weakest, share)
  }
  return weakest
}

/**
 * Does each side separate two different surfaces? Compares a strip just
 * inside every side with a strip just outside (`chan` = one byte per pixel).
 * The paper's real edge has paper on one side and table on the other; a
 * printed box line inside the invoice has paper on both. Returns the weakest
 * side's contrast as 0–1 (a difference of `full` levels or more = 1). A side
 * on the frame border has nothing outside to compare and counts as 0.6.
 */
export function sideContrast(q: Quad, chan: Uint8Array, w: number, h: number, full = 22): number {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4
  const off = Math.max(3, 0.02 * Math.min(w, h))
  const at = (x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y)
    return xi < 0 || yi < 0 || xi >= w || yi >= h ? -1 : chan[yi * w + xi]
  }
  let weakest = 1
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    const len = dist(a, b) || 1
    let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny } // n points inward
    let sIn = 0, sOut = 0, n = 0
    for (let t = 0.1; t <= 0.9; t += 0.02) {
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t
      const vin = at(px + nx * off, py + ny * off)
      const vout = at(px - nx * off, py - ny * off)
      if (vin < 0 || vout < 0) continue
      sIn += vin; sOut += vout; n++
    }
    const share = n < 5 ? 0.6 : Math.min(1, Math.abs(sIn - sOut) / n / full)
    weakest = Math.min(weakest, share)
  }
  return weakest
}

/** Is p inside the convex quad (corners in order)? */
export function pointInQuad(p: Pt, q: Quad): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cross === 0) continue
    const s = Math.sign(cross)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** Share of the printed marks (`ink` points) that fall inside the quad. */
export function inkInside(q: Quad, ink: Pt[]): number {
  if (!ink.length) return 1
  let n = 0
  for (const p of ink) if (pointInQuad(p, q)) n++
  return n / ink.length
}

/**
 * Map a point in a source image (srcW × srcH) shown with CSS
 * `object-fit: cover` (or `contain`) in a box (boxW × boxH) to box coordinates.
 */
export function fitTransform(srcW: number, srcH: number, boxW: number, boxH: number, mode: 'cover' | 'contain') {
  const s = mode === 'cover'
    ? Math.max(boxW / srcW, boxH / srcH)
    : Math.min(boxW / srcW, boxH / srcH)
  const ox = (boxW - srcW * s) / 2
  const oy = (boxH - srcH * s) / 2
  return {
    scale: s,
    toBox: (p: Pt): Pt => ({ x: p.x * s + ox, y: p.y * s + oy }),
    toSrc: (p: Pt): Pt => ({ x: (p.x - ox) / s, y: (p.y - oy) / s }),
  }
}
