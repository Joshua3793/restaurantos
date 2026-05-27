import { ReactNode } from 'react'

interface AlertProps {
  title?: string
  children: ReactNode
  tone?: 'gold' | 'red' | 'green'
}

const TONE_STYLES = {
  gold:  { wrap: 'bg-gold-soft border-amber-300',   title: 'text-gold-2',  body: 'text-amber-900' },
  red:   { wrap: 'bg-red-50 border-red-200',         title: 'text-red-700', body: 'text-red-900' },
  green: { wrap: 'bg-green-50 border-green-200',     title: 'text-green-700', body: 'text-green-900' },
}

export function Alert({ title, children, tone = 'gold' }: AlertProps) {
  const s = TONE_STYLES[tone]
  return (
    <div className={`${s.wrap} border rounded-md p-3`}>
      {title && (
        <p className={`${s.title} font-mono text-label uppercase tracking-[0.04em] mb-1`}>{title}</p>
      )}
      <div className={`${s.body} text-body leading-relaxed`}>{children}</div>
    </div>
  )
}
