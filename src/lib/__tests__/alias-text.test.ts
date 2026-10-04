import { describe, it, expect } from 'vitest'
import { normaliseAliasText, isShoutyName, SHOUTY_HINT } from '@/lib/alias-text'

describe('normaliseAliasText', () => {
  it('lower-cases, turns punctuation into spaces and collapses whitespace', () => {
    expect(normaliseAliasText('GRAPE, RED  Frsh/Seedls (CLAM)')).toBe('grape red frsh seedls clam')
  })
  it('is blank for null, undefined, empty and punctuation-only input', () => {
    expect(normaliseAliasText(null)).toBe('')
    expect(normaliseAliasText(undefined)).toBe('')
    expect(normaliseAliasText('')).toBe('')
    expect(normaliseAliasText('   ')).toBe('')
    expect(normaliseAliasText(' -/, ')).toBe('')
  })
  it('folds accents to plain ascii without splitting the word', () => {
    expect(normaliseAliasText('Crème Brûlée')).toBe('creme brulee')
    expect(normaliseAliasText('JALAPEÑO')).toBe('jalapeno')
  })
  it('keeps digits and folds compatibility forms (NFKD)', () => {
    expect(normaliseAliasText('Bun 12 PK')).toBe('bun 12 pk')
    expect(normaliseAliasText('Ｂｕｎ ½')).toBe('bun 1 2')
  })
  it('gives the same key for two spellings that differ only in punctuation and case', () => {
    expect(normaliseAliasText('Butter, Unsalted 454g')).toBe(normaliseAliasText('BUTTER UNSALTED 454G'))
  })
  it('folds letters NFKD cannot decompose (ß Æ Ø Œ Ð Þ Ł) instead of dropping them', () => {
    expect(normaliseAliasText('Weißwurst')).toBe('weisswurst')
    expect(normaliseAliasText('WEISSWURST')).toBe(normaliseAliasText('WEIẞWURST'))
    expect(normaliseAliasText('Smørrebrød')).toBe('smorrebrod')
    expect(normaliseAliasText('SMØRREBRØD')).toBe('smorrebrod')
    expect(normaliseAliasText('Æbleskiver')).toBe('aebleskiver')
    expect(normaliseAliasText('bœuf, Œuf')).toBe('boeuf oeuf')
    expect(normaliseAliasText('Ðað Þorn')).toBe('dad thorn')
    expect(normaliseAliasText('Łosoś')).toBe('losos')
  })
  it('keeps "10LB" and "10 LB" as different keys on purpose (no digit/letter splitting)', () => {
    expect(normaliseAliasText('POTATO 10LB')).toBe('potato 10lb')
    expect(normaliseAliasText('POTATO 10 LB')).toBe('potato 10 lb')
    expect(normaliseAliasText('POTATO 10LB')).not.toBe(normaliseAliasText('POTATO 10 LB'))
  })
})

describe('isShoutyName', () => {
  it('flags an all-caps invoice wording of 3+ words', () => {
    expect(isShoutyName('GRAPE RED FRSH SEEDLS CLAM')).toBe(true)
    expect(isShoutyName('GRAPE, RED FRSH/SEEDLS (CLAM)')).toBe(true)
  })
  it('lets a plain name through', () => {
    expect(isShoutyName('Red Grapes')).toBe(false)
    expect(isShoutyName('Red Seedless Grapes Clamshell')).toBe(false)
  })
  it('lets short codes through (fewer than 3 words)', () => {
    expect(isShoutyName('GF BUN')).toBe(false)
    expect(isShoutyName('BUTTER')).toBe(false)
  })
  it('ignores digits and punctuation when counting letters', () => {
    expect(isShoutyName('Bun 12 PK')).toBe(false)
    expect(isShoutyName('BUN 12 PK 454G')).toBe(true)
  })
  it('is false for blank or letter-less text', () => {
    expect(isShoutyName('')).toBe(false)
    expect(isShoutyName('12 24 36')).toBe(false)
  })
  it('has a plain-English hint', () => {
    expect(SHOUTY_HINT).toContain('Red Grapes')
  })
})
