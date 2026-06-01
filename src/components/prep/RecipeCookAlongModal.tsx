'use client'

import { useEffect, useState } from 'react'
import type { RecipeStepsData, IngredientAvailability } from '@/components/prep/types'
import { IcX, IcCheck, IcPlus, IcSync } from '@/components/prep/icons'

interface RecipeCookAlongModalProps {
  open: boolean
  recipe: RecipeStepsData | null
  ingredients: IngredientAvailability[]
  initialMakeQty: number
  unit: string
  onClose: () => void
  onAddToPrep: (qty: number) => void
  /** Open a sub-recipe ingredient's recipe (e.g. tap "Custard" inside French Toast). */
  onOpenSubRecipe?: (recipeId: string, name: string) => void
}

const SLIDER_MIN = 0.25
const SLIDER_MAX = 5

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function fmtAmt(n: number): string {
  let s: string
  if (n >= 100) s = Math.round(n).toLocaleString()
  else if (n >= 10) s = (Math.round(n * 10) / 10).toString()
  else s = (Math.round(n * 100) / 100).toString()
  // strip trailing .0
  if (s.endsWith('.0')) s = s.slice(0, -2)
  return s
}

function ProgressBar({ frac }: { frac: number }) {
  return (
    <span className="w-[54px] h-[5px] bg-bg-2 rounded-full overflow-hidden inline-block">
      <span
        className="block h-full bg-green rounded-full transition-[width] duration-200"
        style={{ width: `${Math.round(frac * 100)}%` }}
      />
    </span>
  )
}

interface IngRowProps {
  ing: IngredientAvailability
  factor: number
  checked: boolean
  onToggle: () => void
  onOpenSubRecipe?: (recipeId: string, name: string) => void
}

function IngRow({ ing, factor, checked, onToggle, onOpenSubRecipe }: IngRowProps) {
  const isSub = !!ing.linkedRecipeId && !!onOpenSubRecipe
  return (
    <div className="flex items-center gap-3 w-full px-2.5 py-2.5 rounded-[9px] border-b border-bg-2 last:border-0 hover:bg-bg">
      <button
        type="button"
        onClick={onToggle}
        title={checked ? 'Uncheck' : 'Check off'}
        className={`w-6 h-6 rounded-[7px] border-2 grid place-items-center flex-shrink-0 ${
          checked ? 'bg-green border-green text-white' : 'border-line-2'
        }`}
      >
        {checked && <IcCheck size={13} strokeWidth={3} />}
      </button>
      {isSub ? (
        <button
          type="button"
          onClick={() => onOpenSubRecipe!(ing.linkedRecipeId!, ing.itemName)}
          title="Open sub-recipe"
          className={`flex-1 min-w-0 text-left text-sm font-medium inline-flex items-center gap-1.5 ${
            checked ? 'text-ink-4 line-through' : 'text-gold-2 hover:underline'
          }`}
        >
          <span className="truncate">{ing.itemName}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
            <path d="M7 17 17 7M8 7h9v9" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          className={`flex-1 min-w-0 text-left text-sm font-medium truncate ${
            checked ? 'text-ink-4 line-through' : 'text-ink'
          }`}
        >
          {ing.itemName}
        </button>
      )}
      {!ing.isAvailable && (
        <span className="font-mono text-[9.5px] text-red-text bg-red-soft px-1.5 py-px rounded font-semibold uppercase shrink-0">
          out
        </span>
      )}
      <span
        className={`font-mono text-[14.5px] font-semibold min-w-[82px] text-right shrink-0 ${
          checked ? 'text-ink-4' : 'text-ink'
        }`}
      >
        {fmtAmt(Number(ing.qtyBase) * factor)}
        <span className="text-ink-3 font-normal text-[11px] ml-0.5">{ing.unit}</span>
      </span>
    </div>
  )
}

interface StepRowProps {
  index: number
  text: string
  done: boolean
  onToggle: () => void
}

