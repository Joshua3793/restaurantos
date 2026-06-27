import { lookupDensity } from '../../src/lib/density'

let fails = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fails++ }
  else console.log(`ok   ${label}`)
}

eq('egg yolk',  lookupDensity('Liquid Egg Yolk 11kg'), { gPerMl: 1.03, source: 'library' })
eq('olive oil', lookupDensity('Extra Virgin Olive Oil'), { gPerMl: 0.91, source: 'library' })
eq('honey',     lookupDensity('Clover Honey'), { gPerMl: 1.42, source: 'library' })
eq('unknown',   lookupDensity('Mystery Goo'), { gPerMl: 1.0, source: 'fallback' })
// case-insensitive + first-match-wins on the longest keyword
eq('sesame oil', lookupDensity('SESAME OIL TOASTED'), { gPerMl: 0.92, source: 'library' })

// word-boundary matching: bare keywords must not match inside longer words
eq('eggplant not egg', lookupDensity('Eggplant Diced'), { gPerMl: 1.0, source: 'fallback' })
eq('butternut not butter', lookupDensity('Butternut Squash'), { gPerMl: 1.0, source: 'fallback' })
eq('watermelon not water', lookupDensity('Watermelon Chunks'), { gPerMl: 1.0, source: 'fallback' })
eq('whole egg still matches', lookupDensity('Whole Egg Liquid'), { gPerMl: 1.03, source: 'library' })

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
