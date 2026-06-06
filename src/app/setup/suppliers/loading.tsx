export default function Loading() {
  return (
    <div className="flex h-[calc(100vh-64px)] animate-pulse">
      {/* List panel */}
      <div className="w-72 border-r border-line flex flex-col shrink-0">
        <div className="p-3 border-b border-line">
          <div className="h-9 bg-bg-2 rounded" />
        </div>
        <div className="flex-1 p-2 space-y-1">
          {[1,2,3,4,5,6].map(i => <div key={i} className="h-14 bg-bg-2 rounded-lg" />)}
        </div>
      </div>
      {/* Detail panel */}
      <div className="flex-1 p-6 space-y-4">
        <div className="h-28 bg-ink rounded-xl" />
        <div className="grid grid-cols-2 gap-4">
          {[1,2,3,4].map(i => <div key={i} className="h-20 bg-bg-2 rounded-xl" />)}
        </div>
        <div className="h-48 bg-bg-2 rounded-xl" />
      </div>
    </div>
  )
}
