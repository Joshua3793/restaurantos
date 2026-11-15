'use client'
// Page-side handle on the scanner worker: one shared worker per tab, started
// on demand (or early via preloadScanner() so the ~11 MB engine is cached by
// the time a cook taps Scan). Each call is a promise matched by id.
import type { Quad } from './geometry'
import type { Quality, RGBAImage } from './pipeline'
import type { WorkerRequest, WorkerResponse } from './protocol'

const ENGINE_URL = '/vendor/opencv.js'

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }

let worker: Worker | null = null
let ready: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./scan.worker.ts', import.meta.url))
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const p = pending.get(ev.data.id)
    if (!p) return
    pending.delete(ev.data.id)
    if (ev.data.type === 'error') p.reject(new Error(ev.data.message))
    else p.resolve(ev.data)
  }
  worker.onerror = (ev) => {
    // A crashed worker fails everything in flight; the next call starts a fresh one.
    const err = new Error(ev.message || 'scanner stopped')
    pending.forEach(p => p.reject(err))
    pending.clear()
    worker?.terminate()
    worker = null
    ready = null
  }
  return worker
}

function call(req: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    pending.set(req.id, { resolve, reject })
    getWorker().postMessage(req, transfer)
  })
}

/** Load the page finder (once). Rejects if it can't load — the camera then works without auto-crop. */
export function initScanner(): Promise<void> {
  if (!ready) {
    ready = call({ type: 'init', id: nextId++, engineUrl: ENGINE_URL }).then(() => undefined)
    ready.catch(() => { ready = null })
  }
  return ready
}

/** Start loading the engine in the background; never throws. */
export function preloadScanner(): void {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return
  initScanner().catch(() => {})
}

/**
 * Find the page in a small preview frame. `prev` is the last page found on a
 * frame of the same size (keeps the outline steady). The frame's buffer is
 * transferred (unusable after).
 */
export async function detectFrame(img: ImageData, prev: Quad | null = null): Promise<{ quad: Quad | null; brightness: number }> {
  const buffer = img.data.buffer as ArrayBuffer
  const r = await call({ type: 'detect', id: nextId++, width: img.width, height: img.height, buffer, prev }, [buffer])
  if (r.type !== 'detected') throw new Error('unexpected reply')
  return { quad: r.quad, brightness: r.brightness }
}

export interface ProcessedPage { page: RGBAImage; quad: Quad; quality: Quality }

/**
 * Flatten + clean a full-resolution capture. Pass `quad` to use the cook's
 * corners instead of finding the page. The image's buffer is COPIED (the
 * caller keeps the original for a later corner fix).
 */
export async function processFrame(img: ImageData, quad: Quad | null): Promise<ProcessedPage> {
  const copy = img.data.slice().buffer as ArrayBuffer
  const r = await call({ type: 'process', id: nextId++, width: img.width, height: img.height, buffer: copy, quad }, [copy])
  if (r.type !== 'processed') throw new Error('unexpected reply')
  return {
    page: { width: r.width, height: r.height, data: new Uint8ClampedArray(r.buffer) },
    quad: r.quad,
    quality: r.quality,
  }
}
