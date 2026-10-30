// Test helper: does a plain row satisfy a Prisma-style `where`? Covers the
// operators the Inbox queries use (equals, not, in, startsWith, gte, gt, lte,
// lt, null, AND, OR) — enough for an in-memory mock to honour a query instead
// of over-fetching. Relation filters are not supported (they never match).
type Where = Record<string, unknown>

const isDate = (v: unknown): v is Date => v instanceof Date
const cmp = (a: unknown, b: unknown): number => {
  const x = isDate(a) ? a.getTime() : (a as number)
  const y = isDate(b) ? b.getTime() : (b as number)
  return x < y ? -1 : x > y ? 1 : 0
}
const eq = (a: unknown, b: unknown): boolean =>
  isDate(a) || isDate(b) ? a != null && b != null && cmp(a, b) === 0 : a === b

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null) return value == null
  if (typeof cond !== 'object' || isDate(cond)) return eq(value, cond)
  const c = cond as Record<string, unknown>
  for (const [op, arg] of Object.entries(c)) {
    switch (op) {
      case 'not': if (arg === null ? value == null : matchField(value, arg)) return false; break
      case 'in': if (!(arg as unknown[]).some(a => eq(value, a))) return false; break
      case 'startsWith': if (typeof value !== 'string' || !value.startsWith(arg as string)) return false; break
      case 'gte': if (value == null || cmp(value, arg) < 0) return false; break
      case 'gt': if (value == null || cmp(value, arg) <= 0) return false; break
      case 'lte': if (value == null || cmp(value, arg) > 0) return false; break
      case 'lt': if (value == null || cmp(value, arg) >= 0) return false; break
      default: return false
    }
  }
  return true
}

export function matchWhere(row: Record<string, unknown>, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(cond as Where[]).every(w => matchWhere(row, w))) return false
    } else if (key === 'OR') {
      if (!(cond as Where[]).some(w => matchWhere(row, w))) return false
    } else if (!matchField(row[key], cond)) {
      return false
    }
  }
  return true
}
