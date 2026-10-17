import { describe, it, expect, vi } from 'vitest'

// The reader's instructions and tool shape. The Claude call itself is mocked.
vi.mock('@/lib/invoice-ocr', () => ({
  resolveAnthropicKey: () => 'test-key',
  compressImageForClaude: async (data: string) => ({ mediaType: 'image/jpeg', data }),
}))

import { SYSTEM_PROMPT, RECORD_RECIPES_TOOL } from '../recipe-scan/extract'

describe('reader instructions — estimates across weight and volume', () => {
  it('asks for a gram estimate when a dry or solid good is measured by volume', () => {
    expect(SYSTEM_PROMPT).toMatch(/dry or solid ingredient measured by volume/)
    expect(SYSTEM_PROMPT).toMatch(/"2 cups flour" -> \{ qty: 250, unit: "g" \}/)
  })
  it('asks for an ml estimate when a liquid is measured by weight', () => {
    expect(SYSTEM_PROMPT).toMatch(/liquid measured by weight/)
    expect(SYSTEM_PROMPT).toMatch(/unit: "ml"/)
  })
  it('the estimate is still only grams or ml', () => {
    const est = RECORD_RECIPES_TOOL.input_schema.properties.recipes.items.properties.ingredients.items.properties.estimate
    expect(est.properties.unit.enum).toEqual(['g', 'ml'])
    expect(est.description).toMatch(/dry\/solid good measured by volume/)
  })
})
