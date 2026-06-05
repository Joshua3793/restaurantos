# Pre-shift Editable Checklists — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pre-shift Safety + Service checklists fully editable — add, delete, and rename any row — persisted as a per-device template across days. Line checks (Prep-derived) and the Temperatures summary stay non-editable.

**Architecture:** Replace the hardcoded `SAFETY_DEFAULTS`/`SERVICE_DEFAULTS` + per-day `custom` array with a persistent `localStorage` **template** (`preshift:template:<rc>`, seeded once from the defaults) that owns the authored Safety/Service items; the per-day blob keeps only `done`. The `CheckRow` (desktop) and `MCheckRow` (mobile) gain an inline edit/delete mode. Everything is one coupled change in two files, so it lands as a single task that builds at the end.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind (flat tokens), Lucide icons. No test suite — `npm run build` + browser preview are the gates.

**Spec:** [docs/superpowers/specs/2026-06-05-preshift-editable-checklists-design.md](../specs/2026-06-05-preshift-editable-checklists-design.md)

---

## File Structure

- **Modify** `src/app/preshift/page.tsx` — storage split (template vs per-day done), `template` state + seed, `addCheck`/`deleteItem`/`editItem` handlers, `itemsBySection` from template, `AddCheck` section picker (Safety/Service only), `CheckRow` editable mode, and both render call sites pass `onEdit`/`onDelete` for Safety/Service rows.
- **Modify** `src/components/preshift/mobile.tsx` — `MCheckRow` editable mode.

---

## Task 1: Editable checklist template + inline edit/delete

**Files:**
- Modify: `src/app/preshift/page.tsx`
- Modify: `src/components/preshift/mobile.tsx`

- [ ] **Step 1: Add the `Pencil` icon import (page.tsx)**

In the existing `lucide-react` import in `src/app/preshift/page.tsx`, add `Pencil`. (The import currently lists icons like `Sun, Activity, ChefHat, ClipboardList, Thermometer, UtensilsCrossed, Clock, Plus, X, Check, ArrowLeft, ArrowRight, RotateCcw` — append `, Pencil`.)

- [ ] **Step 2: Replace storage keys + state (page.tsx)**

Find:
```tsx
  const storageKey = useMemo(() => `preshift:${ymd(new Date())}:${activeRcId || 'all'}`, [activeRcId])

  const [done, setDone] = useState<Record<string, boolean>>({})
  const [custom, setCustom] = useState<CheckItem[]>([])
  const [hydrated, setHydrated] = useState(false)
```
Replace with:
```tsx
  const storageKey = useMemo(() => `preshift:${ymd(new Date())}:${activeRcId || 'all'}`, [activeRcId])
  const templateKey = useMemo(() => `preshift:template:${activeRcId || 'all'}`, [activeRcId])

  const [done, setDone] = useState<Record<string, boolean>>({})
  const [template, setTemplate] = useState<CheckItem[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [tplHydrated, setTplHydrated] = useState(false)
```

- [ ] **Step 3: Replace hydrate/persist effects (page.tsx)**

Find the existing hydrate effect and persist effect:
```tsx
  // Hydrate per-day state.
  useEffect(() => {
    setHydrated(false)
    try {
      const raw = localStorage.getItem(storageKey)
      const p = raw ? JSON.parse(raw) : {}
      setDone(p.done ?? {})
      setCustom(p.custom ?? [])
    } catch { setDone({}); setCustom([]) }
    setHydrated(true)
  }, [storageKey])

  // Persist.
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(storageKey, JSON.stringify({ done, custom })) } catch { /* noop */ }
  }, [done, custom, hydrated, storageKey])
```
Replace with:
```tsx
  // Hydrate per-day done-state.
  useEffect(() => {
    setHydrated(false)
    try {
      const raw = localStorage.getItem(storageKey)
      const p = raw ? JSON.parse(raw) : {}
      setDone(p.done ?? {})
    } catch { setDone({}) }
    setHydrated(true)
  }, [storageKey])

  // Hydrate the editable checklist template (persists across days; seeded from defaults).
  useEffect(() => {
    setTplHydrated(false)
    try {
      const raw = localStorage.getItem(templateKey)
      const p = raw ? JSON.parse(raw) : null
      setTemplate(p && Array.isArray(p.items) ? p.items : seedTemplate())
    } catch { setTemplate(seedTemplate()) }
    setTplHydrated(true)
  }, [templateKey])

  // Persist done-state (per day) and template (per RC).
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(storageKey, JSON.stringify({ done })) } catch { /* noop */ }
  }, [done, hydrated, storageKey])
  useEffect(() => {
    if (!tplHydrated) return
    try { localStorage.setItem(templateKey, JSON.stringify({ items: template })) } catch { /* noop */ }
  }, [template, tplHydrated, templateKey])
```

