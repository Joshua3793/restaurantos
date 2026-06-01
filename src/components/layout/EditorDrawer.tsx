'use client'
import { useEffect, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

interface EditorDrawerProps {
  /** Optional dark cost-strip slot rendered under the title bar. */
  costStrip?: ReactNode
  /** Title bar slot — left of the back button is rendered here. */
  titleBar: ReactNode
  /** Main scrollable content. */
  children: ReactNode
  /** ESC + overlay click → call onClose. */
  onClose: () => void
  /** Width preset. Defaults to "default" (640px). */
  width?: 'default' | 'wide'
  /** Tailwind z-index. Default z-[60]. */
  zClassName?: string
}

/**
 * Generic right-side editor drawer. Shared chrome:
 * - Fixed inset overlay with backdrop click-to-close
 * - Sticky title bar with back-button slot for actions
 * - Optional cost-strip slot directly under the title bar (Principle 01)
 * - Scrollable body
 *
 * Used by RecipePanel + future Menu / Inventory item editors.
 * Mock reference: app/Recipes.html + app/Menu.html drawer pattern.
 */
export function EditorDrawer({
  costStrip,
  titleBar,
  children,
  onClose,
  width = 'default',
  zClassName = 'z-[60]',
}: EditorDrawerProps) {

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const w = width === 'wide' ? 'md:w-[880px] xl:w-[1080px]' : 'md:w-[640px]'

  return (
    <div className={`fixed inset-0 ${zClassName} flex`}>
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className={`w-full max-w-[100vw] ${w} bg-bg h-full overflow-y-auto overflow-x-hidden flex flex-col shadow-2xl`}>
        <div className="sticky top-0 z-10 bg-paper">
          <div
            className="border-b border-line px-5 py-4 flex items-center gap-3"
            style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}
          >
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-[8px] border border-line flex items-center justify-center text-ink-2 hover:border-ink-3 transition-colors bg-paper shrink-0"
              aria-label="Close"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="flex-1 min-w-0 flex items-center gap-3">
              {titleBar}
            </div>
          </div>
          {costStrip}
        </div>
        {children}
      </div>
    </div>
  )
}
