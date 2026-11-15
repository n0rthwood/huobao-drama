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
/**
 * 生成段时长（秒）：读采用任务的请求时长 sys_task.params.duration（序列化后是 JSON 字符串）。
 * 没有任务或没有时长返回 0 —— 界面显示「—」，播放后由 loadedmetadata 的实测值覆盖。
 */
export function taskDurationOf(task) {
  let params = task?.params ?? null
  if (typeof params === 'string') { try { params = JSON.parse(params) } catch { params = null } }
  const seconds = Number(params?.duration || 0)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}
/** 成品时长（秒）：读服务端已存的 narration_meta.composed.duration_ms；没有数据返回 0 */
export function composedSecondsOf(shot) {
  const meta = shot?.narration_meta ?? shot?.narrationMeta ?? {}
  const ms = Number(meta.composed?.duration_ms || 0)
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0
}
/** 显示用时长：播放后的实测值优先，否则用服务端已存值；两者都没有返回 0（显示「—」） */
export function displaySecondsOf(measuredSeconds, servedSeconds) {
  const measured = Number(measuredSeconds || 0)
  if (Number.isFinite(measured) && measured > 0) return measured
  const served = Number(servedSeconds || 0)
  return Number.isFinite(served) && served > 0 ? served : 0
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
