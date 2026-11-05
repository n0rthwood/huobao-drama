import { parseDesignCard } from './design-card.js'

/** Match documentary video submission, including its legacy nullish fallback. */
export function generatedSegmentSeconds(designCard: string | null | undefined, duration: number | null | undefined): number {
  return Number(parseDesignCard(designCard)?.budget.gen_s ?? duration ?? 10)
}

/** Whole-shot limits; generated segments have their own independent 15 second limit. */
export function shotMaxSeconds(combo: string | null | undefined): number {
  if (combo === 'A') return 30
  if (combo === 'C' || combo === 'D') return 45
  return 15
}
