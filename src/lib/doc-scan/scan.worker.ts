/// <reference lib="webworker" />
// The page scanner's worker: loads OpenCV.js once, then finds pages in live
// preview frames and flattens + cleans captured pages — all off the main
// thread, so the camera preview never stutters. See pipeline.ts for the maths.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { findPage, processPage, frameBrightness } from './pipeline'
import type { WorkerRequest, WorkerResponse } from './protocol'

declare const self: DedicatedWorkerGlobalScope & { cv?: any }

let cv: any = null
let loading: Promise<void> | null = null

function load(engineUrl: string): Promise<void> {
  if (cv) return Promise.resolve()
  if (loading) return loading
  loading = new Promise<void>((resolve, reject) => {
    try {
      self.importScripts(engineUrl)
      const mod = self.cv
      if (!mod) throw new Error('page finder did not load')
      if (mod.Mat) { cv = mod; resolve(); return }
      // The module is a thenable that resolves to itself; strip `then` so it
      // can be held without promise machinery recursing into it.
      mod.then((c: any) => { delete c.then; cv = c; resolve() })
    } catch (e) {
      loading = null
      reject(e)
    }
  })
  return loading
}

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer)
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  try {
    if (msg.type === 'init') {
      await load(msg.engineUrl)
      post({ type: 'ready', id: msg.id })
      return
    }
    if (!cv) throw new Error('page finder not ready')
    const img = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer) }
    if (msg.type === 'detect') {
      post({ type: 'detected', id: msg.id, quad: findPage(cv, img, undefined, msg.prev), brightness: frameBrightness(img) })
      return
    }
    if (msg.type === 'process') {
      const r = processPage(cv, img, msg.quad)
      const buf = r.page.data.buffer as ArrayBuffer
      post({
        type: 'processed', id: msg.id,
        width: r.page.width, height: r.page.height, buffer: buf,
        quad: r.quad, quality: r.quality,
      }, [buf])
    }
  } catch (e) {
    post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) })
  }
}
