import { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary'
}

// Controla `.btn`: 9×14px, r 9px, 13px/500; hover darkens the border (120ms, the only motion).
export function Button({ variant = 'primary', className = '', children, ...props }: ButtonProps) {
  const base = 'inline-flex items-center gap-[7px] py-[9px] rounded text-[13px] font-medium tracking-[-0.01em] whitespace-nowrap border transition-colors duration-[120ms] disabled:opacity-50'

  const styles =
    variant === 'primary'
      ? 'px-4 bg-ink border-ink text-paper hover:bg-[#18181b] hover:border-[#18181b]'
      : 'px-[14px] bg-paper border-line text-ink-2 hover:border-ink-3'

  return (
    <button className={`${base} ${styles} ${className}`} {...props}>
      {children}
    </button>
  )
}