- [ ] **Step 4: Add the `seedTemplate` helper (page.tsx)**

In the helpers section at the bottom of the file (next to `fmtQty`, `ymd`, `slug`), add:
```tsx
function seedTemplate(): CheckItem[] {
  return [...SAFETY_DEFAULTS, ...SERVICE_DEFAULTS].map(it => ({ ...it }))
}
```

- [ ] **Step 5: Rebuild `itemsBySection` from the template (page.tsx)**

Find:
```tsx
  const itemsBySection = useMemo<Record<SectionKey, CheckItem[]>>(() => {
    const customBy = (s: SectionKey) => custom.filter(c => c.section === s)
    return {
      safety:  [...SAFETY_DEFAULTS, ...customBy('safety')],
      line:    [...lineItems,       ...customBy('line')],
      service: [...SERVICE_DEFAULTS, ...customBy('service')],
    }
  }, [lineItems, custom])
```
Replace with:
```tsx
  const itemsBySection = useMemo<Record<SectionKey, CheckItem[]>>(() => ({
    safety:  template.filter(c => c.section === 'safety'),
    line:    lineItems,
    service: template.filter(c => c.section === 'service'),
  }), [lineItems, template])
```

- [ ] **Step 6: Replace `addCheck`/`removeCustom` with `addCheck`/`deleteItem`/`editItem` (page.tsx)**

Find:
```tsx
  const addCheck = useCallback((section: SectionKey, title: string, blocker: boolean) => {
    const t = title.trim()
    if (!t) return
    const id = `custom:${section}:${slug(t)}-${custom.length}`
    setCustom(prev => [...prev, { id, section, title: t, meta: 'Added by you', blocker, custom: true }])
  }, [custom.length])

  const removeCustom = useCallback((id: string) => {
    setCustom(prev => prev.filter(c => c.id !== id))
    setDone(prev => { const n = { ...prev }; delete n[id]; return n })
  }, [])
```
Replace with:
```tsx
  const addCheck = useCallback((section: SectionKey, title: string, blocker: boolean) => {
    const t = title.trim()
    if (!t) return
    const id = `tpl:${section}:${slug(t)}-${Date.now().toString(36)}`
    setTemplate(prev => [...prev, { id, section, title: t, meta: 'Added by you', blocker }])
  }, [])

  const deleteItem = useCallback((id: string) => {
    setTemplate(prev => prev.filter(c => c.id !== id))
    setDone(prev => { const n = { ...prev }; delete n[id]; return n })
  }, [])

  const editItem = useCallback((id: string, title: string) => {
    const t = title.trim()
    if (!t) return
    setTemplate(prev => prev.map(c => c.id === id ? { ...c, title: t } : c))
  }, [])
```

- [ ] **Step 7: Restrict the `AddCheck` section picker to Safety/Service (page.tsx)**

In the `AddCheck` component, change the default section and the `<select>` options. Find:
```tsx
  const [section, setSection] = useState<SectionKey>('line')
```
Replace with:
```tsx
  const [section, setSection] = useState<SectionKey>('safety')
```
And find:
```tsx
        {SECTIONS.map(s => <option key={s.key} value={s.key}>{s.title}</option>)}
```
Replace with:
```tsx
        {SECTIONS.filter(s => s.key !== 'line').map(s => <option key={s.key} value={s.key}>{s.title}</option>)}
```

