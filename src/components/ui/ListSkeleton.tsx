/**
 * Placeholder rows for a list that is still fetching its first page of data.
 * Render it INSTEAD of the empty state until the first load resolves — an empty
 * list that appears before the fetch lands reads as "you have no items".
 */
export function ListSkeleton({ rows = 8, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div
      className="bg-paper rounded-xl border border-line overflow-hidden animate-pulse"
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      <div className="h-9 bg-bg-2 border-b border-line" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5 border-b border-line last:border-b-0">
          <div className="w-4 h-4 rounded-[4px] bg-bg-2 shrink-0" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="h-3.5 bg-bg-2 rounded" style={{ width: `${45 + ((i * 17) % 35)}%` }} />
            <div className="h-2.5 bg-bg-2 rounded w-24" />
          </div>
          <div className="hidden sm:block h-3.5 bg-bg-2 rounded w-20" />
          <div className="h-3.5 bg-bg-2 rounded w-14" />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  )
}
