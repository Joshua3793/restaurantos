export default function Loading() {
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4 animate-pulse">
      <div className="h-8 bg-bg-2 rounded w-48" />
      <div className="space-y-2">
        {[1, 2, 3].map(i => <div key={i} className="h-16 bg-bg-2 rounded-xl" />)}
      </div>
    </div>
  )
}
