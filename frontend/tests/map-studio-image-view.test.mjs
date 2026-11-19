import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createRenderer, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

function transpile(source) {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
}
const snapshotSource = transpile(readFileSync(new URL('../app/map-studio/utils/mapSnapshot.ts', import.meta.url), 'utf8')
  .replace("import { mediaUrl } from '~/utils/url'", "const mediaUrl = (p) => '/media/' + p"))
const snapshotModule = `data:text/javascript;base64,${Buffer.from(snapshotSource).toString('base64')}`
const snapshot = await import(snapshotModule)

const OUTPUTS = { base_image: { path: 'base.png', width: 10, height: 8 }, texture_image: null, final_image: null, kmz: null, layer_doc: null, layer_options: {} }
const SPEC = {
  version: 1, projection: { type: 'mercator' }, bbox: [1, 2, 3, 4],
  layers: { land: true, coastline: true, rivers: true, lakes: true, countries: true },
  places: [{ id: 'city', name: '安阳', lon: 114.3, lat: 36.1, category: 'settlement', description: '殷墟附近（人工）', keywords: ['聚落'], manual: true, name_manual: true, source: 'manual' }],
  routes: [{ id: 'river', name: '河', points: [[1, 2], [3, 4]], category: 'river' }],
  regions: [],
  style: { theme: 'archival' },
}
const RESEARCH = {
  queries: [], sources: [{ id: 'S1', adapter: 'a', title: '来源一', url: null, institution: 'x', date: '', license: '', excerpt: '', tier: 'A' }],
  features: [{ id: 'city', kind: 'place', name: '安阳', uncertainty: 'low', basis: '洹北商城位置', coordinate_basis: 'dataset_point', supporting_excerpt: '原文摘要', source_ids: ['S1'], source_url: null, source_title: '来源一', excerpt_verified: true }],
  uncertainties: [], notes: [], searched_at: '2026-11-19',
}
const LAYER_DOC = { version: 1, base: { path: 'base.png', width: 10, height: 8 }, theme: 'archival', layers: [
  { id: 'feature-city', type: 'marker', name: '安阳', text: '安阳', at: [0.2, 0.3], anchor: { semantic_id: 'city', semantic_name: '安阳' } },
  { id: 'feature-river', type: 'polyline', name: '河', points: [[0.1, 0.2], [0.5, 0.6]], anchor: { semantic_id: 'river', semantic_name: '河' } },
  { id: 'theme-title-1', type: 'label', name: '标题', text: '标题', box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } },
  { id: 'feature-ghost', type: 'marker', name: '缺锚', at: [0.4, 0.5], anchor: { semantic_id: 'gone', semantic_name: 'gone' } },
] }

function detail(overrides = {}) {
  return {
    task_id: 5, title: '地图', host: null, stage: 'complete', status: 'awaiting_review', mode: 'guided', stop_at: 'drawing', revision: 9, busy: false,
    run_id: 4, text_config_id: null, image_config_id: null, image_model: null, error: null, error_detail: null, updated_at: null,
    brief: { subject: '安阳' }, steps: [], issues: [], research: RESEARCH, map_spec: SPEC,
    outputs: { ...OUTPUTS, final_image: { path: 'final-new.png', width: 1600, height: 900, source: 'map-drawing', run_id: 4, provenance: { background: 'base.png' } }, layer_doc: LAYER_DOC },
    history: [
      { revision: 3, at: 'a', stage: 'drawing', status: 'awaiting_review', action: 'stage_done:drawing', actor: 'manual', note: null,
        snapshot: { outputs: { ...OUTPUTS, final_image: { path: 'final-old.png', width: 1600, height: 900, source: 'map-drawing', run_id: 2, provenance: {} }, layer_doc: LAYER_DOC }, map_spec: SPEC, research: RESEARCH } },
      { revision: 7, at: 'b', stage: 'drawing', status: 'awaiting_review', action: 'stage_done:drawing', actor: 'manual', note: null,
        snapshot: { outputs: { ...OUTPUTS, final_image: { path: 'final-old.png', width: 1600, height: 900, source: 'map-drawing', run_id: 2, provenance: {} }, layer_doc: LAYER_DOC }, map_spec: SPEC, research: RESEARCH } },
      { revision: 9, at: 'c', stage: 'complete', status: 'awaiting_review', action: 'stage_done:complete', actor: 'manual', note: null,
        snapshot: { outputs: { ...OUTPUTS, final_image: { path: 'final-new.png', width: 1600, height: 900, source: 'map-drawing', run_id: 4, provenance: {} }, layer_doc: LAYER_DOC }, map_spec: SPEC, research: RESEARCH } },
    ],
    agent: { run_id: 4, rounds: {}, rollbacks: 0, attempts: [] }, deliveries: [], runs_summary: { latest: null, count: 0 },
    ...overrides,
  }
}