- [ ] **Step 8: Make `CheckRow` editable (page.tsx)**

Replace the entire `CheckRow` function with:
```tsx
function CheckRow({ item, done, blockingOpen, onToggle, onEdit, onDelete }: {
  item: CheckItem
  done: boolean
  blockingOpen: boolean
  onToggle: () => void
  onEdit?: (title: string) => void
  onDelete?: () => void
}) {
  const rightTint = (t?: Tint) =>
    t === 'bad' ? 'text-red-text' : t === 'warn' ? 'text-gold-2' : t === 'ok' ? 'text-green-text' : 'text-ink-3'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.title)
  const editable = !!onEdit || !!onDelete
  const commit = () => { const t = draft.trim(); if (t) onEdit?.(t); setEditing(false) }

  return (
    <div
      className="grid grid-cols-[26px_1fr_auto] items-center gap-3.5 px-[18px] py-[13px] border-b border-line last:border-0 hover:bg-bg/60 transition-colors cursor-pointer group"
      onClick={() => { if (!editing) onToggle() }}
    >
      <div className={`w-[22px] h-[22px] rounded-[6px] border-[1.5px] grid place-items-center transition-all ${done ? 'bg-green border-green text-white' : 'border-line-2 text-transparent'}`}>
        <Check size={13} strokeWidth={3} />
      </div>

      <div className="min-w-0">
        <div className={`text-[14px] font-medium tracking-[-0.01em] flex items-center gap-1.5 ${done ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink'}`}>
          {editing ? (
            <input
              autoFocus
              value={draft}
              onClick={e => e.stopPropagation()}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(item.title); setEditing(false) } }}
              onBlur={commit}
              className="flex-1 min-w-0 bg-bg border border-ink-3 rounded-[6px] px-2 py-0.5 text-[14px] text-ink outline-none"
            />
          ) : (
            <span className="truncate">{item.title}</span>
          )}
          {editable && !editing && (
            <span className="ml-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <button onClick={e => { e.stopPropagation(); setDraft(item.title); setEditing(true) }} className="text-ink-4 hover:text-ink" aria-label="Edit"><Pencil size={12} /></button>
              <button onClick={e => { e.stopPropagation(); onDelete?.() }} className="text-ink-4 hover:text-red-text" aria-label="Delete"><X size={12} /></button>
            </span>
          )}
        </div>
        {(item.meta || item.metaAlert) && !editing && (
          <div className="font-mono text-[10.5px] text-ink-3 mt-[3px] tracking-[0] flex items-center gap-1.5 flex-wrap">
            {item.meta}
            {item.meta && item.metaAlert && <span className="text-ink-4">·</span>}
            {item.metaAlert && <b className="text-red-text font-semibold">{item.metaAlert}</b>}
          </div>
        )}
      </div>

      {item.right ? (
        <div className={`text-right font-mono text-[11.5px] font-semibold tracking-[-0.01em] ${rightTint(item.right.tint)}`}>
          {item.right.value}
          {item.right.sub && <small className="block font-normal text-ink-3 text-[9.5px] mt-px">{item.right.sub}</small>}
        </div>
      ) : (
        <div className="text-right font-mono text-[11.5px] text-ink-3">{done ? '✓' : '—'}</div>
      )}
    </div>
  )
}
```

- [ ] **Step 9: Wire `onEdit`/`onDelete` at the DESKTOP call site (page.tsx)**

Find the desktop `CheckRow` usage:
```tsx
                  ) : items.map(it => (
                    <CheckRow
                      key={it.id}
                      item={it}
                      done={isDone(it)}
                      blockingOpen={isBlockingOpen(it)}
                      onToggle={() => toggle(it)}
                      onRemove={it.custom ? () => removeCustom(it.id) : undefined}
                    />
                  ))}
