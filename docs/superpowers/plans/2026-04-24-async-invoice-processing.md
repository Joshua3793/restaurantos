# Async Invoice Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move invoice OCR processing to a true background flow — upload fires and returns immediately, the list polls for completion, and an in-app notification appears when the invoice is ready to review; failed scans surface an ERROR status with retry.

**Architecture:** The upload modal fires `POST /process` without awaiting and navigates back to the invoice list. The invoices page polls every 4s while any PROCESSING sessions exist, detects PROCESSING→REVIEW transitions, and shows a dismissible toast notification. Failed sessions set status=ERROR so the user can retry from the list.

**Tech Stack:** Next.js App Router, Prisma/PostgreSQL, Anthropic SDK (extended thinking), Tailwind CSS, Lucide icons.

---

## File Structure

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `errorMessage String?` to `InvoiceSession` |
| `src/components/invoices/types.ts` | Add `'ERROR'` to `SessionStatus`, add `errorMessage` to `SessionSummary` |
| `src/lib/invoice-ocr.ts` | Higher image resolution (2500px), extended thinking (budget_tokens: 10000), max_tokens: 20000 |
| `src/app/api/invoices/sessions/[id]/process/route.ts` | Wrap in try/catch → set ERROR on failure; allow retry (reset ERROR files to PENDING at start) |
| `src/components/invoices/ProcessingToast.tsx` | New: dismissible in-app toast for "Invoice ready for review" |
| `src/app/invoices/page.tsx` | `onComplete` → no drawer auto-open; add 4s polling when PROCESSING sessions exist; fire toast on transition |
| `src/components/invoices/InvoiceList.tsx` | ERROR badge (red); PROCESSING rows non-clickable; Retry option in ⋯ menu for ERROR rows |
| `src/components/invoices/InvoiceUploadModal.tsx` | Remove loading state for process step (already fire-and-forget; just close modal) |

---

### Task 1: Schema — add errorMessage field

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add errorMessage field**

In `prisma/schema.prisma`, find the `InvoiceSession` model and add the field after `total`:

```prisma
model InvoiceSession {
  id              String            @id @default(uuid())
  status          String            @default("UPLOADING")
  supplierName    String?
  supplierId      String?
  invoiceDate     String?
  invoiceNumber   String?
  subtotal        Decimal?
  tax             Decimal?
  total           Decimal?
  errorMessage    String?           // ← add this line
  ...
```

- [ ] **Step 2: Run migration**

```bash
npx prisma migrate dev --name add-invoice-error-message
```

