'use client'
import { useState } from 'react'
import type { Person } from '@/lib/people'
import { personWarnings } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { EmptyTab, Field, WarningNote, inputClass, useSave } from './kit'

interface Props {
  person: Person
  payload: PeopleHubPayload
  /** `nextKey` re-selects a person whose key changed (link/unlink) — unused here, but the shared contract. */
  onChanged: (nextKey?: string) => void
}

/**
 * Clock ID / daily-hour-cap / wage are uncontrolled (`defaultValue` +
 * `onBlur`) so typing feels normal — no re-render fights the caret on every
 * keystroke. `defaultValue` only seeds the DOM at mount, though, so once the
 * SAME field has been saved once, the input never notices the server
 * normalised the value (trimmed `clockId`, rounded `dailyHourCap`) unless it
 * remounts.
 *
 * `rev` forces that remount. It bumps exactly once, right after THIS field's
 * own save round-trip resolves successfully — never mid-keystroke, because
 * the input is `disabled` for the whole round-trip and so cannot be focused
 * when the bump lands. Folding `rev` into the `key` (alongside the current
 * prop value) covers both directions: the prop-value half catches the case
 * where the parent's refetch lands the real, different value a tick after
 * the bump; the `rev` half catches the case the prop-value half alone would
 * miss — normalisation collapsing back to the SAME stored value (`" 123 "` ->
 * `"123"` when the field already held `"123"`), where the prop never changes
 * at all and only forcing a remount corrects the stale padded text on screen.
 */
function useResyncRev() {
  const [rev, setRev] = useState(0)
  return [rev, () => setRev(r => r + 1)] as const
}

export default function TipsTab({ person, payload, onChanged }: Props) {
  const { busy, error, warning, save } = useSave(onChanged)
  const roster = person.roster
  const [clockIdRev, bumpClockIdRev] = useResyncRev()
  const [capRev, bumpCapRev] = useResyncRev()
  const [wageRev, bumpWageRev] = useResyncRev()

  if (!roster) {
    return (
      <EmptyTab
        title="Not on the kitchen roster"
        body="Tip payouts are driven by the roster. Add them on the Identity tab first."
      />
    )
  }

  const patch = (body: Record<string, unknown>) =>
    save(() => fetch(`/api/tips/roster/${roster.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))

  // personWarnings() is the single source of the on-pool-without-clock-ID
  // check — the list row's ⚠ badge computes off the same function, so the
  // tab and the row can never disagree about who is a silent zero.
  const poolWarning = personWarnings(person).find(w => w.code === 'POOL_NO_CLOCK')

  return (
    <div className="px-5 py-5 space-y-5">
      <div className="flex items-center justify-between border border-line rounded-[10px] px-4 py-3">
        <span>
          <b className="block text-[13px] text-ink">On the tip pool</b>
          <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
            Turn off to keep someone on the roster but out of the payout.
          </span>
        </span>
        <button
          onClick={() => patch({ onTipPool: !roster.onTipPool })}
          disabled={busy}
          className={`shrink-0 px-3.5 py-1.5 rounded-full text-[12px] font-semibold disabled:opacity-50 ${
            roster.onTipPool ? 'bg-green-soft text-green-text' : 'bg-bg-2 text-ink-3'
          }`}
        >
          {roster.onTipPool ? 'On pool' : 'Off pool'}
        </button>
      </div>

      {poolWarning && <WarningNote>{poolWarning.message}</WarningNote>}

      <Field
        label="Clock ID"
        hint="The POS employee number. Hours match on this and nothing else — never on a name."
      >
        <input
          key={`${clockIdRev}:${roster.clockId ?? ''}`}
          defaultValue={roster.clockId ?? ''}
          disabled={busy}
          placeholder="—"
          onBlur={async e => {
            const next = e.target.value
            if (next === (roster.clockId ?? '')) return
            if (await patch({ clockId: next })) bumpClockIdRev()
          }}
          className={inputClass}
        />
      </Field>

      <Field label="Tip role" hint="The multiplier applied to this person's hours in the split.">
        <select
          value={roster.tipRoleId ?? ''}
          disabled={busy}
          onChange={e => patch({ tipRoleId: e.target.value || null })}
          className={inputClass}
        >
          <option value="">No role</option>
          {payload.tipRoles.map(r => (
            <option key={r.id} value={r.id}>{r.name} — ×{r.multiplier}</option>
          ))}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Daily hour cap"
          hint="Contracted shift length. Hours above this on any single day are not paid tips. Blank = uncapped."
        >
          <input
            key={`${capRev}:${roster.dailyHourCap ?? ''}`}
            // Server rejects `v <= 0` — a cap of exactly 0 is never valid,
            // blank (uncapped) is a separate null case handled below. min is
            // the smallest step-aligned value above 0, so the control never
            // invites a value the route always 400s on.
            type="number" step="0.25" min="0.25" max="24"
            defaultValue={roster.dailyHourCap ?? ''}
            disabled={busy}
            placeholder="uncapped"
            onBlur={async e => {
              const next = e.target.value === '' ? null : e.target.value
              if (String(next ?? '') === String(roster.dailyHourCap ?? '')) return
              if (await patch({ dailyHourCap: next })) bumpCapRev()
            }}
            className={inputClass}
          />
        </Field>

        <Field label="Wage" hint="Reference only — never affects the split.">
          <input
            key={`${wageRev}:${roster.wage ?? ''}`}
            type="number" step="0.25" min="0"
            defaultValue={roster.wage ?? ''}
            disabled={busy}
            placeholder="—"
            onBlur={async e => {
              const next = e.target.value === '' ? null : e.target.value
              if (String(next ?? '') === String(roster.wage ?? '')) return
              if (await patch({ wage: next })) bumpWageRev()
            }}
            className={inputClass}
          />
        </Field>
      </div>

      <p className="text-[11px] text-ink-4 leading-relaxed">
        The house-wide default cap in Tip settings is a prefill for new roster rows only — the cap
        that actually applies is the one on this page.
      </p>

      {error && (
        <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-line rounded-[10px]">
          <span className="text-red-text">⚠</span>
          <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
        </div>
      )}
      {warning && <WarningNote>{warning}</WarningNote>}
    </div>
  )
}
