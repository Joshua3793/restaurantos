import { ReactNode } from 'react'

interface AlertProps {
  title?: string
  children: ReactNode
  tone?: 'gold' | 'red' | 'green'
}

const TONE_STYLES = {
  gold:  { wrap: 'bg-gold-soft border-gold-soft',   title: 'text-gold-2',  body: 'text-gold-2' },
  red:   { wrap: 'bg-red-soft border-red-soft',         title: 'text-red-text', body: 'text-red-text' },
  green: { wrap: 'bg-green-soft border-green-soft',     title: 'text-green-text', body: 'text-green-text' },
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
