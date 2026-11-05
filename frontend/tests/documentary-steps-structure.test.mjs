/**
 * 纪录片工作流骨架（Issue #54）的结构约束：
 * 7 步定义、页签白名单与旧链接重映射（纯函数）、7 个稳定挂载点、剧情分支未被改动、
 * 四语 locale 键集合一致且旧术语键已删。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const appRoot = new URL('../app/', import.meta.url)
const readApp = (path) => readFileSync(new URL(path, appRoot), 'utf8')

const episodeView = readApp('views/drama/episode.vue')
const useApi = readApp('composables/useApi.ts')
const locales = ['zh', 'en', 'ja', 'ko'].map(code => [code, JSON.parse(readApp(`locales/${code}.json`))])

const {
  DOC_PROD_TABS, DRAMA_PROD_TABS, DOC_STAGES, DRAMA_STAGES, PROD_TAB_KEYS, ASSET_SUB_TABS,
  remapProdTab, remapAssetTab, stepTargetOf, isStageLocked, isStageGateUnknown,
} = await import(new URL('utils/workbenchSteps.js', appRoot).href)
const workflowGates = readApp('composables/useWorkflowGates.ts')

test('纪录片 7 步 / 剧情 6 步的步骤定义', () => {
  assert.deepEqual(DOC_STAGES, ['script', 'assets', 'design', 'production', 'final', 'poster', 'export'])
  assert.deepEqual(DRAMA_STAGES, ['script', 'assets', 'poster', 'keyframes', 'videos', 'export'])
  assert.deepEqual(DOC_PROD_TABS, ['assets', 'design', 'production', 'final', 'poster'])
  assert.deepEqual(DRAMA_PROD_TABS, ['assets', 'poster', 'keyframes', 'videos'])
  assert.deepEqual(ASSET_SUB_TABS, ['cards', 'review'])
  // 页签白名单 = 两类项目的并集（URL / 本地记忆的合法取值）
  assert.deepEqual([...PROD_TAB_KEYS].sort(), [...new Set([...DOC_PROD_TABS, ...DRAMA_PROD_TABS])].sort())
})

test('旧 deeplink 重映射：expression/layers/keyframes/videos → 新纪录片步骤', () => {
  assert.equal(remapProdTab('expression', 'documentary'), 'design')
  assert.equal(remapProdTab('layers', 'documentary'), 'production')
  assert.equal(remapProdTab('keyframes', 'documentary'), 'production')
  assert.equal(remapProdTab('videos', 'documentary'), 'final')
  assert.equal(remapProdTab('poster', 'documentary'), 'poster')
  assert.equal(remapProdTab('nonsense', 'documentary'), 'assets')
  // 项目类型未知时不判定（deeplink 的纪录片页签不能被当成非法值）
  assert.equal(remapProdTab('design', null), 'design')
})

test('剧情项目的页签不被重映射', () => {
  for (const tab of DRAMA_PROD_TABS) assert.equal(remapProdTab(tab, 'drama'), tab)
  // 纪录片专属页签在剧情项目落回资产
  assert.equal(remapProdTab('design', 'drama'), 'assets')
  assert.equal(remapProdTab('final', 'drama'), 'assets')
  assert.equal(remapAssetTab('review', 'drama'), 'cards')
  assert.equal(remapAssetTab('review', 'documentary'), 'review')
  assert.equal(remapAssetTab('nonsense', 'documentary'), 'cards')
})

test('门禁跳转目标解析', () => {
  assert.deepEqual(stepTargetOf('script'), { panel: 'script', tab: null })
  assert.deepEqual(stepTargetOf('assets'), { panel: 'production', tab: 'assets' })
  assert.deepEqual(stepTargetOf('design'), { panel: 'production', tab: 'design' })
})

test('门禁未判定时按锁定渲染：首屏/取数失败都不放行内容', () => {
  const unlocked = { assets: true, design: false, production: false, final: false, poster: true, export: false }
  // 门禁还没取到（ready=false）：纪录片的受管步骤一律锁定，剧本步与剧情项目不受影响
  for (const stageId of ['assets', 'design', 'production', 'final', 'poster', 'export']) {
    assert.equal(isStageLocked({ documentary: true, stageId, gatesReady: false, unlocked: null }), true, `${stageId} 门禁未判定时必须锁定`)
    assert.equal(isStageGateUnknown({ documentary: true, stageId, gatesReady: false }), true)
    assert.equal(isStageLocked({ documentary: false, stageId, gatesReady: false, unlocked: null }), false, `剧情项目的 ${stageId} 不受门禁管辖`)
  }
  assert.equal(isStageLocked({ documentary: true, stageId: 'script', gatesReady: false, unlocked: null }), false)
  assert.equal(isStageGateUnknown({ documentary: true, stageId: 'script', gatesReady: false }), false)
  // 门禁已判定：严格按服务端给的解锁位，未判定态消失
  assert.equal(isStageLocked({ documentary: true, stageId: 'design', gatesReady: true, unlocked }), true)
  assert.equal(isStageLocked({ documentary: true, stageId: 'assets', gatesReady: true, unlocked }), false)
  assert.equal(isStageGateUnknown({ documentary: true, stageId: 'design', gatesReady: true }), false)
})

test('门禁守卫排在内容之前：ready 只在取数成功后置位', () => {
  // ready 初值 false，且只由 applyGates（取数 / 确认 / 取消确认的唯一写入口）置位
  assert.match(workflowGates, /const ready = ref\(false\)/)
  assert.match(workflowGates, /function applyGates\([\s\S]*?ready\.value = true/)
  // 导航类刷新先作废上一次判定（后台重算才保留），换集同样作废
  assert.match(workflowGates, /if \(!opts\.background \|\| id !== loadedFor\) ready\.value = false/)
  // 晚到的旧响应不得覆盖新结果：每次请求取一个代号，落地载荷（含确认/取消确认）同时作废在飞请求
  assert.match(workflowGates, /const mine = \+\+seq/)
  assert.match(workflowGates, /if \(mine !== seq \|\| id !== episodeId\(\)\) return/)
  assert.match(workflowGates, /function applyGates\([\s\S]*?seq \+= 1/)
  // 成功响应落地后必须复位 loading（apply 会改 seq，不能再用 mine === seq 判断）
  assert.match(workflowGates, /applyGates\(next\)\n *loading\.value = false/)
  assert.match(episodeView, /applyGates\(await episodeAPI\.confirmScript/)
  assert.match(episodeView, /applyGates\(await episodeAPI\.unconfirmScript/)
  // 只有任务结束是后台重算（不打断正在看的内容）；改变门禁的写路径（剧本保存）与导航一律前台失效
  assert.match(workflowGates, /GATE_TASK_KINDS\.includes\(kind\)\) refreshGates\(\{ background: true \}\)/)
  assert.equal((episodeView.match(/background: true/g) || []).length, 0)
  assert.equal((episodeView.match(/\.then\(\(\) => refreshGates\(\)\)/g) || []).length, 2)
  assert.match(episodeView, /watch\(\[prodTab, panel\], \(\) => \{ if \(epId\.value\) refreshGates\(\) \}\)/)
  assert.equal((workflowGates.match(/ready\.value = true/g) || []).length, 1)
  // episode.vue 用纯函数判定，且锁定空态渲染在「剧本未就绪」与内容之前
  assert.match(episodeView, /isStageLocked\(\{/)
  const gateGuard = episodeView.indexOf('v-if="stageLocked(prodTab)"')
  const blockGuard = episodeView.indexOf('v-else-if="productionBlockMessage"')
  const contentStart = episodeView.indexOf('<template v-else>')
  assert.ok(gateGuard > 0 && blockGuard > gateGuard && contentStart > blockGuard, '锁定空态必须是制作面板的第一道分支')
  // 门禁未判定时不展示误导性的「未解锁」原因，而是校验中提示
  assert.match(episodeView, /stageGateUnknown\(prodTab\) \? t\('episode\.gate\.checking'\)/)
  assert.match(episodeView, /stageGateUnknown\('export'\) \? t\('episode\.gate\.checking'\)/)
  // 两条进入路径一致：侧栏点击不再改道，锁定步骤照常进入并渲染锁定空态；
  // 「去解决」才跳到阻塞步（goStageBlocker 只在空态按钮上用）
  const goSubStep = episodeView.slice(episodeView.indexOf('function goSubStep('))
  assert.doesNotMatch(goSubStep.slice(0, goSubStep.indexOf('\n}')), /goStageBlocker/)
  assert.equal((episodeView.match(/goStageBlocker\(/g) || []).length, 3) // 定义 1 次 + 两个空态按钮
})

test('每步一个稳定挂载组件，episode.vue 只剩挂载行', () => {
  for (const name of ['ScriptStepPanel', 'AssetReviewPanel', 'DesignCardPanel', 'ShotProductionPanel', 'VideoShotPanel', 'PosterPanel', 'ExportPanel']) {
    assert.match(episodeView, new RegExp(`<${name}[\\s/>]`), `${name} 必须在 episode.vue 挂载`)
  }
  // 设计卡与图层工作台的内部实现已经搬进面板组件，episode.vue 不再直接渲染
  assert.doesNotMatch(episodeView, /ClipWorkspace/)
  assert.doesNotMatch(episodeView, /ClipCard/)
})

test('两个纪录片口径职责互斥：工作流结构只看 isDocumentaryProject', () => {
  assert.match(episodeView, /const isDocumentaryRuleset = computed\(\(\) => drama\.value\?\.genre_ruleset === 'documentary'\)/)
  assert.match(episodeView, /const isDocumentaryProject = computed\(\(\) => drama\.value\?\.project_type === 'documentary'\)/)
  // 规则集口径只驱动选角名册按钮
  const rulesetUses = episodeView.match(/isDocumentaryRuleset/g) || []
  assert.equal(rulesetUses.length, 2)
})

test('剧情分支未被改动：6 步定义与旧的关键帧/视频页签', () => {
  assert.match(episodeView, /\{ id: 'keyframes', label: t\('episode\.prod\.keyframes'\)/)
  assert.match(episodeView, /\{ id: 'videos', label: t\('episode\.prod\.videos'\)/)
  // 剧情项目的关键帧页签仍由 episode.vue 自己渲染（不走纪录片的制作页）
  assert.match(episodeView, /v-if="prodTab === 'keyframes' && !isDocumentaryProject"/)
})

test('门禁 API 与 400 结构化错误透出', () => {
  assert.match(useApi, /gates: \(id: number\) => api\.get<EpisodeGates>\(`\/episodes\/\$\{id\}\/gates`\)/)
  assert.match(useApi, /confirmScript/)
  assert.match(useApi, /unconfirmScript/)
  assert.match(useApi, /gate_blocked/)
})

test('四语 locale 键集合一致，旧术语键已删、融合文案已替换', () => {
  const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (
    v && typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  ))
  const [, zh] = locales[0]
  const baseKeys = new Set(flat(zh))
  for (const [code, data] of locales.slice(1)) {
    const keys = new Set(flat(data))
    assert.deepEqual([...keys].filter(k => !baseKeys.has(k)), [], `${code} 多出的键`)
    assert.deepEqual([...baseKeys].filter(k => !keys.has(k)), [], `${code} 缺失的键`)
  }
  for (const [code, data] of locales) {
    const ep = data.episode
    assert.equal(ep.prod.expression, undefined, `${code} 仍有 prod.expression`)
    assert.equal(ep.prod.layers, undefined, `${code} 仍有 prod.layers`)
    assert.equal(ep.stage.expressionDesc, undefined, `${code} 仍有 stage.expressionDesc`)
    assert.equal(ep.stage.layersDesc, undefined, `${code} 仍有 stage.layersDesc`)
    for (const key of ['design', 'production', 'final', 'poster', 'assets']) {
      assert.equal(typeof ep.prod[key], 'string', `${code} 缺 prod.${key}`)
    }
    assert.equal(typeof ep.stage.designDesc, 'string')
    assert.equal(typeof ep.stage.productionDesc, 'string')
    assert.equal(typeof ep.stage.finalDesc, 'string')
    assert.equal(typeof ep.assets.tabCards, 'string')
    assert.equal(typeof ep.assets.tabReview, 'string')
    assert.equal(typeof ep.gate.locked, 'string')
    assert.equal(typeof ep.gate.goFix, 'string')
    assert.equal(typeof ep.script.confirm, 'string')
    // 「融合」只剩键名，文案全部换成合成成品
    const text = JSON.stringify([ep.compose, ep.composeBatch, ep.export].map(group => Object.values(group)))
    assert.doesNotMatch(text, /融合|[Ff]usion|융합/, `${code} 仍有融合文案`)
  }
})
