import { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary'
}

export function Button({ variant = 'primary', className = '', children, ...props }: ButtonProps) {
  const base = 'inline-flex items-center gap-2 px-[18px] py-[11px] rounded-md text-body font-semibold transition-colors disabled:opacity-50'

  const styles =
    variant === 'primary'
      ? 'bg-ink text-paper hover:bg-ink-2'
      : 'bg-paper border border-line text-ink-2 hover:bg-bg-2'

  return (
    <button className={`${base} ${styles} ${className}`} {...props}>
      {children}
    </button>
  )
}
