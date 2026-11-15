'use client'
// Drag the four page corners on the original photo. A loupe above the finger
// shows the corner up close so it can be placed on the paper's real edge.
import { useEffect, useRef, useState, useCallback } from 'react'
import { fitTransform, clampQuad, type Quad, type Pt } from '@/lib/doc-scan/geometry'

const DISPLAY_LONG = 1400
const LOUPE = 120
const ZOOM = 2.5

interface Props {
  frame: ImageData
  quad: Quad
  onCancel: () => void
  onApply: (q: Quad) => void
}

export function CornerEditor({ frame, quad, onCancel, onApply }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const loupeRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [q, setQ] = useState<Quad>(quad)
  const [drag, setDrag] = useState<number | null>(null)

  // Paint the photo once, at display size.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const k = Math.min(1, DISPLAY_LONG / Math.max(frame.width, frame.height))
    const full = document.createElement('canvas')
    full.width = frame.width
    full.height = frame.height
    full.getContext('2d')!.putImageData(frame, 0, 0)
    c.width = Math.round(frame.width * k)
    c.height = Math.round(frame.height * k)
    c.getContext('2d')!.drawImage(full, 0, 0, c.width, c.height)
    full.width = full.height = 0
  }, [frame])

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const t = box.w ? fitTransform(frame.width, frame.height, box.w, box.h, 'contain') : null
  const pts = t ? q.map(t.toBox) : []

  const drawLoupe = useCallback((p: Pt) => {
    const lc = loupeRef.current, src = canvasRef.current
    if (!lc || !src) return
    const ctx = lc.getContext('2d')!
    const k = src.width / frame.width
    const sz = LOUPE / ZOOM
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, LOUPE, LOUPE)
    ctx.drawImage(src, p.x * k - sz / 2, p.y * k - sz / 2, sz, sz, 0, 0, LOUPE, LOUPE)
    ctx.strokeStyle = '#34d399'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(LOUPE / 2, 0); ctx.lineTo(LOUPE / 2, LOUPE)
    ctx.moveTo(0, LOUPE / 2); ctx.lineTo(LOUPE, LOUPE / 2)
    ctx.stroke()
  }, [frame])

  const move = (e: React.PointerEvent, i: number) => {
    if (drag !== i || !t || !boxRef.current) return
    const r = boxRef.current.getBoundingClientRect()
    const p = t.toSrc({ x: e.clientX - r.left, y: e.clientY - r.top })
    const next = clampQuad(q.map((c, j) => (j === i ? p : c)) as Quad, frame.width, frame.height)
    setQ(next)
    drawLoupe(next[i])
  }

  const loupePos = drag !== null && pts[drag]
    ? { left: Math.min(Math.max(pts[drag].x - LOUPE / 2, 4), box.w - LOUPE - 4), top: Math.max(pts[drag].y - LOUPE - 40, 4) }
    : null

  return (
    <div className="absolute inset-0 flex flex-col bg-black text-white">
      <div className="px-4 pt-[max(env(safe-area-inset-top),12px)] pb-2 text-center text-[13px] text-white/80">
        Drag each corner onto the edge of the page
      </div>
      <div ref={boxRef} className="relative flex-1 touch-none select-none overflow-hidden">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-contain" />
        {t && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            <polygon
              points={pts.map(p => `${p.x},${p.y}`).join(' ')}
              fill="rgba(52,211,153,0.15)" stroke="#34d399" strokeWidth={2.5}
            />
          </svg>
        )}
        {pts.map((p, i) => (
          <div
            key={i}
            role="slider"
            aria-label={['Top-left corner', 'Top-right corner', 'Bottom-right corner', 'Bottom-left corner'][i]}
            aria-valuenow={Math.round(q[i].x)}
            className="absolute w-11 h-11 -ml-[22px] -mt-[22px] grid place-items-center"
            style={{ left: p.x, top: p.y }}
            onPointerDown={e => {
              // Capture keeps the drag on this corner when a finger slides off it.
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not capturable: drag still works */ }
              setDrag(i)
              drawLoupe(q[i])
            }}
            onPointerMove={e => move(e, i)}
            onPointerUp={() => setDrag(null)}
            onPointerCancel={() => setDrag(null)}
          >
            <div className={`w-6 h-6 rounded-full border-[3px] border-white shadow ${drag === i ? 'bg-white' : 'bg-blue'}`} />
          </div>
        ))}
        <canvas
          ref={loupeRef}
          width={LOUPE}
          height={LOUPE}
          className="absolute rounded-full border-2 border-white shadow-lg pointer-events-none"
          style={loupePos ? { ...loupePos, width: LOUPE, height: LOUPE } : { display: 'none' }}
        />
      </div>
      <div className="flex gap-2 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),14px)] bg-black">
        <button onClick={onCancel} className="flex-1 h-12 rounded-xl bg-white/15 text-[15px] font-semibold active:bg-white/25">Cancel</button>
        <button onClick={() => onApply(q)} className="flex-1 h-12 rounded-xl bg-blue text-[15px] font-semibold active:opacity-80">Apply</button>
      </div>
    </div>
  )
}
