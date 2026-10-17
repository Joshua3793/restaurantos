// Recipe Scan: turn the steps the reader found into the recipe's ONE Method.
// Times the page did not state are kept (the chef needs a number to start
// from) but flagged in `guessed` so the review screen can show them as a guess.
import { newStepKey, type MethodStep } from '@/lib/recipe-method'
import type { DraftData, ExtractedStep } from './types'

export function toMethod(steps: ExtractedStep[]): { method: MethodStep[]; guessed: DraftData['guessed'] } {
  const method: MethodStep[] = []
  const guessed: DraftData['guessed'] = {}
  const keys = new Set<string>()
  const freshKey = (): string => {
    let k = newStepKey()
    while (keys.has(k)) k = newStepKey()
    keys.add(k)
    return k
  }

  for (const s of steps) {
    const text = typeof s.text === 'string' ? s.text.trim() : ''
    if (!text) continue // a blank step would fail validateMethod
    const step: MethodStep = { key: freshKey(), text }
    const phase = typeof s.phase === 'string' ? s.phase.trim() : ''
    if (phase) step.phase = phase

    const g: { minutes?: true; wait?: true } = {}
    if (typeof s.minutes === 'number' && Number.isFinite(s.minutes)) {
      const m = Math.round(s.minutes)
      if (m > 0) {
        step.minutes = m
        if (!s.minutesStated) g.minutes = true
      }
    }
    if (typeof s.waitMinutes === 'number' && Number.isFinite(s.waitMinutes) && s.waitMinutes >= 1) {
      step.wait = { minutes: Math.round(s.waitMinutes) }
      const note = typeof s.waitNote === 'string' ? s.waitNote.trim() : ''
      if (note) step.wait.note = note
      if (!s.waitStated) g.wait = true
    }
    if (g.minutes || g.wait) guessed[step.key] = g
    method.push(step)
  }

  // A wait cannot be the last thing: the job ends with the step that logs the yield.
  const last = method[method.length - 1]
  if (last?.wait) {
    const closing: MethodStep = { key: freshKey(), text: 'Label and date.' }
    if (last.phase) closing.phase = last.phase
    method.push(closing)
  }

  return { method, guessed }
}
