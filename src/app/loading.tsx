// Root loading — shown while the dashboard chunk loads
export default function Loading() {
  return (
    <div className="p-4 space-y-4 animate-pulse">
      <div className="h-8 bg-gray-100 rounded w-40" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1,2,3,4].map(i => <div key={i} className="h-24 bg-gray-100 rounded-xl" />)}
      </div>
      <div className="h-48 bg-gray-100 rounded-xl" />
      <div className="h-48 bg-gray-100 rounded-xl" />
    </div>
  )
}
