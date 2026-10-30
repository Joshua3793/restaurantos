import 'server-only'

/**
 * Files the app's own alerts (temps, stations, prep, money, stock, phones) into
 * the Inbox for one kitchen. Stub until Task 6 replaces it: resolves at once.
 * The real one throttles itself and never throws to the caller.
 */
export async function syncSystemItems(rcId: string | null): Promise<void> {
  void rcId
}