Expected: Migration created and applied. `prisma generate` runs automatically.

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Clean build, no type errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add errorMessage to InvoiceSession for OCR failure details"
```

---

### Task 2: Types — add ERROR status and errorMessage

**Files:**
- Modify: `src/components/invoices/types.ts`

- [ ] **Step 1: Update SessionStatus and SessionSummary**

In `src/components/invoices/types.ts`, make these two changes:

```typescript
// Line 1 — add ERROR to the union:
export type SessionStatus = 'UPLOADING' | 'PROCESSING' | 'REVIEW' | 'APPROVED' | 'REJECTED' | 'ERROR'
```

In `SessionSummary` (around line 92), add `errorMessage` after `parentSessionId`:

```typescript
export interface SessionSummary {
  id: string
  status: SessionStatus
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  total: string | null
  files: Array<{ id: string; fileName: string; ocrStatus: string }>
  createdAt: string
  _count: {
    scanItems: number
    priceAlerts: number
    recipeAlerts: number
  }
  revenueCenterId?: string | null
  parentSessionId?: string | null
  errorMessage?: string | null     // ← add this
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/components/invoices/types.ts
git commit -m "feat: add ERROR to SessionStatus and errorMessage to SessionSummary"
```

---

### Task 3: OCR quality — extended thinking + higher resolution

**Files:**
- Modify: `src/lib/invoice-ocr.ts`

- [ ] **Step 1: Update constants and compressImageForClaude**

At the top of `src/lib/invoice-ocr.ts`, change the constants:

```typescript
const OCR_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 20000       // must be > budget_tokens
const THINKING_BUDGET = 10000  // extended thinking budget
```

In `compressImageForClaude`, change the resize and quality values:

```typescript
async function compressImageForClaude(
  base64Data: string
): Promise<{ data: string; mediaType: 'image/jpeg' }> {
  const sharp = (await import('sharp')).default
  const inputBuffer = Buffer.from(base64Data, 'base64')

  let quality = 90            // was 85
  let outputBuffer = await sharp(inputBuffer)
    .rotate()
    .resize(2500, 2500, { fit: 'inside', withoutEnlargement: true })  // was 2000
    .jpeg({ quality })
    .toBuffer()

  // Reduce quality until under 4MB — floor raised to 60 (was 40)
  while (outputBuffer.length > 4 * 1024 * 1024 && quality > 60) {
    quality -= 15
    outputBuffer = await sharp(inputBuffer)
      .rotate()
      .resize(2500, 2500, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer()
  }

  // Last resort: shrink to 1800px (was 1400px)
  if (outputBuffer.length > 4 * 1024 * 1024) {
    outputBuffer = await sharp(inputBuffer)
      .rotate()
      .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer()
  }

  return { data: outputBuffer.toString('base64'), mediaType: 'image/jpeg' }
}
```

- [ ] **Step 2: Add extended thinking to extractInvoiceFromImages**

In `extractInvoiceFromImages`, change the `client.messages.create` call to add the `thinking` parameter:

```typescript
  const message = await client.messages.create({
    model: OCR_MODEL,
    max_tokens: MAX_TOKENS,
    thinking: {
      type: 'enabled',
      budget_tokens: THINKING_BUDGET,
    },
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        ...imageBlocks,
        {
          type: 'text',
          text: files.length > 1
            ? `These are ${files.length} pages of the same invoice. Parse all pages together and return one combined JSON object.`
            : 'Parse this invoice and return JSON only.',
        },
      ],
    }],
  })
```

The `text` block filtering in `parseOcrResponse` already ignores non-text blocks, so thinking blocks are safely skipped.

- [ ] **Step 3: Add extended thinking to extractInvoiceFromPdf**

In `extractInvoiceFromPdf`, same change to `client.messages.create`:

```typescript
  const message = await client.messages.create({
    model: OCR_MODEL,
    max_tokens: MAX_TOKENS,
    thinking: {
      type: 'enabled',
      budget_tokens: THINKING_BUDGET,
    },
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } } as any,
        { type: 'text', text: 'Parse this invoice and return JSON only.' },
      ],
    }],
  })
