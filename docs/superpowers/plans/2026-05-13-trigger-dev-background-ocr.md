# Trigger.dev Background OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move invoice OCR processing from a Vercel serverless function (120s hard limit) into a Trigger.dev background task (up to 10 minutes), so multi-page scans never time out.

**Architecture:** The `/api/invoices/sessions/[id]/process` route shrinks to ~30 lines — it validates the session, resets ERROR state if needed, and calls `processInvoiceTask.trigger()`, returning 202 in under a second. The actual OCR runs on Trigger.dev's infrastructure with no timeout pressure. The frontend already polls for status changes, so no frontend changes are needed.

**Tech Stack:** `@trigger.dev/sdk` v3, Trigger.dev cloud, Next.js 14 App Router, Prisma + Supabase, Anthropic SDK

---

## File Structure

| File | Change |
|------|--------|
| `trigger.config.ts` | **Create** — Trigger.dev project config at repo root |
| `src/trigger/processInvoice.ts` | **Create** — background task containing all OCR logic |
| `src/app/api/invoices/sessions/[id]/process/route.ts` | **Modify** — strip to ~30 lines, just enqueue |
| `.env.local` | **Modify** — add `TRIGGER_SECRET_KEY` |

---

## Task 1: Create Trigger.dev account and project

This task is manual — no code changes. You must complete it before any code will work.

**Files:** none

- [ ] **Step 1: Create a Trigger.dev account**

  Go to https://trigger.dev and sign up (free tier is sufficient).

- [ ] **Step 2: Create a new project**

  In the Trigger.dev dashboard, click **New Project**. Name it `fergie-os` (or anything). Select **Node.js**. Choose the **cloud** option.

- [ ] **Step 3: Copy your project ref**

  After creating the project, go to **Project Settings → General**. Copy the **Project ref** — it looks like `proj_abc123xyz`. You'll need it in Task 2.

- [ ] **Step 4: Get your secret key**

  In the dashboard, go to **API Keys** (left sidebar). Copy the **Secret key** for the `production` environment — it starts with `tr_prod_`. Also copy the `dev` secret key — it starts with `tr_dev_`.

- [ ] **Step 5: Add environment variables to Trigger.dev dashboard**

  In the dashboard, go to **Project Settings → Environment Variables**. Add all three:

  | Name | Value |
  |------|-------|
  | `DATABASE_URL` | `postgresql://postgres.wxwbzvybjbxvcsfoilyy:JosueabeL37DB@aws-1-us-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true` |
  | `DIRECT_URL` | `postgresql://postgres:JosueabeL37DB@db.wxwbzvybjbxvcsfoilyy.supabase.co:5432/postgres` |
  | `ANTHROPIC_API_KEY` | *(copy from your existing .env file)* |

  These let the background task connect to Supabase and call Claude.

---

## Task 2: Install @trigger.dev/sdk and create trigger.config.ts

**Files:**
- Modify: `package.json` (via npm install)
- Create: `trigger.config.ts`
- Modify: `.env.local`

- [ ] **Step 1: Install the SDK**

  ```bash
  cd "/Users/joshua/Desktop/Fergie's OS"
  npm install @trigger.dev/sdk
  ```

  Expected: installs cleanly, `package.json` gets `"@trigger.dev/sdk": "^3.x.x"`.

- [ ] **Step 2: Create trigger.config.ts at the repo root**

  Replace `<your-project-ref>` with the project ref you copied in Task 1 Step 3.

  ```typescript
  // trigger.config.ts
  import { defineConfig } from "@trigger.dev/sdk"

  export default defineConfig({
    project: "<your-project-ref>",
    dirs: ["./src/trigger"],
    maxDuration: 600,
    retries: {
      enabledInDev: false,
      default: {
        maxAttempts: 2,
        minTimeoutInMs: 5000,
        maxTimeoutInMs: 30000,
        factor: 2,
        randomize: false,
      },
    },
    build: {
      external: ["sharp"],
    },
  })
  ```

