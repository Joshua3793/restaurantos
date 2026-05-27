import { ButtonHTMLAttributes } from 'react'

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
}

export function Chip({ active, className = '', children, ...props }: ChipProps) {
  const styles = active
    ? 'bg-ink text-paper border-ink'
    : 'bg-paper border-line text-ink-2 hover:border-ink-3'

  return (
    <button
      className={`font-mono text-[11px] px-2.5 py-1.5 rounded-full border tracking-[0.02em] transition-colors ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
