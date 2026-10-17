import { ButtonHTMLAttributes } from 'react'

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  /** Category data colour for the dot (a `c-*` / `m-*` hex). Defaults to ink-4. */
  dot?: string
  /** Optional mono count after the label. */
  count?: number
}

// Controla `.cat` category chip: 12.5px/500 sans, 7px colour dot, mono count; active = ink.
export function Chip({ active, dot, count, className = '', children, ...props }: ChipProps) {
  const styles = active
    ? 'bg-ink text-paper border-ink'
    : 'bg-paper border-line text-ink-2 hover:border-ink-3'

  return (
    <button
      className={`inline-flex items-center gap-[7px] px-3 py-1.5 rounded-full border text-[12.5px] font-medium tracking-[-0.005em] transition-colors duration-[120ms] ${styles} ${className}`}
      {...props}
    >
      <span className="w-[7px] h-[7px] rounded-full shrink-0 bg-ink-4" style={dot ? { background: dot } : undefined} />
      {children}
      {count !== undefined && (
        <span className={`font-mono text-[10.5px] tracking-[0] ${active ? 'text-ink-4' : 'text-ink-3'}`}>{count}</span>
      )}
    </button>
  )
}
