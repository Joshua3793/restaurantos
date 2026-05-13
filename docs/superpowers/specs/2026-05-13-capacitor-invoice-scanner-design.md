# Capacitor Invoice Scanner — Design Spec

**Date:** 2026-05-13
**Status:** Approved for implementation

## Overview

Add a native document scanner to Fergie's OS by wrapping the existing Next.js web app in a Capacitor shell. The scanner uses OS-level document detection (iOS VNDocumentCameraViewController / Android ML Kit) for iScanner-quality framing. The scanned pages are merged into a PDF client-side and posted to the existing invoice upload endpoint — zero backend changes required.

## Platforms

- iOS (App Store) + Android (Play Store), shipped simultaneously
- Web experience unchanged — scan button is hidden on desktop and in the browser

## Architecture

```
Vercel (unchanged)                    App Store / Play Store
┌─────────────────────────┐          ┌──────────────────────────────┐
│  Next.js web app        │          │  Capacitor shell             │
│  - All existing pages   │◄─────────│  - WKWebView (iOS)           │
│  - Invoice OCR pipeline │  loads   │  - WebView (Android)         │
│  - API routes           │  URL     │  - capacitor-document-scanner│
└─────────────────────────┘          │  - @capacitor/core           │
                                     └──────────────────────────────┘
```

The Capacitor project lives in `/mobile/` at the repo root. It has no React/Next.js code — it loads the production Vercel URL in a WKWebView/WebView. The native scanner plugin bridges to JavaScript via Capacitor's plugin system.

## New Files & Components

### `src/lib/capacitor.ts`
Thin wrapper isolating all Capacitor imports behind dynamic `import()` so the web build never attempts to load native modules.

```ts
export const isNative = (): boolean => {
  // Capacitor sets this global in native context
  return typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform()
}

export const scanDocument = async (): Promise<string[]> => {
  const { DocumentScanner } = await import('capacitor-document-scanner')
  const { scannedImages } = await DocumentScanner.scanDocument()
  return scannedImages // base64 JPEGs
}
```

### `src/components/invoices/ScanButton.tsx`
- Renders `null` when `isNative()` is false (web/desktop — completely hidden)
- On tap: calls `scanDocument()`, receives base64 JPEG array
- Merges pages into a single PDF using `pdf-lib` (client-side)
- Creates an invoice session via `POST /api/invoices/sessions`
- Uploads the PDF blob to `POST /api/invoices/sessions/[id]/upload`
- Shows loading state during merge + upload
- On success: triggers the existing session polling / notification flow

### `src/app/invoices/page.tsx` (minor change)
Add `<ScanButton onSessionCreated={...} />` alongside the existing upload button. The button is self-hiding on web so no conditional logic needed in the page.

### `/mobile/` (new Capacitor project)
```
mobile/
  capacitor.config.ts     # points webDir at '../out' or live Vercel URL
  ios/                    # Xcode project (generated)
  android/                # Android Studio project (generated)
  package.json            # capacitor deps only
```

`capacitor.config.ts`:
```ts
import { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.fergies.os',
  appName: "Fergie's OS",
  webDir: 'out',           // Next.js static export for shell bootstrap
  server: {
    url: 'https://your-app.vercel.app',  // live URL loaded in WKWebView
    cleartext: false,
  },
}
export default config
```

## Data Flow

```
User taps "Scan Invoice"
  → ScanButton calls scanDocument()
  → capacitor-document-scanner opens native scanner UI
     (OS handles: camera, frame detection, auto-capture, perspective warp)
  → User scans 1–N pages; each returned as base64 JPEG
  → pdf-lib merges JPEGs into single PDF Blob client-side
  → POST /api/invoices/sessions          → creates session (status: UPLOADING)
  → POST /api/invoices/sessions/[id]/upload  → uploads PDF (same as file picker)
  → existing pipeline: OCR → REVIEW → APPROVE (unchanged)
```

## Native Scanner Behaviour

- **iOS**: `VNDocumentCameraViewController` — Apple's built-in scanner. Frame detection corners, auto-capture on stability, and perspective correction are OS-provided.
- **Android**: ML Kit `GmsDocumentScanner` — Google's equivalent, same UX quality.
- **Plugin**: `capacitor-document-scanner` (websitebeaver) — wraps both platforms, returns `{ scannedImages: string[] }` base64 JPEGs.
- **Camera permission**: requested by the plugin on first scan via the standard OS prompt. No manual `Info.plist` / `AndroidManifest.xml` entries required beyond what the plugin installs.
- **Auto-capture**: enabled by default — scanner captures when document is detected and stable. User can also tap shutter manually.

## PDF Merge (client-side, pdf-lib)

```
scannedImages: string[]   // base64 JPEGs from plugin
  → PDFDocument.create()
  → for each image:
      embedJpg(base64ToUint8Array(image))
      addPage([width, height])
      drawImage(embedded, { x:0, y:0, width, height })
  → pdfDoc.save()         // Uint8Array
  → new Blob([bytes], { type: 'application/pdf' })
  → filename: `scan_${Date.now()}.pdf`
```

Merge runs on-device before upload. Output is identical in format to a manually uploaded PDF — OCR pipeline requires zero changes.

## What Does Not Change

- All API routes (`/api/invoices/*`)
- Claude OCR pipeline (`src/lib/invoice-ocr.ts`)
- Fuzzy matcher (`src/lib/invoice-matcher.ts`)
- Invoice review drawer
- Session polling and notification flow
- Desktop web experience

## Dependencies

| Package | Where | Purpose |
|---|---|---|
| `@capacitor/core` | `/mobile/` | Capacitor runtime |
| `@capacitor/cli` | `/mobile/` devDep | Build tooling |
| `@capacitor/ios` | `/mobile/` | iOS platform |
| `@capacitor/android` | `/mobile/` | Android platform |
| `capacitor-document-scanner` | `/mobile/` | Native scanner plugin |
| `pdf-lib` | root `package.json` | Client-side PDF merge |

## App Store Requirements

- **iOS**: Apple Developer account ($99/yr), Xcode on a Mac for final build + submission
- **Android**: Google Play Console account ($25 one-time)
- **Privacy strings** (iOS `Info.plist`): "Camera used to scan invoice documents"
- **Min OS**: iOS 16+ (VNDocumentCameraViewController), Android 10+ (ML Kit GmsDocumentScanner)

## Out of Scope

- Offline mode (app requires internet to load Vercel URL)
- Push notifications (can be added later via `@capacitor/push-notifications`)
- Any other page accessing the camera
