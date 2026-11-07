/**
 * 画面文字判定的展示口径（Issue #73 用户决策 #1）——纯函数，组件与单测共用。
 *
 * 规则不再是「一律不许有字」：器物自身的铭文/刻字允许保留，只有生成器额外加的
 * 标签、图例、字幕、水印、招牌（overlay）才算违规。
 * 旧记录没有 overlay 字段，必须如实显示为「未记录」，不能倒推成合格或违规。
 *
 * 返回 { state, failed, label }：
 *   present=false        → 'none'           画面无文字
 *   present=null         → 'unknown'        未判定
 *   overlay=true         → 'overlay'        额外叠加文字（违规）
 *   overlay=false        → 'own'            器物自身文字（允许）
 *   overlay=null + 有文字 → 'overlayUnrecorded' 旧记录，未区分
 */
export function describeTextPolicy(textInImage, t) {
  const present = textInImage && textInImage.present !== undefined ? textInImage.present : null
  const overlay = textInImage && textInImage.overlay !== undefined ? textInImage.overlay : null
  if (present === false) return { state: 'none', failed: false, label: t('episode.documentary.pipeline.textAbsent') }
  if (present !== true) return { state: 'unknown', failed: false, label: t('episode.documentary.pipeline.textUnknown') }
  if (overlay === true) return { state: 'overlay', failed: true, label: t('episode.documentary.pipeline.textOverlayAdded') }
  if (overlay === false) return { state: 'own', failed: false, label: t('episode.documentary.pipeline.textObjectOwn') }
  return { state: 'overlayUnrecorded', failed: false, label: t('episode.documentary.pipeline.textOverlayUnrecorded') }
}
