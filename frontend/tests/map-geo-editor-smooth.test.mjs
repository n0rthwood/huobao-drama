import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { createRenderer, h, nextTick, reactive, ref } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createI18n } from 'vue-i18n'
import { deeplinkRuntimeModule } from './sfc-deeplink-runtime.mjs'

// 执行真实的 MapGeoEditor.vue：平滑开关/滑杆只发 layer-options 草稿、画布用同源函数实时预览、
// 中点把手按像素反投影插入顶点。这里不 mock 组件逻辑，只替换 Nuxt 别名与侧效（toast/mediaUrl）。
const app = new URL('../app/', import.meta.url)
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const registrationModule = dataModule(transpile(readFileSync(new URL('map-studio/utils/mapRegistration.ts', app), 'utf8')))
const aliases = {
  vue: import.meta.resolve('vue'),
  'vue-i18n': import.meta.resolve('vue-i18n'),
  'lucide-vue-next': import.meta.resolve('lucide-vue-next'),
  'vue-sonner': dataModule('export const toast = { warning(){}, success(){}, error(){}, info(){} }'),
  '~/composables/useQuerySync': deeplinkRuntimeModule,
  '~/map-studio/utils/mapRegistration': registrationModule,
  '~/map-studio/utils/smooth': new URL('map-studio/utils/smooth.js', app).href,
  '~/utils/url': dataModule("export const mediaUrl = path => path; export const apiBase = () => '/api/v1'"),
}

async function loadGeoEditor() {
  const { descriptor } = parse(readFileSync(new URL('map-studio/components/MapGeoEditor.vue', app), 'utf8'))
  let source = compileScript(descriptor, { id: 'test-map-geo', inlineTemplate: true }).content
  for (const [name, url] of Object.entries(aliases)) {
    source = source.replaceAll(`from '${name}'`, `from '${url}'`).replaceAll(`from "${name}"`, `from "${url}"`)
  }
  return (await import(dataModule(transpile(source)))).default
}
const GeoEditor = await loadGeoEditor()
const messages = JSON.parse(readFileSync(new URL('locales/en.json', app), 'utf8'))

// 720×720 的等距圆柱程序投影：经度 0..10 → x 0..720，纬度 40..50 → y 720..0
const DEG = Math.PI / 180
const REGISTRATION = {
  mode: 'program',
  width: 720,
  height: 720,
  bbox: [0, 40, 10, 50],
  program: { projection: 'equirectangular', bbox: [0, 40, 10, 50], scale: 720 / (10 * DEG), translate: [0, 3600] },
}
// 像素空间的形状（短边夹在两条长边之间）：缺省强度 1 时第 3 段偏离超出验收口径
const CONTROL_POINTS = [[1, 45.5], [5.5, 46], [9, 45.4], [9, 44.7], [5, 43.8]]
const specWithRegion = () => ({
  bbox: [0, 40, 10, 50],
  places: [],
  routes: [],
  regions: [{
    id: 'r-1',
    name: '测试面',
    points: CONTROL_POINTS.map(point => [point[0], point[1]]),
    origin: 'model',
    proposed: true,
    verification: { status: 'proposed', reasons: [] },
  }],
})

function allNodes(root) {
  return [root, ...root.children.flatMap(allNodes)]
}
function classesOf(node) {
  const raw = node.props.class
  if (!raw) return []
  if (Array.isArray(raw)) return raw.flatMap(value => classesOf({ props: { class: value } }))
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean)
  if (typeof raw === 'object') return Object.entries(raw).filter(([, on]) => on).map(([name]) => name)
  return []
}
const nodesWithClass = (root, name) => allNodes(root).filter(node => classesOf(node).includes(name))

async function mountGeoEditor(t, values) {
  // 组件里的输入处理按 instanceof HTMLInputElement 校验目标
  const originalInput = globalThis.HTMLInputElement
  const originalElement = globalThis.Element
  globalThis.HTMLInputElement = globalThis.HTMLInputElement || class FakeInputElement {}
  globalThis.Element = globalThis.Element || class FakeElement {}
  const originalWindow = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {}, confirm: () => true }
  function element(type, text = '') {
    return {
      type, text, props: {}, children: [], parent: null, focus() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 720, height: 720 } },
    }
  }
  function remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  }
  const renderer = createRenderer({
    createElement: type => element(type),
    createText: text => element('#text', text),
    createComment: () => element('#comment'),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, previous, value) => { node.props[key] = value },
    insert(node, parent, anchor = null) {
      remove(node)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
      node.parent = parent
    },
    remove,
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  })
  const root = element('root')
  const props = reactive(values)
  const instance = ref(null)
  const mounted = renderer.createApp({ render: () => h(GeoEditor, { ...props, ref: instance }) })
  mounted.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  mounted.mount(root)
  t.after(() => {
    mounted.unmount()
    globalThis.window = originalWindow
    if (originalInput === undefined) delete globalThis.HTMLInputElement
    else globalThis.HTMLInputElement = originalInput
    if (originalElement === undefined) delete globalThis.Element
    else globalThis.Element = originalElement
  })
  await nextTick()
  return { root, instance: instance.value }
}

