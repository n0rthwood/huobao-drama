/**
 * 资产审核清单面板（Issue #55）的结构约束：
 * 四类处置动作齐全、门禁底条两态、失效横幅、补齐路径（补提取 / 新建资产 / 选已有资产）、
 * episode.vue 只在纪录片分支挂载且剧情项目不请求清单接口、四语 locale 键集合一致。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const appRoot = new URL('../app/', import.meta.url)
const readApp = (path) => readFileSync(new URL(path, appRoot), 'utf8')

const panel = readApp('components/AssetReviewPanel.vue')
const episodeView = readApp('views/drama/episode.vue')
const useApi = readApp('composables/useApi.ts')
const semanticsPanel = readApp('components/PropSemanticsPanel.vue')
const locales = ['zh', 'en', 'ja', 'ko'].map(code => [code, JSON.parse(readApp(`locales/${code}.json`))])

test('面板提供四类处置动作与三条补齐路径', () => {
  for (const action of ['action.extract', 'action.create', 'action.bind', 'action.ignore', 'action.notNeeded', 'action.undo']) {
    assert.ok(panel.includes(`episode.assetReview.${action}`), `缺少动作 ${action}`)
  }
  // 忽略必须走弹窗且理由 ≥5 字才能提交
  assert.match(panel, /ignoreDialog\.reason\.trim\(\)\.length < 5/)
  assert.ok(panel.includes('assetReviewAPI.updateItem'))
  assert.ok(panel.includes('assetReviewAPI.extract'))
  assert.ok(panel.includes('assetReviewAPI.run'))
  // 「上传 / AI 生成」= 打开新建资产抽屉并带上条目 id，由服务端回链
  assert.match(panel, /emit\('create-asset'[\s\S]{0,200}review_item_id: item\.id/)
})

test('门禁底条两态 + 失效横幅 + 琥珀「标注待修正」直达', () => {
  assert.ok(panel.includes('episode.assetReview.gate.pending'))
  assert.ok(panel.includes('episode.assetReview.gate.passed'))
  assert.ok(panel.includes('episode.assetReview.gate.next'))
  assert.ok(panel.includes('episode.assetReview.gate.locked'))
  assert.ok(panel.includes('episode.assetReview.staleBanner'))
  assert.ok(panel.includes('episode.assetReview.needsReviewTag'))
  assert.match(panel, /emit\('open-asset'/)
  // 语义面板接受聚焦条目（为空时行为不变）
  assert.ok(semanticsPanel.includes('focusSemanticId'))
  assert.ok(semanticsPanel.includes('data-semantic-id'))
})

test('episode.vue 只在纪录片的审核清单子页签挂载面板', () => {
  assert.match(episodeView, /<AssetReviewPanel[\s\S]{0,400}assetTab === 'review' && isDocumentaryProject/)
  assert.match(episodeView, /@open-asset="openAssetFromReview"/)
  assert.match(episodeView, /@create-asset="openAssetCreateFromReview"/)
  // 新建资产请求带条目 id，服务端保存后自动置「已补」
  assert.ok(episodeView.includes('asset_review_item_id: assetCreate.value.reviewItemId'))
})

test('API 层：四条接口 + 门禁载荷带 missing 计数', () => {
  assert.match(useApi, /assetReviewAPI = \{[\s\S]{0,900}\}/)
  for (const path of [
    '/episodes/${episodeId}/asset-review`',
    '/episodes/${episodeId}/asset-review/run`',
    '/asset-review/items/${itemId}`',
    '/asset-review/items/${itemId}/extract`',
  ]) {
    assert.ok(useApi.includes(path), `缺少接口 ${path}`)
  }
  assert.match(useApi, /review_status: 'none' \| 'running' \| 'pending' \| 'passed'; stale_reasons: string\[\]; missing: number/)
})

test('四语 locale 的 assetReview 键集合完全一致且无占位键残留', () => {
  const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([key, value]) => (
    value && typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`]
  ))
  const [, zh] = locales[0]
  const expected = flatten(zh.episode.assetReview).sort()
  assert.ok(expected.length >= 50, '键数量过少，说明 R2 的文案没补齐')
  for (const [code, doc] of locales) {
    assert.deepEqual(flatten(doc.episode.assetReview).sort(), expected, `${code} 的 assetReview 键集合与 zh 不一致`)
  }
  // R1 的「功能未上线」占位已随实现删除
  for (const [code, doc] of locales) {
    assert.equal(doc.episode.assetReview.startDisabled, undefined, `${code} 仍残留占位键 startDisabled`)
  }
})
