# Collapsible Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop nav sidebar collapsible and summonable on demand (Notion-style) so each page can use full screen width.

**Architecture:** A new `SidebarContext` holds `pinned` (persisted to localStorage, default `true`) and `peeking` (transient). The desktop `<aside>` in `Navigation.tsx` reads this state to render docked (pushes content), collapsed (off-screen), or peeking (floating overlay). A fixed edge-hover strip + a floating toggle button drive the state. `main`'s left margin/padding becomes reactive to the state.

**Tech Stack:** Next.js 14 App Router, React context + hooks, Tailwind, Lucide icons, localStorage.

**Note on testing:** This repo has no unit test suite. The automated check is `npm run build` (type-check). Behavior is verified with the preview MCP tools. Each task ends with a build + a manual verification note instead of unit tests.

---

### Task 1: SidebarContext (state + persistence)

**Files:**
- Create: `src/contexts/SidebarContext.tsx`

- [ ] **Step 1: Create the context**

Create `src/contexts/SidebarContext.tsx`:

```tsx
'use client'
import { createContext, useContext, useEffect, useState, useCallback } from 'react'

const STORAGE_KEY = 'controla.sidebar.pinned'

interface SidebarState {
  pinned: boolean
  peeking: boolean
  hydrated: boolean
  togglePinned: () => void
  setPeeking: (v: boolean) => void
}

const SidebarContext = createContext<SidebarState | null>(null)

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  // Default true (docked) so first paint + first-time users match today's layout.
  const [pinned, setPinned] = useState(true)
  const [peeking, setPeeking] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  // Restore persisted choice after mount (avoids SSR/hydration mismatch).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (stored !== null) setPinned(stored === 'true')
    } catch { /* ignore */ }
    setHydrated(true)
  }, [])

  const togglePinned = useCallback(() => {
    setPinned(prev => {
      const next = !prev
      try { window.localStorage.setItem(STORAGE_KEY, String(next)) } catch { /* ignore */ }
      return next
    })
    setPeeking(false)
  }, [])

  return (
    <SidebarContext.Provider value={{ pinned, peeking, hydrated, togglePinned, setPeeking }}>
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  const ctx = useContext(SidebarContext)
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider')
  return ctx
}
```

- [ ] **Step 2: Build to type-check**

Run: `npm run build`
Expected: PASS (the new file compiles; nothing imports it yet so no runtime change).

- [ ] **Step 3: Commit**

```bash
git add src/contexts/SidebarContext.tsx
git commit -m "feat(nav): add SidebarContext for collapsible sidebar state"
```

---

### Task 2: Edge trigger + floating toggle button

**Files:**
- Create: `src/components/layout/SidebarEdgeTrigger.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/layout/SidebarEdgeTrigger.tsx`:

```tsx
'use client'
import { PanelLeft } from 'lucide-react'
import { useSidebar } from '@/contexts/SidebarContext'

/**
 * Desktop-only controls for the collapsible sidebar:
 *  - a thin invisible hover strip at the far-left edge that summons a peek
 *  - a floating toggle button (top-left) that pins / unpins the sidebar
 * Both are hidden on mobile (md:block), where the bottom tab bar owns nav.
 */
export function SidebarEdgeTrigger() {
  const { pinned, setPeeking, togglePinned } = useSidebar()

  return (
    <>
      {/* Edge-hover summon zone — only meaningful when unpinned */}
      {!pinned && (
        <div
          aria-hidden
          onMouseEnter={() => setPeeking(true)}
          className="hidden md:block fixed left-0 top-0 w-1.5 h-screen z-40"
        />
      )}

      {/* Floating toggle button */}
      <button
        onClick={togglePinned}
        title={pinned ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-label={pinned ? 'Collapse sidebar' : 'Expand sidebar'}
        className={`hidden md:flex fixed top-3 left-3 z-50 w-8 h-8 items-center justify-center rounded-lg transition-colors ${
          pinned
            ? 'text-zinc-400 hover:text-white hover:bg-white/10'
            : 'text-ink-3 hover:text-ink bg-paper/80 backdrop-blur border border-line shadow-sm hover:bg-paper'
        }`}
      >
        <PanelLeft size={16} />
      </button>
    </>
  )
}
```