function StepRow({ index, text, done, onToggle }: StepRowProps) {
  return (
    <li
      onClick={onToggle}
      className="flex gap-3.5 items-start px-2.5 py-3 rounded-[10px] cursor-pointer hover:bg-bg"
    >
      <span
        className={`w-[27px] h-[27px] rounded-lg font-mono text-xs font-semibold grid place-items-center flex-shrink-0 ${
          done ? 'bg-green text-white' : 'bg-gold-soft text-gold-2'
        }`}
      >
        {done ? <IcCheck size={14} strokeWidth={3} /> : index + 1}
      </span>
      <span
        className={`text-[13.5px] leading-[1.5] pt-0.5 ${
          done ? 'text-ink-4 line-through' : 'text-ink-2'
        }`}
      >
        {text}
      </span>
    </li>
  )
}

export default function RecipeCookAlongModal({
  open,
  recipe,
  ingredients,
  initialMakeQty,
  unit,
  onClose,
  onAddToPrep,
  onOpenSubRecipe,
}: RecipeCookAlongModalProps) {
  const [makeQty, setMakeQty] = useState(initialMakeQty)
  const [checkedIngredients, setCheckedIngredients] = useState<Set<number>>(new Set())
  const [doneSteps, setDoneSteps] = useState<Set<number>>(new Set())

  // Reset on open / recipe change. Default the making scale to ×1 (a full base
  // batch) every time a recipe opens; the chef can scale up/down from there.
  useEffect(() => {
    if (!open || !recipe) return
    const base = recipe.baseYieldQty > 0 ? recipe.baseYieldQty : 1
    setMakeQty(base)
    setCheckedIngredients(new Set())
    setDoneSteps(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe?.id, open])

  // Escape closes
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !recipe) return null

  const factor = recipe.baseYieldQty > 0 ? makeQty / recipe.baseYieldQty : 0
  const sliderValue = clamp(factor, SLIDER_MIN, SLIDER_MAX)
  const batchCost = recipe.totalCost * factor
  const costPerYield = recipe.baseYieldQty > 0 ? recipe.totalCost / recipe.baseYieldQty : 0
  const tubs = Math.ceil(makeQty / 2)

  const ingTotal = ingredients.length
  const ingChecked = checkedIngredients.size
  const allChecked = ingTotal > 0 && ingChecked === ingTotal

  const stepTotal = recipe.steps.length
  const stepDone = doneSteps.size

  const toggleIngredient = (idx: number) => {
    setCheckedIngredients((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const toggleStep = (idx: number) => {
    setDoneSteps((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const toggleAllIngredients = () => {
    if (allChecked) setCheckedIngredients(new Set())
    else setCheckedIngredients(new Set(ingredients.map((_, i) => i)))
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-[rgba(9,9,11,0.5)] backdrop-blur-[3px] grid place-items-center p-3 sm:p-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-label="Recipe"
        className="w-full max-w-[660px] max-h-[90vh] bg-paper rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* HEAD */}
        <div className="px-[22px] pt-5 pb-[18px] border-b border-line flex items-start gap-3.5">
          <div className="w-[38px] h-[38px] rounded-[10px] bg-ink text-gold grid place-items-center flex-shrink-0">
            <IcSync size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[19px] font-semibold tracking-[-0.02em]">{recipe.name}</div>
            <div className="font-mono text-[11px] text-ink-3 mt-[5px]">
              Base yield {recipe.baseYieldQty} {recipe.yieldUnit} · ${recipe.totalCost.toFixed(2)} / batch
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg border border-line grid place-items-center flex-shrink-0 text-ink-2 hover:border-ink-3"
            aria-label="Close"
          >
            <IcX size={15} />
          </button>
        </div>

        {/* BODY */}
        <div className="flex-1 overflow-auto px-[22px] pt-[18px] pb-5">
          {/* SCALE */}
          <div className="flex items-center gap-3.5 px-3.5 py-3 bg-[#fff7ed] border border-[#fed7aa] rounded-[10px] mb-3.5">
            <div className="text-[10.5px] uppercase text-gold-2 font-semibold tracking-[0.04em] flex-shrink-0">
              Making
            </div>
            <input
              type="range"
              min={SLIDER_MIN}
              max={SLIDER_MAX}
              step={0.25}
              value={sliderValue}
              onChange={(e) => setMakeQty(parseFloat(e.target.value) * recipe.baseYieldQty)}
              className="flex-1 accent-gold"
            />
            <div className="text-right min-w-[96px] flex-shrink-0">
              <div className="font-mono text-[17px] font-semibold">
                {makeQty.toFixed(1)} {unit}
              </div>
              <div className="font-mono text-[10.5px] text-gold-2">×{factor.toFixed(2)} of base</div>
            </div>
          </div>

          {/* COST line */}
          <div className="flex items-center gap-2 mt-3.5 text-[12.5px] text-ink-3">
            This batch{' '}
            <b className="font-mono text-[15px] text-ink font-semibold">${batchCost.toFixed(2)}</b>
            <span className="font-mono text-[11.5px] text-ink-3">
              · ${costPerYield.toFixed(2)} / {recipe.yieldUnit} · {tubs} tubs
            </span>
          </div>

          {/* GATHER INGREDIENTS */}
          <div className="mt-[22px]">
            <div className="flex justify-between items-center font-mono text-[10px] uppercase text-ink-3 mb-2 px-0.5 tracking-[0.05em]">
              <span>Gather ingredients</span>
              <span className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={toggleAllIngredients}
                  className="text-gold-2 font-semibold uppercase tracking-[0.03em] hover:underline"
                >
                  {allChecked ? 'Uncheck all' : 'Check all'}
                </button>
                <span className="inline-flex items-center gap-[7px] text-ink-2 font-semibold">
                  {ingChecked} / {ingTotal}
                  <ProgressBar frac={ingTotal > 0 ? ingChecked / ingTotal : 0} />
                </span>
              </span>
            </div>
            <div className="flex flex-col">
              {ingredients.map((ing, idx) => (
                <IngRow
                  key={ing.id}
                  ing={ing}
                  factor={factor}
                  checked={checkedIngredients.has(idx)}
                  onToggle={() => toggleIngredient(idx)}
                  onOpenSubRecipe={onOpenSubRecipe}
                />
              ))}
            </div>
          </div>

          {/* METHOD */}
          {stepTotal > 0 && (
            <div className="mt-[22px]">
              <div className="flex justify-between items-center font-mono text-[10px] uppercase text-ink-3 mb-2 px-0.5 tracking-[0.05em]">
                <span>Method · tick as you go</span>
                <span className="inline-flex items-center gap-[7px] text-ink-2 font-semibold">
                  {stepDone} / {stepTotal}
                  <ProgressBar frac={stepTotal > 0 ? stepDone / stepTotal : 0} />
                </span>
              </div>
              <ol className="m-0 p-0 list-none flex flex-col gap-[3px]">
                {recipe.steps.map((step, idx) => (
                  <StepRow
                    key={idx}
                    index={idx}
                    text={step}
                    done={doneSteps.has(idx)}
                    onToggle={() => toggleStep(idx)}
                  />
                ))}
              </ol>
            </div>
          )}
        </div>

        {/* FOOT */}
        <div className="border-t border-line px-[22px] py-3.5 flex items-center justify-between gap-3 bg-bg">
          <div className="text-[12.5px] text-ink-3">
            This batch ·{' '}
            <b className="font-mono text-base text-ink font-semibold">${batchCost.toFixed(2)}</b>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="bg-paper border border-line h-[42px] px-4 rounded-[10px] text-[13px] font-medium"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => {
                onAddToPrep(makeQty)
                onClose()
              }}
              className="bg-ink text-paper h-[42px] px-[18px] rounded-[10px] text-[13px] font-semibold inline-flex items-center gap-2"
            >
              <IcPlus size={15} strokeWidth={2.4} className="text-gold" />
              Add {fmtAmt(makeQty)} {unit} to prep
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
