// Messages between the page (src/lib/doc-scan/client.ts) and the scanner
// worker (scan.worker.ts). Pixel buffers travel as transferred ArrayBuffers —
// zero-copy, so a 12 MP frame costs nothing to hand over.
import type { Quad } from './geometry'
import type { Quality } from './pipeline'

export type WorkerRequest =
  | { type: 'init'; id: number; engineUrl: string }
  | { type: 'detect'; id: number; width: number; height: number; buffer: ArrayBuffer; prev: Quad | null }
  | { type: 'process'; id: number; width: number; height: number; buffer: ArrayBuffer; quad: Quad | null }

export type WorkerResponse =
  | { type: 'ready'; id: number }
  | { type: 'detected'; id: number; quad: Quad | null; brightness: number }
  | {
      type: 'processed'; id: number
      width: number; height: number; buffer: ArrayBuffer
      quad: Quad; quality: Quality
    }
  | { type: 'error'; id: number; message: string }
