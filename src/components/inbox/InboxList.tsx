'use client'
import { GROUP_LABEL, GROUP_TONE, groupBySeverity, metaLine, whenLabel, type InboxItem } from './format'
import { TagDot } from './TagChips'

// The Inbox list in severity groups. Phone: one card per group, rows open the
// sheet. Desktop: one card, group headers inside it, rows select the pane.

type RowProps = {
  item: InboxItem
  unread: boolean
  now: Date
  selected: boolean
  onOpen: (item: InboxItem) => void
}

const UnreadDot = ({ on }: { on: boolean }) => (
  <span
    className={`flex-none w-2 h-2 rounded-full ${on ? 'bg-gold' : 'bg-transparent'}`}
    aria-label={on ? 'New' : undefined}
    aria-hidden={on ? undefined : true}
  />
)

function PhoneRow({ item, unread, now, onOpen }: RowProps) {
  const meta = metaLine(item)
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="w-full flex gap-3 px-3.5 py-[13px] min-h-[64px] text-left border-t border-bg-2 first:border-t-0"
    >
      <span className="flex-1 min-w-0 flex flex-col gap-1">
        <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-ink-3">
          <TagDot color={item.tag.color} />
          {item.tag.name.toUpperCase()}
          <span className="text-ink-4">· {whenLabel(item.createdAt, now)}</span>
        </span>
        <span className="text-[15px] font-semibold tracking-[-0.015em] leading-[1.3] text-ink">{item.title}</span>
        {meta && <span className="font-mono text-[10.5px] text-ink-3 truncate">{meta}</span>}
      </span>
      <span className="flex-none self-center flex items-center gap-2">
        <UnreadDot on={unread} />
        <span className="text-ink-4 text-[16px]" aria-hidden>›</span>
      </span>
    </button>
  )
}

function DesktopRow({ item, unread, now, selected, onOpen }: RowProps) {
  const meta = metaLine(item)
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={() => onOpen(item)}
      className={`w-full grid grid-cols-[8px_minmax(0,1fr)_auto] gap-3 items-center px-[18px] py-3 text-left border-t border-bg-2 ${
        selected ? 'bg-bg-2' : 'hover:bg-bg'
      }`}
    >
      <UnreadDot on={unread} />
      <span className="flex flex-col gap-[3px] min-w-0">
        <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-ink-3">
          <TagDot color={item.tag.color} />
          {item.tag.name.toUpperCase()}
        </span>
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink">{item.title}</span>
        {meta && <span className="font-mono text-[10.5px] text-ink-3 truncate">{meta}</span>}
      </span>
      <span className="font-mono text-[11px] text-ink-3 text-right min-w-[64px]">{whenLabel(item.createdAt, now)}</span>
    </button>
  )
}

export function InboxList({ variant, items, isUnread, now, selectedId, onOpen, empty }: {
  variant: 'phone' | 'desktop'
  items: InboxItem[]
  isUnread: (item: InboxItem) => boolean
  now: Date
  selectedId: string | null
  onOpen: (item: InboxItem) => void
  empty: string
}) {
  const groups = groupBySeverity(items)

  if (groups.length === 0) {
    return variant === 'phone' ? (
      <div className="border border-dashed border-line-2 rounded-xl p-3.5 font-mono text-[11px] text-ink-2">{empty}</div>
    ) : (
      <section aria-label="Items" className="bg-paper border border-line rounded-xl px-[18px] py-6 font-mono text-[11px] text-ink-3">
        {empty}
      </section>
    )
  }

  if (variant === 'phone') {
    return (
      <>
        {groups.map(g => (
          <section key={g.severity} aria-label={GROUP_LABEL[g.severity]} className="flex flex-col gap-2">
            <div className={`font-mono text-[10px] font-medium tracking-[0.08em] px-0.5 ${GROUP_TONE[g.severity]}`}>{GROUP_LABEL[g.severity]}</div>
            <div className="bg-paper border border-line rounded-[14px] overflow-hidden">
              {g.items.map(i => (
                <PhoneRow key={i.id} item={i} unread={isUnread(i)} now={now} selected={i.id === selectedId} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ))}
      </>
    )
  }

  return (
    <section aria-label="Items" className="bg-paper border border-line rounded-xl overflow-hidden flex flex-col">
      {groups.map((g, gi) => (
        <div key={g.severity} role="group" aria-label={GROUP_LABEL[g.severity]}>
          <div className={`px-[18px] py-2.5 font-mono text-[10px] font-medium tracking-[0.08em] bg-bg ${gi > 0 ? 'border-t border-line' : ''} ${GROUP_TONE[g.severity]}`}>
            {GROUP_LABEL[g.severity]}
          </div>
          {g.items.map(i => (
            <DesktopRow key={i.id} item={i} unread={isUnread(i)} now={now} selected={i.id === selectedId} onOpen={onOpen} />
          ))}
        </div>
      ))}
    </section>
  )
}
