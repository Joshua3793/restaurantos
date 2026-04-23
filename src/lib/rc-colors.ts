export const RC_COLOR_MAP: Record<string, string> = {
  blue:   '#3B82F6',
  amber:  '#F59E0B',
  purple: '#8B5CF6',
  green:  '#22C55E',
  rose:   '#F43F5E',
  teal:   '#14B8A6',
  orange: '#F97316',
  indigo: '#6366F1',
}

export const RC_COLORS = Object.keys(RC_COLOR_MAP) as string[]

export function rcHex(color: string): string {
  return RC_COLOR_MAP[color] ?? '#6B7280'
}
