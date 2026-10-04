// Stage 3 one-time rename — PROPOSE (read-only). Lists the active items whose
// name looks like an invoice wording (`isShoutyName`) and asks Claude for a
// plain name for each. Writes docs/audits/2026-10-rename/proposals.{json,md}
// for the owner to approve or edit. NO database writes.
//   npx tsx scripts/propose-item-renames.ts
// Then, after the owner approves: scripts/apply-item-renames.ts --apply
import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../src/lib/prisma'
import { isShoutyName } from '../src/lib/alias-text'
import { formatPurchaseDisplay } from '../src/lib/count-uom'

const MODEL = 'claude-sonnet-5-5'
const BATCH = 10
const OUT_DIR = 'docs/audits/2026-10-rename'
const SYSTEM = 'You name restaurant ingredients for a kitchen inventory. Reply with ONLY the name: 1–4 words, Title Case, no pack size, no supplier code, no brand unless it is the product (e.g. Tabasco).'

export interface Proposal { id: string; current: string; proposed: string; category: string; supplier: string }

interface Candidate {
  id: string
  current: string
  category: string
  supplier: string          // the primary box's supplier, else the first box's, else ''
  boxes: string[]           // "Sysco: case (12 × 1 L)"
}

// Claude Code's shell sets ANTHROPIC_API_KEY="" — fall back to the .env file
// (same rule as src/lib/invoice-ocr.ts).
function resolveAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf-8')
    return raw.match(/^ANTHROPIC_API_KEY=["']?([^"'\r\n]+)["']?/m)?.[1] ?? ''
  } catch {
    return ''
  }
}

let requests = 0

/** One request for up to BATCH items; returns one name per item ('' when the
 *  line is missing). Lines are labelled `1.`…`N.` and parsed by that number. */
async function nameBatch(client: Anthropic, items: Candidate[], retryNote = ''): Promise<string[]> {
  const lines = items.map((c, i) => {
    const boxes = c.boxes.length ? c.boxes.join('; ') : 'no supplier box'
    return `${i + 1}. ${c.current} — category ${c.category}; boxes: ${boxes}`
  })
  const user =
    `Give a plain name for each of these ${items.length} items. Answer with exactly ${items.length} lines, ` +
    `each "<number>. <name>", in the same order, nothing else.${retryNote}\n\n${lines.join('\n')}`
  requests++
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: user }],
  })
  if (res.stop_reason === 'refusal') {
    console.warn(`  request ${requests}: refused — these items go to the second pass`)
    return items.map(() => '')
  }
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n')
  const out = items.map(() => '')
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(/^(\d+)[.)]\s*(.+)$/)
    if (!m) continue
    const n = Number(m[1])
    if (n >= 1 && n <= items.length) out[n - 1] = clean(m[2])
  }
  return out
}

/** Strip quotes/markdown/trailing punctuation the model sometimes adds. */
function clean(s: string): string {
  return s.replace(/[*_`"“”]/g, '').replace(/\s+/g, ' ').replace(/[.;,]+$/, '').trim()
}

const needsRedo = (name: string) => !name || isShoutyName(name)

const cell = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'

async function main() {
  const apiKey = resolveAnthropicKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set (env or .env)')
  const client = new Anthropic({ apiKey })

  const rows = await prisma.inventoryItem.findMany({
    where: { isActive: true, mergedIntoId: null, recipe: null },
    select: {
      id: true, itemName: true, category: true,
      supplierPrices: {
        select: { supplierName: true, isPrimary: true, packChain: true, supplierItemCode: true, supplier: { select: { name: true } } },
        orderBy: [{ isPrimary: 'desc' }, { supplierName: 'asc' }],
      },
      dimension: true, baseUnit: true,
    },
    orderBy: { itemName: 'asc' },
  })
  const shouty = rows.filter(r => isShoutyName(r.itemName))
  console.log(`Active, non-merged, non-recipe items: ${rows.length}; shouty names: ${shouty.length}`)

  const candidates: Candidate[] = shouty.map(r => {
    const boxes = r.supplierPrices.map(b => {
      const name = b.supplier?.name ?? b.supplierName
      let pack = ''
      try {
        pack = formatPurchaseDisplay({ dimension: r.dimension, baseUnit: r.baseUnit, packChain: b.packChain })
      } catch { pack = '' }
      return pack ? `${name}: ${pack}` : name
    })
    const primary = r.supplierPrices.find(b => b.isPrimary) ?? r.supplierPrices[0]
    return {
      id: r.id, current: r.itemName, category: r.category,
      supplier: primary ? (primary.supplier?.name ?? primary.supplierName) : '',
      boxes,
    }
  })

  // ── First pass ────────────────────────────────────────────────────────────
  const names = new Map<string, string>()
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH)
    const got = await nameBatch(client, batch)
    batch.forEach((c, j) => names.set(c.id, got[j]))
    console.log(`  request ${requests}: ${batch.length} item(s)`)
  }

  // ── Second pass: empty or still shouty ────────────────────────────────────
  const redo = candidates.filter(c => needsRedo(names.get(c.id) ?? ''))
  const firstPass = new Map(redo.map(c => [c.id, names.get(c.id) ?? '']))
  if (redo.length) {
    console.log(`Second pass: ${redo.length} item(s) came back empty or still in capitals`)
    for (let i = 0; i < redo.length; i += BATCH) {
      const batch = redo.slice(i, i + BATCH)
      const got = await nameBatch(client, batch, ' Use normal Title Case (not all capitals).')
      batch.forEach((c, j) => { if (got[j]) names.set(c.id, got[j]) })
    }
  }
  const stillBad = candidates.filter(c => needsRedo(names.get(c.id) ?? ''))

  const proposals: Proposal[] = candidates
    .map(c => ({ id: c.id, current: c.current, proposed: names.get(c.id) ?? '', category: c.category, supplier: c.supplier }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.current.localeCompare(b.current))

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'proposals.json'), JSON.stringify(proposals, null, 2) + '\n')

  const date = new Date().toISOString().slice(0, 10)
  const L: string[] = []
  L.push('# Plain names for invoice-worded items — proposals', '')
  L.push(`${proposals.length} items · proposed ${date} · nothing is renamed until the owner approves (\`scripts/apply-item-renames.ts\`). The old wording is kept as the supplier's own.`, '')
  L.push('| # | Current | Proposed | Category | Supplier |', '|---|---|---|---|---|')
  proposals.forEach((p, i) => L.push(`| ${i + 1} | ${cell(p.current)} | ${cell(p.proposed)} | ${cell(p.category)} | ${cell(p.supplier)} |`))
  fs.writeFileSync(path.join(OUT_DIR, 'proposals.md'), L.join('\n') + '\n')

  console.log(`Requests made: ${requests}`)
  for (const c of redo) console.log(`  redone: "${c.current}" — first pass "${firstPass.get(c.id)}" → "${names.get(c.id)}"`)
  if (stillBad.length) {
    console.warn(`Still empty or in capitals after the second pass: ${stillBad.length}`)
    for (const c of stillBad) console.warn(`  ${c.id} "${c.current}" → "${names.get(c.id) ?? ''}"`)
  }
  console.log(`written: ${OUT_DIR}/proposals.json, ${OUT_DIR}/proposals.md (${proposals.length} items) — no database writes`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
