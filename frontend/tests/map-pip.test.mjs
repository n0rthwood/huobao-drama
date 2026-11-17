import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

// 与 map-studio-api.test.mjs 同一口径：直接转译源码，测真实实现，不复制一份逻辑。
function load(relative, replacements = []) {
  let source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  for (const [from, to] of replacements) {
    assert.ok(source.includes(from), `expected source to contain ${from}`)
    source = source.replace(from, to)
  }
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}

const pip = await load('../app/map-studio/utils/mapPip.ts', [
  ["from 'd3-geo'", `from '${import.meta.resolve('d3-geo')}'`],
])
const preview = await load('../app/map-studio/utils/mapPreview.ts', [
  ["import type { MapStudioOutputs } from '~/map-studio/api'", ''],
  ["import type { MapRegistration } from '~/map-studio/utils/mapRegistration'", ''],
  ["import { mediaUrl } from '~/utils/url'", "const mediaUrl = (url) => '/huobao/' + String(url).replace(/^\\/+/, '')"],
])

// 翻译桩：只记录选中的 key 与参数，locale 文本本身由四个语言的 JSON 保证。
const t = (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key)

test('map_pip 徽标：全览给细节个数，细节给编号/所属全览/过期', () => {
  const overview = { role: 'overview', frames: [{ no: 1 }, { no: 2 }, { no: 3 }], usage: '用法' }
  assert.deepEqual(pip.pipBadgeOf(overview), {
    role: 'overview', detailCount: 3, frameNo: null, parentName: '', stale: false, usage: '用法', label: '',
  })
  // 列表接口可能给原样 JSON 字符串：解析后再读，不要当成没有画中画
  const detail = JSON.stringify({ role: 'detail', parent_name: ' 全览图 ', frame: { no: 2, label: '乌格拉河口' }, usage: 'u', stale: true })
  assert.deepEqual(pip.pipBadgeOf(detail), {
    role: 'detail', detailCount: 0, frameNo: 2, parentName: '全览图', stale: true, usage: 'u', label: '乌格拉河口',
  })
  // 还没登记 frames 的全览：细节个数就是 0，不猜
  assert.equal(pip.pipBadgeOf({ role: 'overview' }).detailCount, 0)
})

test('map_pip 徽标：形状不认识就不显示，绝不按名字猜画中画', () => {
  for (const raw of [null, undefined, '', 'not json', '{}', [], { role: 'prop' }, { frames: [] }, 42]) {
    assert.equal(pip.pipBadgeOf(raw), null, `unexpected badge for ${JSON.stringify(raw)}`)
    assert.equal(pip.pipBadgeText(raw, t), '')
  }
  // frame 缺失时编号写成「-」，文字里不会出现 undefined 或空括号
  assert.equal(pip.pipBadgeText({ role: 'detail', parent_name: '全览' }, t), 'mapStudio.pip.detailBadge({"no":"-","name":"全览"})')
})

test('map_pip 徽标文字：全览/细节/过期的 key 与参数', () => {
  assert.equal(pip.pipBadgeText({ role: 'overview', frames: [{}, {}] }, t), 'mapStudio.pip.overviewBadge({"n":2})')
  assert.equal(pip.pipBadgeText({ role: 'detail', parent_name: 'Russia', frame: { no: 1 } }, t), 'mapStudio.pip.detailBadge({"no":1,"name":"Russia"})')
  assert.equal(
    pip.pipBadgeText({ role: 'detail', parent_name: 'Russia', frame: { no: 1 }, stale: true }, t),
    'mapStudio.pip.detailBadge({"no":1,"name":"Russia"}) · mapStudio.pip.stale',
  )
})

test('map_pip 编号角标颜色：1 起按四色轮转，非法编号不配色', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(pip.pipFrameColor), ['#6b2c91', '#c46a00', '#00796b', '#b3272d', '#6b2c91'])
  for (const raw of [0, -1, 1.5, null, undefined, '2']) assert.equal(pip.pipFrameColor(raw), null, `unexpected colour for ${String(raw)}`)
})

