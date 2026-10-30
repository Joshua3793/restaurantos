'use client'

// The PIN keypad and its dots, used by /auth/pin. 3×4 grid of 64 px keys:
// 1–9, a blank, 0 and ⌫. It never submits on its own — PINs are 3–8 digits
// and "123" can be the start of another cook's "1234".

export const PIN_MIN = 3
export const PIN_MAX = 8

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

const KEY = 'h-16 rounded-full font-mono text-[24px] font-medium text-ink select-none touch-manipulation disabled:opacity-40'

export function Keypad({
  length,
  disabled,
  onDigit,
  onBack,
}: {
  length: number
  disabled?: boolean
  onDigit: (d: string) => void
  onBack: () => void
}) {
  const full = length >= PIN_MAX
  const digitKey = (d: string) => (
    <button
      key={d}
      type="button"
      aria-label={d}
      disabled={disabled || full}
      onClick={() => onDigit(d)}
      className={`${KEY} bg-paper border border-line active:bg-bg-2`}
    >
      {d}
    </button>
  )
  return (
    <div className="grid grid-cols-3 gap-3 w-full max-w-[300px]">
      {DIGITS.map(digitKey)}
      <span aria-hidden className="h-16" />
      {digitKey('0')}
      <button
        type="button"
        aria-label="Delete"
        disabled={disabled || length === 0}
        onClick={onBack}
        className={`${KEY} bg-transparent text-[20px] text-ink-3`}
      >
        ⌫
      </button>
    </div>
  )
}

/** One dot per digit typed — no placeholder dots, so the PIN length isn't hinted. */
export function PinDots({ length }: { length: number }) {
  return (
    // The live region announces its text content, so the count lives in a
    // visually hidden child (an aria-label on the region itself is not read out).
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-4 h-8">
      {Array.from({ length }, (_, i) => (
        <span key={i} aria-hidden className="w-4 h-4 rounded-full bg-ink" />
      ))}
      <span className="sr-only">{length} {length === 1 ? 'digit' : 'digits'} typed</span>
    </div>
  )
}