```

- [ ] **Step 4: Add extended thinking to extractInvoiceFromText**

In `extractInvoiceFromText`, same change:

```typescript
  const message = await client.messages.create({
    model: OCR_MODEL,
    max_tokens: MAX_TOKENS,
    thinking: {
      type: 'enabled',
      budget_tokens: THINKING_BUDGET,
    },
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Parse this invoice text and return JSON only.\n\n${text}`,
    }],
  })
```

- [ ] **Step 5: Verify build**

```bash
npm run build
```

Expected: Clean build. The `thinking` parameter is accepted by the SDK as `any` in the options; if there's a type error, cast the options object: `client.messages.create({ ..., thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET } } as any)`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/invoice-ocr.ts
git commit -m "feat: enable extended thinking and higher image resolution for invoice OCR"
```

---

### Task 4: Process route — ERROR handling and retry support

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/process/route.ts`

The route currently always ends with `status: 'REVIEW'`. We need to:
1. Allow retrying ERROR sessions (reset ERROR files to PENDING at the start)
2. Set `status: 'ERROR'` if an unhandled exception occurs during processing

- [ ] **Step 1: Allow ERROR sessions to be retried**

In the `POST` handler, change the initial session status check. Currently it has no status guard. Add this after the `session` is fetched:

```typescript
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  // Allow retrying ERROR sessions by resetting their files
  if (session.status === 'ERROR') {
    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'PROCESSING', errorMessage: null },
    })
    await prisma.invoiceFile.updateMany({
      where: { sessionId: params.id, ocrStatus: { in: ['ERROR', 'PENDING'] } },
      data: { ocrStatus: 'PENDING' },
    })
  }
```

- [ ] **Step 2: Wrap entire processing in try/catch → set ERROR on failure**

Wrap the main processing block (from "Mark all as PROCESSING" through the final `invoiceSession.update`) in a try/catch. Replace the existing body of the handler after the status guard with:

```typescript
  const pendingFiles = session.files.filter(f => f.ocrStatus === 'PENDING')
  if (!pendingFiles.length) {
    // Re-fetch files in case retry just reset them
    const freshFiles = await prisma.invoiceFile.findMany({
      where: { sessionId: params.id, ocrStatus: 'PENDING' },
    })
    if (!freshFiles.length) {
      return NextResponse.json({ error: 'No pending files to process' }, { status: 400 })
    }
  }

  const needsFreshOcr = session.files.some(f => f.ocrStatus === 'PENDING' && !f.ocrRawJson)
  if (needsFreshOcr && !process.env.ANTHROPIC_API_KEY) {
    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'ERROR', errorMessage: 'ANTHROPIC_API_KEY is not configured.' },
    })
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 503 })
  }

  // Re-fetch pending files (may have been reset by retry logic above)
  const filesToProcess = await prisma.invoiceFile.findMany({
    where: { sessionId: params.id, ocrStatus: 'PENDING' },
    select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true, ocrRawJson: true },
  })

  if (!filesToProcess.length) {
    return NextResponse.json({ error: 'No pending files to process' }, { status: 400 })
  }

  try {
    // Mark all as PROCESSING up front
    await prisma.invoiceFile.updateMany({
      where: { id: { in: filesToProcess.map(f => f.id) } },
      data: { ocrStatus: 'PROCESSING' },
    })

    // [rest of existing processing logic — sessionMeta, allOcrItems, imageFiles, nonImgFiles, cachedFiles, matching, final update]
    // The final invoiceSession.update at the end stays as-is (sets status: 'REVIEW')

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[process] Unhandled error:', msg)
    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'ERROR', errorMessage: msg.slice(0, 500) },
    }).catch(() => {}) // ignore — DB might be unreachable
    return NextResponse.json({ error: msg }, { status: 500 })
  }
```

The full handler after the change should look like:

```typescript
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      files: {
        select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true, ocrRawJson: true },
      },
    },
  })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  // Allow retrying ERROR sessions
  if (session.status === 'ERROR') {
    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'PROCESSING', errorMessage: null },
    })
    await prisma.invoiceFile.updateMany({
      where: { sessionId: params.id, ocrStatus: { in: ['ERROR', 'PENDING'] } },
      data: { ocrStatus: 'PENDING' },
    })
  }

  const needsFreshOcr = session.files.some(f => !f.ocrRawJson)
  if (needsFreshOcr && !process.env.ANTHROPIC_API_KEY) {
    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'ERROR', errorMessage: 'ANTHROPIC_API_KEY is not configured.' },
    })
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 503 })
  }

  const filesToProcess = await prisma.invoiceFile.findMany({
    where: { sessionId: params.id, ocrStatus: 'PENDING' },
    select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true, ocrRawJson: true },
  })
  if (!filesToProcess.length) {
    return NextResponse.json({ error: 'No pending files to process' }, { status: 400 })
  }

  try {
    await prisma.invoiceFile.updateMany({
      where: { id: { in: filesToProcess.map(f => f.id) } },
      data: { ocrStatus: 'PROCESSING' },
    })

    const sessionMeta: Partial<OcrResult> = {}
    let allOcrItems: OcrResult['lineItems'] = []

    async function loadBuffer(file: typeof filesToProcess[0]): Promise<Buffer> {
      if (file.fileUrl.startsWith('data:')) {
        const comma = file.fileUrl.indexOf(',')
        return Buffer.from(file.fileUrl.slice(comma + 1), 'base64')
      }
      const res = await fetch(file.fileUrl)
      if (!res.ok) throw new Error(`Failed to fetch ${file.fileName}: ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    }

    const imageFiles  = filesToProcess.filter(f => !f.ocrRawJson && isImage(f.fileType, f.fileName))
    const nonImgFiles = filesToProcess.filter(f => !f.ocrRawJson && !isImage(f.fileType, f.fileName))
    const cachedFiles = filesToProcess.filter(f =>  f.ocrRawJson)

    for (const file of cachedFiles) {
      try {
        const result = JSON.parse(file.ocrRawJson!) as OcrResult
        if (!Array.isArray(result.lineItems)) result.lineItems = []
        mergeResult(result, sessionMeta)
        allOcrItems = [...allOcrItems, ...result.lineItems]
        await prisma.invoiceFile.update({ where: { id: file.id }, data: { ocrStatus: 'COMPLETE' } })
      } catch (err) {
        console.error(`[process] Cached OCR JSON corrupt for ${file.fileName}:`, err)
        await prisma.invoiceFile.update({ where: { id: file.id }, data: { ocrStatus: 'PENDING' } })
      }
    }

    if (imageFiles.length > 0) {
      try {
        console.log(`[process] Sending ${imageFiles.length} image(s) in one Claude call`)
        const imagePayloads = await Promise.all(
          imageFiles.map(async (f) => {
            const buf = await loadBuffer(f)
            const ft  = f.fileType.toLowerCase()
            return {
              base64:    buf.toString('base64'),
              mediaType: (ft === 'image/png' ? 'image/png' : ft === 'image/webp' ? 'image/webp' : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp',
            }
          })
        )
        const result = await extractInvoiceFromImages(imagePayloads)
        mergeResult(result, sessionMeta)
        allOcrItems = [...allOcrItems, ...result.lineItems]
        await prisma.invoiceFile.update({
          where: { id: imageFiles[0].id },
          data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(result) },
        })
        if (imageFiles.length > 1) {
          await prisma.invoiceFile.updateMany({
            where: { id: { in: imageFiles.slice(1).map(f => f.id) } },
            data: { ocrStatus: 'COMPLETE' },
          })
        }
      } catch (err) {
        console.error('[process] Image OCR failed:', err)
        await prisma.invoiceFile.updateMany({
          where: { id: { in: imageFiles.map(f => f.id) } },
          data: { ocrStatus: 'ERROR' },
        })
        throw err  // re-throw so the outer catch sets session to ERROR
      }
    }

    if (nonImgFiles.length > 0) {
      await Promise.all(
        nonImgFiles.map(async (file) => {
          try {
            const buf = await loadBuffer(file)
            const ft  = file.fileType.toLowerCase()
            let result: OcrResult
            if (ft === 'text/csv' || file.fileName.endsWith('.csv')) {
              result = await extractInvoiceFromCsv(buf.toString('utf-8'))
            } else {
              result = await extractInvoiceFromPdf(buf)
            }
            await prisma.invoiceFile.update({
              where: { id: file.id },
              data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(result) },
            })
            mergeResult(result, sessionMeta)
            allOcrItems = [...allOcrItems, ...result.lineItems]
          } catch (err) {
            console.error(`[process] OCR failed for ${file.fileName}:`, err)
            await prisma.invoiceFile.update({ where: { id: file.id }, data: { ocrStatus: 'ERROR' } })
            throw err
          }
        })
      )
    }

    console.log(`[process] Extracted ${allOcrItems.length} items`)

    let matched: Awaited<ReturnType<typeof matchLineItems>> = []
    try {
      matched = await matchLineItems(allOcrItems, session.supplierName)
      await prisma.invoiceScanItem.deleteMany({ where: { sessionId: params.id } })
      if (matched.length > 0) {
        await prisma.invoiceScanItem.createMany({
          data: matched.map((item, i) => ({
            sessionId:          params.id,
            rawDescription:     item.description,
            rawQty:             item.qty ?? null,
            rawUnit:            item.unit ?? null,
            rawUnitPrice:       item.unitPrice ?? null,
            rawLineTotal:       item.lineTotal ?? null,
            matchedItemId:      item.matchedItemId,
            matchConfidence:    item.matchConfidence,
            matchScore:         item.matchScore,
            action:             item.action,
            previousPrice:      item.previousPrice ?? null,
            newPrice:           item.newPrice ?? null,
            priceDiffPct:       item.priceDiffPct ?? null,
            formatMismatch:     item.formatMismatch,
            invoicePackQty:     item.invoicePackQty ?? null,
            invoicePackSize:    item.invoicePackSize ?? null,
            invoicePackUOM:     item.invoicePackUOM ?? null,
            needsFormatConfirm: item.needsFormatConfirm,
            sortOrder:          i,
          })),
        })
      }
    } catch (err) {
      console.error('[process] Matching failed:', err)
    }

    const finalSupplierName = sessionMeta.supplierName ?? session.supplierName
    let autoSupplierId: string | null = null
    if (finalSupplierName) {
      autoSupplierId = await matchSupplierByName(finalSupplierName)
    }

    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: {
        status:        'REVIEW',
        supplierName:  finalSupplierName,
        invoiceDate:   sessionMeta.invoiceDate   ?? session.invoiceDate,
        invoiceNumber: sessionMeta.invoiceNumber ?? session.invoiceNumber,
        subtotal:      sessionMeta.subtotal  ?? null,
        tax:           sessionMeta.tax       ?? null,
        total:         sessionMeta.total     ?? null,
        errorMessage:  null,
        ...(autoSupplierId ? { supplierId: autoSupplierId } : {}),
      },
    })

    const updatedFiles = await prisma.invoiceFile.findMany({
      where: { sessionId: params.id },
      select: { ocrStatus: true },
    })
    const ocrErrorCount = updatedFiles.filter(f => f.ocrStatus === 'ERROR').length

    return NextResponse.json({
      processed: matched.length,
      ocrItemCount: allOcrItems.length,
      ocrErrors: ocrErrorCount,
      status: 'REVIEW',
    })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[process] Unhandled error:', msg)
    await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'ERROR', errorMessage: msg.slice(0, 500) },
    }).catch(() => {})
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add 'src/app/api/invoices/sessions/[id]/process/route.ts'
git commit -m "feat: set ERROR status on OCR failure and support retry on ERROR sessions"
```

---

### Task 5: Upload modal — close immediately after upload

**Files:**
- Modify: `src/components/invoices/InvoiceUploadModal.tsx`
- Modify: `src/app/invoices/page.tsx`

The upload modal already fires process as fire-and-forget. The only change needed is in `page.tsx` where `onComplete` currently opens the drawer (`setSelectedSessionId(newSessionId)`).

- [ ] **Step 1: Change onComplete in page.tsx to not open the drawer**

In `src/app/invoices/page.tsx`, change the `InvoiceUploadModal` `onComplete` handler:

```typescript
      {showUpload && (
        <InvoiceUploadModal
          activeRcId={activeRcId}
          onClose={() => setShowUpload(false)}
          onComplete={() => {
            fetchSessions()
            setShowUpload(false)
            // Do NOT open drawer — session is processing in background
          }}
        />
      )}