const outputs = {
  pip: {
    layout: { id: 'L2b-B', family: 'B', label_tier: 'reduced' },
    frames: [{ no: 1, label: '乌格拉河口' }, { no: 2, label: '上乌拉尔' }],
    details: [{ no: 2, path: 'static/map-pip/d2.png', width: 1080, height: 1920, sha256: 'x' }],
    composite: { path: 'static/map-pip/composite.png', width: 3840, height: 2160, sha256: 'y' },
  },
  base_image: { path: 'static/map/base.png', width: 3840, height: 2160, source: 'map-base:program' },
}

test('预览身份：只认固定产出与 pip 两种写法，编号必须是正整数', () => {
  assert.equal(preview.mapPreviewView('base'), 'base')
  assert.equal(preview.mapPreviewView(' pip-detail:2 '), 'pip-detail:2')
  assert.equal(preview.mapPreviewView('pip-composite'), 'pip-composite')
  for (const raw of ['pip-detail:0', 'pip-detail:', 'pip-detail:1.5', 'pip-detail:002', 'pip:1', '', null, 3]) {
    assert.equal(preview.mapPreviewView(raw), null, `unexpected view for ${JSON.stringify(raw)}`)
  }
  assert.equal(preview.pipDetailView(3), 'pip-detail:3')
  assert.equal(preview.pipDetailView(0), null)
  assert.equal(preview.pipDetailNo('pip-detail:2'), 2)
  assert.equal(preview.pipDetailNo('base'), null)
})

test('预览求值：细节图/组合图按产出身份取当前这一版，缺图返回 null', () => {
  const detail = preview.mapPreviewImage('pip-detail:2', outputs, null)
  assert.equal(detail.url, '/huobao/static/map-pip/d2.png')
  assert.equal(detail.width, 1080)
  assert.equal(detail.height, 1920)
  assert.equal(detail.source, '')
  assert.equal(detail.labelKey, 'pipDetail')
  assert.deepEqual(detail.labelParams, { no: 2, label: '上乌拉尔' })
  // 细节 1 还没渲染：不能拿细节 2 的图顶上
  assert.equal(preview.mapPreviewImage('pip-detail:1', outputs, null), null)
  assert.equal(preview.mapPreviewImage('pip-detail:2', { pip: { ...outputs.pip, details: [] } }, null), null)
  const composite = preview.mapPreviewImage('pip-composite', outputs, null)
  assert.equal(composite.url, '/huobao/static/map-pip/composite.png')
  assert.equal(composite.labelKey, 'pipComposite')
  assert.equal(preview.mapPreviewImage('pip-composite', { pip: { ...outputs.pip, composite: null } }, null), null)
  // 固定产出照旧
  const base = preview.mapPreviewImage('base', outputs, null)
  assert.equal(base.url, '/huobao/static/map/base.png')
  assert.equal(base.labelKey, 'base_image')
  assert.equal(base.source, 'map-base:program')
})

test('预览标题：产出被清掉时仍能说出是哪个预览不可用', () => {
  assert.equal(preview.mapPreviewLabel('pip-composite', { pip: null }).key, 'pipComposite')
  // 帧已经没了也要能给出编号，标题留空而不是编一个名字
  assert.deepEqual(preview.mapPreviewLabel('pip-detail:3', { pip: { frames: [] } }), { key: 'pipDetail', params: { no: 3, label: '' } })
  assert.deepEqual(preview.mapPreviewLabel('pip-detail:1', outputs), { key: 'pipDetail', params: { no: 1, label: '乌格拉河口' } })
  assert.equal(preview.mapPreviewLabel('final', outputs).key, 'final_image')
  assert.equal(preview.mapPreviewLabel('calibration', outputs).key, 'calibrationEvidence')
})
