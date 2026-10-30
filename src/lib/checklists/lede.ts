/**
 * The closing sentence on the cook screen, in two parts so the page can bold
 * the first: `<b>{count}</b>{tail}`.
 *
 * The count matches the BEFORE YOU LEAVE header: this cook's own blockers plus
 * the whole-kitchen ones (ruling R10). When some of them are whole-kitchen jobs
 * the sentence says how many are the cook's own; otherwise it keeps the
 * sign-off wording.
 */
export function closingLede(
  ownLeft: number,
  sharedLeft: number,
  stationNames: string,
): { count: string; tail: string } {
  const total = ownLeft + sharedLeft
  const count = `${total} ${total === 1 ? 'thing' : 'things'}`
  if (sharedLeft === 0) return { count, tail: ` left before you can sign off ${stationNames}.` }
  if (ownLeft === 0) {
    return { count, tail: ` left before you leave — ${total === 1 ? 'it is a' : 'all are'} whole-kitchen ${total === 1 ? 'job' : 'jobs'}.` }
  }
  return {
    count,
    tail: ` left before you leave — ${ownLeft} ${ownLeft === 1 ? 'is' : 'are'} ${stationNames}’s.`,
  }
}
