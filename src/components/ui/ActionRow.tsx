import { ReactNode } from 'react'

interface ActionRowProps {
  icon?: ReactNode
  title: string
  titleMeta?: string
  caption?: string
  tone?: 'default' | 'alert'
  right?: ReactNode
  onClick?: () => void
}

export function ActionRow({ icon, title, titleMeta, caption, tone = 'default', right, onClick }: ActionRowProps) {
  return (
    <div
      className="flex items-center justify-between px-3 py-[11px] border-b border-dashed border-line last:border-b-0 cursor-pointer hover:bg-bg transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && (
          <div className="w-6 h-6 rounded-[6px] bg-bg-2 grid place-items-center font-mono text-[11px] text-ink-3 shrink-0">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-body font-medium text-ink truncate">{title}</span>
            {titleMeta && <span className="ui-meta">{titleMeta}</span>}
          </div>
          {caption && (
            <p className={`ui-meta mt-0.5 ${tone === 'alert' ? 'text-red' : ''}`}>{caption}</p>
          )}
        </div>
      </div>
      {right ?? <span className="text-ink-3 text-lg ml-3 shrink-0">›</span>}
    </div>
  )
}
