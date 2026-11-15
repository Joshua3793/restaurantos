import { describe, it, expect } from 'vitest'
import {
  orderQuad, quadArea, isConvex, isPlausiblePage, quadDelta, touchesEdge, warpSize,
  groupLines, quadFromLines, edgeSupport, sideContrast, pointInQuad, inkInside, fitTransform,
  type Quad,
} from '@/lib/doc-scan/geometry'
import { issuesFor, LIMITS, type Quality } from '@/lib/doc-scan/pipeline'

const rect = (x0: number, y0: number, x1: number, y1: number): Quad =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]

describe('orderQuad', () => {
  it('orders shuffled corners TL, TR, BR, BL', () => {
    const q = orderQuad([{ x: 90, y: 110 }, { x: 10, y: 5 }, { x: 5, y: 100 }, { x: 95, y: 10 }])
    expect(q).toEqual([{ x: 10, y: 5 }, { x: 95, y: 10 }, { x: 90, y: 110 }, { x: 5, y: 100 }])
  })
  it('keeps a page tilted 30° in order', () => {
    const q = orderQuad([{ x: 50, y: 0 }, { x: 137, y: 50 }, { x: 87, y: 137 }, { x: 0, y: 87 }])
    expect(q[0]).toEqual({ x: 50, y: 0 }) // smallest x + y
    expect(isConvex(q)).toBe(true)
  })
})

describe('page checks', () => {
  it('area and convexity', () => {
    expect(quadArea(rect(0, 0, 10, 20))).toBe(200)
    expect(isConvex(rect(0, 0, 10, 20))).toBe(true)
    const bowtie: Quad = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }]
    expect(isConvex(bowtie)).toBe(false)
  })
  it('a big square page is plausible; a sliver or a speck is not', () => {
    expect(isPlausiblePage(rect(10, 10, 90, 90), 100, 100)).toBe(true)
    expect(isPlausiblePage(rect(10, 10, 20, 20), 100, 100)).toBe(false)
    const sliver: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 60, y: 30 }, { x: 40, y: 30 }]
    expect(isPlausiblePage(sliver, 100, 100)).toBe(false)
  })
  it('steadiness is corner movement over the frame diagonal', () => {
    const a = rect(10, 10, 90, 90)
    const b = rect(13, 14, 90, 90)
    expect(quadDelta(a, b, 300, 400)).toBeCloseTo(5 / 500)
  })
  it('a corner on the frame edge means the page may be cut off', () => {
    expect(touchesEdge(rect(0, 10, 90, 90), 100, 100)).toBe(true)
    expect(touchesEdge(rect(5, 10, 90, 90), 100, 100)).toBe(false)
  })
})

describe('warpSize', () => {
  it('uses the longer opposite edges and never upscales', () => {
    expect(warpSize(rect(0, 0, 800, 1000), 2500)).toEqual({ width: 800, height: 1000 })
  })
  it('caps the long side', () => {
    expect(warpSize(rect(0, 0, 3000, 4000), 2500)).toEqual({ width: 1875, height: 2500 })
  })
})

describe('straight-line page sides', () => {
  it('pairs two horizontal and two vertical lines into the page', () => {
    const { horizontal, vertical } = groupLines([
      { a: { x: 20, y: 30 }, b: { x: 180, y: 32 } },
      { a: { x: 20, y: 250 }, b: { x: 180, y: 252 } },
      { a: { x: 25, y: 20 }, b: { x: 24, y: 260 } },
      { a: { x: 175, y: 20 }, b: { x: 176, y: 260 } },
      { a: { x: 100, y: 31 }, b: { x: 170, y: 33 } }, // same top line, merged
    ], 8)
    expect(horizontal).toHaveLength(2)
    expect(vertical).toHaveLength(2)
    const q = quadFromLines(horizontal[0], horizontal[1], vertical[0], vertical[1], 200, 300)!
    expect(q).not.toBeNull()
    expect(q[0].x).toBeCloseTo(25, 0)
    expect(q[0].y).toBeCloseTo(30, 0)
    expect(q[2].x).toBeCloseTo(176, 0)
    expect(q[2].y).toBeCloseTo(252, 0)
  })
})

describe('edge and contrast checks', () => {
  const w = 100, h = 100
  // A white page (200) at 20..80 on a dark table (60), with its outline drawn as edges.
  const chan = new Uint8Array(w * h).fill(60)
  const edges = new Uint8Array(w * h)
  for (let y = 20; y <= 80; y++) for (let x = 20; x <= 80; x++) {
    chan[y * w + x] = 200
    if (x === 20 || x === 80 || y === 20 || y === 80) edges[y * w + x] = 255
  }
  const page = rect(20, 20, 80, 80)
  const inner = rect(35, 35, 65, 65)

  it('the real outline is fully supported, an inner box is not', () => {
    expect(edgeSupport(page, edges, w, h)).toBe(1)
    expect(edgeSupport(inner, edges, w, h)).toBe(0)
  })
  it('the real outline separates page from table; an inner box has paper both sides', () => {
    expect(sideContrast(page, chan, w, h)).toBe(1)
    expect(sideContrast(inner, chan, w, h)).toBe(0)
  })
  it('ink share counts printing inside the crop', () => {
    expect(pointInQuad({ x: 50, y: 50 }, page)).toBe(true)
    expect(pointInQuad({ x: 90, y: 50 }, page)).toBe(false)
    expect(inkInside(inner, [{ x: 50, y: 50 }, { x: 70, y: 75 }])).toBe(0.5)
  })
})

describe('fitTransform', () => {
  it('maps a cover-fitted video frame to the screen and back', () => {
    const t = fitTransform(1080, 1920, 390, 844, 'cover')
    const p = t.toBox({ x: 540, y: 960 })
    expect(p.x).toBeCloseTo(195)
    expect(p.y).toBeCloseTo(422)
    const back = t.toSrc(p)
    expect(back.x).toBeCloseTo(540)
  })
})

describe('retake warnings', () => {
  const good: Quality = { sharpness: 300, paper: 180, glare: 0, coverage: 0.6, cutOff: false, pageFound: true }
  it('a clean photo has no warnings', () => expect(issuesFor(good)).toEqual([]))
  it('flags blur, dark, glare, cut off and too far', () => {
    expect(issuesFor({ ...good, sharpness: LIMITS.minSharpness - 1 })).toEqual(['blurry'])
    expect(issuesFor({ ...good, paper: 70 })).toEqual(['dark'])
    expect(issuesFor({ ...good, glare: 0.05 })).toEqual(['glare'])
    expect(issuesFor({ ...good, cutOff: true })).toEqual(['cutoff'])
    expect(issuesFor({ ...good, coverage: 0.1 })).toEqual(['far'])
    expect(issuesFor({ ...good, pageFound: false, coverage: 1 })).toEqual(['nopage'])
  })
})
