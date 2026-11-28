'use client'
// Full-screen camera that reads one product barcode (EAN-13 / EAN-8 / UPC-A /
// UPC-E / Code 128) and hands it back: onResult(code). Reads continuously; on a
// read it buzzes (where the phone can), stops the camera and returns.
//
// Decoder: the browser's own BarcodeDetector when it has one (Chrome on
// Android), otherwise ZXing — loaded only when this sheet opens, never in the
// page bundle. Works in the phone app's web view too (getUserMedia).
//
// No camera, or camera refused → a plain message and a "type the code" box.
// The camera is always released on close and on unmount.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Flashlight, Keyboard, Loader2, CameraOff } from 'lucide-react'
import { useBackDismiss } from '@/lib/back-stack'
import { normalizeBarcode } from '@/lib/barcode'

type Phase = 'starting' | 'scanning' | 'denied' | 'nocamera'

/** One look at a frame → the code read, or null. */
type Decode = (canvas: HTMLCanvasElement) => Promise<{ code: string; checked: boolean } | null>

const LOOK_MS = 140          // time between looks at the camera
const CROP_W = 0.9           // share of the frame width read (barcodes run across)
const CROP_H = 0.55          // share of the frame height read
const MAX_W = 1280           // frames are scaled down to this before decoding

// Formats with a check digit are trusted on the first read; Code 128 has a
// checksum too but short partial reads happen, so it must read the same twice.
const CHECKED = new Set(['ean_13', 'ean_8', 'upc_a', 'upc_e'])

interface NativeDetector { detect(src: CanvasImageSource): Promise<{ rawValue: string; format: string }[]> }
interface NativeDetectorCtor {
  new (opts: { formats: string[] }): NativeDetector
  getSupportedFormats?: () => Promise<string[]>
}

async function makeDecoder(): Promise<Decode> {
  const Native = (globalThis as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector
  if (Native) {
    try {
      const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']
      const have = (await Native.getSupportedFormats?.()) ?? want
      const formats = want.filter(f => have.includes(f))
      if (formats.length >= 4) {
        const det = new Native({ formats })
        return async canvas => {
          const hits = await det.detect(canvas)
          const hit = hits.find(h => h.rawValue)
          return hit ? { code: hit.rawValue, checked: CHECKED.has(hit.format) } : null
        }
      }
    } catch { /* fall through to ZXing */ }
  }
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library'),
  ])
  const hints = new Map<unknown, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128,
    ]],
    [DecodeHintType.TRY_HARDER, true],
  ])
  const reader = new BrowserMultiFormatReader(hints as Map<never, unknown>)
  return async canvas => {
    try {
      const r = reader.decodeFromCanvas(canvas)
      const f = r.getBarcodeFormat()
      return { code: r.getText(), checked: f !== BarcodeFormat.CODE_128 }
    } catch {
      return null // NotFound on most frames — expected
    }
  }
}

export function BarcodeScanSheet({
  open, onClose, onResult, title = 'Scan a barcode',
}: {
  open: boolean
  onClose: () => void
  onResult: (code: string) => void
  title?: string
}) {
  useBackDismiss(open, onClose)
  if (!open || typeof document === 'undefined') return null
  return createPortal(<ScanView onClose={onClose} onResult={onResult} title={title} />, document.body)
}

