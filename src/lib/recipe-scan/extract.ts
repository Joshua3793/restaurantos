// Recipe Scan: read photos / a PDF / pasted text with Claude and return
// structured recipes. One call, one tool. Claude Sonnet 5.5 rejects a forced
// tool_choice ("tool"/"any" → 400), so the choice is "auto" and the system
// prompt + closing instruction tell it to always call record_recipes; a reply
// without the tool call reads as "no recipe" (requireRecipes).
import Anthropic from '@anthropic-ai/sdk'
import { compressImageForClaude, resolveAnthropicKey } from '@/lib/invoice-ocr'
import { NotARecipeError, requireRecipes } from './parse'
import type { ExtractedRecipe } from './types'

export const RECIPE_SCAN_MODEL = 'claude-sonnet-5-5'
const MAX_TOKENS = 16000

export const SYSTEM_PROMPT = `You read recipes for a restaurant kitchen and record them with the record_recipes tool. Always call the tool, even if you are unsure; if the files contain no recipe, call it with an empty recipes list.

Rules:
- Every separate recipe is its own entry in recipes. A page with an aioli and a pickle brine is two entries.
- name: the recipe's title as written. categoryHint: one short word such as "Sauces", "Soups", "Dressings", "Doughs"; null if unclear.
- yieldQty / yieldUnit: only what the page states (e.g. 2 and "l", or 24 and "portion"). null when it is not stated. Never invent a yield.
- ingredients: one entry per ingredient line.
  - raw: keep the line EXACTLY as written on the page, including quantities and prep notes ("3 cloves garlic, minced").
  - name: the ingredient only, without amount or prep notes ("garlic").
  - qty: the number on the page (a number, not text; 1 1/2 is 1.5; for a range like 2-3 use the middle). null when there is no amount ("to taste", "a pinch of").
  - unit: write a measure as a short standard abbreviation: g, kg, ml, l, tsp, tbsp, cup, oz, lb, each. When the page gives a count word instead, use the singular word: clove, bunch, handful, sprig, pinch, can, slice. null when there is no unit.
  - estimate: your best estimate of the TOTAL amount of the WHOLE line (not per unit), in grams (unit "g") or millilitres (unit "ml"). Give one in these three cases:
    - a count word (clove, bunch, handful, sprig, pinch, a whole onion) with no weight on the page: "3 cloves garlic" -> { qty: 15, unit: "g" }.
    - a dry or solid ingredient measured by volume (cup, tbsp, tsp) — flour, sugar, salt, rice, nuts, grated cheese, spices, chopped herbs: give its WEIGHT in grams. "2 cups flour" -> { qty: 250, unit: "g" }; "1 tbsp sugar" -> { qty: 12, unit: "g" }.
    - a liquid measured by weight (g, kg, oz, lb) — water, stock, milk, cream, oil, vinegar, wine: give its VOLUME in ml. "500 g cream" -> { qty: 490, unit: "ml" }.
    Leave estimate null otherwise (a solid already given by weight, a liquid already given by volume), or when you cannot sensibly estimate.
- steps: split the method into one action per step, in order. A paragraph with three actions becomes three steps.
  - text: the action in plain words, close to the page's wording.
  - phase: a short name for the stage this step belongs to, taken from the method itself ("Roast", "Peel & toast", "Blend"). Steps in the same stage share the phase name.
  - minutes: hands-on time for the step. minutesStated is true ONLY if the page gives that time; if you are guessing, set minutes to your guess and minutesStated to false. null if you have no idea.
  - waitMinutes / waitNote: time the food then sits or cooks unattended (rest, chill, bake, marinate, proof) and what happens in it ("chill in the fridge"). waitStated is true ONLY if the page gives that time; a guess must have waitStated false. null when there is no wait.
- Do not invent ingredients or steps that are not on the page. Ignore page furniture such as headers, page numbers and photos.`

