import { describe, it, expect } from 'vitest'
import { resolveEffective, type RcNode, type ScopeRow } from '../access-model'

// Downtown has two RCs, Uptown has one.
const RCS: RcNode[] = [
  { id: 'rc-kitchen', name: 'Kitchen',       locationId: 'loc-dt', locationName: 'Downtown' },
  { id: 'rc-dtbar',   name: 'Downtown Bar',  locationId: 'loc-dt', locationName: 'Downtown' },
  { id: 'rc-rooftop', name: 'Rooftop Bar',   locationId: 'loc-up', locationName: 'Uptown'   },
]

const byRc = (out: ReturnType<typeof resolveEffective>) =>
  Object.fromEntries(out.map(e => [e.rcId, e.clearance]))

describe('resolveEffective', () => {
  it('returns nothing when there are no assignments', () => {
    expect(resolveEffective('MANAGER', [], RCS)).toEqual([])
  })

  it('expands a location assignment to every child RC at the inherited clearance', () => {
    const scopes: ScopeRow[] = [{ locationId: 'loc-dt', revenueCenterId: null, clearance: null }]
    const out = resolveEffective('MANAGER', scopes, RCS)
    expect(out).toHaveLength(2)
    expect(byRc(out)).toEqual({ 'rc-kitchen': 'MANAGER', 'rc-dtbar': 'MANAGER' })
    expect(out.every(e => e.source === 'inherited')).toBe(true)
  })

  it('marks a location assignment carrying its own clearance as an override', () => {
    const scopes: ScopeRow[] = [{ locationId: 'loc-dt', revenueCenterId: null, clearance: 'STAFF' }]
    const out = resolveEffective('MANAGER', scopes, RCS)
    expect(byRc(out)).toEqual({ 'rc-kitchen': 'STAFF', 'rc-dtbar': 'STAFF' })
    expect(out.every(e => e.source === 'override')).toBe(true)
  })

  it('resolves a single-RC assignment', () => {
    const scopes: ScopeRow[] = [{ locationId: null, revenueCenterId: 'rc-kitchen', clearance: null }]
    const out = resolveEffective('LEAD', scopes, RCS)
    expect(byRc(out)).toEqual({ 'rc-kitchen': 'LEAD' })
  })

  it('lets an RC-level override beat the location assignment above it', () => {
    // The T3 example: Manager at Downtown, Staff override at Rooftop (Uptown).
    const scopes: ScopeRow[] = [
      { locationId: 'loc-dt', revenueCenterId: null,        clearance: null },
      { locationId: null,     revenueCenterId: 'rc-rooftop', clearance: 'STAFF' },
    ]
    const out = resolveEffective('MANAGER', scopes, RCS)
    expect(byRc(out)).toEqual({
      'rc-kitchen': 'MANAGER', 'rc-dtbar': 'MANAGER', 'rc-rooftop': 'STAFF',
    })
    expect(out.find(e => e.rcId === 'rc-rooftop')!.source).toBe('override')
  })

  it('prefers the RC-level row even when it is weaker than the location row', () => {
    const scopes: ScopeRow[] = [
      { locationId: 'loc-dt', revenueCenterId: null,         clearance: null },
      { locationId: null,     revenueCenterId: 'rc-kitchen', clearance: 'STAFF' },
    ]
    expect(byRc(resolveEffective('MANAGER', scopes, RCS))['rc-kitchen']).toBe('STAFF')
  })

  it('takes the higher clearance when two rows of equal specificity overlap', () => {
    const scopes: ScopeRow[] = [
      { locationId: 'loc-dt', revenueCenterId: null, clearance: 'STAFF'   },
      { locationId: 'loc-dt', revenueCenterId: null, clearance: 'MANAGER' },
    ]
    expect(byRc(resolveEffective('LEAD', scopes, RCS))['rc-kitchen']).toBe('MANAGER')
  })

  it('ignores assignments pointing at unknown or inactive nodes', () => {
    const scopes: ScopeRow[] = [
      { locationId: 'loc-gone', revenueCenterId: null,      clearance: null },
      { locationId: null,       revenueCenterId: 'rc-gone', clearance: null },
    ]
    expect(resolveEffective('MANAGER', scopes, RCS)).toEqual([])
  })

  it('carries location naming through for display', () => {
    const scopes: ScopeRow[] = [{ locationId: null, revenueCenterId: 'rc-rooftop', clearance: null }]
    const [entry] = resolveEffective('STAFF', scopes, RCS)
    expect(entry).toMatchObject({
      rcId: 'rc-rooftop', rcName: 'Rooftop Bar',
      locationId: 'loc-up', locationName: 'Uptown',
    })
  })
})