function ScanView({ onClose, onResult, title }: { onClose: () => void; onResult: (code: string) => void; title: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const doneRef = useRef(false)
  const [phase, setPhase] = useState<Phase>('starting')
  const [torchAble, setTorchAble] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')
  const [typedError, setTypedError] = useState<string | null>(null)

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    trackRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  // The caller's onResult may be a fresh function every render; keep the
  // latest in a ref so the camera effect below starts exactly once per open.
  const onResultRef = useRef(onResult)
  useEffect(() => { onResultRef.current = onResult }, [onResult])

  const finish = useCallback((code: string) => {
    if (doneRef.current) return
    doneRef.current = true
    try { navigator.vibrate?.(60) } catch { /* not on iPhone */ }
    stopCamera()
    onResultRef.current(code)
  }, [stopCamera])

  // Escape closes the scanner only, not the sheet underneath it: a window
  // capture listener runs before the document listeners those sheets use.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setPhase('nocamera'); return }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        })
      } catch (e) {
        const name = (e as DOMException)?.name
        if (cancelled) return
        if (name === 'NotAllowedError' || name === 'SecurityError') { setPhase('denied'); return }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true })
        } catch (e2) {
          if (cancelled) return
          const n2 = (e2 as DOMException)?.name
          setPhase(n2 === 'NotAllowedError' || n2 === 'SecurityError' ? 'denied' : 'nocamera')
          return
        }
      }
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
      streamRef.current = stream
      const track = stream.getVideoTracks()[0] ?? null
      trackRef.current = track
      try {
        const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] }
        setTorchAble(!!caps.torch)
        if (caps.focusMode?.includes('continuous')) {
          await track!.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
        }
      } catch { /* nice-to-haves */ }

      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      video.setAttribute('playsinline', 'true')
      video.muted = true
      await video.play().catch(() => {})
      if (cancelled) return
      setPhase('scanning')

      let decode: Decode
      try { decode = await makeDecoder() }
      catch { stopCamera(); if (!cancelled) setPhase('nocamera'); return }

      let last: string | null = null
      const look = async () => {
        if (cancelled || doneRef.current) return
        const w = video.videoWidth, h = video.videoHeight
        if (w && h && ctx) {
          const sw = Math.round(w * CROP_W), sh = Math.round(h * CROP_H)
          const k = Math.min(1, MAX_W / sw)
          canvas.width = Math.round(sw * k)
          canvas.height = Math.round(sh * k)
          ctx.drawImage(video, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height)
          try {
            const hit = await decode(canvas)
            const code = hit ? normalizeBarcode(hit.code) : null
            if (code && hit) {
              if (hit.checked || code === last) { finish(code); return }
              last = code
            }
          } catch { /* one bad frame is fine */ }
        }
        if (!cancelled && !doneRef.current) timer = setTimeout(look, LOOK_MS)
      }
      void look()
    }
    void start()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      stopCamera()
      canvas.width = canvas.height = 0
    }
    // finish and stopCamera are stable (refs only): one getUserMedia per open.
  }, [finish, stopCamera])

  const toggleTorch = async () => {
    const t = trackRef.current
    if (!t) return
    try {
      await t.applyConstraints({ advanced: [{ torch: !torchOn } as MediaTrackConstraintSet] })
      setTorchOn(v => !v)
    } catch { setTorchAble(false) }
  }

  const submitTyped = () => {
    const code = normalizeBarcode(typed)
    if (!code) { setTypedError('A barcode is 6 to 32 letters or numbers.'); return }
    finish(code)
  }

  const noCamera = phase === 'denied' || phase === 'nocamera'
  const showTyping = typing || noCamera

  return (
    <div className="fixed inset-0 z-[100] bg-black text-white select-none flex flex-col" role="dialog" aria-label={title}>
      {/* Top bar */}
      <div className="relative z-10 flex items-center justify-between px-2" style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 8px)' }}>
        <button onClick={onClose} aria-label="Close scanner" className="w-11 h-11 grid place-items-center rounded-full bg-black/40">
          <X size={22} />
        </button>
        <div className="text-[16px] font-semibold">{title}</div>
        {torchAble && phase === 'scanning' ? (
          <button
            onClick={toggleTorch}
            aria-label={torchOn ? 'Turn light off' : 'Turn light on'}
            aria-pressed={torchOn}
            className={`w-11 h-11 grid place-items-center rounded-full ${torchOn ? 'bg-gold text-ink' : 'bg-black/40'}`}
          >
            <Flashlight size={20} />
          </button>
        ) : <span className="w-11 h-11" />}
      </div>

      {/* Camera */}
      <div className="absolute inset-0">
        <video ref={videoRef} className={`w-full h-full object-cover ${noCamera ? 'hidden' : ''}`} playsInline muted />
        {phase === 'scanning' && !showTyping && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="relative w-[82%] max-w-[420px] aspect-[2/1] rounded-2xl border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
              <div className="absolute left-3 right-3 top-1/2 h-0.5 bg-red/80" />
            </div>
          </div>
        )}
        {phase === 'starting' && (
          <div className="absolute inset-0 grid place-items-center">
            <Loader2 size={28} className="animate-spin text-white/80" />
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* Bottom: hint, or the type-the-code box */}
      <div className="relative z-10 px-4" style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 16px)' }}>
        {noCamera && (
          <div className="mb-4 rounded-2xl bg-white/10 p-4 text-[16px] leading-snug">
            <div className="flex items-center gap-2 font-semibold mb-1"><CameraOff size={18} />
              {phase === 'denied' ? 'The camera is blocked' : 'No camera here'}
            </div>
            {phase === 'denied'
              ? 'Allow the camera for this app in your phone’s settings, or type the number under the barcode below.'
              : 'This device has no camera we can use. Type the number under the barcode below.'}
          </div>
        )}
        {showTyping ? (
          <form
            className="rounded-2xl bg-paper text-ink p-3 flex flex-col gap-2"
            onSubmit={e => { e.preventDefault(); submitTyped() }}
          >
            <label className="text-[14px] text-ink-3" htmlFor="barcode-typed">The number under the barcode</label>
            <div className="flex gap-2">
              <input
                id="barcode-typed"
                value={typed}
                onChange={e => { setTyped(e.target.value); setTypedError(null) }}
                inputMode="numeric"
                autoComplete="off"
                autoFocus={!noCamera}
                enterKeyHint="go"
                placeholder="e.g. 0012345678905"
                className="flex-1 min-w-0 h-11 px-3 rounded-[10px] border border-line bg-paper text-[16px] focus:outline-none focus:border-ink-3"
              />
              <button type="submit" className="h-11 px-4 rounded-[10px] bg-ink text-paper text-[16px] font-semibold">Find</button>
            </div>
            {typedError && <div className="text-[14px] text-red-text">{typedError}</div>}
          </form>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="text-[16px] text-white/90 text-center">Hold the barcode inside the box</div>
            <button
              onClick={() => setTyping(true)}
              className="h-11 px-4 rounded-full bg-white/15 text-[16px] flex items-center gap-2"
            >
              <Keyboard size={18} /> Type the code instead
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