```
Replace with:
```tsx
                  ) : items.map(it => (
                    <CheckRow
                      key={it.id}
                      item={it}
                      done={isDone(it)}
                      blockingOpen={isBlockingOpen(it)}
                      onToggle={() => toggle(it)}
                      onEdit={sec.key === 'line' ? undefined : (title) => editItem(it.id, title)}
                      onDelete={sec.key === 'line' ? undefined : () => deleteItem(it.id)}
                    />
                  ))}
```

- [ ] **Step 10: Wire `onEdit`/`onDelete` at the MOBILE call site (page.tsx)**

Find the mobile `MCheckRow` usage:
```tsx
              {items.map(it => (
                <MCheckRow
                  key={it.id}
                  title={it.title}
                  meta={it.meta}
                  metaAlert={it.metaAlert}
                  done={isDone(it)}
                  right={it.right?.value}
                  rightTint={it.right?.tint}
                  onToggle={() => toggle(it)}
                  onRemove={it.custom ? () => removeCustom(it.id) : undefined}
                />
              ))}
```
Replace with:
```tsx
              {items.map(it => (
                <MCheckRow
                  key={it.id}
                  title={it.title}
                  meta={it.meta}
                  metaAlert={it.metaAlert}
                  done={isDone(it)}
                  right={it.right?.value}
                  rightTint={it.right?.tint}
                  onToggle={() => toggle(it)}
                  onEdit={sec.key === 'line' ? undefined : (title) => editItem(it.id, title)}
                  onDelete={sec.key === 'line' ? undefined : () => deleteItem(it.id)}
                />
              ))}
```

- [ ] **Step 11: Make `MCheckRow` editable (mobile.tsx)**

In `src/components/preshift/mobile.tsx`: add `import { useState } from 'react'` as the first import line (above the existing `import { Check, X, ArrowRight, AlertTriangle } from 'lucide-react'`), and add `Pencil` to that lucide import. Then replace the entire `MCheckRow` function with:
```tsx
export function MCheckRow({ title, meta, metaAlert, done, right, rightTint, onToggle, onEdit, onDelete }: {
  title: string
  meta?: string
  metaAlert?: string
  done: boolean
  right?: string
  rightTint?: MTint
  onToggle: () => void
  onEdit?: (title: string) => void
  onDelete?: () => void
}) {
  const tintClass = rightTint === 'bad' ? 'text-red-text' : rightTint === 'warn' ? 'text-gold-2' : rightTint === 'ok' ? 'text-green-text' : 'text-ink-3'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const editable = !!onEdit || !!onDelete
  const commit = () => { const t = draft.trim(); if (t) onEdit?.(t); setEditing(false) }

  return (
    <div className="flex items-center gap-3 px-3.5 py-3 border-b border-line last:border-0 active:bg-bg/60 group" onClick={() => { if (!editing) onToggle() }}>
      <div className={`w-[22px] h-[22px] rounded-[6px] border-[1.5px] grid place-items-center shrink-0 ${done ? 'bg-green border-green text-white' : 'border-line-2 text-transparent'}`}>
        <Check size={13} strokeWidth={3} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-[14px] font-medium tracking-[-0.01em] flex items-center gap-1.5 ${done ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink'}`}>
          {editing ? (
            <input
              autoFocus
              value={draft}
              onClick={e => e.stopPropagation()}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(title); setEditing(false) } }}
              onBlur={commit}
              className="flex-1 min-w-0 bg-bg border border-ink-3 rounded-[6px] px-2 py-1 text-[14px] text-ink outline-none"
            />
          ) : (
            <span className="truncate">{title}</span>
          )}
        </div>
        {(meta || metaAlert) && !editing && (
          <div className="font-mono text-[10px] text-ink-3 mt-[3px] flex items-center gap-1.5 flex-wrap">
            {meta}
            {meta && metaAlert && <span className="text-ink-4">·</span>}
            {metaAlert && <b className="text-red-text font-semibold">{metaAlert}</b>}
          </div>
        )}
      </div>
      {editable && !editing ? (
        <div className="flex items-center gap-2.5 shrink-0">
          <button onClick={e => { e.stopPropagation(); setDraft(title); setEditing(true) }} className="text-ink-4 active:text-ink" aria-label="Edit"><Pencil size={15} /></button>
          <button onClick={e => { e.stopPropagation(); onDelete?.() }} className="text-ink-4 active:text-red-text" aria-label="Delete"><X size={15} /></button>
        </div>
      ) : (right && !editing && <span className={`font-mono text-[11px] font-semibold shrink-0 ${tintClass}`}>{right}</span>)}
    </div>
  )
}
```

- [ ] **Step 12: Build**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -20
```
Expected: `✓ Compiled successfully`, `/preshift` listed. Fix any type errors (e.g. a leftover `custom`/`removeCustom` reference — `grep -nE "removeCustom|setCustom|p.custom|it.custom|\\bcustom\\b" src/app/preshift/page.tsx` should only possibly match the `CheckItem.custom?` field definition, which is harmless; there must be NO `removeCustom`/`setCustom` references). If a flaky `.next/export ENOTEMPTY` or `PageNotFoundError` appears, `rm -rf .next` and rebuild once.

