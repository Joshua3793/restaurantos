// Prep run-sheet — section header for a group of ladder rows.
// Ported from desktop.jsx's DGroupHead. `dot` is a Tailwind background class
// (e.g. "bg-red", "bg-ink-3") so callers pick the accent per group/priority.
export function GroupHead({
  dot,
  title,
  count,
  sub,
}: {
  dot: string
  title: string
  count: number | string
  sub?: string | null
}) {
  return (
    <div className="flex items-baseline gap-2 mt-5 mb-2.5 px-0.5">
      <span className={`w-2 h-2 rounded-full shrink-0 self-center ${dot}`} />
      <span className="font-mono text-[11px] font-semibold tracking-[0.05em] uppercase text-ink">{title}</span>
      <span className="font-mono text-[10.5px] text-ink-3">· {count}</span>
      {sub && <span className="font-mono text-[10px] text-ink-4 ml-1">{sub}</span>}
    </div>
  )
}
