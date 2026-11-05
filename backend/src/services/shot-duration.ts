/** Whole-shot limits; generated segments have their own independent 15 second limit. */
export function shotMaxSeconds(combo: string | null | undefined): number {
  if (combo === 'A') return 30
  if (combo === 'C' || combo === 'D') return 45
  return 15
}