- [ ] **Step 13: Commit**

```bash
git add src/app/preshift/page.tsx src/components/preshift/mobile.tsx
git commit -m "feat(preshift): editable Safety/Service checklists (add, delete, rename)"
```

---

## Task 2: Verify + push

**Files:** none (verification only)

- [ ] **Step 1: Browser verification**

Restart the dev server fresh (the build wiped `.next`): preview_stop the running server, `rm -rf .next`, preview_start "RestaurantOS (Next.js)". Navigate to `/preshift`.

Desktop (preview_resize width 1320):
- Hover a Safety/Service row → pencil + × appear. Click pencil → title becomes an input; type a new name, press Enter → renamed. Reload → rename persists.
- Click × on a built-in (e.g. "POS open & printers tested") → row removed; section/gate counts drop by one. Reload → still gone.
- "Add check" bar → section picker shows only **Safety** and **Service** (no Line). Add one → appears + persists + counts toward gate.
- Confirm the **Temperatures** summary row has NO pencil/×, and **Line checks** rows have NO pencil/× (only their `behind`/`ready` value).

Mobile (preview_resize preset mobile):
- Safety/Service rows show pencil + × inline. Pencil → inline rename input. × → delete. Tapping the row body still toggles the check.

- [ ] **Step 2: Final build + push**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd "/Users/joshua/Desktop/Fergie's OS" && rm -rf .next && npm run build 2>&1 | grep -iE "Compiled successfully|/preshift|Error occurred" | head
git push -u origin feat/preshift-editable
```
Then merge/PR per the user's preference.

---

## Self-Review

- **Spec coverage:** template storage split (Steps 2–5) ✓; seed from defaults (Step 4) ✓; add → template, Safety/Service only (Steps 6–7) ✓; delete any Safety/Service row (Steps 6, 8–11) ✓; edit wording inline (Steps 8, 11) ✓; Line + Temps excluded (Steps 9–10 pass `undefined` for `line`; Temperatures summary is not a row) ✓; per-day `done` unchanged (Step 3) ✓; both renderers (Steps 8–11) ✓; verification incl. persistence + exclusions (Task 2) ✓.
- **Placeholders:** none — every step has full code or exact commands.
- **Type consistency:** `template: CheckItem[]`, `seedTemplate(): CheckItem[]`, `editItem(id, title)`, `deleteItem(id)`, and the `onEdit?: (title: string) => void` / `onDelete?: () => void` props are consistent across `CheckRow`, `MCheckRow`, and both call sites. The removed `onRemove`/`it.custom` wiring is replaced everywhere it appeared (Steps 9–11). `Pencil` imported in both files (Steps 1, 11); `useState` imported in mobile.tsx (Step 11).
