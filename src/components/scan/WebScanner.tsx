'use client'
// The browser page scanner — the web counterpart of the phone app's native
// (Apple / Android) document scanner. Full-screen camera with a live page
// outline; auto-snaps once the page is held still for 1 s (switchable, the
// phone remembers); each shot is cropped to the page, flattened and its
// lighting evened out before it is read; a bad shot (blurry, dark, glare, cut
// off, too far) asks for a retake; up to 10 pages, then onDone(files).
//
// Engine: src/lib/doc-scan (OpenCV.js in a worker). If the engine can't load,
// the camera still works — pages are plain photos, no auto-crop.
import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Zap, ZapOff, Camera, ImageIcon, Check, RotateCcw, Crop, Trash2, Plus, Loader2, AlertTriangle, Flashlight } from 'lucide-react'
import { initScanner, detectFrame, processFrame, type ProcessedPage } from '@/lib/doc-scan/client'
import {
  openCamera, closeCamera, setTorch, grabVideoFrame, fileToImageData, pixelsToJpeg,
  CAPTURE_LONG, type CameraHandle,
} from '@/lib/doc-scan/camera'
import { DETECT_LONG, issuesFor, type Issue } from '@/lib/doc-scan/pipeline'
import {
  fitTransform, quadArea, quadDelta, scaleQuad, touchesEdge, insetQuad, type Quad,
} from '@/lib/doc-scan/geometry'
import { CornerEditor } from './CornerEditor'

const HOLD_MS = 1000          // auto-snap after the page is held still this long
const STEADY = 0.02           // max corner movement between looks (share of the frame diagonal)
const MIN_AREA = 0.2          // page must fill at least this much of the view
const MISSES_ALLOWED = 2      // a look or two that loses the page doesn't restart the hold
const DARK = 55               // preview brightness below which we say "too dark"
const AUTO_KEY = 'scanner.autoSnap'

type Phase = 'starting' | 'camera' | 'nocamera' | 'working' | 'review' | 'adjust' | 'pages'
type Hint = 'loading' | 'nopage' | 'far' | 'cutoff' | 'dark' | 'hold' | 'manual' | 'max'

interface Page { id: number; file: File; url: string }
interface Shot {
  frame: ImageData         // the full-resolution original, kept for a corner fix
  quad: Quad               // corners used, in frame pixels
  file: File               // the cleaned page
  url: string
  issues: Issue[]
  dismissed: boolean
}

const HINT_TEXT: Record<Hint, string> = {
  loading: 'Getting auto-crop ready…',
  nopage: 'Point the camera at the invoice',
  far: 'Move closer',
  cutoff: 'Fit the whole page in view',
  dark: 'Too dark — turn on a light',
  hold: 'Hold still…',
  manual: 'Tap the button to snap',
  max: '10 pages — tap Done',
}

const ISSUE_TEXT: Record<Issue, { title: string; body: string }> = {
  blurry: { title: 'This photo is blurry', body: 'Prices on this page may be misread. Hold the phone still and try again.' },
  dark: { title: 'This photo is too dark', body: 'Turn on a light or the flash, then try again.' },
  glare: { title: 'There is glare on the page', body: 'A light is reflecting off the paper. Tilt the phone a little and try again.' },
  cutoff: { title: 'Part of the page may be cut off', body: 'Fit the whole invoice in view, or fix the corners.' },
  far: { title: 'The page is too far away', body: 'Move closer so the invoice fills the screen.' },
  nopage: { title: "Couldn't find the page edges", body: 'Fix the corners by hand, or try again with the invoice on a darker surface.' },
}
const ISSUE_ORDER: Issue[] = ['blurry', 'dark', 'glare', 'cutoff', 'nopage', 'far']