export const RECORD_RECIPES_TOOL = {
  name: 'record_recipes',
  description: 'Record every recipe found in the files, with ingredients and method steps.',
  input_schema: {
    type: 'object',
    properties: {
      recipes: {
        type: 'array',
        description: 'One entry per separate recipe. Empty if the files contain no recipe.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            yieldQty: { type: ['number', 'null'], description: 'Yield amount as stated on the page; null if not stated.' },
            yieldUnit: { type: ['string', 'null'], description: 'Yield unit as stated (l, kg, portion...); null if not stated.' },
            categoryHint: { type: ['string', 'null'], description: 'One short word such as "Sauces".' },
            ingredients: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  raw: { type: 'string', description: 'The line exactly as written on the page.' },
                  qty: { type: ['number', 'null'], description: 'Amount as a number; null when there is none ("to taste").' },
                  unit: { type: ['string', 'null'], description: 'g, kg, ml, l, tsp, tbsp, cup, oz, lb, each; or the singular count word (clove, bunch, handful, sprig, pinch).' },
                  name: { type: 'string', description: 'Ingredient only, no amount or prep.' },
                  estimate: {
                    type: ['object', 'null'],
                    description: 'TOTAL amount of the WHOLE line, not per unit. Grams for a count word (3 cloves garlic -> 15 g) or a dry/solid good measured by volume (2 cups flour -> 250 g); ml for a liquid measured by weight (500 g cream -> 490 ml). Null otherwise.',
                    properties: {
                      qty: { type: 'number' },
                      unit: { type: 'string', enum: ['g', 'ml'] },
                    },
                    required: ['qty', 'unit'],
                  },
                },
                required: ['raw', 'qty', 'unit', 'name'],
              },
            },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'One action.' },
                  phase: { type: 'string', description: 'Stage name taken from the method, e.g. "Roast".' },
                  minutes: { type: ['number', 'null'], description: 'Hands-on minutes.' },
                  minutesStated: { type: 'boolean', description: 'True only if the page gives these minutes.' },
                  waitMinutes: { type: ['number', 'null'], description: 'Unattended minutes (rest, chill, bake).' },
                  waitNote: { type: ['string', 'null'], description: 'What happens during the wait.' },
                  waitStated: { type: 'boolean', description: 'True only if the page gives the wait time.' },
                },
                required: ['text', 'phase', 'minutes', 'minutesStated', 'waitMinutes', 'waitNote', 'waitStated'],
              },
            },
          },
          required: ['name', 'yieldQty', 'yieldUnit', 'categoryHint', 'ingredients', 'steps'],
        },
      },
    },
    required: ['recipes'],
  },
}

/** Reads photos, a PDF and/or pasted text. Throws ScanTooLongError when the answer was cut off, NotARecipeError when nothing usable comes back. */
export async function extractRecipes(
  src: { images?: Buffer[]; pdf?: Buffer; text?: string },
): Promise<ExtractedRecipe[]> {
  const apiKey = resolveAnthropicKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = []
  for (const img of src.images ?? []) {
    const c = await compressImageForClaude(img.toString('base64'), false)
    content.push({ type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } })
  }
  if (src.pdf) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: src.pdf.toString('base64') } })
  }
  if (src.text && src.text.trim()) {
    content.push({ type: 'text', text: `Recipe text:\n\n${src.text}` })
  }
  if (content.length === 0) throw new NotARecipeError()
  content.push({ type: 'text', text: 'Record every recipe above with record_recipes.' })

  const client = new Anthropic({ apiKey })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message: any = await client.messages.create({
    model: RECIPE_SCAN_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [RECORD_RECIPES_TOOL],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const block = (message.content as any[]).find(b => b.type === 'tool_use' && b.name === 'record_recipes')
  // Throws ScanTooLongError on a cut-off answer, NotARecipeError when empty.
  return requireRecipes(block?.input, message.stop_reason)
}
