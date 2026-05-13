# Capacitor Invoice Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native document scanner (iOS VNDocumentCameraViewController / Android ML Kit) to the invoice flow by wrapping the existing Next.js app in a Capacitor shell, with zero backend changes.

**Architecture:** Capacitor shell in `/mobile/` loads the production Vercel URL in a WKWebView/WebView. The native scanner plugin bridges to JavaScript via `@capacitor/core`. On scan, pages are merged into a single PDF client-side using `pdf-lib` and posted to the existing upload endpoint. The scan button renders `null` when not running in a native Capacitor context, so desktop web users never see it.

**Tech Stack:** Capacitor 6, `capacitor-document-scanner` (websitebeaver), `pdf-lib`, `@capacitor/core`, existing UploadThing + local-fallback upload pipeline, Next.js 14 App Router.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `src/lib/capacitor.ts` | `isNative()` guard + `scanDocument()` wrapper |
| Create | `src/hooks/useNativeScan.ts` | Full scan-to-upload state machine hook |
| Modify | `src/components/invoices/InvoiceList.tsx` | Add optional `onScanClick` prop + camera button |
| Modify | `src/app/invoices/page.tsx` | Wire `useNativeScan` → `onScanClick` prop |
| Create | `mobile/package.json` | Capacitor CLI + platform deps |
| Create | `mobile/capacitor.config.ts` | App ID, name, Vercel server URL |
| Run | `npx cap add ios` (in `mobile/`) | Generate Xcode project |
| Run | `npx cap add android` (in `mobile/`) | Generate Android Studio project |

---

## Task 1: Install root dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install pdf-lib, @capacitor/core, and capacitor-document-scanner into the root package**

Run from the repo root:
```bash
npm install pdf-lib @capacitor/core capacitor-document-scanner
```

Expected: `package.json` dependencies section gains `pdf-lib`, `@capacitor/core`, `capacitor-document-scanner`.

- [ ] **Step 2: Verify the build still passes**

```bash
npm run build
```

Expected: exits 0, no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(scanner): install pdf-lib, @capacitor/core, capacitor-document-scanner"
```

---

## Task 2: Create `src/lib/capacitor.ts`

**Files:**
- Create: `src/lib/capacitor.ts`

- [ ] **Step 1: Create the file**

```ts
// src/lib/capacitor.ts
'use client'

export function isNative(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as any).Capacitor?.isNativePlatform()
}

// Returns base64-encoded JPEG strings, one per scanned page.
// Only call this when isNative() is true.
export async function scanDocument(): Promise<string[]> {
  const { DocumentScanner, ResponseType } = await import('capacitor-document-scanner')
  const result = await DocumentScanner.scanDocument({
    responseType: ResponseType.Base64,
    maxNumDocuments: 10,
  })
  return result.scannedImages ?? []
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/capacitor.ts
git commit -m "feat(scanner): add capacitor.ts with isNative + scanDocument helpers"
```

---

## Task 3: Create `src/hooks/useNativeScan.ts`

This hook encapsulates the entire scan → PDF merge → upload → process flow, mirroring the logic in `InvoiceUploadModal.tsx`.

**Files:**
- Create: `src/hooks/useNativeScan.ts`

- [ ] **Step 1: Create the hook**

```ts
// src/hooks/useNativeScan.ts
'use client'

import { useState, useRef } from 'react'
import { scanDocument } from '@/lib/capacitor'
import { useUploadThing } from '@/lib/uploadthing-client'

interface Options {
  activeRcId: string | null
  onComplete: (sessionId: string) => void
}

// Converts a base64 JPEG string (no data-URI prefix) to Uint8Array.
async function base64ToUint8Array(b64: string): Promise<Uint8Array> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Merges an array of base64 JPEG strings into a single PDF Blob.
async function mergePagesToPdf(base64Images: string[]): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  for (const raw of base64Images) {
    // Strip data URI prefix if the plugin includes it
    const b64 = raw.replace(/^data:image\/[^;]+;base64,/, '')
    const bytes = await base64ToUint8Array(b64)
    const image = await doc.embedJpg(bytes)
    const page = doc.addPage([image.width, image.height])
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  }
  const pdfBytes = await doc.save()
  return new Blob([pdfBytes], { type: 'application/pdf' })
}

