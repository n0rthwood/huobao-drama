/**
 * 分镜设计卡（Issue #57）前端结构约束：
 * 四语 `episode.design.*` 键集合一致且非空、旧的 `episode.intent.*` 整组已删、
 * 段组合四张选择卡且无默认选中、素材选择器的两个空态出路都在。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const appRoot = new URL('../app/', import.meta.url)
const readApp = path => readFileSync(new URL(path, appRoot), 'utf8')

const LOCALES = ['zh', 'en', 'ja', 'ko']
const locales = LOCALES.map(code => [code, JSON.parse(readApp(`locales/${code}.json`))])
const designPanel = readApp('components/DesignCardPanel.vue')
const assetPicker = readApp('components/AssetPicker.vue')

function flatten(value, prefix = '') {
  const keys = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) keys.push(...flatten(child, path))
    else keys.push(path)
  }
  return keys.sort()
}

test('四语 episode.design.* 键集合一致且非空', () => {
  const sets = locales.map(([code, data]) => {
    const design = data.episode?.design
    assert.ok(design, `${code} 缺少 episode.design`)
    const keys = flatten(design)
    assert.ok(keys.length > 0, `${code} 的 episode.design 为空`)
    return [code, keys]
  })
  const [, base] = sets[0]
  for (const [code, keys] of sets.slice(1)) {
    assert.deepEqual(keys, base, `${code} 的 episode.design 键集合与 zh 不一致`)
  }
  // 契约要求的关键分组必须在（而不是只要四语一致就算过）
  for (const key of [
    'title', 'lockedTitle', 'lockedDesc', 'lockedGoto',
    'status.blank', 'status.ai_filling', 'status.pending', 'status.confirmed', 'status.stale',
    'combo.A.name', 'combo.B.name', 'combo.C.name', 'combo.D.name', 'combo.suggested',
    'section.narrative', 'section.structure', 'section.layerPlan', 'section.genPlan', 'section.rationale',
    'affects.combo', 'affects.budget', 'affects.frames',
    'issue.combo_missing', 'issue.budget_over_gen', 'issue.budget_over_layer',
    'budget.limitGen', 'budget.limitLayer', 'junction.locked',
    'batch.fillAll', 'batch.confirmAll', 'batch.scopeTitle', 'batch.willProcess', 'batch.excluded',
    'order.up', 'order.down', 'actions.confirm', 'actions.unconfirm', 'actions.acknowledge',
    'unconfirmedHint', 'unconfirmedShort', 'segment.layer', 'segment.generated', 'segment.composite',
    'picker.emptyAsset', 'picker.emptySemantic', 'picker.gotoAssets', 'picker.gotoSemantics',
  ]) {
    assert.ok(base.includes(key), `episode.design.${key} 缺失`)
  }
})

test('旧的表达设计键 episode.intent.* 四语都已删除', () => {
  for (const [code, data] of locales) {
    assert.equal(data.episode?.intent, undefined, `${code} 仍保留 episode.intent`)
  }
})

test('段组合是四张选择卡，且没有任何默认选中', () => {
  assert.match(designPanel, /v-for="key in COMBOS"/)
  assert.match(designPanel, /episode\.design\.combo\.\$\{key\}\.name/)
  assert.match(designPanel, /episode\.design\.combo\.\$\{key\}\.desc/)
  // 建议只是角标，不等于选中
  assert.match(designPanel, /suggestedCombo === key/)
  assert.match(designPanel, /:aria-pressed="draft\.combo === key"/)
  // 初始组合必须是空：不得出现 combo: 'A' 之类的预选默认值
  assert.match(designPanel, /combo:\s*null/)
  assert.doesNotMatch(designPanel, /combo:\s*['"][ABCD]['"]/)
  assert.doesNotMatch(designPanel, /ref\(\s*['"][ABCD]['"]\s*\)/)
})

test('设计卡面板覆盖门禁、批量范围与衔接帧锁定', () => {
  assert.match(designPanel, /useWorkflowGates/)
  assert.match(designPanel, /episode\.design\.lockedTitle/)
  assert.match(designPanel, /episode\.design\.batch\.scopeTitle/)
  assert.match(designPanel, /episode\.design\.junction\.locked/)
  assert.match(designPanel, /designCardStatus/)
})

test('素材选择器两个空态都有出路', () => {
  assert.match(assetPicker, /episode\.design\.picker\.emptyAsset/)
  assert.match(assetPicker, /episode\.design\.picker\.emptySemantic/)
  assert.match(assetPicker, /episode\.design\.picker\.gotoAssets/)
  assert.match(assetPicker, /episode\.design\.picker\.gotoSemantics/)
  assert.match(assetPicker, /mediaUrl\(/)
})
