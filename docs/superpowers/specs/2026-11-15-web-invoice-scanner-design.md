# Browser invoice scanner — design (2026-11-15)

## Why
Most invoice scanning happens in the phone **browser**, where Scan was missing:
staff used Upload → a raw camera photo (table, tilt, shadows), shrunk on the
phone to 2000 px *before* any crop, so the page itself ended up small and the
reader misread small print. The phone app uses Apple/Android's native document
scanner, which crops, flattens and cleans first. Goal: the browser gets the
same — the page handed to the reader is cropped to the paper, flattened, evenly
lit, at full detail — with no glitches.

## What the cook sees (approved with Joshua)
1. Scan → full-screen back camera; a live outline finds the invoice.
2. **Auto-snap** after the page is held still **1 second** (a ring fills);
   on/off switch on the camera, starts ON, the phone remembers. Manual shutter always works.
3. Each shot comes back cropped + flattened; **Fix corners** drags the four corners (with a magnifier).
4. A bad shot — blurry, too dark, glare, page cut off, too far, no page found —
   shows a warning: Retake / (Fix corners) / Use it anyway.
5. Up to **10 pages**; the pages screen lets a page be redone or deleted;
   **Done** sends them exactly like the native scanner (one page → read now,
   several → the grouping screen).
6. No camera access → "Take a photo" / "Choose a photo"; the photo still gets
   cropped and cleaned.
7. Desktop browsers: unchanged (Upload only). Phone app: unchanged (native scanner).

## How (builder's calls)
- **Engine:** OpenCV.js (`@techstark/opencv-js`, Apache-2.0) copied to
  `public/vendor/opencv.js` on install (gitignored, ~3.5 MB gzipped), run in a
  **web worker** (`src/lib/doc-scan/scan.worker.ts`) so the preview never
  stutters. Preloaded 1.5 s after the invoice screen opens on a touch device.
- **Page finding** (`pipeline.ts findPage`, at 480 px): candidates from edge
  contours, the bright-paper blob and paired straight lines (Hough), on grey and
  "whiteness" (min of R,G,B — separates white paper from beige wood). Scored by
  size × square corners × sides on real edges × paper-inside/table-outside
  contrast × **share of the printed marks kept inside** (a crop must never cut
  off the totals; a little table in the crop is harmless to the reader). Live
  preview prefers the page found a moment ago so the outline doesn't flicker.
- **Capture:** up to 4K video; on Chrome/Android `ImageCapture.takePhoto()`
  (full sensor) when it is actually bigger. Capped at 3264 px.
- **Clean-up:** perspective flatten from the full-res frame to ≤ 2500 px long
  side (the server reads at 2500); lighting evened per colour channel (closing +
  median background, floored at 55 % so dark header bars survive); gentle black
  point. **No sharpening** — the server already normalizes + sharpens every page.
  JPEG 0.9, not re-compressed by the client.
- **Warnings** (`LIMITS` in pipeline.ts), tuned on real Fergie's invoice photos
  with `scripts/doc-scan-tune.ts`: sharpness < 60, paper < 95, glare > 2.5 %,
  page < 22 % of the photo, a corner on the frame edge, no page found.
- The recipe scan's browser camera uses the same scanner; the old
  `CameraCapture` is removed.

## Known limits
- Page finding is a best guess on busy or same-colour tables; the cook can
  always fix the corners, and the cut-off warning catches crops that touch the
  frame edge.
- iPhone Safari has no full-sensor still from a web page; it uses the 4K video frame.
