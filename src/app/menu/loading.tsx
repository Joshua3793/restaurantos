export default function Loading() {
  return (
    <div className="flex h-[calc(100vh-64px)] animate-pulse">
      {/* Sidebar */}
      <div className="w-64 border-r border-gray-100 p-3 space-y-2 shrink-0">
        <div className="h-9 bg-gray-100 rounded" />
        {[1,2,3,4,5,6].map(i => <div key={i} className="h-8 bg-gray-100 rounded" />)}
      </div>
      {/* Card grid */}
      <div className="flex-1 p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 content-start overflow-hidden">
        {[1,2,3,4,5,6].map(i => <div key={i} className="h-36 bg-gray-100 rounded-xl" />)}
      </div>
    </div>
  )
}
