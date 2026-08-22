'use client'
import type { Person } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { EmptyTab, Field, WarningNote, inputClass, useSave } from './kit'

interface Props {
  person: Person
  payload: PeopleHubPayload
  /** `nextKey` re-selects a person whose key changed (link/unlink) — unused here, but the shared contract. */
  onChanged: (nextKey?: string) => void
}

export default function PrepTab({ person, payload, onChanged }: Props) {
  const { busy, error, warning, save } = useSave(onChanged)
  const roster = person.roster

  if (!roster) {
    return (
      <EmptyTab
        title="Not on the kitchen roster"
        body="Add them to the roster on the Identity tab to assign prep work and include them in the tip pool."
      />
    )
  }

  const patch = (body: Record<string, unknown>) =>
    save(() => fetch(`/api/prep/cooks/${roster.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))

  return (
    <div className="px-5 py-5 space-y-5">
      <Field label="Home station" hint="Where the run sheet defaults their work. Stations are edited in Prep settings.">
        <select
          value={roster.homeStation ?? ''}
          disabled={busy}
          onChange={e => patch({ homeStation: e.target.value || null })}
          className={inputClass}
        >
          <option value="">No station</option>
          {payload.stations.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>

      <Field
        label="Run-sheet position"
        hint="Order this person appears in prep assignment lists. Reorder with the ↑/↓ handles in the Roster view of the list."
      >
        <input value={roster.sortOrder + 1} readOnly className={`${inputClass} bg-bg text-ink-3 w-24`} />
      </Field>

      <div className="flex items-center justify-between border border-line rounded-[10px] px-4 py-3">
        <span>
          <b className="block text-[13px] text-ink">On the kitchen roster</b>
          <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
            {roster.isActive
              ? 'Appears in prep assignment lists.'
              : 'Hidden from prep assignment lists. Tip history is kept.'}
          </span>
        </span>
        <button
          onClick={() => patch({ isActive: !roster.isActive })}
          disabled={busy}
          className={`shrink-0 px-3.5 py-1.5 rounded-full text-[12px] font-semibold disabled:opacity-50 ${
            roster.isActive ? 'bg-green-soft text-green-text' : 'bg-bg-2 text-ink-3'
          }`}
        >
          {roster.isActive ? 'On' : 'Off'}
        </button>
      </div>

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
