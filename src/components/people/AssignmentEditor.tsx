'use client'
import type { Role } from '@prisma/client'
import { Check } from 'lucide-react'
import { ROLE_LABELS, assignableLevels } from '@/lib/roles'
import type { LocationNode } from './people-utils'

export interface AssignmentDraft {
  locationId: string | null
  revenueCenterId: string | null
  clearance: Role | null
}

interface Props {
  locations: LocationNode[]
  value: AssignmentDraft[]
  primaryClearance: Role
  actorRole: Role
  onChange: (next: AssignmentDraft[]) => void
}

const keyOf = (d: { locationId: string | null; revenueCenterId: string | null }) =>
  `${d.locationId ?? ''}|${d.revenueCenterId ?? ''}`

/** Per-node override picker. Rendered inline on a selected row. */
function OverridePicker({
  current, primary, actorRole, onPick,
}: {
  current: Role | null
  primary: Role
  actorRole: Role
  onPick: (r: Role | null) => void
}) {
  const options = assignableLevels(actorRole)
  return (
    <select
      value={current ?? ''}
      onChange={e => onPick(e.target.value ? (e.target.value as Role) : null)}
      onClick={e => e.stopPropagation()}
      className="ml-auto text-[10px] font-mono rounded-full border border-line bg-paper px-2 py-1 text-ink-3 focus:outline-none focus:ring-2 focus:ring-gold"
    >
      <option value="">inherit · {ROLE_LABELS[primary]}</option>
      {options.map(r => (
        <option key={r} value={r}>override: {ROLE_LABELS[r]}</option>
      ))}
    </select>
  )
}

export default function AssignmentEditor({
  locations, value, primaryClearance, actorRole, onChange,
}: Props) {
  const selected = new Map(value.map(d => [keyOf(d), d]))

  const toggle = (draft: AssignmentDraft) => {
    const k = keyOf(draft)
    if (selected.has(k)) {
      onChange(value.filter(d => keyOf(d) !== k))
    } else {
      onChange([...value, draft])
    }
  }

  const setClearance = (draft: AssignmentDraft, clearance: Role | null) => {
    const k = keyOf(draft)
    onChange(value.map(d => (keyOf(d) === k ? { ...d, clearance } : d)))
  }

  return (
    <div className="space-y-2">
      {locations.map(loc => {
        const locDraft: AssignmentDraft = {
          locationId: loc.id, revenueCenterId: null, clearance: null,
        }
        const locSelected = selected.get(keyOf(locDraft))

        return (
          <div key={loc.id} className="border border-line rounded-lg overflow-hidden">
            {/* whole-location row */}
            <label className="flex items-center gap-2.5 px-3 py-2.5 border-b border-bg-2 cursor-pointer hover:bg-bg">
              <span
                className={`w-[17px] h-[17px] rounded-sm grid place-items-center shrink-0 ${
                  locSelected ? 'bg-gold text-white' : 'border border-line-2'
                }`}
              >
                {locSelected && <Check size={11} strokeWidth={3} />}
              </span>
              <span
                className="w-5 h-5 rounded grid place-items-center text-[10px] text-white shrink-0"
                style={{ backgroundColor: loc.color }}
              >
                ⌂
              </span>
              <input
                type="checkbox"
                className="sr-only"
                checked={!!locSelected}
                onChange={() => toggle(locDraft)}
              />
              <span className="text-sm font-medium text-ink">
                {loc.name} <span className="text-ink-4 font-normal">· whole location</span>
              </span>
              {locSelected && (
                <OverridePicker
                  current={locSelected.clearance}
                  primary={primaryClearance}
                  actorRole={actorRole}
                  onPick={r => setClearance(locDraft, r)}
                />
              )}
            </label>

            {/* individual RCs */}
            <div className="px-3 pb-2 pt-1 pl-10 space-y-0.5">
              {loc.revenueCenters.length === 0 && (
                <p className="text-xs text-ink-4 py-1">No revenue centers yet.</p>
              )}
              {loc.revenueCenters.map(rc => {
                const rcDraft: AssignmentDraft = {
                  locationId: null, revenueCenterId: rc.id, clearance: null,
                }
                const rcSelected = selected.get(keyOf(rcDraft))
                return (
                  <label
                    key={rc.id}
                    className="flex items-center gap-2.5 py-1.5 cursor-pointer group"
                  >
                    <span
                      className={`w-[15px] h-[15px] rounded-sm grid place-items-center shrink-0 ${
                        rcSelected ? 'bg-gold text-white' : 'border border-line-2'
                      }`}
                    >
                      {rcSelected && <Check size={10} strokeWidth={3} />}
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={!!rcSelected}
                      onChange={() => toggle(rcDraft)}
                    />
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ backgroundColor: rc.color }}
                    />
                    <span className="text-[12.5px] text-ink-2">{rc.name}</span>
                    {rcSelected && (
                      <OverridePicker
                        current={rcSelected.clearance}
                        primary={primaryClearance}
                        actorRole={actorRole}
                        onPick={r => setClearance(rcDraft, r)}
                      />
                    )}
                  </label>
                )
              })}
            </div>
          </div>
        )
      })}

      {locations.length === 0 && (
        <p className="text-xs text-ink-4">
          No locations yet — set one up before assigning people.
        </p>
      )}

      <p className="text-[11.5px] text-ink-4 leading-relaxed">
        Each place inherits the primary clearance. Set a per-place override where it should differ.
      </p>
    </div>
  )
}
