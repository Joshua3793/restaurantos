import type { LinkedItemSummary } from './types'

// Renders a task name, highlighting the inline "@<ingredient>" mention where the
// user invoked it (e.g. "Slice @Salmon (is already cured)"). The linked item's
// name defines the mention boundary so multi-word ingredients ("@Sesame Oil") are
// highlighted whole. Falls back to plain text when there's no inline mention.
export default function TaskName({
  name,
  linkedInventoryItem,
}: {
  name: string
  linkedInventoryItem: LinkedItemSummary | null
}) {
  if (!linkedInventoryItem) return <>{name}</>
  const token = `@${linkedInventoryItem.itemName}`
  const idx = name.indexOf(token)
  if (idx < 0) return <>{name}</>
  return (
    <>
      {name.slice(0, idx)}
      <span className="font-medium px-1 py-0.5 rounded bg-gold-soft text-gold-2">{token}</span>
      {name.slice(idx + token.length)}
    </>
  )
}