export function useNativeScan({ activeRcId, onComplete }: Options) {
  const [isScanning, setIsScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const utErrorRef = useRef<string | null>(null)

  const { startUpload } = useUploadThing('invoiceUploader', {
    onUploadError: (err) => { utErrorRef.current = err.message ?? 'Upload error' },
  })

  const triggerScan = async () => {
    setIsScanning(true)
    setScanError(null)
    utErrorRef.current = null

    try {
      // 1. Open native scanner
      const pages = await scanDocument()
      if (!pages.length) { setIsScanning(false); return }

      // 2. Merge pages into a single PDF
      const pdfBlob = await mergePagesToPdf(pages)
      const pdfFile = new File([pdfBlob], `scan_${Date.now()}.pdf`, {
        type: 'application/pdf',
      })

      // 3. Create session
      const sessRes = await fetch('/api/invoices/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: activeRcId }),
      })
      if (!sessRes.ok) {
        setScanError(`Failed to create session (${sessRes.status}). Please try again.`)
        return
      }
      const sess = await sessRes.json()

      // 4a. Try UploadThing CDN (8 s timeout, same as InvoiceUploadModal)
      let uploadOk = false
      try {
        const uploaded = await Promise.race([
          startUpload([pdfFile]),
          new Promise<null>((_, rej) =>
            setTimeout(() => rej(new Error('Cloud upload timed out')), 8_000)
          ),
        ])
        if (uploaded?.length) {
          const regRes = await fetch(`/api/invoices/sessions/${sess.id}/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              files: uploaded.map(f => ({
                url: (f as any).ufsUrl ?? f.url,
                fileName: f.name,
                fileType: 'application/pdf',
              })),
            }),
          })
          if (regRes.ok) uploadOk = true
        }
      } catch {
        // fall through to local
      }

      // 4b. Local fallback (same as InvoiceUploadModal)
      if (!uploadOk) {
        const fd = new FormData()
        fd.append('files', pdfFile)
        const localRes = await fetch(`/api/invoices/sessions/${sess.id}/upload-local`, {
          method: 'POST',
          body: fd,
        })
        if (localRes.ok) {
          uploadOk = true
        } else {
          const body = await localRes.json().catch(() => ({}))
          setScanError(body.error ?? `Upload failed (${localRes.status}).`)
          return
        }
      }

      // 5. Kick off OCR (fire-and-forget; drawer polls for status)
      fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' }).catch(() => {})

      // 6. Notify parent
      onComplete(sess.id)
    } catch (err) {
      setScanError(`Scan error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsScanning(false)
    }
  }

  const clearError = () => setScanError(null)

  return { triggerScan, isScanning, scanError, clearError }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useNativeScan.ts
git commit -m "feat(scanner): add useNativeScan hook (scan → PDF merge → upload → process)"
```

---

## Task 4: Add native scan button to InvoiceList

The existing `Props` interface gets one new optional field. When `onScanClick` is provided, a camera icon button renders next to the existing "+ Scan Invoice" upload button.

**Files:**
- Modify: `src/components/invoices/InvoiceList.tsx:26-32` (Props), `src/components/invoices/InvoiceList.tsx:241-246` (toolbar)

- [ ] **Step 1: Add `onScanClick` to the Props interface**

Find this block in `InvoiceList.tsx`:
```ts
interface Props {
  sessions: SessionSummary[]
  onSelect: (id: string) => void
  onUploadClick: () => void
  onDelete: (id: string, status: SessionStatus) => Promise<void>
  onBulkDelete: (ids: string[]) => Promise<void>
  onRetry: (id: string) => Promise<void>
}
```

Replace with:
```ts
interface Props {
  sessions: SessionSummary[]
  onSelect: (id: string) => void
  onUploadClick: () => void
  onScanClick?: () => void
  onDelete: (id: string, status: SessionStatus) => Promise<void>
  onBulkDelete: (ids: string[]) => Promise<void>
  onRetry: (id: string) => Promise<void>
}
```

- [ ] **Step 2: Destructure the new prop**

Find the function signature:
```ts
export function InvoiceList({ sessions, onSelect, onUploadClick, onDelete, onBulkDelete, onRetry }: Props) {
```

Replace with:
```ts
export function InvoiceList({ sessions, onSelect, onUploadClick, onScanClick, onDelete, onBulkDelete, onRetry }: Props) {
```

- [ ] **Step 3: Render the native scan button next to the upload button**

Find this button in the toolbar:
```tsx
          <button onClick={onUploadClick}
            className="bg-gold text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-[#a88930] transition-colors shrink-0 sm:px-3 sm:py-1.5 sm:text-xs">
            + Scan Invoice
          </button>
```

Replace with:
```tsx
          {onScanClick && (
            <button
              onClick={onScanClick}
              className="bg-gold text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-[#a88930] transition-colors shrink-0 sm:px-3 sm:py-1.5 sm:text-xs flex items-center gap-1.5"
            >
              📷 Scan
            </button>
          )}
          <button onClick={onUploadClick}
            className="bg-gold text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-[#a88930] transition-colors shrink-0 sm:px-3 sm:py-1.5 sm:text-xs">
            + Upload
          </button>
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/InvoiceList.tsx
git commit -m "feat(scanner): add optional onScanClick prop + native scan button to InvoiceList"
```

---

## Task 5: Wire `useNativeScan` into the invoices page

**Files:**
- Modify: `src/app/invoices/page.tsx`

- [ ] **Step 1: Import `isNative` and `useNativeScan`**

At the top of `src/app/invoices/page.tsx`, after the existing imports, add:
```ts
import { isNative } from '@/lib/capacitor'
import { useNativeScan } from '@/hooks/useNativeScan'
```

- [ ] **Step 2: Add the hook inside `InvoicesPage`**

Inside `export default function InvoicesPage()`, after the existing `useState` declarations, add:
```ts
  const { triggerScan, isScanning, scanError } = useNativeScan({
    activeRcId,
    onComplete: (newSessionId) => {
      fetchSessions()
      setSelectedSessionId(newSessionId)
    },
  })
```

- [ ] **Step 3: Pass `onScanClick` to InvoiceList**

Find:
```tsx
      <InvoiceList
        sessions={sessions}
        onSelect={setSelectedSessionId}
        onUploadClick={() => setShowUpload(true)}
        onDelete={handleDelete}
        onBulkDelete={handleBulkDelete}
        onRetry={handleRetry}
      />
```

Replace with:
```tsx
      <InvoiceList
        sessions={sessions}
        onSelect={setSelectedSessionId}
        onUploadClick={() => setShowUpload(true)}
        onScanClick={isNative() ? triggerScan : undefined}
        onDelete={handleDelete}
        onBulkDelete={handleBulkDelete}
        onRetry={handleRetry}
      />
```

- [ ] **Step 4: Show scan error as a toast if scanning fails (optional but good UX)**

After the `InvoiceList` block and before `InvoiceDrawer`, add:
```tsx
      {scanError && (
        <div className="fixed bottom-20 left-4 right-4 z-50 bg-red-600 text-white text-sm font-medium rounded-xl px-4 py-3 shadow-lg sm:hidden">
          {scanError}
        </div>
      )}
      {isScanning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 sm:hidden">
          <div className="bg-white rounded-2xl px-8 py-6 flex flex-col items-center gap-3 shadow-xl">
            <div className="w-10 h-10 border-4 border-gold border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-semibold text-gray-700">Processing scan…</p>
          </div>
        </div>
      )}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npm run build
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/app/invoices/page.tsx
git commit -m "feat(scanner): wire useNativeScan into invoices page, pass onScanClick to InvoiceList"
```

---

## Task 6: Create the Capacitor mobile project

This sets up the `/mobile/` folder with config and installs Capacitor tooling. The `ios/` and `android/` native projects are generated by Capacitor CLI commands.

**Files:**
- Create: `mobile/package.json`
- Create: `mobile/capacitor.config.ts`

- [ ] **Step 1: Create `mobile/package.json`**

```json
{
  "name": "fergies-os-mobile",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "sync": "npx cap sync",
    "open:ios": "npx cap open ios",
    "open:android": "npx cap open android"
  },
  "dependencies": {
    "@capacitor/android": "^6.0.0",
    "@capacitor/core": "^6.0.0",
    "@capacitor/ios": "^6.0.0",
    "capacitor-document-scanner": "^1.1.4"
  },
  "devDependencies": {
    "@capacitor/cli": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create `mobile/capacitor.config.ts`**

Replace `https://your-app.vercel.app` with your actual production Vercel URL before running `cap sync`.

```ts
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.fergies.os',
  appName: "Fergie's OS",
  // webDir is relative to this file; points at the repo root's Next.js output.
  // Not used when server.url is set — the app loads the live Vercel URL.
  webDir: '../out',
  server: {
    url: 'https://your-app.vercel.app',
    cleartext: false,
  },
  plugins: {
    DocumentScanner: {
      // No extra config needed — defaults work for both platforms.
    },
  },
}

export default config
```

- [ ] **Step 3: Install Capacitor deps in `/mobile/`**

```bash
cd mobile && npm install
```

Expected: `mobile/node_modules/` created, no errors.

- [ ] **Step 4: Add the iOS platform**

```bash
cd mobile && npx cap add ios
```

Expected: `mobile/ios/` folder created with an Xcode project inside.

- [ ] **Step 5: Add the Android platform**

```bash
cd mobile && npx cap add android
```

Expected: `mobile/android/` folder created with a Gradle project inside.

- [ ] **Step 6: Commit the mobile project**

```bash
git add mobile/
git commit -m "feat(scanner): add Capacitor mobile project (iOS + Android)"
```

---

## Task 7: Configure iOS camera permission

Without the `NSCameraUsageDescription` key, iOS will crash when the scanner tries to access the camera. App Store review also requires it.

**Files:**
- Modify: `mobile/ios/App/App/Info.plist`

- [ ] **Step 1: Open the Info.plist and add camera permission string**

Find the closing `</dict>` tag in `mobile/ios/App/App/Info.plist` and insert this before it:

```xml
	<key>NSCameraUsageDescription</key>
	<string>Used to scan invoice documents</string>
```

Full context (insert before the last `</dict></plist>`):
```xml
  ...existing keys...
	<key>NSCameraUsageDescription</key>
	<string>Used to scan invoice documents</string>
</dict>
</plist>
```

- [ ] **Step 2: Commit**

```bash
git add mobile/ios/App/App/Info.plist
git commit -m "feat(scanner): add NSCameraUsageDescription to iOS Info.plist"
```

---

## Task 8: Configure Android camera permission

**Files:**
- Modify: `mobile/android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Verify camera permission is present**

Open `mobile/android/app/src/main/AndroidManifest.xml`. The `capacitor-document-scanner` plugin's Android component should auto-add `CAMERA` permission via its own manifest merge. Verify by checking:

```bash
grep -r "CAMERA" mobile/android/app/src/main/AndroidManifest.xml
```

Expected: `<uses-permission android:name="android.permission.CAMERA" />` is present.

If missing, add it manually inside the `<manifest>` tag (before `<application>`):
```xml
<uses-permission android:name="android.permission.CAMERA" />
```

- [ ] **Step 2: Commit if you added the line**

```bash
git add mobile/android/app/src/main/AndroidManifest.xml
git commit -m "feat(scanner): ensure CAMERA permission in AndroidManifest"
```

---

## Task 9: Final sync and smoke test

- [ ] **Step 1: Update the Vercel URL in capacitor.config.ts**

In `mobile/capacitor.config.ts`, replace `'https://your-app.vercel.app'` with your actual production URL (e.g. `'https://fergies-os.vercel.app'`).

- [ ] **Step 2: Run cap sync to copy plugin code into native projects**

```bash
cd mobile && npx cap sync
```

Expected: no errors, both `ios` and `android` are updated.

- [ ] **Step 3: Open Xcode and test on iOS Simulator or device**

```bash
cd mobile && npx cap open ios
```

In Xcode: select a real device or simulator → Run (⌘R). Navigate to Invoices. On a real device, the "📷 Scan" button should appear. Tapping it should open the iOS document scanner.

**Note:** The simulator does not have a camera. Test the scan button on a physical iPhone.

- [ ] **Step 4: Open Android Studio and test on Android**

```bash
cd mobile && npx cap open android
```

In Android Studio: Run on a physical Android device. Navigate to Invoices. Verify the "📷 Scan" button appears and the ML Kit scanner opens.

- [ ] **Step 5: Commit the final config**

```bash
git add mobile/capacitor.config.ts
git commit -m "feat(scanner): set production Vercel URL in Capacitor config"
```

---

## App Store Checklist (post-implementation)

These steps happen outside the codebase — complete after all tasks above pass:

- [ ] **iOS**: Enroll in Apple Developer Program ($99/yr) if not already
- [ ] **iOS**: In Xcode → Signing & Capabilities, set your Team and Bundle ID to match `com.fergies.os`
- [ ] **iOS**: Archive (Product → Archive) → Distribute to App Store Connect
- [ ] **Android**: Create a Google Play Console account ($25 one-time) if not already
- [ ] **Android**: In `mobile/android/app/build.gradle`, set `applicationId "com.fergies.os"` and increment `versionCode`
- [ ] **Android**: Build signed APK/AAB (Build → Generate Signed Bundle) → upload to Play Console
