import { describe, it, expect } from 'vitest'
import { parseItemInput, parseName, isPaletteColor } from '@/lib/checklists/item-input'

const base = {
  title: 'Lowboy temp',
  howTo: 'Probe the middle shelf',
  isBlocker: true,
  answer: 'NUMBER',
  unit: '°C',
  safeMin: 0,
  safeMax: 4,
  tempUnitId: null,
  days: 127,
  categoryId: 'c1',
}

const err = (body: unknown) => {
  const r = parseItemInput(body)
  if (r.ok) throw new Error('expected an error')
  return r.error
}
const ok = (body: unknown) => {
  const r = parseItemInput(body)
  if (!r.ok) throw new Error(r.error)
  return r.data
}

describe('parseItemInput', () => {
  it('a valid NUMBER item round-trips', () => {
    expect(ok(base)).toEqual({
      title: 'Lowboy temp', howTo: 'Probe the middle shelf', isBlocker: true, answer: 'NUMBER',
      unit: '°C', safeMin: 0, safeMax: 4, tempUnitId: null, days: 127, categoryId: 'c1',
    })
  })

  it('a valid TICK item round-trips and drops unit, range and Temps unit', () => {
    expect(ok({ ...base, answer: 'TICK', tempUnitId: 't1', isBlocker: false, howTo: '  ' })).toEqual({
      title: 'Lowboy temp', howTo: null, isBlocker: false, answer: 'TICK',
      unit: null, safeMin: null, safeMax: null, tempUnitId: null, days: 127, categoryId: 'c1',
    })
  })

  it('a valid TEMP item round-trips; unit and range come from the Temps unit', () => {
    expect(ok({ ...base, answer: 'TEMP', tempUnitId: 't1', unit: '°F', safeMin: 3, safeMax: 1 })).toEqual({
      title: 'Lowboy temp', howTo: 'Probe the middle shelf', isBlocker: true, answer: 'TEMP',
      unit: null, safeMin: null, safeMax: null, tempUnitId: 't1', days: 127, categoryId: 'c1',
    })
  })

  it('trims the title and the how-to', () => {
    const d = ok({ ...base, title: '  Lowboy temp  ', howTo: '  Probe it  ' })
    expect(d.title).toBe('Lowboy temp')
    expect(d.howTo).toBe('Probe it')
  })

  it('title: 1–120 characters after trimming', () => {
    expect(err({ ...base, title: '' })).toBe('Give the job a name')
    expect(err({ ...base, title: '   ' })).toBe('Give the job a name')
    expect(err({ ...base, title: undefined })).toBe('Give the job a name')
    expect(err({ ...base, title: 42 })).toBe('Give the job a name')
    expect(err({ ...base, title: 'x'.repeat(121) })).toBe('Give the job a name')
    expect(ok({ ...base, title: 'x'.repeat(120) }).title).toHaveLength(120)
    expect(ok({ ...base, title: 'x' }).title).toBe('x')
  })

  it('a body that is not an object asks for a name', () => {
    expect(err(null)).toBe('Give the job a name')
    expect(err('hello')).toBe('Give the job a name')
  })

  it('days: an integer 1–127', () => {
    expect(err({ ...base, days: 0 })).toBe('Pick at least one day')
    expect(err({ ...base, days: 128 })).toBe('Pick at least one day')
    expect(err({ ...base, days: 1.5 })).toBe('Pick at least one day')
    expect(err({ ...base, days: '127' })).toBe('Pick at least one day')
    expect(err({ ...base, days: undefined })).toBe('Pick at least one day')
    expect(ok({ ...base, days: 1 }).days).toBe(1)
    expect(ok({ ...base, days: 127 }).days).toBe(127)
  })

  it('NUMBER needs a unit', () => {
    expect(err({ ...base, unit: '' })).toBe('Add a unit, e.g. °C')
    expect(err({ ...base, unit: '   ' })).toBe('Add a unit, e.g. °C')
    expect(err({ ...base, unit: null })).toBe('Add a unit, e.g. °C')
    expect(ok({ ...base, unit: ' PPM ' }).unit).toBe('PPM')
  })

  it('NUMBER: min must not be above max when both are set', () => {
    expect(err({ ...base, safeMin: 5, safeMax: 4 })).toBe('Safe range is back to front')
    expect(ok({ ...base, safeMin: 4, safeMax: 4 })).toMatchObject({ safeMin: 4, safeMax: 4 })
  })

  it('NUMBER: a one-sided or empty range is fine', () => {
    expect(ok({ ...base, safeMin: 60, safeMax: null })).toMatchObject({ safeMin: 60, safeMax: null })
    expect(ok({ ...base, safeMin: null, safeMax: 4 })).toMatchObject({ safeMin: null, safeMax: 4 })
    expect(ok({ ...base, safeMin: '', safeMax: undefined })).toMatchObject({ safeMin: null, safeMax: null })
  })

  it('NUMBER: typed text is read as a number (comma decimal ok); other text is refused', () => {
    expect(ok({ ...base, safeMin: '-18', safeMax: '2,5' })).toMatchObject({ safeMin: -18, safeMax: 2.5 })
    expect(err({ ...base, safeMin: 'cold' })).toBe('The safe range must be numbers')
    expect(err({ ...base, safeMax: Number.NaN })).toBe('The safe range must be numbers')
  })

  it('NUMBER drops a stray Temps unit', () => {
    expect(ok({ ...base, tempUnitId: 't1' }).tempUnitId).toBeNull()
  })

  it('TEMP needs a Temps unit', () => {
    expect(err({ ...base, answer: 'TEMP', tempUnitId: null })).toBe('Pick a fridge or unit')
    expect(err({ ...base, answer: 'TEMP', tempUnitId: '' })).toBe('Pick a fridge or unit')
    expect(err({ ...base, answer: 'TEMP' })).toBe('Pick a fridge or unit')
  })

  it('the answer must be one of the three kinds', () => {
    expect(err({ ...base, answer: 'PHOTO' })).toBe('Pick how the cook answers')
    expect(err({ ...base, answer: undefined })).toBe('Pick how the cook answers')
  })

  it('needs a category', () => {
    expect(err({ ...base, categoryId: '' })).toBe('Pick a category')
    expect(err({ ...base, categoryId: undefined })).toBe('Pick a category')
  })

  it('a long how-to is refused', () => {
    expect(err({ ...base, howTo: 'x'.repeat(1001) })).toBe('Keep the how-to under 1000 characters')
    expect(ok({ ...base, howTo: 'x'.repeat(1000) }).howTo).toHaveLength(1000)
  })

  it('isBlocker is true only for literal true', () => {
    expect(ok({ ...base, isBlocker: 'yes' }).isBlocker).toBe(false)
    expect(ok({ ...base, isBlocker: undefined }).isBlocker).toBe(false)
  })
})

describe('parseName', () => {
  it('trims and keeps 1–40 characters', () => {
    expect(parseName('  Grill ', 'Give the station a name')).toEqual({ ok: true, name: 'Grill' })
    expect(parseName('', 'Give the station a name')).toEqual({ ok: false, error: 'Give the station a name' })
    expect(parseName('  ', 'm')).toEqual({ ok: false, error: 'm' })
    expect(parseName(7, 'm')).toEqual({ ok: false, error: 'm' })
    expect(parseName('x'.repeat(41), 'm')).toEqual({ ok: false, error: 'm' })
    expect(parseName('x'.repeat(40), 'm')).toEqual({ ok: true, name: 'x'.repeat(40) })
  })
})

describe('isPaletteColor', () => {
  it('accepts only the 8 palette colours', () => {
    expect(isPaletteColor('#dc2626')).toBe(true)
    expect(isPaletteColor('#DC2626')).toBe(false)
    expect(isPaletteColor('#000000')).toBe(false)
    expect(isPaletteColor(undefined)).toBe(false)
  })
})