- [ ] **Step 2: Build to type-check**

Run: `npm run build`
Expected: PASS (compiles; not yet mounted).

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/SidebarEdgeTrigger.tsx
git commit -m "feat(nav): add sidebar edge-hover strip + floating toggle button"
```

---

### Task 3: Wire provider + reactive main margin into the layout

**Files:**
- Modify: `src/app/layout.tsx`
- Create: `src/components/layout/AppShell.tsx`

**Why a new AppShell:** `layout.tsx` is a server component; `main`'s class must now react to `useSidebar()`, a client hook. Extract the `<main>` + edge trigger into a small client component.

- [ ] **Step 1: Create the client shell**

Create `src/components/layout/AppShell.tsx`:

```tsx
'use client'
import { useSidebar } from '@/contexts/SidebarContext'
import { SidebarEdgeTrigger } from './SidebarEdgeTrigger'
import { CostChromeGate } from './CostChromeGate'

/**
 * Client wrapper around the page content. Owns the reactive left offset:
 *  - pinned  → push content right by the docked sidebar width (240px)
 *  - else    → full-width content with a small left gutter so the floating
 *              toggle button never overlaps the cost-chrome strip / content.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { pinned } = useSidebar()
  return (
    <>
      <SidebarEdgeTrigger />
      <main
        className={`${pinned ? 'md:ml-[240px]' : 'md:pl-12'} pb-20 md:pb-0 mobile-content-top md:pt-0 min-h-screen bg-[#fafaf9] flex flex-col transition-[margin,padding] duration-200`}
      >
        <CostChromeGate />
        <div className="flex-1 p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
          {children}
        </div>
      </main>
    </>
  )
}
```

- [ ] **Step 2: Update `src/app/layout.tsx`**

Add the import near the other layout imports:

```tsx
import { SidebarProvider } from '@/contexts/SidebarContext'
import { AppShell } from '@/components/layout/AppShell'
```

Remove the now-unused `CostChromeGate` import from `layout.tsx` (it moved into `AppShell`).

Wrap the existing providers with `<SidebarProvider>` (just inside `<DrawerProvider>` is fine), and replace the `<main>…</main>` block with `<AppShell>{children}</AppShell>`. The provider region becomes:

```tsx
        <DrawerProvider>
        <SidebarProvider>
          <Navigation />
          <MobileRcBar />
          <GlobalSearch />
          <KeyboardShortcuts />
          <AppShell>{children}</AppShell>
          <AiChat />
        </SidebarProvider>
        </DrawerProvider>
```

(Leave the outer `UserProvider / RcProvider / ToastProvider / NotificationProvider` nesting unchanged.)

- [ ] **Step 3: Build to type-check**

Run: `npm run build`
Expected: PASS. The cost-chrome strip still renders (now via `AppShell`). Sidebar still always docked because `Navigation.tsx` isn't reading state yet, but the floating toggle button is now visible and clicking it shifts `main`'s margin/padding.

- [ ] **Step 4: Commit**

```bash
git add src/app/layout.tsx src/components/layout/AppShell.tsx
git commit -m "feat(nav): reactive main offset + mount sidebar controls via AppShell"
```

---

### Task 4: Make the desktop aside docked / collapsed / floating

**Files:**
- Modify: `src/components/Navigation.tsx`

- [ ] **Step 1: Read sidebar state in `NavigationInner`**

At the top of `NavigationInner` (with the other hooks, near `const pathname = usePathname()`), add:

```tsx
  const { pinned, peeking, setPeeking } = useSidebar()
```

And add the import at the top of the file with the other imports:

```tsx
import { useSidebar } from '@/contexts/SidebarContext'
```

- [ ] **Step 2: Make the `<aside>` positioning reactive**

The desktop sidebar currently is:

```tsx
      <aside
        className="hidden md:flex flex-col w-[240px] h-screen fixed left-0 top-0 z-40 px-[14px] py-[18px] gap-[18px] text-zinc-300"
        style={{ background: '#09090b' }}
      >
```

Replace it with a version that translates off-screen when collapsed-and-not-peeking, floats (shadow + higher z) when peeking, and keeps `peeking` alive while hovered:

```tsx
      <aside
        onMouseEnter={() => { if (!pinned) setPeeking(true) }}
        onMouseLeave={() => { if (!pinned) setPeeking(false) }}
        className={`hidden md:flex flex-col w-[240px] h-screen fixed left-0 top-0 z-40 px-[14px] py-[18px] gap-[18px] text-zinc-300 transition-transform duration-200 ${
          pinned || peeking ? 'translate-x-0' : '-translate-x-full'
        } ${!pinned && peeking ? 'z-50 shadow-2xl shadow-black/40' : ''}`}
        style={{ background: '#09090b' }}
      >
```

- [ ] **Step 3: Clear `peeking` when a nav link is clicked**

In the desktop nav-groups `map`, the `<Link>` for each item currently has no `onClick`. Add one that dismisses the peek so the floating panel closes on navigation. Change the opening tag of that `<Link>` to include:

```tsx
                      onClick={() => setPeeking(false)}
```

Do the same for the Setup-group `<Link>` in the desktop sidebar. (Do **not** touch the mobile "More" drawer links — those already call `setMoreOpen(false)`.)

- [ ] **Step 4: Build to type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/Navigation.tsx
git commit -m "feat(nav): docked / collapsed / floating-peek states for desktop sidebar"
```

---

### Task 5: Manual verification with preview tools

**Files:** none (verification only).

- [ ] **Step 1: Ensure dev server is running**

Use `preview_start` (or confirm one is up with `preview_list`). Navigate to `/` (or any spine page like `/inventory`) at desktop width.

- [ ] **Step 2: Verify pinned → collapse**

Use `preview_resize` to a desktop width (e.g. 1280×800). `preview_screenshot`: sidebar docked, content offset. `preview_click` the top-left toggle button. `preview_screenshot`: sidebar gone, content full-width, toggle button now a bordered floating chip. Check `preview_console_logs` for errors (expect none).

- [ ] **Step 3: Verify edge-hover peek**

While collapsed, simulate a hover at the far-left edge. Since synthetic `mouseenter` on the 6px strip is hard to drive precisely, use `preview_eval` to dispatch it:
```js
document.querySelector('div[aria-hidden].fixed.left-0')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
```
`preview_screenshot`: sidebar floats in over content (content not shifted). Then move the mouse out (hover elsewhere) and confirm it slides away.

- [ ] **Step 4: Verify click-to-navigate stays collapsed**

While peeking, `preview_click` a nav item (e.g. Inventory). Confirm navigation happened and the sidebar is collapsed again (not docked).

- [ ] **Step 5: Verify persistence**

Collapse the sidebar, then `preview_eval: window.location.reload()`. After reload, `preview_screenshot`: still collapsed. Then pin it, reload, confirm still pinned. Clear with `preview_eval: localStorage.removeItem('controla.sidebar.pinned'); window.location.reload()` → should come back pinned (default).

- [ ] **Step 6: Verify no cost-chrome collision**

On a page with the cost-chrome strip (e.g. `/inventory`), in collapsed mode confirm via `preview_screenshot` that the floating toggle button sits in the left gutter and does not overlap the strip's left-edge content.

- [ ] **Step 7: Verify mobile untouched**

`preview_resize` to 390×844. `preview_screenshot`: bottom tab bar present, no floating toggle button, no edge strip behavior. Content top unaffected.

- [ ] **Step 8: Final build + commit (if any fixes were needed)**

Run: `npm run build` → PASS. Commit any fixes made during verification.

---

## Self-Review notes

- **Spec coverage:** state model (Task 1), edge strip + toggle button (Task 2), reactive `main` offset + collision gutter (Task 3), three aside modes + link-dismiss (Task 4), all verification scenarios from the spec (Task 5). ✓
- **Default `pinned = true`:** Task 1 initial state + the `stored === null` path. ✓
- **Hydration:** `hydrated` flag + post-mount restore in Task 1; first paint renders docked default. ✓
- **Type consistency:** `useSidebar()` returns `{ pinned, peeking, hydrated, togglePinned, setPeeking }` — consumers in Tasks 2–4 use only these names. ✓
- **Mobile untouched:** every new control is `hidden md:*`; mobile renderers in `Navigation.tsx` not modified. ✓
