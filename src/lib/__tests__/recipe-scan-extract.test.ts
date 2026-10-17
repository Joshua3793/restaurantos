import { describe, it, expect, vi, beforeEach } from 'vitest'

// The reader's request shape and instructions. The Claude call itself is mocked.
const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reply: null as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queue: [] as any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: [] as any[],
  create: 0,
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: (p: any) => {
        h.params.push(p)
        const r = h.queue.length ? h.queue.shift() : h.reply
        return { finalMessage: async () => { if (r instanceof Error) throw r; return r } }
      },
      create: async () => { h.create++; return h.reply },
    }
  },
}))
vi.mock('@/lib/invoice-ocr', () => ({
  resolveAnthropicKey: () => 'test-key',
  compressImageForClaude: async (data: string) => ({ mediaType: 'image/jpeg', data }),
}))

import { SYSTEM_PROMPT, RECORD_RECIPES_TOOL, extractRecipes, keepMoreSteps } from '../recipe-scan/extract'
import { NotARecipeError, ScanTooLongError } from '../recipe-scan/parse'

const step = (text: string) => ({
  text, phase: 'Mix', minutes: 2, minutesStated: false, waitMinutes: null, waitNote: null, waitStated: false,
})
const RECIPE = {
  name: 'Aioli', yieldQty: null, yieldUnit: null, categoryHint: null,
  ingredients: [{ raw: '2 egg yolks', qty: 2, unit: 'each', name: 'egg yolk' }], steps: [step('Whisk the yolks.')],
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolReply = (stop = 'tool_use', recipes: any[] = [RECIPE]) => ({
  stop_reason: stop,
  content: [{ type: 'tool_use', name: 'record_recipes', input: { recipes } }],
})
const NO_METHOD = { ...RECIPE, steps: [] }

beforeEach(() => { h.params = []; h.queue = []; h.create = 0; h.reply = toolReply(); vi.restoreAllMocks() })

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

describe('a read that drops the method', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

  it('asks once more and uses the steps from the second read', async () => {
    quiet()
    h.queue = [toolReply('tool_use', [NO_METHOD]), toolReply('tool_use', [{ ...RECIPE, steps: [step('Whisk.'), step('Add oil slowly.')] }])]
    const out = await extractRecipes({ text: 'Aioli' })
    expect(h.params).toHaveLength(2)
    expect(out[0].steps.map(s => s.text)).toEqual(['Whisk.', 'Add oil slowly.'])
    // Same files and instructions, plus a note naming the recipe.
    const [a, b] = h.params.map(p => p.messages[0].content)
    expect(b.slice(0, a.length)).toEqual(a)
    expect(b).toHaveLength(a.length + 1)
    expect(b[b.length - 1].text).toMatch(/no method steps for "Aioli"/)
  })
  it('still empty after the second read: returns the first read as-is, no third call', async () => {
    quiet()
    h.reply = toolReply('tool_use', [NO_METHOD])
    const out = await extractRecipes({ text: 'Aioli' })
    expect(h.params).toHaveLength(2)
    expect(out).toHaveLength(1)
    expect(out[0].steps).toEqual([])
    expect(out[0].ingredients).toHaveLength(1)
  })
  it('no second read when the method is there', async () => {
    const warn = quiet()
    await extractRecipes({ text: 'Aioli' })
    expect(h.params).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })
  it('a failed second read keeps the first', async () => {
    quiet()
    h.queue = [toolReply('tool_use', [NO_METHOD]), toolReply('max_tokens', [])]
    const out = await extractRecipes({ text: 'Aioli' })
    expect(out[0].name).toBe('Aioli')
    h.queue = [toolReply('tool_use', [NO_METHOD]), new Error('network')]
    expect((await extractRecipes({ text: 'Aioli' }))[0].ingredients).toHaveLength(1)
  })
  it('a cut-off FIRST read is still "too much to read" and is not retried', async () => {
    quiet()
    h.reply = { stop_reason: 'max_tokens', content: [] }
    await expect(extractRecipes({ text: 'x' })).rejects.toBeInstanceOf(ScanTooLongError)
    expect(h.params).toHaveLength(1)
  })
})

describe('keepMoreSteps', () => {
  const r = (name: string, n: number) => ({ ...RECIPE, name, steps: Array.from({ length: n }, (_, i) => step(`s${i}`)) })
  it('keeps, per recipe, whichever read has more steps', () => {
    const out = keepMoreSteps([r('Aioli', 0), r('Brine', 3)], [r('Brine', 1), r('aioli ', 2)])
    expect(out.map(x => [x.name.trim(), x.steps.length])).toEqual([['aioli', 2], ['Brine', 3]])
  })
  it('falls back to position when names changed but the count matches', () => {
    expect(keepMoreSteps([r('Aioli', 0)], [r('Garlic aioli', 4)])[0].steps).toHaveLength(4)
  })
  it('a recipe the second read did not find stays as it was', () => {
    const out = keepMoreSteps([r('Aioli', 0), r('Brine', 0)], [r('Brine', 2)])
    expect(out.map(x => x.steps.length)).toEqual([0, 2])
  })
})
