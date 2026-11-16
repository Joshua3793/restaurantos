// Per-device memory for the prep To Do — what this phone / iPad remembers about
// who is holding it. Storage access is guarded: private mode or blocked
// storage simply means "nothing remembered".
const COOK_KEY = 'prep.todo.cook'

/** The cook this device used last, when still on the roster; else the first cook. */
export function rememberedCook(cooks: ReadonlyArray<{ id: string }>, saved: string | null): string | null {
  if (cooks.length === 0) return null
  return saved && cooks.some(c => c.id === saved) ? saved : cooks[0].id
}

export function loadSavedCook(): string | null {
  try { return localStorage.getItem(COOK_KEY) } catch { return null }
}

export function saveCook(id: string): void {
  try { localStorage.setItem(COOK_KEY, id) } catch { /* storage off */ }
}
