import { IcCheck, IcUndo } from '@/components/prep/icons'

interface PrepRestStateProps {
  total: number
  onReopenLast?: () => void
}

export default function PrepRestState({ total, onReopenLast }: PrepRestStateProps) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-12 bg-gradient-to-b from-[#f1faf4] to-paper border border-[#bbf7d0] rounded-2xl">
      <div className="w-[62px] h-[62px] rounded-full bg-green text-white grid place-items-center mb-4 shadow-lg">
        <IcCheck className="w-[30px] h-[30px]" />
      </div>
      <h3 className="text-[23px] font-semibold tracking-[-0.03em] mb-[7px]">All prep done</h3>
      <p className="text-[13.5px] text-ink-3 max-w-[380px] leading-[1.5]">
        Nice work — all {total} item{total !== 1 ? 's' : ''} handled. This list resets with your next stock count.
      </p>
      {onReopenLast && (
        <div className="flex gap-2.5 mt-[18px]">
          <button
            onClick={onReopenLast}
            className="bg-paper border border-line rounded-lg px-3.5 py-2 text-[13px] font-medium inline-flex items-center gap-1.5"
          >
            <IcUndo className="w-[14px] h-[14px]" />
            Reopen last item
          </button>
        </div>
      )}
    </div>
  )
}
