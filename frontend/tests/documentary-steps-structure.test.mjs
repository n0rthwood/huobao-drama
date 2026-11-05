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
  remapProdTab, remapAssetTab, stepTargetOf,
} = await import(new URL('utils/workbenchSteps.js', appRoot).href)

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

test('每步一个稳定挂载组件，episode.vue 只剩挂载行', () => {
  for (const name of ['ScriptStepPanel', 'AssetReviewPanel', 'DesignCardPanel', 'ShotProductionPanel', 'VideoShotPanel', 'PosterPanel', 'ExportPanel']) {
    assert.match(episodeView, new RegExp(`<${name}[\\s/>]`), `${name} 必须在 episode.vue 挂载`)
  }
  // 设计卡与图层工作台的内部实现已经搬进面板组件，episode.vue 不再直接渲染
  assert.doesNotMatch(episodeView, /ShotIntentPanel/)
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