```

- [ ] **Step 2: Update InvoiceUploadModal Props type**

The `onComplete` prop currently receives `newSessionId: string`. Since the page no longer needs the ID, keep the prop signature but make it optional by changing the call signature in the modal. In `src/components/invoices/InvoiceUploadModal.tsx`, the `Props` interface:

```typescript
interface Props {
  onClose: () => void
  onComplete: (newSessionId: string) => void  // keep as-is — page just ignores the arg
  activeRcId: string | null
}
```

No change needed in the modal itself — `onComplete(sess.id)` still fires but the page ignores the ID. The type stays compatible.

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/app/invoices/page.tsx
git commit -m "feat: return to invoice list immediately after upload instead of opening drawer"
```

---

### Task 6: ProcessingToast component

**Files:**
- Create: `src/components/invoices/ProcessingToast.tsx`

A small dismissible toast that appears when an invoice transitions to REVIEW. Auto-dismisses after 6 seconds. Has a "Review" button that opens the drawer.

- [ ] **Step 1: Create the component**

```typescript
// src/components/invoices/ProcessingToast.tsx
'use client'
import { useEffect } from 'react'
import { CheckCircle2, X } from 'lucide-react'

interface Props {
  supplierName: string | null
  invoiceNumber: string | null
  onReview: () => void
  onDismiss: () => void
}

export function ProcessingToast({ supplierName, invoiceNumber, onReview, onDismiss }: Props) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [onDismiss])

  const label = supplierName ?? invoiceNumber ?? 'Invoice'

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 sm:left-auto sm:translate-x-0 sm:right-6 sm:bottom-8 z-[70] w-[calc(100vw-32px)] sm:w-80 bg-white border border-gray-200 rounded-2xl shadow-xl flex items-start gap-3 p-4 animate-in slide-in-from-bottom-4 duration-300">
      <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center shrink-0">
        <CheckCircle2 size={16} className="text-green-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">Ready for review</p>
        <button
          onClick={onReview}
          className="mt-2 text-xs font-semibold text-blue-600 hover:text-blue-800"
        >
          Review now →
        </button>
      </div>
      <button onClick={onDismiss} className="text-gray-300 hover:text-gray-500 shrink-0">
        <X size={14} />
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/components/invoices/ProcessingToast.tsx
git commit -m "feat: add ProcessingToast notification for invoice ready-for-review"
```

