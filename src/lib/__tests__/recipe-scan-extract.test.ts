import { describe, it, expect, vi, beforeEach } from 'vitest'

// The reader's request shape and instructions. The Claude call itself is mocked.
const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reply: null as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: [] as any[],
  create: 0,
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: (p: any) => { h.params.push(p); return { finalMessage: async () => h.reply } },
      create: async () => { h.create++; return h.reply },
    }
  },
}))
vi.mock('@/lib/invoice-ocr', () => ({
  resolveAnthropicKey: () => 'test-key',
  compressImageForClaude: async (data: string) => ({ mediaType: 'image/jpeg', data }),
}))

import { SYSTEM_PROMPT, RECORD_RECIPES_TOOL, extractRecipes } from '../recipe-scan/extract'
import { NotARecipeError, ScanTooLongError } from '../recipe-scan/parse'

const RECIPE = {
  name: 'Aioli', yieldQty: null, yieldUnit: null, categoryHint: null,
  ingredients: [{ raw: '2 egg yolks', qty: 2, unit: 'each', name: 'egg yolk' }], steps: [],
}
const toolReply = (stop = 'tool_use') => ({
  stop_reason: stop,
  content: [{ type: 'tool_use', name: 'record_recipes', input: { recipes: [RECIPE] } }],
})

beforeEach(() => { h.params = []; h.create = 0; h.reply = toolReply(); vi.restoreAllMocks() })

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

/** Every object schema in the tool, however deep. */
function objectSchemas(s: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(s)) { s.forEach(x => objectSchemas(x, out)); return out }
  if (s && typeof s === 'object') {
    const o = s as Record<string, unknown>
    const t = o.type
    if (t === 'object' || (Array.isArray(t) && t.includes('object'))) out.push(o)
    Object.values(o).forEach(v => objectSchemas(v, out))
  }
  return out
}

describe('the read request', () => {
  it('streams with room for thinking plus a long chapter, and no sampling settings', async () => {
    await extractRecipes({ text: 'Aioli: 2 egg yolks' })
    expect(h.create).toBe(0)
    expect(h.params).toHaveLength(1)
    const p = h.params[0]
    expect(p.model).toBe('claude-sonnet-5-5')
    expect(p.max_tokens).toBe(64000)
    expect(p.tool_choice).toEqual({ type: 'auto' })
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) expect(p).not.toHaveProperty(k)
  })
  it('the record_recipes tool is strict and closes every object', async () => {
    await extractRecipes({ text: 'x' })
    const tool = h.params[0].tools[0]
    expect(tool.strict).toBe(true)
    const objs = objectSchemas(tool.input_schema)
    expect(objs.length).toBe(5) // input, recipe, ingredient, estimate, step
    for (const o of objs) expect(o.additionalProperties).toBe(false)
  })
  it('returns the recipes from the tool call', async () => {
    const out = await extractRecipes({ text: 'x' })
    expect(out.map(r => r.name)).toEqual(['Aioli'])
  })
  it('a cut-off reply is still "too much to read"', async () => {
    h.reply = { stop_reason: 'max_tokens', content: [] }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(extractRecipes({ text: 'x' })).rejects.toBeInstanceOf(ScanTooLongError)
    expect(warn).toHaveBeenCalledTimes(1)
  })
  it('a reply with no tool call logs once and reads as no recipe', async () => {
    for (const stop of ['end_turn', 'refusal']) {
      h.reply = { stop_reason: stop, content: [{ type: 'text', text: 'Sorry' }] }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(extractRecipes({ text: 'x' })).rejects.toBeInstanceOf(NotARecipeError)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain(stop)
      warn.mockRestore()
    }
  })
  it('a normal reply logs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await extractRecipes({ text: 'x' })
    expect(warn).not.toHaveBeenCalled()
  })
})