function readAuto(): boolean {
  try { return localStorage.getItem(AUTO_KEY) !== 'off' } catch { return true }
}
function writeAuto(on: boolean) {
  try { localStorage.setItem(AUTO_KEY, on ? 'on' : 'off') } catch { /* private mode */ }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export interface WebScannerProps {
  /** Shown on the no-camera screen, e.g. "Scan invoice". */
  title?: string
  maxPages?: number
  /** Page files are named `${fileStem}_p1.jpg`, … */
  fileStem?: string
  onDone: (files: File[]) => void
  onClose: () => void
}

export function WebScanner({ title = 'Scan invoice', maxPages = 10, fileStem = 'scan', onDone, onClose }: WebScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const polyRef = useRef<SVGPolygonElement>(null)
  const ringRef = useRef<SVGCircleElement>(null)
  const camRef = useRef<CameraHandle | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)

  const [phase, setPhase] = useState<Phase>('starting')
  const [engine, setEngine] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [auto, setAuto] = useState(true)
  const [torch, setTorchState] = useState<{ available: boolean; on: boolean }>({ available: false, on: false })
  const [hint, setHint] = useState<Hint>('loading')
  const [pages, setPages] = useState<Page[]>([])
  const [shot, setShot] = useState<Shot | null>(null)
  const [replaceAt, setReplaceAt] = useState<number | null>(null)
  const [pageMenu, setPageMenu] = useState<number | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [flash, setFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Live state the detection + drawing loops read without re-rendering.
  const live = useRef({
    quad: null as Quad | null,          // in video pixels
    shown: null as Quad | null,         // smoothed outline actually drawn
    good: false,
    steadySince: 0,
    misses: 0,
  })
  const busy = useRef(false)
  const phaseRef = useRef(phase); phaseRef.current = phase
  const autoRef = useRef(auto); autoRef.current = auto
  const pagesRef = useRef(pages); pagesRef.current = pages
  const replaceRef = useRef(replaceAt); replaceRef.current = replaceAt
  const engineRef = useRef(engine); engineRef.current = engine

  const full = pages.length >= maxPages && replaceAt === null

  // ── Engine + auto-snap preference ──────────────────────────────────────────
  useEffect(() => {
    setAuto(readAuto())
    let off = false
    initScanner().then(() => { if (!off) setEngine('ready') }).catch(() => { if (!off) setEngine('failed') })
    return () => { off = true }
  }, [])

  // ── Camera: open on mount, close when hidden or unmounted ──────────────────
  const startCamera = useCallback(async () => {
    const v = videoRef.current
    if (!v || camRef.current) return
    try {
      const h = await openCamera(v)
      camRef.current = h
      setTorchState({ available: h.torch, on: false })
      setPhase(p => (p === 'starting' ? 'camera' : p))
    } catch {
      setPhase(p => (p === 'starting' ? 'nocamera' : p))
    }
  }, [])

  const stopCamera = useCallback(() => {
    closeCamera(camRef.current, videoRef.current)
    camRef.current = null
  }, [])

  useEffect(() => {
    startCamera()
    const onVis = () => {
      if (document.visibilityState === 'hidden') stopCamera()
      else if (phaseRef.current !== 'nocamera') startCamera()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); stopCamera() }
  }, [startCamera, stopCamera])

  // Free page previews on close.
  useEffect(() => () => { pagesRef.current.forEach(p => URL.revokeObjectURL(p.url)) }, [])

  // ── Capture → clean → review ───────────────────────────────────────────────
  const finishShot = useCallback(async (
    frame: ImageData,
    quad: Quad | null,
    opts: { fromUser?: boolean; done?: ProcessedPage; engineOk?: boolean } = {},
  ) => {
    const { fromUser = false, done, engineOk = engineRef.current === 'ready' } = opts
    let file: File, used: Quad, issues: Issue[] = []
    if (engineOk) {
      const r = done ?? await processFrame(frame, quad)
      file = await pixelsToJpeg(r.page.data, r.page.width, r.page.height, 'page.jpg')
      used = r.quad
      issues = issuesFor(r.quality)
      // Corners the cook placed are their call — only warn about the photo itself.
      if (fromUser) issues = issues.filter(i => i === 'blurry' || i === 'dark' || i === 'glare')
    } else {
      file = await pixelsToJpeg(frame.data, frame.width, frame.height, 'page.jpg')
      used = insetQuad(frame.width, frame.height, 0)
    }
    issues.sort((a, b) => ISSUE_ORDER.indexOf(a) - ISSUE_ORDER.indexOf(b))
    setShot(prev => {
      if (prev) URL.revokeObjectURL(prev.url)
      return { frame, quad: used, file, url: URL.createObjectURL(file), issues, dismissed: false }
    })
    setPhase('review')
  }, [])

  // The photo is the frame on screen at the instant of the snap — grabbed
  // before anything else, then the preview freezes on it so the cook can see
  // it is taken and move the phone straight away. (No separate full-sensor
  // still: on Android that takes up to a couple of seconds AFTER the snap, so
  // any movement in that time blurred the page.)
  const capture = useCallback(async () => {
    const v = videoRef.current
    if (busy.current || !v || !camRef.current || phaseRef.current !== 'camera') return
    if (pagesRef.current.length >= maxPages && replaceRef.current === null) return
    const img = grabVideoFrame(v, CAPTURE_LONG)
    if (!img) { setError('Could not take that photo — try again.'); return }
    busy.current = true
    v.pause()
    setFlash(true); setTimeout(() => setFlash(false), 180)
    if (navigator.vibrate) try { navigator.vibrate(20) } catch { /* not allowed */ }
    setPhase('working')
    setError(null)
    try {
      const liveQuad = live.current.good ? live.current.quad : null
      await finishShot(img, liveQuad ? scaleQuad(liveQuad, img.width / v.videoWidth) : null)
    } catch {
      setError('Could not take that photo — try again.')
      setPhase('camera')
    } finally {
      live.current.steadySince = 0
      busy.current = false
    }
  }, [finishShot, maxPages])

  // Back on the camera: un-freeze the preview (restart the camera if it won't).
  useEffect(() => {
    if (phase !== 'camera') return
    const v = videoRef.current
    if (v && v.paused && v.srcObject) {
      v.play().catch(() => { stopCamera(); startCamera() })
    }
  }, [phase, startCamera, stopCamera])

  // ── Live page finder (≈10 looks a second, one at a time) ───────────────────
  useEffect(() => {
    if (phase !== 'camera') return
    let stopped = false
    live.current = { quad: null, shown: null, good: false, steadySince: 0, misses: 0 }
    ;(async () => {
      while (!stopped) {
        const v = videoRef.current
        if (engineRef.current !== 'ready') {
          setHint(engineRef.current === 'failed' ? 'manual' : 'loading')
          await sleep(250)
          continue
        }
        if (pagesRef.current.length >= maxPages && replaceRef.current === null) {
          setHint('max'); live.current.quad = null; await sleep(300); continue
        }
        const f = v ? grabVideoFrame(v, DETECT_LONG) : null
        if (!f || !v) { await sleep(100); continue }
        const fw = f.width, fh = f.height
        let r: { quad: Quad | null; brightness: number } | null = null
        const prevSmall = live.current.quad ? scaleQuad(live.current.quad, fw / v.videoWidth) : null
        try { r = await detectFrame(f, prevSmall) } catch { r = null }
        if (stopped) break
        const L = live.current
        const now = performance.now()
        const q = r?.quad ?? null
        let next: Hint
        if (!q) {
          L.misses++
          if (L.misses > MISSES_ALLOWED) { L.quad = null; L.good = false; L.steadySince = 0 }
          next = r && r.brightness < DARK ? 'dark' : 'nopage'
        } else {
          L.misses = 0
          const vq = scaleQuad(q, v.videoWidth / fw)
          const area = quadArea(q) / (fw * fh)
          const cut = touchesEdge(q, fw, fh)
          const good = area >= MIN_AREA && !cut
          if (good && L.quad && L.good && quadDelta(L.quad, vq, v.videoWidth, v.videoHeight) < STEADY) {
            if (!L.steadySince) L.steadySince = now
          } else {
            L.steadySince = good ? now : 0
          }
          L.quad = vq
          L.good = good
          next = r!.brightness < DARK ? 'dark' : !good ? (cut ? 'cutoff' : 'far') : autoRef.current ? 'hold' : 'manual'
        }
        setHint(next)
        if (autoRef.current && L.good && L.steadySince && now - L.steadySince >= HOLD_MS) {
          stopped = true
          capture()
          break
        }
        await sleep(40)
      }
    })()
    return () => { stopped = true }
  }, [phase, capture, maxPages])

  // ── Smooth outline + hold ring, drawn every frame without re-rendering ─────
  useEffect(() => {
    if (phase !== 'camera') return
    let raf = 0
    const draw = () => {
      const v = videoRef.current, box = boxRef.current, poly = polyRef.current, ring = ringRef.current
      const L = live.current
      if (v && box && poly && v.videoWidth) {
        if (L.quad) {
          L.shown = L.shown
            ? (L.shown.map((p, i) => ({ x: p.x + (L.quad![i].x - p.x) * 0.35, y: p.y + (L.quad![i].y - p.y) * 0.35 })) as Quad)
            : L.quad
          const t = fitTransform(v.videoWidth, v.videoHeight, box.clientWidth, box.clientHeight, 'cover')
          poly.setAttribute('points', L.shown.map(p => { const b = t.toBox(p); return `${b.x},${b.y}` }).join(' '))
          poly.style.opacity = '1'
          poly.style.stroke = L.good ? '#34d399' : '#ffffff'
          poly.style.fill = L.good ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.06)'
        } else {
          L.shown = null
          poly.style.opacity = '0'
        }
      }
      if (ring) {
        const p = autoRef.current && L.good && L.steadySince ? Math.min(1, (performance.now() - L.steadySince) / HOLD_MS) : 0
        ring.style.strokeDashoffset = String(226 * (1 - p))
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [phase])

  // ── Actions ────────────────────────────────────────────────────────────────
  const toggleAuto = () => setAuto(a => { writeAuto(!a); return !a })

  const toggleTorch = async () => {
    if (!camRef.current) return
    const on = await setTorch(camRef.current, !torch.on)
    setTorchState(t => ({ ...t, on }))
  }

  const retake = () => {
    setShot(prev => { if (prev) URL.revokeObjectURL(prev.url); return null })
    setPhase(camRef.current ? 'camera' : 'nocamera')
  }

  const acceptShot = () => {
    if (!shot) return
    const page: Page = { id: Date.now(), file: shot.file, url: shot.url }
    const at = replaceRef.current
    const count = at !== null ? pagesRef.current.length : pagesRef.current.length + 1
    setPages(prev => {
      if (at !== null && prev[at]) {
        URL.revokeObjectURL(prev[at].url)
        return prev.map((p, i) => (i === at ? page : p))
      }
      return [...prev, page]
    })
    setShot(null)
    setReplaceAt(null)
    // Back to the camera for the next page; after a redo, or when full, show the pages.
    setPhase(at !== null || count >= maxPages ? 'pages' : camRef.current ? 'camera' : 'nocamera')
  }

  const applyCorners = async (q: Quad) => {
    if (!shot) return
    setPhase('working')
    try {
      await finishShot(shot.frame, q, { fromUser: true })
    } catch {
      setError('Could not fix the corners — try again.')
      setPhase('review')
    }
  }

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setPhase('working')
    setError(null)
    try {
      const [img, engineOk] = await Promise.all([
        fileToImageData(f),
        initScanner().then(() => true, () => false),
      ])
      await finishShot(img, null, { engineOk })
    } catch {
      setError('Could not open that photo — try another.')
      setPhase(camRef.current ? 'camera' : 'nocamera')
    }
  }

  const deletePage = (i: number) => {
    setPages(prev => {
      const gone = prev[i]
      if (gone) URL.revokeObjectURL(gone.url)
      return prev.filter((_, j) => j !== i)
    })
    setPageMenu(null)
  }

  const redoPage = (i: number) => {
    setReplaceAt(i)
    setPageMenu(null)
    setPhase(camRef.current ? 'camera' : 'nocamera')
  }

  const finish = () => {
    const files = pages.map((p, i) => new File([p.file], `${fileStem}_p${i + 1}.jpg`, { type: 'image/jpeg' }))
    stopCamera()
    onDone(files)
  }

  const requestClose = () => {
    if (pages.length) setConfirmClose(true)
    else { stopCamera(); onClose() }
  }

  const pageLabel = replaceAt !== null ? `Redo page ${replaceAt + 1}` : `Page ${Math.min(pages.length + 1, maxPages)} of up to ${maxPages}`
  const warning = shot && !shot.dismissed && shot.issues.length ? ISSUE_TEXT[shot.issues[0]] : null
  const warnCorners = !!shot?.issues.some(i => i === 'cutoff' || i === 'nopage')

  return (
    <div className="fixed inset-0 z-[80] bg-black text-white select-none" role="dialog" aria-label={title}>
      <input ref={fileInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPickFile} />
      <input ref={libraryInputRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />

      {/* ── Camera (stays mounted so the stream keeps running between pages) ── */}
      <div ref={boxRef} className={`absolute inset-0 ${phase === 'camera' || phase === 'working' || phase === 'starting' ? '' : 'invisible'}`}>
        <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 w-full h-full object-cover" />
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          <polygon ref={polyRef} points="" strokeWidth={3} strokeLinejoin="round" style={{ opacity: 0, transition: 'stroke 150ms, fill 150ms' }} />
        </svg>
        {flash && <div className="absolute inset-0 bg-white/80" />}
      </div>

      {(phase === 'camera' || phase === 'starting') && (
        <>
          <div className="absolute top-0 inset-x-0 flex items-center justify-between gap-2 px-3 pt-[max(env(safe-area-inset-top),12px)] pb-3 bg-gradient-to-b from-black/70 to-transparent">
            <button onClick={requestClose} aria-label="Close scanner" className="h-10 px-3 rounded-full bg-black/50 grid place-items-center"><X size={20} /></button>
            <span className="text-[12.5px] font-medium px-3 py-1.5 rounded-full bg-black/50">{pageLabel}</span>
            <div className="flex items-center gap-2">
              {torch.available && (
                <button onClick={toggleTorch} aria-label={torch.on ? 'Light off' : 'Light on'}
                  className={`h-10 w-10 rounded-full grid place-items-center ${torch.on ? 'bg-white text-black' : 'bg-black/50'}`}>
                  <Flashlight size={17} />
                </button>
              )}
              <button onClick={toggleAuto} disabled={engine === 'failed'} aria-pressed={auto}
                className={`h-10 px-3 rounded-full flex items-center gap-1.5 text-[12.5px] font-semibold disabled:opacity-40 ${auto && engine !== 'failed' ? 'bg-gold text-black' : 'bg-black/50'}`}>
                {auto && engine !== 'failed' ? <Zap size={15} /> : <ZapOff size={15} />} Auto {auto && engine !== 'failed' ? 'on' : 'off'}
              </button>
            </div>
          </div>

          {phase === 'camera' && (
            <div className="absolute inset-x-0 bottom-[150px] flex justify-center pointer-events-none">
              <span className={`text-[14px] font-semibold px-4 py-2 rounded-full ${hint === 'hold' ? 'bg-[#34d399] text-black' : 'bg-black/60'}`}>
                {HINT_TEXT[hint]}
              </span>
            </div>
          )}
          {error && (
            <div className="absolute inset-x-4 top-20 rounded-xl bg-red px-4 py-3 text-[13.5px] font-medium" onClick={() => setError(null)}>{error}</div>
          )}

          <div className="absolute bottom-0 inset-x-0 flex items-center justify-between px-6 pt-4 pb-[max(env(safe-area-inset-bottom),18px)] bg-gradient-to-t from-black/80 to-transparent">
            <button onClick={() => pages.length && setPhase('pages')} aria-label="See pages" className="w-14 h-14 relative">
              {pages.length > 0 ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={pages[pages.length - 1].url} alt="" className="w-12 h-14 object-cover rounded-md border-2 border-white" />
                  <span className="absolute -top-2 -right-1 min-w-[22px] h-[22px] px-1 rounded-full bg-blue text-[12px] font-bold grid place-items-center">{pages.length}</span>
                </>
              ) : <span className="block w-12 h-14 rounded-md border border-white/30" />}
            </button>

            <button onClick={capture} disabled={phase !== 'camera' || full} aria-label="Take photo" className="relative w-[78px] h-[78px] grid place-items-center disabled:opacity-40">
              <svg className="absolute inset-0 -rotate-90" viewBox="0 0 78 78">
                <circle cx="39" cy="39" r="36" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="4" />
                <circle ref={ringRef} cx="39" cy="39" r="36" fill="none" stroke="#34d399" strokeWidth="4"
                  strokeDasharray="226" strokeDashoffset="226" strokeLinecap="round" />
              </svg>
              <span className="w-[60px] h-[60px] rounded-full bg-white active:scale-95 transition-transform" />
            </button>

            <button onClick={finish} disabled={!pages.length || replaceAt !== null}
              className="w-14 h-14 text-[15px] font-semibold disabled:opacity-0">
              Done
            </button>
          </div>
        </>
      )}

      {phase === 'starting' && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="flex items-center gap-2 text-[14px] text-white/80"><Loader2 size={18} className="animate-spin" /> Starting the camera…</div>
        </div>
      )}

      {phase === 'working' && (
        <div className="absolute inset-0 grid place-items-center bg-black/45">
          <div className="flex flex-col items-center gap-2 rounded-2xl bg-black/70 px-6 py-4">
            <span className="text-[15px] font-semibold text-[#34d399]">✓ Photo taken — you can move the phone</span>
            <span className="flex items-center gap-2 text-[13px] text-white/80">
              <Loader2 size={16} className="animate-spin text-gold" /> Cleaning up the page…
            </span>
          </div>
        </div>
      )}

      {/* ── No camera: use the phone's camera app or a saved photo ── */}
      {phase === 'nocamera' && (
        <div className="absolute inset-0 flex flex-col">
          <div className="flex justify-between items-center px-3 pt-[max(env(safe-area-inset-top),12px)] pb-3">
            <button onClick={requestClose} aria-label="Close scanner" className="h-10 w-10 rounded-full bg-white/10 grid place-items-center"><X size={20} /></button>
            <span className="text-[13px] text-white/70">{pages.length ? `${pages.length} page${pages.length > 1 ? 's' : ''}` : ''}</span>
            <span className="w-10" />
          </div>
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center">
            <Camera size={40} className="text-gold" />
            <h2 className="text-[19px] font-semibold">{title}</h2>
            <p className="text-[14px] text-white/70 leading-relaxed">
              The live camera isn&apos;t available here (camera access may be blocked for this site).
              Take a photo instead — it still gets cropped and cleaned up.
            </p>
            {error && <p className="text-[13.5px] text-red">{error}</p>}
            <button onClick={() => fileInputRef.current?.click()} className="mt-2 w-full max-w-xs h-12 rounded-xl bg-gold text-black text-[15px] font-semibold flex items-center justify-center gap-2">
              <Camera size={18} /> Take a photo
            </button>
            <button onClick={() => libraryInputRef.current?.click()} className="w-full max-w-xs h-12 rounded-xl bg-white/15 text-[15px] font-semibold flex items-center justify-center gap-2">
              <ImageIcon size={18} /> Choose a photo
            </button>
            {pages.length > 0 && (
              <button onClick={() => setPhase('pages')} className="text-[14px] underline text-white/80">See {pages.length} page{pages.length > 1 ? 's' : ''}</button>
            )}
          </div>
        </div>
      )}

      {/* ── Review the cleaned page ── */}
      {phase === 'review' && shot && (
        <div className="absolute inset-0 flex flex-col bg-[#111]">
          <div className="flex items-center justify-between px-3 pt-[max(env(safe-area-inset-top),12px)] pb-2">
            <span className="text-[13px] font-medium px-3 py-1.5 rounded-full bg-white/10">{replaceAt !== null ? `Page ${replaceAt + 1}` : `Page ${pages.length + 1}`}</span>
            {engine === 'ready' && (
              <button onClick={() => setPhase('adjust')} className="h-9 px-3 rounded-full bg-white/10 text-[13px] font-medium flex items-center gap-1.5">
                <Crop size={15} /> Fix corners
              </button>
            )}
          </div>
          <div className="relative flex-1 min-h-0 px-4 py-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={shot.url} alt="Scanned page" className="w-full h-full object-contain" />
          </div>
          {error && <p className="px-4 text-[13px] text-red">{error}</p>}
          <div className="flex gap-2 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),14px)]">
            <button onClick={retake} className="flex-1 h-12 rounded-xl bg-white/15 text-[15px] font-semibold flex items-center justify-center gap-1.5 active:bg-white/25">
              <RotateCcw size={16} /> Retake
            </button>
            <button onClick={acceptShot} className="flex-1 h-12 rounded-xl bg-blue text-[15px] font-semibold flex items-center justify-center gap-1.5 active:opacity-80">
              <Check size={17} /> Looks good
            </button>
          </div>

          {warning && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center p-5">
              <div className="w-full max-w-sm rounded-2xl bg-white text-ink p-5 shadow-2xl">
                <div className="flex items-center gap-2 text-[17px] font-semibold"><AlertTriangle size={20} className="text-gold" /> {warning.title}</div>
                <p className="mt-2 text-[14px] text-ink/70 leading-relaxed">{warning.body}</p>
                <button onClick={retake} className="mt-4 w-full h-12 rounded-xl bg-gold text-black text-[15px] font-semibold">Retake</button>
                {warnCorners && engine === 'ready' && (
                  <button onClick={() => { setShot(s => s && { ...s, dismissed: true }); setPhase('adjust') }}
                    className="mt-2 w-full h-12 rounded-xl bg-ink text-white text-[15px] font-semibold">Fix corners</button>
                )}
                <button onClick={() => setShot(s => s && { ...s, dismissed: true })}
                  className="mt-2 w-full h-11 rounded-xl text-[14.5px] font-medium text-ink/70">Use it anyway</button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'adjust' && shot && (
        <CornerEditor frame={shot.frame} quad={shot.quad} onCancel={() => setPhase('review')} onApply={applyCorners} />
      )}

      {/* ── All pages ── */}
      {phase === 'pages' && (
        <div className="absolute inset-0 flex flex-col bg-[#111]">
          <div className="flex items-center justify-between px-3 pt-[max(env(safe-area-inset-top),12px)] pb-2">
            <button onClick={requestClose} aria-label="Close scanner" className="h-10 w-10 rounded-full bg-white/10 grid place-items-center"><X size={20} /></button>
            <span className="text-[13px] font-medium">{pages.length} page{pages.length === 1 ? '' : 's'} · tap a page to redo</span>
            <span className="w-10" />
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 grid grid-cols-2 gap-3 content-start">
            {pages.map((p, i) => (
              <button key={p.id} onClick={() => setPageMenu(i)} className="relative rounded-lg overflow-hidden bg-white aspect-[3/4]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={`Page ${i + 1}`} className="w-full h-full object-contain" />
                <span className="absolute bottom-1.5 right-1.5 min-w-[24px] h-6 px-1.5 rounded-full bg-blue text-white text-[12px] font-bold grid place-items-center">{i + 1}</span>
              </button>
            ))}
            {pages.length < maxPages && (
              <button onClick={() => setPhase(camRef.current ? 'camera' : 'nocamera')}
                className="rounded-lg border-2 border-dashed border-white/30 aspect-[3/4] flex flex-col items-center justify-center gap-1 text-white/70">
                <Plus size={28} /> <span className="text-[13px]">Add page</span>
              </button>
            )}
          </div>
          <div className="px-4 pt-3 pb-[max(env(safe-area-inset-bottom),14px)]">
            <button onClick={finish} disabled={!pages.length}
              className="w-full h-12 rounded-xl bg-blue text-[15px] font-semibold disabled:opacity-40">
              Done · Read {pages.length} page{pages.length === 1 ? '' : 's'}
            </button>
          </div>

          {pageMenu !== null && (
            <div className="absolute inset-0 bg-black/60 flex items-end" onClick={() => setPageMenu(null)}>
              <div className="w-full rounded-t-2xl bg-white text-ink p-4 pb-[max(env(safe-area-inset-bottom),16px)]" onClick={e => e.stopPropagation()}>
                <p className="text-[13px] text-ink/60 text-center mb-3">Page {pageMenu + 1}</p>
                <button onClick={() => redoPage(pageMenu)} className="w-full h-12 rounded-xl bg-ink text-white text-[15px] font-semibold flex items-center justify-center gap-2">
                  <RotateCcw size={16} /> Retake this page
                </button>
                <button onClick={() => deletePage(pageMenu)} className="mt-2 w-full h-12 rounded-xl bg-red/10 text-red text-[15px] font-semibold flex items-center justify-center gap-2">
                  <Trash2 size={16} /> Delete this page
                </button>
                <button onClick={() => setPageMenu(null)} className="mt-2 w-full h-11 text-[14.5px] text-ink/70">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {confirmClose && (
        <div className="absolute inset-0 z-10 bg-black/70 flex items-center justify-center p-5">
          <div className="w-full max-w-sm rounded-2xl bg-white text-ink p-5">
            <p className="text-[17px] font-semibold">Throw away {pages.length} scanned page{pages.length === 1 ? '' : 's'}?</p>
            <p className="mt-1.5 text-[14px] text-ink/70">They haven&apos;t been sent yet.</p>
            <button onClick={() => setConfirmClose(false)} className="mt-4 w-full h-12 rounded-xl bg-ink text-white text-[15px] font-semibold">Keep scanning</button>
            <button onClick={() => { stopCamera(); onClose() }} className="mt-2 w-full h-11 rounded-xl text-red text-[14.5px] font-semibold">Throw away</button>
          </div>
        </div>
      )}
    </div>
  )
}