test('缺省强度 1：画布实时画平滑曲线、控制点仍可拖，侧栏给出偏离警示', async t => {
  const spec = specWithRegion()
  const mounted = await mountGeoEditor(t, {
    spec,
    persistedSpec: spec,
    registration: REGISTRATION,
    baseImage: { path: 'static/base.png', width: 720, height: 720 },
    layerDoc: { layers: [{ id: 'L-region', type: 'polygon', anchor: { semantic_id: 'r-1' } }] },
    layerOptions: {},
  })
  const [region] = nodesWithClass(mounted.root, 'geo-region')
  assert.ok(region, '面必须画出来')
  const preview = String(region.props.points).trim().split(/\s+/)
  assert.ok(preview.length > CONTROL_POINTS.length, '预览必须是细分后的曲线，不是折线副本')
  const [startX, startY] = preview[0].split(',').map(Number)
  assert.ok(Math.abs(startX - 72) < 1e-6 && Math.abs(startY - 324) < 1e-6, `曲线从首个控制点开始，实际 ${preview[0]}`)
  assert.equal(nodesWithClass(mounted.root, 'geo-vertex').length, CONTROL_POINTS.length, '控制点全部保留且可拖')
  assert.equal(nodesWithClass(mounted.root, 'geo-smooth-warn').length, 1, '偏离超限必须提示')
  const [toggle] = nodesWithClass(mounted.root, 'geo-smooth-toggle')
  assert.equal(toggle.props['aria-pressed'], true, '缺省强度 1 = 开')
})

test('平滑开关与滑杆只发 layer-options 草稿，键是落地图层 id，值不钳制', async t => {
  const spec = specWithRegion()
  const emitted = []
  const mounted = await mountGeoEditor(t, {
    spec,
    persistedSpec: spec,
    registration: REGISTRATION,
    baseImage: { path: 'static/base.png', width: 720, height: 720 },
    layerDoc: { layers: [{ id: 'L-region', type: 'polygon', anchor: { semantic_id: 'r-1' } }] },
    layerOptions: {},
    onLayerOptions: value => emitted.push(value),
  })
  const [toggle] = nodesWithClass(mounted.root, 'geo-smooth-toggle')
  toggle.props.onClick({ stopPropagation() {} })
  assert.deepEqual(emitted.at(-1), { 'L-region': { smooth: 0 } }, '关闭时显式写 0，不删键')

  const input = new globalThis.HTMLInputElement()
  input.value = '0.4'
  const [slider] = nodesWithClass(mounted.root, 'geo-smooth-slider')
  slider.props.onInput({ target: input })
  assert.deepEqual(emitted.at(-1), { 'L-region': { smooth: 0.4 } }, '滑杆值原样上草稿')
  assert.equal(emitted.length, 2)
})

test('还没画出图层时平滑键用要素 id 暂存（作图阶段再映射）', async t => {
  const spec = specWithRegion()
  const emitted = []
  const mounted = await mountGeoEditor(t, {
    spec,
    persistedSpec: spec,
    registration: REGISTRATION,
    baseImage: { path: 'static/base.png', width: 720, height: 720 },
    layerDoc: null,
    layerOptions: {},
    onLayerOptions: value => emitted.push(value),
  })
  const [toggle] = nodesWithClass(mounted.root, 'geo-smooth-toggle')
  toggle.props.onClick({ stopPropagation() {} })
  assert.deepEqual(emitted.at(-1), { 'r-1': { smooth: 0 } })
})

test('强度 0：预览回到折线，偏离警示消失', async t => {
  const spec = specWithRegion()
  const mounted = await mountGeoEditor(t, {
    spec,
    persistedSpec: spec,
    registration: REGISTRATION,
    baseImage: { path: 'static/base.png', width: 720, height: 720 },
    layerDoc: { layers: [{ id: 'L-region', type: 'polygon', anchor: { semantic_id: 'r-1' } }] },
    layerOptions: { 'L-region': { smooth: 0 } },
  })
  const [region] = nodesWithClass(mounted.root, 'geo-region')
  assert.equal(String(region.props.points).trim().split(/\s+/).length, CONTROL_POINTS.length, '关闭时点不变')
  assert.equal(nodesWithClass(mounted.root, 'geo-smooth-warn').length, 0)
  const [toggle] = nodesWithClass(mounted.root, 'geo-smooth-toggle')
  assert.equal(toggle.props['aria-pressed'], false)
})

