export type VocabType = 'FOOD' | 'DRINK'

interface Vocab {
  costPctLabel: string
  targetLabel: string
  build: string
  menu: string
  inputs: string
}

const VOCAB: Record<VocabType, Vocab> = {
  FOOD:  { costPctLabel: 'Food cost %', targetLabel: 'Target food cost %', build: 'Recipe',   menu: 'Menu',       inputs: 'Ingredients' },
  DRINK: { costPctLabel: 'Pour cost %', targetLabel: 'Target pour cost %', build: 'Cocktail', menu: 'Drink menu', inputs: 'Pours' },
}

export function getVocab(type: string | null | undefined): Vocab {
  return VOCAB[(type as VocabType)] ?? VOCAB.FOOD
}