test('成图版本：本轮 final 优先、上一版次之、发布 revision 只取 history 记录，空态不伪造', () => {
  const state = snapshot.mapImageState(detail())
  assert.equal(state.current.path, 'final-new.png')
  assert.equal(state.current.snapshotId, '5:8:final', '本轮图首次出现在 revision 9 的快照里 → 发布于 8')
  assert.equal(state.previous.path, 'final-old.png')
  assert.equal(state.previous.snapshotId, '5:2:final', '上一版首次出现在 revision 3 的快照里 → 发布于 2')
  assert.equal(state.previous.kind, 'previous')
  assert.equal(state.defaultSelection, state.current.snapshotId, '默认选本轮成图')
  assert.deepEqual(state.versions.map(v => v.path), ['final-new.png', 'final-old.png'])

  const stale = snapshot.mapImageState(detail({ outputs: { ...OUTPUTS, layer_doc: LAYER_DOC } }))
  assert.equal(stale.current, null)
  assert.equal(stale.previous.path, 'final-new.png', '成图失效时默认选最后一个可验证历史 final')
  assert.equal(stale.previous.snapshotId, '5:8:final')
  assert.equal(stale.defaultSelection, stale.previous.snapshotId)
  assert.deepEqual(stale.versions.map(v => v.path), ['final-new.png', 'final-old.png'])

  const empty = snapshot.mapImageState(detail({ outputs: { ...OUTPUTS, final_image: null, layer_doc: null }, history: [] }))
  assert.equal(empty.versions.length, 0)
  assert.equal(empty.defaultSelection, '5:9:base', '只有底图时显示底图身份，不标成图')
  assert.equal(empty.base.kind, 'base')

  const noRevision = snapshot.mapImageState(detail({
    history: [],
    outputs: { ...OUTPUTS, final_image: { path: 'only.png', width: 10, height: 8, source: 'map-drawing', run_id: null, provenance: null } },
  }))
  assert.equal(noRevision.current.publishedRevision, 9, '只有当前任务 revision 可证明时用它，否则组件显示「未记录」语义')
})

test('深链选择：非法/失效值回默认并给出提示，有效值按 snapshotId 恢复，不产生副作用', () => {
  const state = snapshot.mapImageState(detail())
  assert.deepEqual(snapshot.restoreMapSelection(null, state), { snapshotId: state.current.snapshotId, warning: null })
  assert.deepEqual(snapshot.restoreMapSelection(state.previous.snapshotId, state), { snapshotId: state.previous.snapshotId, warning: null })
  assert.deepEqual(snapshot.restoreMapSelection('5:999:final', state), { snapshotId: state.current.snapshotId, warning: 'missing' })
  assert.deepEqual(snapshot.mapVersionGeometryChanged(detail(), state.previous), false)
  const moved = detail()
  moved.map_spec = { ...SPEC, places: [{ ...SPEC.places[0], lon: 115 }] }
  assert.equal(snapshot.mapVersionGeometryChanged(moved, snapshot.mapImageState(moved).previous), true, '当前几何变了要标「图与当前几何不一致」')
})

test('图层查看器：锚定只按 semantic_id 精确匹配，消费 #125 描述/关键词/所有权，缺字段降级几何摘要', () => {
  const model = snapshot.mapLayerViewerModel({ revision: 8, outputs: { ...OUTPUTS, layer_doc: LAYER_DOC }, spec: SPEC, research: RESEARCH, origin: 'current' }, SPEC)
  assert.equal(model.available, true)
  assert.equal(model.layers.length, 4)
  const city = model.layers.find(layer => layer.id === 'feature-city')
  assert.equal(city.featureName, '安阳')
  assert.equal(city.description, '殷墟附近（人工）')
  assert.deepEqual(city.keywords, ['聚落'])
  assert.equal(city.manual, true)
  assert.equal(city.nameManual, true)
  assert.equal(city.source, 'manual')
  assert.equal(city.basis, '洹北商城位置')
  assert.equal(city.coordinateBasis, 'dataset_point')
  assert.equal(city.excerpt, '原文摘要')
  assert.deepEqual(city.sourceTitles, ['来源一'], '出处只按 source_ids 取同快照来源')
  assert.equal(city.geometryChanged, false)
  assert.deepEqual(city.geometry, { kind: 'point', lon: 114.3, lat: 36.1 })

  const river = model.layers.find(layer => layer.id === 'feature-river')
  assert.equal(river.description, null, '没有 description 就是 null（组件显示「暂无描述」）')
  assert.deepEqual(river.keywords, [])
  assert.equal(river.manual, false)
  assert.deepEqual(river.geometry, { kind: 'vertices', count: 2 })

  const label = model.layers.find(layer => layer.id === 'theme-title-1')
  assert.equal(label.anchorId, null, '无锚定层只显示自身摘要')
  assert.equal(label.featureName, null)

  const ghost = model.layers.find(layer => layer.id === 'feature-ghost')
  assert.equal(ghost.anchorMissing, true, '锚定失效明确标出，不按名称模糊匹配')

  const noDoc = snapshot.mapLayerViewerModel({ revision: 8, outputs: OUTPUTS, spec: SPEC, research: RESEARCH, origin: 'history' }, SPEC)
  assert.deepEqual(noDoc, { available: false, layers: [] }, '此版本未保存图层数据')
})

