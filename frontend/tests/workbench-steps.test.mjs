/** Workbench navigation and gate behavior (Issue #62). */
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

