export default function Loading() {
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4 animate-pulse">
      <div className="h-8 bg-gray-100 rounded w-32" />
      <div className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
        <div className="h-5 bg-gray-100 rounded w-48" />
        <div className="h-9 bg-gray-100 rounded" />
        <div className="h-9 bg-gray-100 rounded" />
        <div className="h-9 bg-gray-100 rounded w-32" />
      </div>
    </div>
  )
}