test('中点把手：选中后出现，点击按像素中点反投影插入顶点且原控制点不动', async t => {
  const spec = specWithRegion()
  const emitted = []
  const mounted = await mountGeoEditor(t, {
    spec,
    persistedSpec: spec,
    registration: REGISTRATION,
    baseImage: { path: 'static/base.png', width: 720, height: 720 },
    layerDoc: { layers: [{ id: 'L-region', type: 'polygon', anchor: { semantic_id: 'r-1' } }] },
    layerOptions: { 'L-region': { smooth: 0 } },
    onUpdate: value => emitted.push(value),
  })
  assert.equal(nodesWithClass(mounted.root, 'geo-midpoint').length, 0, '未选中的形状不铺把手')
  const [row] = nodesWithClass(mounted.root, 'geo-item')
  row.props.onClick()
  await nextTick()
  const handles = nodesWithClass(mounted.root, 'geo-midpoint')
  assert.equal(handles.length, CONTROL_POINTS.length, '闭合环每段一个把手（含最后一段连回首点）')
  handles[0].props.onPointerdown({ stopPropagation() {} })
  const next = emitted.at(-1)
  assert.ok(next, '插入必须发出新的 spec')
  const points = next.regions[0].points
  assert.equal(points.length, CONTROL_POINTS.length + 1, '控制点数 +1')
  assert.deepEqual(points[1], [3.25, 45.75], '像素中点 (234,306) 反投影成 (3.25, 45.75)')
  assert.deepEqual(points.filter((_, index) => index !== 1), CONTROL_POINTS, '原控制点顺序与数值一个不动')
  assert.equal(next.regions[0].origin, 'manual', '人工插入点是 manual')
  assert.equal('proposed' in next.regions[0], false, '人工确认后不再留在 AI 候选状态')
  assert.equal(next.regions[0].verification.status, 'confirmed')
})

test('没有底图/配准也可预设平滑：逐点要素默认开，dataset 默认关，均用要素 id', async t => {
  for (const origin of ['model', 'dataset']) {
    await t.test(origin, async child => {
      const spec = specWithRegion()
      spec.regions[0].origin = origin
      const emitted = []
      const mounted = await mountGeoEditor(child, {
        spec, persistedSpec: spec, registration: null, baseImage: null, layerDoc: null,
        layerOptions: {}, onLayerOptions: value => emitted.push(value),
      })
      const [toggle] = nodesWithClass(mounted.root, 'geo-smooth-toggle')
      assert.equal(toggle.props['aria-pressed'], origin !== 'dataset')
      toggle.props.onClick({ stopPropagation() {} })
      assert.deepEqual(emitted.at(-1), { 'r-1': { smooth: origin === 'dataset' ? 1 : 0 } })
    })
  }
})

test('数据集几何插入中点后明确转 manual/confirmed，移除 dataset_ref 并保留其他元数据', async t => {
  const spec = specWithRegion()
  Object.assign(spec.regions[0], {
    origin: 'dataset', dataset_ref: { ref: 'ne:10m_lakes:1' },
    category: 'lake', relations: [{ id: 'relation-1' }],
    verification: { status: 'verified', reasons: ['dataset'] },
  })
  let updated
  const mounted = await mountGeoEditor(t, {
    spec, persistedSpec: spec, registration: REGISTRATION,
    baseImage: { path: 'static/base.png', width: 720, height: 720 },
    layerDoc: null, layerOptions: {}, onUpdate: value => { updated = value },
  })
  nodesWithClass(mounted.root, 'geo-item')[0].props.onClick()
  await nextTick()
  nodesWithClass(mounted.root, 'geo-midpoint')[0].props.onPointerdown({ stopPropagation() {} })
  assert.equal(updated.regions[0].origin, 'manual')
  assert.equal(updated.regions[0].verification.status, 'confirmed')
  assert.equal('dataset_ref' in updated.regions[0], false)
  assert.equal('proposed' in updated.regions[0], false)
  assert.equal(updated.regions[0].category, 'lake')
  assert.deepEqual(updated.regions[0].relations, spec.regions[0].relations)
  assert.deepEqual(updated.regions[0].points.filter((_, index) => index !== 1), CONTROL_POINTS)
})
