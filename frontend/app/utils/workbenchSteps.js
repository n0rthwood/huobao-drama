/**
 * 工作台步骤定义与页签重映射（Issue #54）—— URL deeplink 与本地面板记忆共用的唯一纯函数。
 *
 * 纪录片的步骤集合（roadmap 的 8 个大步骤：原始内容 / AI 改写 → 资产 → Poster → 分镜设计 →
 * 分镜制作 → 视频与成品 → 导出）与剧情项目的 6 步都只由服务端 roadmap 决定；
 * 本文件只负责「URL 里的页签 ↔ 步骤」的映射，不保存任何完成判据（#105）。
 */


/**
 * 工作台上下文的 provide/inject 键：`episode.vue` 提供状态与方法（refs 原样传递，
 * 仍是单一数据源），步骤面板组件注入后按原名使用，markup 从 episode.vue 整体搬出。
 */
export const WORKBENCH_CTX = Symbol('huobao:workbench')
/** 纪录片的制作页签顺序（资产页另有 cards/review 两个子页签） */
export const DOC_PROD_TABS = ['assets', 'poster', 'design', 'production', 'final']
/** 剧情的制作页签顺序（改动前即如此） */
export const DRAMA_PROD_TABS = ['assets', 'poster', 'keyframes', 'videos']
/** 两类项目的页签并集：URL / localStorage 的合法取值 */
export const PROD_TAB_KEYS = ['assets', 'poster', 'keyframes', 'videos', 'design', 'production', 'final']
/** 资产步的子页签（审核清单只在纪录片显示） */
export const ASSET_SUB_TABS = ['cards', 'review']

/** 旧步骤 id → 纪录片新步骤 id（#49/#50 的 expression/layers 与共用的 keyframes/videos） */
const DOC_TAB_REMAP = {
  expression: 'design',
  layers: 'production',
  keyframes: 'production',
  videos: 'final',
}

/**
 * 把任意来源（URL ?tab= / 本地记忆 / 旧链接）的页签值归一到当前项目类型的合法页签。
 * 项目类型未知时原样返回，等类型加载后再归一（否则纪录片 deeplink 会被误判成非法值）。
 */
export function remapProdTab(tab, projectType) {
  if (!projectType) return tab
  const documentary = projectType === 'documentary'
  const allowed = documentary ? DOC_PROD_TABS : DRAMA_PROD_TABS
  if (allowed.includes(tab)) return tab
  if (documentary) {
    const mapped = DOC_TAB_REMAP[tab]
    if (mapped && allowed.includes(mapped)) return mapped
  }
  return 'assets'
}

/** 资产步子页签：剧情项目没有审核清单，一律回落到资产卡 */
export function remapAssetTab(sub, projectType) {
  if (!ASSET_SUB_TABS.includes(sub)) return 'cards'
  if (sub === 'review' && projectType !== 'documentary') return 'cards'
  return sub
}

/** roadmap 的 goto（解锁需要先去的步骤 key）→ 该跳到哪个页签/面板 */
export function stepTargetOf(step) {
  if (step === 'script') return { panel: 'script', tab: null }
  return { panel: 'production', tab: step }
}

/**
 * roadmap 未判定（首屏尚未取到 `/episodes/:id/roadmap`，或取数失败）时，
 * 纪录片的受管步骤一律只渲染「校验中」空态——既不渲染内容，也不臆造完成态。
 * 服务端仍是唯一判定方，这里只决定渲染什么。
 */
export function isStageGateUnknown({ documentary, stageId, roadmapReady }) {
  return !!documentary && stageId !== 'script' && !roadmapReady
}

/** 步骤是否锁定：剧情项目与剧本步恒不锁；roadmap 未判定按锁定处理；锁定只认 roadmap 节点的 unlocked */
export function isStageLocked({ documentary, stageId, roadmapReady, unlocked }) {
  if (!documentary || stageId === 'script') return false
  if (!roadmapReady) return true
  return unlocked === false
}
