'use client'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { SectionTitle } from './SectionTitle'

/** The section's last open/closed choice on this device, or null when none
 *  was saved (or storage is blocked). */
function readChoice(name: string): boolean | null {
  try {
    const v = window.localStorage.getItem(`drawer-section:${name}`)
    return v === 'open' ? true : v === 'closed' ? false : null
  } catch {
    return null
  }
}

function saveChoice(name: string, open: boolean) {
  try {
    window.localStorage.setItem(`drawer-section:${name}`, open ? 'open' : 'closed')
  } catch {
    // Storage blocked (private mode) — the choice just isn't remembered.
  }
}

/** One drawer section. On a phone (below `sm`) its title is a button that
 *  folds the section away; on `sm` and up it is always open and the title is
 *  the plain heading it always was — no button. Folding only hides the body
 *  (`hidden`), it never unmounts it, so a section's loaded data and open forms
 *  survive and nothing re-fetches. The last choice per section is remembered
 *  on this device. */
export function CollapsibleSection({
  name, title, aside, heading, defaultOpen = true, gap = 'space-y-2', children,
}: {
  /** Storage key — `drawer-section:<name>`. */
  name: string
  /** The plain-English title on the phone's button. */
  title: string
  /** A short note beside the title (a count, say). */
  aside?: ReactNode
  /** The heading on `sm` and up. Defaults to the drawer's SectionTitle;
   *  `null` means no heading there at all (the section never had one). */
  heading?: ReactNode | null
  defaultOpen?: boolean
  /** Spacing between the section's own blocks. */
  gap?: 'space-y-2' | 'space-y-3'
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()

  // Read the saved choice after mount, so the server render (and the first
  // client render) always match the default.
  useEffect(() => {
    const saved = readChoice(name)
    if (saved != null) setOpen(saved)
  }, [name])

  const toggle = () => {
    const next = !open
    setOpen(next)
    saveChoice(name, next)
  }

  const desktopHeading = heading === undefined
    ? <SectionTitle aside={aside}>{title}</SectionTitle>
    : heading
  // The body sits under the phone's button always; on sm+ only under a heading.
  const bodySpace = gap === 'space-y-3' ? 'mt-3' : 'mt-2'
  const bodyDesktopSpace = desktopHeading == null ? ' sm:mt-0' : ''

  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="sm:hidden flex w-full min-w-0 items-center justify-between gap-2 min-h-[36px] -my-1 text-left"
      >
        <span className="min-w-0 truncate font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em]">
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {aside && <span className="text-[11px] text-ink-4">{aside}</span>}
          <ChevronDown
            size={16}
            aria-hidden
            className={`text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>
      {desktopHeading != null && <div className="hidden sm:block">{desktopHeading}</div>}
      <div
        id={bodyId}
        className={`${bodySpace}${bodyDesktopSpace} ${gap} ${open ? '' : 'hidden sm:block'}`}
      >
        {children}
      </div>
    </section>
  )
}