test('组件渲染与深链恢复只改视图：不发写请求、不自动触发选择/打开事件', async () => {
  const source = readFileSync(new URL('../app/map-studio/components/MapCurrentImage.vue', import.meta.url), 'utf8')
  const descriptor = parse(source).descriptor
  let compiled = compileScript(descriptor, { id: 'map-current-image-test', inlineTemplate: true }).content
  compiled = "import { computed, ref } from 'vue'\n" + compiled
  for (const [name, url] of Object.entries({
    vue: import.meta.resolve('vue'),
    'vue-i18n': import.meta.resolve('vue-i18n'),
    'lucide-vue-next': import.meta.resolve('lucide-vue-next'),
    '~/map-studio/utils/mapSnapshot': snapshotModule,
  })) {
    compiled = compiled.replaceAll(`from '${name}'`, `from '${url}'`).replaceAll(`from "${name}"`, `from "${url}"`)
  }
  const component = (await import(`data:text/javascript;base64,${Buffer.from(transpile(compiled)).toString('base64')}`)).default

  function node(type, text = '') { return { type, text, children: [], props: {}, parent: null } }
  const renderer = createRenderer({
    createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
    setText: (target, text) => { target.text = text }, setElementText: (target, text) => { target.text = text; target.children = [] },
    patchProp: (target, key, _old, value) => { target.props[key] = value },
    parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
    insert(target, parent, anchor = null) { if (target.parent) { const siblings = target.parent.children; siblings.splice(siblings.indexOf(target), 1) } target.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(target); else parent.children.splice(index, 0, target) },
    remove(target) { if (target.parent) { const siblings = target.parent.children; siblings.splice(siblings.indexOf(target), 1); target.parent = null } },
  })
  const all = (target, predicate) => [...(predicate(target) ? [target] : []), ...target.children.flatMap(child => all(child, predicate))]

  const original = globalThis.fetch
  const fetched = []
  globalThis.fetch = async url => { fetched.push(url); return Response.json({ code: 200, data: {} }) }
  const emitted = []
  const state = snapshot.mapImageState(detail())
  const root = node('root')
  const app = renderer.createApp({ setup: () => () => h(component, {
    detail: detail(), state, selectedId: state.current.snapshotId, stale: null,
    onSelect: id => emitted.push(['select', id]),
    onPreview: () => emitted.push(['preview']),
    onOpenLayers: () => emitted.push(['openLayers']),
  }) })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: JSON.parse(readFileSync(new URL('../app/locales/en.json', import.meta.url), 'utf8')) } }))
  try {
    app.mount(root)
    await nextTick()
    const text = all(root, item => true).map(item => `${item.text ?? ''}${typeof item.children === 'string' ? item.children : ''}`).join(' ')
    assert.match(text, /Current render/)
    assert.match(text, /5:8:final/, '身份角标来自快照 id')
    assert.equal(fetched.length, 0, '恢复/渲染不发任何请求')
    assert.deepEqual(emitted, [], '挂载即恢复不触发选择、大图或图层事件')
    const versions = all(root, item => item.type === 'button' && String(item.props.class).includes('img-version'))
    assert.ok(versions.length >= 1)
    versions[0].props.onClick()
    await nextTick()
    assert.deepEqual(emitted.map(item => item[0]), ['select'], '用户点版本只发 select 事件，不写请求')
    assert.equal(fetched.length, 0)
  } finally {
    app.unmount()
    globalThis.fetch = original
  }
})