- [ ] **Step 3: Add TRIGGER_SECRET_KEY to .env.local**

  Open `.env.local` and add at the end:

  ```
  TRIGGER_SECRET_KEY=tr_prod_<your-production-secret-key>
  ```

  For local development using the Trigger.dev dev CLI, also add:
  ```
  TRIGGER_DEV_KEY=tr_dev_<your-dev-secret-key>
  ```

  (You'll use `TRIGGER_SECRET_KEY` in production; when running `trigger.dev dev`, it auto-picks up from the environment.)

- [ ] **Step 4: Add TRIGGER_SECRET_KEY to Vercel**

  In your Vercel dashboard → Project → Settings → Environment Variables, add:
  - `TRIGGER_SECRET_KEY` = `tr_prod_<your-production-secret-key>`

- [ ] **Step 5: Commit**

  ```bash
  git add trigger.config.ts package.json package-lock.json
  git commit -m "feat(invoices): add trigger.dev SDK and config"
  ```

---

## Task 3: Create the processInvoice background task

This file contains all the OCR logic currently in `process/route.ts`. It runs on Trigger.dev's infrastructure with no time limit.

**Files:**
- Create: `src/trigger/processInvoice.ts`

- [ ] **Step 1: Create the src/trigger directory and task file**

  Create `src/trigger/processInvoice.ts` with this complete content:

  ```typescript
  import { task } from "@trigger.dev/sdk/v3"
  import { Prisma } from '@prisma/client'
  import { prisma } from '@/lib/prisma'
  import {
    extractInvoiceFromImages,
    extractInvoiceFromPdf,
    extractInvoiceFromCsv,
    quickExtractMeta,
  } from '@/lib/invoice-ocr'
  import { matchLineItems } from '@/lib/invoice-matcher'
  import { matchSupplierByName } from '@/lib/supplier-matcher'
  import type { OcrResult } from '@/lib/invoice-ocr'

  export const processInvoiceTask = task({
    id: 'process-invoice',
    maxDuration: 600,
    run: async (payload: { sessionId: string }) => {
      const { sessionId } = payload

      const session = await prisma.invoiceSession.findUnique({
        where: { id: sessionId },
        include: {
          files: {
            select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true, ocrRawJson: true },
          },
        },
      })
      if (!session) throw new Error(`Session ${sessionId} not found`)

      const filesToProcess = await prisma.invoiceFile.findMany({
        where: { sessionId, ocrStatus: 'PENDING' },
        select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true, ocrRawJson: true },
      })

      if (!filesToProcess.length) {
        console.log(`[process-invoice] No pending files for session ${sessionId}`)
        return { status: 'no_files' }
      }

      // ── Quick peek: extract supplier/date before full OCR ──────────────────
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const firstFile = filesToProcess[0]
          const buf = await loadBuffer(firstFile)
          const quick = await quickExtractMeta(buf, firstFile.fileType, firstFile.fileName)
          const patch: Record<string, string> = {}
          if (quick.supplierName  && !session.supplierName)  patch.supplierName  = quick.supplierName
          if (quick.invoiceDate   && !session.invoiceDate)   patch.invoiceDate   = quick.invoiceDate
          if (quick.invoiceNumber && !session.invoiceNumber) patch.invoiceNumber = quick.invoiceNumber
          if (Object.keys(patch).length) {
            await prisma.invoiceSession.update({ where: { id: sessionId }, data: patch })
            console.log(`[process-invoice] Quick peek: supplier=${quick.supplierName}, date=${quick.invoiceDate}`)
          }
        } catch (err) {
          console.warn('[process-invoice] Quick peek failed (non-fatal):', err instanceof Error ? err.message : err)
        }
      }

      // ── Learning mode ──────────────────────────────────────────────────────
      const approvedCount = session.supplierName
        ? await prisma.invoiceSession.count({
            where: { supplierName: session.supplierName, status: 'APPROVED', id: { not: sessionId } },
          })
        : 0
      const isLearning = !session.supplierName || approvedCount < 3
      if (isLearning) {
        console.log(`[process-invoice] Learning mode (supplier: ${session.supplierName ?? 'unknown'}, approved: ${approvedCount})`)
      }

      try {
        await prisma.invoiceFile.updateMany({
          where: { id: { in: filesToProcess.map(f => f.id) } },
          data: { ocrStatus: 'PROCESSING' },
        })

        const sessionMeta: Partial<OcrResult> = {}
        let allOcrItems: OcrResult['lineItems'] = []

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
            console.error(`[process-invoice] Cached OCR JSON corrupt for ${file.fileName}:`, err)
            await prisma.invoiceFile.update({ where: { id: file.id }, data: { ocrStatus: 'PENDING' } })
          }
        }

        if (imageFiles.length > 0) {
          try {
            console.log(`[process-invoice] Sending ${imageFiles.length} image(s) to Claude`)
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
            const result = await extractInvoiceFromImages(imagePayloads, session.supplierName, isLearning)
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
            console.error('[process-invoice] Image OCR failed:', err)
            await prisma.invoiceFile.updateMany({
              where: { id: { in: imageFiles.map(f => f.id) } },
              data: { ocrStatus: 'ERROR' },
            })
            throw err
          }
        }

        if (nonImgFiles.length > 0) {
          const results = await Promise.allSettled(
            nonImgFiles.map(async (file) => {
              const buf = await loadBuffer(file)
              const ft  = file.fileType.toLowerCase()
              let result: OcrResult
              if (ft === 'text/csv' || file.fileName.endsWith('.csv')) {
                result = await extractInvoiceFromCsv(buf.toString('utf-8'))
              } else {
                result = await extractInvoiceFromPdf(buf, session.supplierName, isLearning)
              }
              await prisma.invoiceFile.update({
                where: { id: file.id },
                data: { ocrStatus: 'COMPLETE', ocrRawJson: JSON.stringify(result) },
              })
              mergeResult(result, sessionMeta)
              allOcrItems = [...allOcrItems, ...result.lineItems]
            })
          )
          for (const [i, r] of results.entries()) {
            if (r.status === 'rejected') {
              console.error(`[process-invoice] OCR failed for ${nonImgFiles[i].fileName}:`, r.reason)
              await prisma.invoiceFile.update({ where: { id: nonImgFiles[i].id }, data: { ocrStatus: 'ERROR' } })
            }
          }
        }

        console.log(`[process-invoice] Extracted ${allOcrItems.length} items`)

        let matched: Awaited<ReturnType<typeof matchLineItems>> = []
        try {
          matched = await matchLineItems(allOcrItems, session.supplierName)
          await prisma.invoiceScanItem.deleteMany({ where: { sessionId } })
          if (matched.length > 0) {
            await prisma.invoiceScanItem.createMany({
              data: matched.map((item, i) => ({
                sessionId,
                rawDescription:     item.description,
                rawQty:             item.qtyShipped ?? item.qtyOrdered ?? null,
                rawUnit:            item.qtyShippedUOM ?? item.qtyOrderedUOM ?? null,
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
                totalQty:           item.totalQty    ?? null,
                totalQtyUOM:        item.totalQtyUOM ?? null,
                ocrConfidence:      item.confidence       ?? null,
                ocrNotes:           item.confidenceNotes  ?? null,
                pricingMode:        item.pricingMode       ?? null,
                pricingModeSignal:  item.pricingModeSignal ?? null,
                qtyOrdered:         item.qtyOrdered        ?? null,
                qtyOrderedUOM:      item.qtyOrderedUOM     ?? null,
                rate:               item.rate              ?? null,
                rateUOM:            item.rateUOM           ?? null,
                isCatchweight:      item.isCatchweight     ?? false,
                nominalWeight:      item.nominalWeight     ?? null,
                lineCategory:       item.lineCategory      ?? null,
                supplierItemCode:   item.supplierItemCode  ?? null,
                taxFlag:            item.taxFlag           ?? null,
                lineTaxAmount:      item.lineTaxAmount     ?? null,
                bbox:               item.bbox              ?? Prisma.DbNull,
                sortOrder:          i,
              })),
            })
          }
        } catch (err) {
          console.error('[process-invoice] Matching failed:', err)
        }

        const finalSupplierName = sessionMeta.supplierName ?? session.supplierName
        let autoSupplierId: string | null = null
        if (finalSupplierName) {
          autoSupplierId = await matchSupplierByName(finalSupplierName)
        }

        const taxSum = (sessionMeta.gst ?? 0) + (sessionMeta.hst ?? 0) + (sessionMeta.pst ?? 0)
        const taxValue =
          sessionMeta.gst != null || sessionMeta.hst != null || sessionMeta.pst != null
            ? taxSum
            : null

        await prisma.invoiceSession.update({
          where: { id: sessionId },
          data: {
            status:          'REVIEW',
            supplierName:    finalSupplierName,
            invoiceDate:     sessionMeta.invoiceDate   ?? session.invoiceDate,
            invoiceNumber:   sessionMeta.invoiceNumber ?? session.invoiceNumber,
            poNumber:        sessionMeta.poNumber        ?? null,
            subtotal:        sessionMeta.subtotal        ?? null,
            tax:             taxValue,
            discount:        sessionMeta.discount        ?? null,
            fuelSurcharge:   sessionMeta.fuelSurcharge   ?? null,
            freight:         sessionMeta.freight         ?? null,
            minimumOrderFee: sessionMeta.minimumOrderFee ?? null,
            gst:             sessionMeta.gst             ?? null,
            hst:             sessionMeta.hst             ?? null,
            pst:             sessionMeta.pst             ?? null,
            ...(sessionMeta.otherCharges && sessionMeta.otherCharges.length > 0
              ? { otherCharges: sessionMeta.otherCharges }
              : {}),
            total:           sessionMeta.total ?? null,
            errorMessage:    null,
            ...(autoSupplierId ? { supplierId: autoSupplierId } : {}),
          },
        })

        return { processed: matched.length, ocrItemCount: allOcrItems.length }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[process-invoice] Unhandled error:', msg)
        await prisma.invoiceFile.updateMany({
          where: { sessionId, ocrStatus: 'PROCESSING' },
          data: { ocrStatus: 'ERROR' },
        }).catch(() => {})
        await prisma.invoiceSession.update({
          where: { id: sessionId },
          data: { status: 'ERROR', errorMessage: msg.slice(0, 500) },
        }).catch(() => {})
        throw err
      }
    },
  })

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function loadBuffer(file: { fileUrl: string; fileName: string }): Promise<Buffer> {
    if (file.fileUrl.startsWith('data:')) {
      const comma = file.fileUrl.indexOf(',')
      return Buffer.from(file.fileUrl.slice(comma + 1), 'base64')
    }
    const res = await fetch(file.fileUrl)
    if (!res.ok) throw new Error(`Failed to fetch ${file.fileName}: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  function isImage(fileType: string, fileName: string): boolean {
    const ft = fileType.toLowerCase()
    return ft.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(fileName)
  }

  function mergeResult(result: OcrResult, meta: Partial<OcrResult>) {
    if (meta.supplierName    == null && result.supplierName    != null) meta.supplierName    = result.supplierName
    if (meta.invoiceDate     == null && result.invoiceDate     != null) meta.invoiceDate     = result.invoiceDate
    if (meta.invoiceNumber   == null && result.invoiceNumber   != null) meta.invoiceNumber   = result.invoiceNumber
    if (meta.poNumber        == null && result.poNumber        != null) meta.poNumber        = result.poNumber
    if (meta.subtotal        == null && result.subtotal        != null) meta.subtotal        = result.subtotal
    if (meta.discount        == null && result.discount        != null) meta.discount        = result.discount
    if (meta.fuelSurcharge   == null && result.fuelSurcharge   != null) meta.fuelSurcharge   = result.fuelSurcharge
    if (meta.freight         == null && result.freight         != null) meta.freight         = result.freight
    if (meta.minimumOrderFee == null && result.minimumOrderFee != null) meta.minimumOrderFee = result.minimumOrderFee
    if (meta.gst             == null && result.gst             != null) meta.gst             = result.gst
    if (meta.hst             == null && result.hst             != null) meta.hst             = result.hst
    if (meta.pst             == null && result.pst             != null) meta.pst             = result.pst
    if (meta.total           == null && result.total           != null) meta.total           = result.total
  }
  ```

- [ ] **Step 2: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no errors. If you see errors about missing types for `@trigger.dev/sdk/v3`, run `npm install @trigger.dev/sdk` again to confirm it installed.

- [ ] **Step 3: Commit**

  ```bash
  git add src/trigger/processInvoice.ts
  git commit -m "feat(invoices): add processInvoice Trigger.dev background task"
  ```

---

## Task 4: Simplify process/route.ts to just enqueue

The route goes from 363 lines down to ~45. All OCR logic is now in the task file.

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/process/route.ts`

- [ ] **Step 1: Replace the entire contents of process/route.ts**

  ```typescript
  import { NextRequest, NextResponse } from 'next/server'
  import { prisma } from '@/lib/prisma'
  import { processInvoiceTask } from '@/trigger/processInvoice'

  // Short timeout — this route only validates and enqueues, no OCR
  export const maxDuration = 30

  // POST /api/invoices/sessions/[id]/process
  export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
    const session = await prisma.invoiceSession.findUnique({
      where: { id: params.id },
      select: { id: true, status: true },
    })
    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

    // Allow retrying ERROR sessions — reset files to PENDING
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

    await processInvoiceTask.trigger({ sessionId: params.id })

    return NextResponse.json({ ok: true, queued: true }, { status: 202 })
  }

  // DELETE /api/invoices/sessions/[id]/process — cancel processing
  export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
    try {
      await prisma.invoiceFile.updateMany({
        where: { sessionId: params.id, ocrStatus: 'PROCESSING' },
        data: { ocrStatus: 'PENDING' },
      })
      await prisma.invoiceSession.update({
        where: { id: params.id },
        data: { status: 'UPLOADING' },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('P2025')) throw err
    }
    return NextResponse.json({ ok: true })
  }
  ```

- [ ] **Step 2: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add src/app/api/invoices/sessions/[id]/process/route.ts
  git commit -m "feat(invoices): offload OCR to Trigger.dev background task"
  ```

---

## Task 5: Deploy the Trigger.dev worker

Trigger.dev tasks must be deployed to their cloud before they'll run in production. This is separate from your Vercel deploy.

**Files:** none (deploy command only)

- [ ] **Step 1: Log in to Trigger.dev CLI**

  ```bash
  npx trigger.dev@latest login
  ```

  This opens a browser window. Log in with the same account you used in Task 1.

- [ ] **Step 2: Deploy the task**

  ```bash
  npx trigger.dev@latest deploy
  ```

  Expected output ends with something like:
  ```
  ✓ Deployed process-invoice to production
  Version: 20260513.1
  ```

  If it asks which project, select the one you created in Task 1.

- [ ] **Step 3: Verify the task appears in the dashboard**

  Go to your Trigger.dev dashboard → **Tasks**. You should see `process-invoice` listed with status **Active**.

- [ ] **Step 4: Push to Vercel**

  ```bash
  git push origin main
  ```

  Vercel picks up the new `process/route.ts` (which now just calls `processInvoiceTask.trigger()`).

---

## Task 6: Verify end-to-end

- [ ] **Step 1: Scan a single-page invoice on the phone**

  Use the scan button in the app. Watch the invoice list — it should move from UPLOADING → PROCESSING immediately (that part is unchanged). After 30–90 seconds (depending on image complexity), it should flip to REVIEW.

- [ ] **Step 2: Check the Trigger.dev dashboard for the run**

  Go to Trigger.dev dashboard → **Runs**. You should see a run for `process-invoice` that completed successfully, with duration shown (e.g., "45s").

- [ ] **Step 3: Scan a 3-page invoice**

  This was the failing case. It should now complete without getting stuck in PROCESSING. Expect 2–4 minutes in learning mode.

- [ ] **Step 4: Verify retry works for ERROR sessions**

  If a session is in ERROR state, tap Retry in the app. The process route resets the session to PROCESSING and enqueues a new task run. Confirm the session moves to REVIEW.

---

## Local development note

When developing locally, the Trigger.dev task won't run on their cloud — it'll run in a local dev worker you start in a separate terminal:

```bash
npx trigger.dev@latest dev
```

This connects your local task code to Trigger.dev's cloud infrastructure so tasks triggered from your local Next.js dev server execute locally (with full console output). Stop it with Ctrl+C when done.
