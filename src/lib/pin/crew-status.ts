// Pure: the one-word sign-in status shown for each cook on "Crew sign-in".

export type CrewStatus = {
  label: 'SET UP' | 'WAITING' | 'NOT YET' | 'NO PIN'
  tone: 'green' | 'gold' | 'grey' | 'red'
  /** How many phones are approved for this cook. */
  phones: number
}

export function crewStatus(
  cook: { clockId: string | null },
  devices: Array<{ status: string }>,
): CrewStatus {
  const phones = devices.filter((d) => d.status === 'APPROVED').length
  if (!cook.clockId) return { label: 'NO PIN', tone: 'red', phones }
  if (devices.some((d) => d.status === 'PENDING')) return { label: 'WAITING', tone: 'gold', phones }
  if (phones > 0) return { label: 'SET UP', tone: 'green', phones }
  return { label: 'NOT YET', tone: 'grey', phones }
}
