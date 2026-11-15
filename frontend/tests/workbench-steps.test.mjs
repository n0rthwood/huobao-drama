/** Workbench navigation and roadmap lock behavior (Issue #62 / #105). */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const appRoot = new URL('../app/', import.meta.url)

const {
  DRAMA_PROD_TABS,
  remapProdTab, remapAssetTab, stepTargetOf, isStageLocked, isStageGateUnknown,
} = await import(new URL('utils/workbenchSteps.js', appRoot).href)

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

test('roadmap 未判定时按锁定渲染：首屏/取数失败都不放行内容', () => {
  // roadmap 还没取到（ready=false）：纪录片的受管步骤一律锁定，剧本步与剧情项目不受影响
  for (const stageId of ['assets', 'design', 'production', 'final', 'poster', 'export']) {
    assert.equal(isStageLocked({ documentary: true, stageId, roadmapReady: false, unlocked: undefined }), true, `${stageId} roadmap 未判定时必须锁定`)
    assert.equal(isStageGateUnknown({ documentary: true, stageId, roadmapReady: false }), true)
    assert.equal(isStageLocked({ documentary: false, stageId, roadmapReady: false, unlocked: false }), false, `剧情项目的 ${stageId} 不加锁`)
  }
  assert.equal(isStageLocked({ documentary: true, stageId: 'script', roadmapReady: false, unlocked: false }), false)
  assert.equal(isStageGateUnknown({ documentary: true, stageId: 'script', roadmapReady: false }), false)
  // 判定后只认节点的 unlocked：锁与状态是两个维度（上游未就绪时已有产物的步骤仍是 in_progress/stale 但锁着）
  assert.equal(isStageLocked({ documentary: true, stageId: 'design', roadmapReady: true, unlocked: false }), true)
  assert.equal(isStageLocked({ documentary: true, stageId: 'assets', roadmapReady: true, unlocked: true }), false)
  assert.equal(isStageGateUnknown({ documentary: true, stageId: 'design', roadmapReady: true }), false)
})