---

### Task 7: InvoicesPage — polling + toast trigger

**Files:**
- Modify: `src/app/invoices/page.tsx`

Add a 4-second polling interval that activates whenever any session has status PROCESSING. When any session transitions from PROCESSING → REVIEW, show the toast.

- [ ] **Step 1: Add polling and toast state**

Replace the content of `src/app/invoices/page.tsx` with this full implementation:

```typescript
'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { InvoiceKpiStrip } from '@/components/invoices/InvoiceKpiStrip'
import { InvoiceList } from '@/components/invoices/InvoiceList'
import { ProcessingToast } from '@/components/invoices/ProcessingToast'
import { SessionSummary, SessionStatus } from '@/components/invoices/types'
import { useRc } from '@/contexts/RevenueCenterContext'

const InvoiceDrawer = dynamic(
  () => import('@/components/invoices/InvoiceDrawer').then(m => ({ default: m.InvoiceDrawer })),
  { ssr: false, loading: () => null }
)

const InvoiceUploadModal = dynamic(
  () => import('@/components/invoices/InvoiceUploadModal').then(m => ({ default: m.InvoiceUploadModal })),
  { ssr: false, loading: () => null }
)

interface ReadyNotification {
  sessionId: string
  supplierName: string | null
  invoiceNumber: string | null
}

export default function InvoicesPage() {
  const { activeRcId, activeRc } = useRc()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0)
  const [readyNotification, setReadyNotification] = useState<ReadyNotification | null>(null)

  // Track previous statuses to detect PROCESSING → REVIEW transitions
  const prevStatusesRef = useRef<Map<string, SessionStatus>>(new Map())

  const fetchSessions = useCallback(async () => {
    const p = new URLSearchParams()
    if (activeRcId) {
      p.set('rcId', activeRcId)
      if (activeRc?.isDefault) p.set('isDefault', 'true')
    }
    const qs = p.toString()
    const data: SessionSummary[] = await fetch(`/api/invoices/sessions${qs ? `?${qs}` : ''}`).then(r => r.json())

    // Detect PROCESSING → REVIEW transitions
    const prev = prevStatusesRef.current
    for (const s of data) {
      const wasProcessing = prev.get(s.id) === 'PROCESSING'
      if (wasProcessing && s.status === 'REVIEW') {
        setReadyNotification({
          sessionId: s.id,
          supplierName: s.supplierName,
          invoiceNumber: s.invoiceNumber,
        })
      }
    }

    // Update previous statuses map
    const next = new Map<string, SessionStatus>()
    for (const s of data) next.set(s.id, s.status)
    prevStatusesRef.current = next

    setSessions(data)
    return data
  }, [activeRcId, activeRc])

  useEffect(() => { fetchSessions() }, [fetchSessions])

  // Poll every 4s while any session is PROCESSING
  useEffect(() => {
    const hasProcessing = sessions.some(s => s.status === 'PROCESSING')
    if (!hasProcessing) return
    const interval = setInterval(fetchSessions, 4000)
    return () => clearInterval(interval)
  }, [sessions, fetchSessions])

  const handleApproveOrReject = useCallback(() => {
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
  }, [fetchSessions])

  const handleDelete = useCallback(async (id: string, _status: SessionStatus): Promise<void> => {
    await fetch(`/api/invoices/sessions/${id}`, { method: 'DELETE' })
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
    if (selectedSessionId === id) setSelectedSessionId(null)
  }, [selectedSessionId, fetchSessions])

  const handleBulkDelete = useCallback(async (ids: string[]): Promise<void> => {
    await fetch('/api/invoices/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
    if (selectedSessionId && ids.includes(selectedSessionId)) setSelectedSessionId(null)
  }, [selectedSessionId, fetchSessions])

  const handleRetry = useCallback(async (id: string) => {
    fetch(`/api/invoices/sessions/${id}/process`, { method: 'POST' })
      .catch(() => {})
    await fetchSessions()
  }, [fetchSessions])

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="px-4 pt-3 pb-1 sm:pt-4 sm:pb-2 shrink-0">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Invoices</h1>
      </div>
      <InvoiceKpiStrip
        refreshKey={kpiRefreshKey}
        activeRcId={activeRcId}
        isDefault={activeRc?.isDefault ?? false}
      />
      <InvoiceList
        sessions={sessions}
        onSelect={setSelectedSessionId}
        onUploadClick={() => setShowUpload(true)}
        onDelete={handleDelete}
        onBulkDelete={handleBulkDelete}
        onRetry={handleRetry}
      />
      <InvoiceDrawer
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
        onApproveOrReject={handleApproveOrReject}
        allSessions={sessions}
      />
      {showUpload && (
        <InvoiceUploadModal
          activeRcId={activeRcId}
          onClose={() => setShowUpload(false)}
          onComplete={() => {
            fetchSessions()
            setShowUpload(false)
          }}
        />
      )}
      {readyNotification && (
        <ProcessingToast
          supplierName={readyNotification.supplierName}
          invoiceNumber={readyNotification.invoiceNumber}
          onReview={() => {
            setSelectedSessionId(readyNotification.sessionId)
            setReadyNotification(null)
          }}
          onDismiss={() => setReadyNotification(null)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Build will fail because `InvoiceList` doesn't accept `onRetry` yet — that's added in Task 8.

- [ ] **Step 3: Commit after Task 8 passes build**

Wait for Task 8 before committing.

---

### Task 8: InvoiceList — ERROR badge, PROCESSING non-clickable, retry button

**Files:**
- Modify: `src/components/invoices/InvoiceList.tsx`

- [ ] **Step 1: Update Props to accept onRetry**

In `src/components/invoices/InvoiceList.tsx`, add `onRetry` to the `Props` interface:

```typescript
interface Props {
  sessions: SessionSummary[]
  onSelect: (id: string) => void
  onUploadClick: () => void
  onDelete: (id: string, status: SessionStatus) => Promise<void>
  onBulkDelete: (ids: string[]) => Promise<void>
  onRetry: (id: string) => Promise<void>
}
```

And destructure it in the component signature:

```typescript
export function InvoiceList({ sessions, onSelect, onUploadClick, onDelete, onBulkDelete, onRetry }: Props) {
```

- [ ] **Step 2: Update StatusBadge to handle ERROR**

Replace the `StatusBadge` function:

```typescript
function StatusBadge({ status }: { status: SessionStatus }) {
  if (status === 'REVIEW')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">Review</span>
  if (status === 'APPROVED')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">Approved</span>
  if (status === 'REJECTED')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-600">Rejected</span>
  if (status === 'PROCESSING')
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-600 flex items-center gap-1 w-fit">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
        Processing
      </span>
    )
  if (status === 'ERROR')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700">Error</span>
  return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500">Uploading</span>
}
```

- [ ] **Step 3: Make PROCESSING rows non-clickable and add Retry to ERROR ⋯ menu**

In the desktop row, change the `onClick` to guard against PROCESSING:

```typescript
              <div
                className={`hidden sm:grid grid-cols-[28px_1fr_100px_100px_60px_100px_32px] gap-2 px-4 py-2.5 border-b border-gray-100 items-center transition-colors ${
                  s.status === 'PROCESSING' || s.status === 'ERROR'
                    ? 'opacity-70 cursor-default'
                    : isSelected
                      ? 'bg-blue-50 hover:bg-blue-100 cursor-pointer'
                      : s.status === 'REVIEW'
                        ? 'bg-amber-50 hover:bg-amber-100 cursor-pointer'
                        : 'hover:bg-gray-50 cursor-pointer'
                }`}
                onClick={() => {
                  if (s.status !== 'PROCESSING' && s.status !== 'ERROR') onSelect(s.id)
                }}
              >
