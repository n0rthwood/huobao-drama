export function zonesOf(combo) {
  return { layer: ['A', 'C', 'D'].includes(combo), generated: ['B', 'C', 'D'].includes(combo), final: ['A', 'B', 'C', 'D'].includes(combo) }
}
export function budgetOf(shot) {
  let card = shot?.design_card ?? shot?.designCard ?? {}
  if (typeof card === 'string') { try { card = JSON.parse(card) } catch { card = {} } }
  return card.budget || {}
}
export function measuredSecondsOf(shot) {
  if (shot?.narration_measured_s != null || shot?.narrationMeasuredS != null) return Number(shot.narration_measured_s ?? shot.narrationMeasuredS)
  const meta = shot?.narration_meta ?? shot?.narrationMeta ?? {}
  return Number(meta.audio?.duration_ms ?? meta.audio_duration_ms ?? meta.duration_ms ?? 0) / 1000
}
export function junctionSecondsOf(combo, layerSeconds, generatedSeconds) {
  return combo === 'C' ? Number(layerSeconds) || 0 : combo === 'D' ? Number(generatedSeconds) || 0 : null
}
export function junctionPercentOf(combo, layerSeconds, generatedSeconds, totalSeconds) {
  const at = junctionSecondsOf(combo, layerSeconds, generatedSeconds)
  return at !== null && totalSeconds > 0 ? Math.min(100, Math.max(0, at / totalSeconds * 100)) : null
}
export function isFreshExport(shot) { return (shot?.compose_state ?? shot?.composeState)?.exportable === true }
export function batchScopeOf(row) {
  const objectOf = value => {
    if (typeof value !== 'string') return value
    try { return JSON.parse(value) } catch { return null }
  }
  const scope = objectOf(row?.scope ?? objectOf(row?.params)?.scope ?? objectOf(row?.options)?.scope)
  return scope && Array.isArray(scope.included) && Array.isArray(scope.excluded) ? scope : null
}