```

In the desktop ⋯ dropdown menu, add a Retry option for ERROR sessions:

```typescript
                  {openMenu === s.id && (
                    <div className="absolute right-0 top-8 z-10 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[120px]">
                      {s.status === 'ERROR' && (
                        <button
                          onClick={() => { onRetry(s.id); setOpenMenu(null) }}
                          className="w-full px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
                        >Retry scan</button>
                      )}
                      <button
                        onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                        className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                      >Delete</button>
                    </div>
                  )}
```

Apply the same changes (non-clickable, Retry option) to the mobile card:

```typescript
              <div
                className={`sm:hidden flex items-stretch border-b border-gray-100 transition-colors ${
                  s.status === 'PROCESSING' || s.status === 'ERROR'
                    ? 'opacity-70 cursor-default bg-white'
                    : isSelected ? 'bg-blue-50 cursor-pointer' : s.status === 'REVIEW' ? 'bg-amber-50 cursor-pointer' : 'bg-white cursor-pointer'
                }`}
                onClick={() => {
                  if (s.status !== 'PROCESSING' && s.status !== 'ERROR') onSelect(s.id)
                }}
              >
```

And in the mobile ⋯ dropdown:

```typescript
                  {openMenu === s.id && (
                    <div className="absolute right-0 top-9 z-10 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[120px]">
                      {s.status === 'ERROR' && (
                        <button
                          onClick={() => { onRetry(s.id); setOpenMenu(null) }}
                          className="w-full px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
                        >Retry scan</button>
                      )}
                      <button
                        onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                        className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                      >Delete</button>
                    </div>
                  )}
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: Clean build.

- [ ] **Step 5: Commit Tasks 7 and 8 together**

```bash
git add src/app/invoices/page.tsx src/components/invoices/InvoiceList.tsx
git commit -m "feat: async invoice flow — polling, PROCESSING/ERROR states, retry, and ready notification"
```

---

### Task 9: Push to Vercel

- [ ] **Step 1: Final build check**

```bash
npm run build
```

Expected: Clean build, all pages render.

- [ ] **Step 2: Push**

```bash
git push origin main
```

Expected: Vercel deployment triggered.
