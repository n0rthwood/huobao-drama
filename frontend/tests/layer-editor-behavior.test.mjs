import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { createRenderer, h, nextTick, reactive, ref } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createI18n } from 'vue-i18n'
import { baseAspectIssue, baseFrameOf, clampTimelineToFrame, cropRectOf } from '../app/utils/layerQuality.js'
import { semanticEntries, semanticLayerPatch, anchorState } from '../app/utils/semanticGeometry.js'
import { TEXT_SPEC, setLayerTextSpec, textLayerRects, textLayoutsFor } from '../app/utils/layerText.js'
import { deeplinkRuntimeModule } from './sfc-deeplink-runtime.mjs'

// Resolve Nuxt's compile-time aliases while executing the real Vue composables.
const app = new URL('../app/', import.meta.url)
function moduleUrl(path, aliases = {}) {
  let source = readFileSync(new URL(path, app), 'utf8')
  for (const [name, url] of Object.entries({
    vue: import.meta.resolve('vue'),
    '~/utils/layerSvg': new URL('utils/layerSvg.js', app).href,
    '~/utils/layerText': new URL('utils/layerText.js', app).href,
    ...aliases,
  })) {
    source = source.replaceAll(`from '${name}'`, `from '${url}'`)
  }
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
}
const glyphModule = moduleUrl('composables/useMissingGlyphs.ts')
const { useLayerDoc, emptyLayerDoc } = await import(moduleUrl('composables/useLayerDoc.ts', { '~/composables/useMissingGlyphs': glyphModule }))
const makeDoc = () => ({ ...emptyLayerDoc({ path: 'static/test.png', width: 3840, height: 2880 }), layers: [{ id: 'pin', name: 'Pin', type: 'marker', at: [.4, .4], text: '地点', anchor: {asset_id: 1, semantic_id: 'point'}, style: {}, visible: true, locked: false, opacity: 1, z: 0, rotation: 0 }] })

test('anchored geometry requires confirmation and cancellation changes neither history nor geometry', async () => {
  const editor = useLayerDoc()
  editor.load(makeDoc())
  await nextTick()
  const before = JSON.stringify(editor.doc.value)
  const result = editor.patchLayer('pin', {at: [.8, .8]})
  assert.equal(result.confirmationRequired, true)
  assert.equal(JSON.stringify(editor.doc.value), before)
  assert.equal(editor.canUndo.value, false)
  editor.pushHistory()
  editor.detachAnchors(['pin'])
  editor.patchLayer('pin', {at: [.8, .8]})
  assert.equal(editor.doc.value.layers[0].anchor.detached, true)
  editor.undo()
  assert.equal(JSON.stringify(editor.doc.value), before)
})

test('crop undo restores both document crop and all whole-image frame viewports', async () => {
  let timeline = {keyframes: [{t: 0, viewport: {x: 0, y: 0, w: 1, h: 1}, visible: []}]}
  const original = JSON.stringify(timeline)
  const editor = useLayerDoc(undefined, {snapshot: () => timeline, restore: value => { timeline = value }})
  editor.load(makeDoc())
  await nextTick()
  editor.pushHistory()
  const crop = {x: 0, y: .125, w: 1, h: .75}
  editor.doc.value.base.crop = crop
  const result = clampTimelineToFrame(timeline, { source_width: 1920, source_height: 1080, crop }, { width: 960, height: 544 })
  timeline = result.timeline
  assert.equal(result.changed, true)
  assert.notEqual(JSON.stringify(timeline), original)
  editor.undo()
  assert.equal(editor.doc.value.base.crop, undefined)
  assert.equal(JSON.stringify(timeline), original)
  editor.redo()
  assert.deepEqual(editor.doc.value.base.crop, crop)
  // contain：取景归一到取景框（含留白带），不是裁切框本身
  assert.deepEqual(timeline.keyframes[0].viewport, baseFrameOf({ source_width: 1920, source_height: 1080, crop }, { width: 960, height: 544 }).frame)
})

test('saved server metadata preserves history/selection and does not trigger a new save', async () => {
  let saves = 0
  const editor = useLayerDoc(() => {saves++})
  editor.load(makeDoc())
  await nextTick()
  editor.selectedIds.value = ['pin']
  editor.pushHistory()
  editor.acceptSaved({...makeDoc(), base: {...makeDoc().base, source_width: 3840, source_height: 2880}})
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 330))
  assert.equal(saves, 0)
  assert.deepEqual([...editor.selectedIds.value], ['pin'])
  assert.equal(editor.canUndo.value, true)
})

test('unsupported glyph warning follows live text and clears on deletion', async () => {
  const editor = useLayerDoc()
  editor.load(makeDoc())
  await nextTick()
  editor.patchLayer('pin', {text: '测试≠'})
  assert.ok(editor.missingGlyphs.value.includes('≠'))
  editor.patchLayer('pin', {text: '测试'})
  assert.equal(editor.missingGlyphs.value.includes('≠'), false)
})

test('semantic quick-create and manual reanchor keep whole-image pixel coordinates and distinguish deletion from layer rename', async () => {
  const entries = semanticEntries({image:{width:4000,height:3000},points:[{id:'p',name:'地点',at:[1000,1500]}]})
  const patch = semanticLayerPatch(entries[0],1)
  assert.deepEqual(patch.at,[.25,.5])
  const editor=useLayerDoc()
  editor.load(makeDoc())
  await nextTick()
  editor.detachAnchors(['pin'])
  assert.equal(anchorState(editor.doc.value.layers[0],entries,true,1),'manual')
  editor.reanchorLayer('pin',patch)
  assert.equal(anchorState(editor.doc.value.layers[0],entries,true,1),'anchored')
  editor.patchLayer('pin',{name:'Editable layer title'})
  assert.equal(anchorState(editor.doc.value.layers[0],entries,true,1),'anchored')
  assert.equal(anchorState(editor.doc.value.layers[0],[],true,1),'unlink')
  assert.equal(anchorState(editor.doc.value.layers[0],[{...entries[0],name:'Renamed source'}],true,1),'unlink')
  editor.undo()
  assert.equal(anchorState(editor.doc.value.layers[0],entries,true,1),'manual')
})

test('第一个模板文本框自动选一套版式，换套保留图层，几何补丁被忽略（#96）', async () => {
  const editor = useLayerDoc(undefined, undefined, undefined, { medium: 'video' })
  editor.load(emptyLayerDoc({ width: 1920, height: 1080 }))
  await nextTick()
  const first = textLayoutsFor('16:9', 'video')[0]
  const layer = editor.addLayer('text', { role: 'heading' })
  assert.equal(editor.doc.value.text_layout, first.id, '第一个文本框按成片画幅与媒介选第一套')
  assert.equal(layer.type, 'text')
  assert.equal(layer.role, 'heading')
  assert.equal(layer.name, TEXT_SPEC.roles.heading.name, '文本框名字就是角色名（与后端缺省一致）')
  assert.equal(layer.box, undefined, '模板文本框没有自由几何')
  // 几何补丁静默丢弃：拖不动不应该在文档里留下没用的框/旋转
  editor.patchLayer(layer.id, { box: { x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, rotation: 42 })
  assert.equal(layer.box, undefined)
  assert.equal(layer.rotation, 0)
  editor.patchLayer(layer.id, { fields: { main: '甲午战争' } })
  const second = textLayoutsFor('16:9', 'video')[1]
  editor.setTextLayout(second.id)
  assert.equal(editor.doc.value.text_layout, second.id)
  assert.deepEqual(editor.doc.value.layers.map(item => [item.id, item.role, item.fields]), [[layer.id, 'heading', { main: '甲午战争' }]], '换套只改文档级套，图层原样保留')

  // 竖版项目走海报媒介的 9:16 套
  const poster = useLayerDoc(undefined, undefined, undefined, { medium: 'poster' })
  poster.load(emptyLayerDoc({ width: 1080, height: 1920 }))
  await nextTick()
  poster.addLayer('text', { role: 'poster_title' })
  assert.equal(poster.doc.value.text_layout, textLayoutsFor('9:16', 'poster')[0].id)
  // 没有角色的文本框不建：不产生必然非法的文档
  assert.equal(poster.addLayer('text'), null)
  assert.equal(poster.doc.value.layers.length, 1)
})

// Mount the actual SFCs with Vue's host-independent renderer. Only browser layout,
// unrelated child panels, URL configuration and API transport are test seams.
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const emptyPanel = dataModule('export default { render: () => null }')
const pickerPanel = dataModule(`import {h} from '${import.meta.resolve('vue')}';
export default {props:['assets','open'],emits:['confirm'],setup(props,{emit}) {
  return () => h('asset-picker-test',{assets:props.assets,onChoose:items=>emit('confirm',items)})
}}`)
// 规范（#96）在测试里只注入一次：模板文本框的排版/命中框都由它算。
const textSpec = JSON.parse(readFileSync(new URL('../../backend/src/config/layer-text-spec.json', import.meta.url), 'utf8'))
setLayerTextSpec(textSpec)
const testApi = dataModule(`export const api = { get: async () => (${JSON.stringify(textSpec)}) };
export const assetPipelineAPI = {baseCandidates:async()=>({candidates:[
  {asset_kind:'prop',asset_id:7,asset_name:'Replacement',version_task_id:9,path:'static/replacement.png',width:2048,height:2048}
]})}; export const propAPI = {semantics:async()=>({semantics:{}})};`)
const textSpecComposable = moduleUrl('composables/useLayerTextSpec.ts', {
  'vue-i18n': import.meta.resolve('vue-i18n'),
  '~/composables/useApi': testApi,
})
const componentAliases = {
  vue: import.meta.resolve('vue'),
  'vue-i18n': import.meta.resolve('vue-i18n'),
  'lucide-vue-next': import.meta.resolve('lucide-vue-next'),
  'vue-sonner': dataModule('export const toast={warning(){},success(){},error(){},info(){}}'),
  '~/utils/layerSvg': new URL('utils/layerSvg.js', app).href,
  '~/utils/layerQuality': new URL('utils/layerQuality.js', app).href,
  '~/utils/semanticGeometry': new URL('utils/semanticGeometry.js', app).href,
  '~/utils/url': dataModule("export const mediaUrl = path => path; export const apiBase = () => '/api/v1';"),
  '~/composables/useApi': testApi,
  '~/utils/layerText': new URL('utils/layerText.js', app).href,
  '~/composables/useLayerTextSpec': textSpecComposable,
  '~/composables/useMissingGlyphs': glyphModule,
  '~/composables/useQuerySync': deeplinkRuntimeModule,
  '~/components/AssetPicker.vue': pickerPanel,
  './LayerList.vue': emptyPanel,
  './LayerStyle.vue': emptyPanel,
  './LayerImagePicker.vue': emptyPanel,
}
async function loadComponent(name) {
  const { descriptor } = parse(readFileSync(new URL(`components/LayerCanvas/${name}.vue`, app), 'utf8'))
  let source = compileScript(descriptor, { id: `test-${name}`, inlineTemplate: true }).content
  for (const [alias, url] of Object.entries(componentAliases)) {
    source = source.replaceAll(`from '${alias}'`, `from '${url}'`).replaceAll(`from "${alias}"`, `from "${url}"`)
  }
  return (await import(dataModule(source))).default
}
const Canvas = await loadComponent('LayerCanvas')
const Rail = await loadComponent('LayerRail')
const List = await loadComponent('LayerList')
const Style = await loadComponent('LayerStyle')
const messages = JSON.parse(readFileSync(new URL('locales/en.json', app), 'utf8'))
function allNodes(root) { return [root, ...root.children.flatMap(allNodes)] }
function withClass(root, name) { return allNodes(root).find(node => String(node.props.class || '').split(' ').includes(name)) }
function nodeText(root) { return root.text + root.children.map(nodeText).join('') }
async function mountCanvasComponent(t, component, values) {
  const originalWindow = globalThis.window
  const originalRaf = globalThis.requestAnimationFrame
  const listeners = new Map()
  globalThis.window = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
    confirm: () => true,
  }
  globalThis.requestAnimationFrame = fn => { fn(); return 1 }
  function element(type, text = '') {
    return { type, text, props: {}, children: [], parent: null, focus() {},
      querySelector(selector) { return withClass(this, selector.slice(1)) },
      getBoundingClientRect() {
        return { left: 0, top: 0,
          width: this.props.class === 'lc-viewport' ? 984 : Number.parseFloat(this.props.style?.width) || 960,
          height: this.props.class === 'lc-viewport' ? 568 : Number.parseFloat(this.props.style?.height) || 544 }
      },
    }
  }
  function remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  }
  const renderer = createRenderer({
    createElement: type => element(type), createText: text => element('#text', text), createComment: () => element('#comment'),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, previous, value) => { node.props[key] = value },
    insert(node, parent, anchor = null) {
      remove(node)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
      node.parent = parent
    },
    remove, parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  })
  const root = element('root')
  const props = reactive(values)
  const instance = ref(null)
  const mounted = renderer.createApp({ render: () => h(component, { ...props, ref: instance }) })
  mounted.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  mounted.mount(root)
  t.after(() => {
    mounted.unmount()
    globalThis.window = originalWindow
    globalThis.requestAnimationFrame = originalRaf
  })
  await nextTick()
  return { root, props, instance: instance.value, listeners }
}
const outputDoc = base => ({
  ...emptyLayerDoc({ path: 'static/original.png', width: 960, height: 544 }),
  base: { path: 'static/original.png', width: 960, height: 544, source_width: 1024, source_height: 1024, ...base },
  layers: [{ id: 'image', type: 'image', name: 'Original layer', visible: true, locked: false, opacity: 1, z: 0, rotation: 0,
    src: { path: 'static/layer.png' }, box: { x: .25, y: .25, w: .5, h: .5 }, fit: 'cover', style: {} }],
})

const viewBoxOf = box => `${box.x * 1024} ${box.y * 1024} ${box.w * 1024} ${box.h * 1024}`
const containFrame = baseFrameOf({ source_width: 1024, source_height: 1024 }, { width: 960, height: 544 }).frame

test('1024² 源图在 960×544 项目里 contain：舞台是成片，世界是源图，取景框含留白带（#94）', async t => {
  const doc = outputDoc()
  const mounted = await mountCanvasComponent(t, Canvas, {
    doc, baseSrc: doc.base.path, selectedIds: ['image'], viewport: { x: .25, y: .25, w: .5, h: .5 },
  })
  const stage = withClass(mounted.root, 'lc-stage')
  assert.deepEqual([stage.props.style.width, stage.props.style.height], ['960px', '544px'])
  assert.equal(withClass(mounted.root, 'lc-ui').props.viewBox, viewBoxOf(containFrame), '取景框按成片比例向两侧扩出留白')
  const markup = withClass(mounted.root, 'lc-overlay').props.innerHTML
  assert.match(markup, /width="960" height="544"/)
  assert.ok(!markup.includes('preserveAspectRatio="none"'), '矢量不再拉伸')
  const hit = withClass(mounted.root, 'lc-hit')
  assert.deepEqual([hit.props.x, hit.props.y, hit.props.width, hit.props.height], [256, 256, 512, 512], '命中框按源图像素')
  // 留白垫底是同一张图放大模糊，底图本身按 bounds 等比摆放
  assert.equal(withClass(mounted.root, 'lc-backdrop').props.style.filter.startsWith('blur('), true)
  mounted.instance.startViewport()
  await nextTick()
  const frame = withClass(mounted.root, 'lc-frame')
  assert.deepEqual([frame.props.x, frame.props.y, frame.props.width, frame.props.height], [256, 256, 512, 512])
})

test('裁切框按成片比例（9:16 项目裁 9:16），坐标仍是整张源图，且不改文档（#94）', async t => {
  const doc = outputDoc()
  const before = JSON.stringify(doc)
  let crop
  const mounted = await mountCanvasComponent(t, Canvas, { doc, baseSrc: doc.base.path, onCrop: value => { crop = value } })
  mounted.instance.startCrop()
  await nextTick()
  const stage = withClass(mounted.root, 'lc-stage')
  assert.equal(stage.props.style.width, stage.props.style.height)
  assert.equal(withClass(mounted.root, 'lc-ui').props.viewBox, '0 0 1024 1024')
  const frame = withClass(mounted.root, 'lc-frame')
  const expectedHeight = 1024 * 544 / 960
  assert.equal(frame.props.x, 0)
  assert.equal(frame.props.width, 1024)
  assert.ok(Math.abs(frame.props.height - expectedHeight) < 1, `裁框高度按成片比例：${frame.props.height}`)
  assert.ok(Math.abs(frame.props.y - (1024 - expectedHeight) / 2) < 1, '裁框居中')
  const apply = allNodes(mounted.root).find(node => node.type === 'button' && nodeText(node) === 'Apply crop')
  apply.props.onClick()
  await nextTick()
  assert.ok(Math.abs((crop.w * 1024) / (crop.h * 1024) - 960 / 544) < 0.01, '裁出的比例就是成片比例')
  assert.deepEqual(cropRectOf({ crop }, 1024, 1024), { left: 0, top: Math.round((1024 - expectedHeight) / 2), width: 1024, height: Math.round(expectedHeight) })
  assert.equal(JSON.stringify(doc), before)
  assert.equal(withClass(mounted.root, 'lc-ui').props.viewBox, viewBoxOf(containFrame), '退出裁切后回到 contain 取景框')
})

test('persisted crop projects the same source rectangle for image, SVG, hit testing and frame editing', async t => {
  const crop = { x: 0, y: .25, w: 1, h: .5 }
  const doc = outputDoc({ crop })
  const cropFrame = baseFrameOf(doc.base, { width: 960, height: 544 }).frame
  const patches = []
  const mounted = await mountCanvasComponent(t, Canvas, {
    doc, baseSrc: doc.base.path, selectedIds: ['image'], viewport: { ...crop },
    onPatch: patch => patches.push(patch),
  })
  assert.equal(withClass(mounted.root, 'lc-stage').props.style.height, '544px')
  // 2:1 的裁切在 960×544 项目里也是 contain：取景框沿高度扩出留白带
  assert.equal(withClass(mounted.root, 'lc-ui').props.viewBox, viewBoxOf(cropFrame))
  assert.ok(!withClass(mounted.root, 'lc-overlay').props.innerHTML.includes('preserveAspectRatio="none"'), '矢量与栅格同取景框，不拉伸')
  const sourceStyle = withClass(mounted.root, 'lc-source').props.style
  assert.equal(sourceStyle.width, `${100 / cropFrame.w}%`)
  assert.equal(sourceStyle.height, `${100 / cropFrame.h}%`)
  const boundsStyle = withClass(mounted.root, 'lc-bounds').props.style
  assert.equal(boundsStyle.top, `${crop.y * 100}%`, '底图只占裁切区域，留白带不画底图')
  assert.equal(boundsStyle.height, `${crop.h * 100}%`)
  withClass(mounted.root, 'lc-hit').props.onPointerdown({
    clientX: 480, clientY: 272, target: {}, pointerId: 1, stopPropagation() {},
  })
  mounted.listeners.get('pointermove')({ clientX: 480, clientY: 326.4 })
  assert.ok(Math.abs(patches.at(-1).patch.box.y - (.25 + .1 * cropFrame.h)) < 1e-9)
  mounted.listeners.get('pointerup')()
  mounted.instance.startViewport()
  await nextTick()
  const frame = withClass(mounted.root, 'lc-frame')
  assert.deepEqual([frame.props.x, frame.props.y, frame.props.width, frame.props.height], [0, 256, 1024, 512])
  mounted.instance.startCrop()
  await nextTick()
  assert.equal(withClass(mounted.root, 'lc-ui').props.viewBox, '0 0 1024 1024')
})

test('legacy source load is display-only and does not resize or save the output document', async t => {
  const doc = outputDoc({ source_width: undefined, source_height: undefined })
  const before = JSON.stringify(doc)
  let sourceEvents = 0
  const mounted = await mountCanvasComponent(t, Canvas, {
    doc, baseSrc: doc.base.path, onSourceSize: () => { sourceEvents++ },
  })
  withClass(mounted.root, 'lc-base').props.onLoad({ target: { naturalWidth: 1024, naturalHeight: 1024 } })
  await nextTick()
  assert.equal(JSON.stringify(doc), before)
  assert.equal(sourceEvents, 0)
  assert.equal(withClass(mounted.root, 'lc-ui').props.viewBox, viewBoxOf(containFrame), '量到源图后按 contain 取景框显示')
  mounted.instance.startCrop()
  await nextTick()
  assert.equal(withClass(mounted.root, 'lc-ui').props.viewBox, '0 0 1024 1024')
})

const textDoc = () => ({
  ...emptyLayerDoc({ path: 'static/original.png', width: 960, height: 544 }),
  text_layout: 'h-left-stack',
  layers: [{ id: 'text', type: 'text', role: 'heading', name: '主题标题', fields: { main: '甲午战争' },
    visible: true, locked: false, opacity: 1, z: 0, rotation: 0, style: {} }],
})

test('模板文本框按取景框映射命中框、不出手柄、方向键不产生补丁（#96）', async t => {
  const doc = textDoc()
  const patches = []
  const history = []
  const mounted = await mountCanvasComponent(t, Canvas, {
    doc, baseSrc: doc.base.path, selectedIds: ['text'],
    onPatch: patch => patches.push(patch), onHistory: () => history.push('history'),
  })
  assert.match(withClass(mounted.root, 'lc-overlay').props.innerHTML, /data-layer="text"/, '规范就绪后文本框进入画面 SVG')
  const rect = textLayerRects(doc, { width: 960, height: 544 }).text
  const hit = withClass(mounted.root, 'lc-hit')
  assert.ok(hit.props.class.split(' ').includes('text'), '文本框的命中框与普通图层区分')
  assert.ok(Math.abs(hit.props.x - rect.x * 960) < 1e-6, '命中框按成片画面映射到画布')
  assert.ok(Math.abs(hit.props.y - rect.y * 544) < 1e-6)
  assert.ok(Math.abs(hit.props.width - Math.max(rect.w * 960, 8)) < 1e-6)
  const select = withClass(mounted.root, 'lc-select')
  assert.ok(Math.abs(select.props.x - rect.x * 960) < 1e-6, '选中框就是排版框')
  assert.equal(withClass(mounted.root, 'lc-handle'), undefined, '模板文本框不出缩放手柄')
  assert.equal(withClass(mounted.root, 'lc-rotate'), undefined, '模板文本框不出旋转手柄')
  const canvasRoot = allNodes(mounted.root).find(node => node.props.class === 'layer-canvas')
  canvasRoot.props.onKeydown({ key: 'ArrowRight', target: { tagName: 'DIV' }, preventDefault() {} })
  assert.equal(patches.length, 0, '方向键不移动文本框')
  assert.equal(history.length, 0, '方向键不为文本框压空历史')
})

test('图层列表按媒介给出文本框类型与旧图层入口：媒体分组、视频/海报/地图各不相同（#96）', async t => {
  const doc = emptyLayerDoc({ width: 1920, height: 1080 })
  const added = []
  const video = await mountCanvasComponent(t, List, { doc, medium: 'video', onAdd: (type, partial) => added.push([type, partial]) })
  const block = withClass(video.root, 'll-text-add')
  assert.ok(block, '视频媒介提供模板文本框入口')
  const groups = allNodes(block).filter(node => node.type === 'optgroup').map(node => node.props.label)
  assert.deepEqual(groups, ['Identifier', 'Narrative', 'Emphasis', 'Quotation', 'Data', 'Structure'], '按角色分类分组')
  allNodes(block).find(node => node.type === 'button').props.onClick()
  assert.deepEqual(added, [['text', { role: 'date' }]], '默认选第一个角色，添加时带上 role')
  const videoAdds = allNodes(video.root).filter(node => node.type === 'button' && String(node.props.class || '').includes('ll-add-btn')).map(nodeText)
  assert.ok(videoAdds.includes('Text'), `图层段保留锚定文字标注：${JSON.stringify(videoAdds)}`)
  assert.ok(!videoAdds.includes('Card'), '图层段不再提供自由卡片')

  const poster = await mountCanvasComponent(t, List, { doc, medium: 'poster' })
  const posterGroups = allNodes(withClass(poster.root, 'll-text-add')).filter(node => node.type === 'optgroup').map(node => node.props.label)
  assert.ok(posterGroups.includes('Poster'), '海报媒介可用海报专用类型')
  const posterAdds = allNodes(poster.root).filter(node => node.type === 'button' && String(node.props.class || '').includes('ll-add-btn')).map(nodeText)
  assert.ok(!posterAdds.includes('Text') && !posterAdds.includes('Card'), `海报编辑器不再提供旧文字层：${JSON.stringify(posterAdds)}`)

  const map = await mountCanvasComponent(t, List, { doc })
  assert.equal(withClass(map.root, 'll-text-add'), undefined, '地图编辑器一个文本框入口都没有')
})

test('模板文本框样式面板给出容量与引擎问题：同位置区两个框即阻断（#96）', async t => {
  const layer = { id: 'text', type: 'text', role: 'heading', name: '主题标题', fields: { main: '甲午战争' },
    visible: true, locked: false, opacity: 1, z: 0, rotation: 0, style: {} }
  const doc = { ...emptyLayerDoc({ width: 1920, height: 1080 }), text_layout: 'h-left-stack', layers: [layer] }
  const mounted = await mountCanvasComponent(t, Style, { doc, layer, layerOnly: true })
  const text = nodeText(mounted.root)
  assert.ok(text.includes('主题标题'), '标题显示角色名')
  assert.match(text, /chars per line × \d+ lines, 4 used/, '容量提示按规范算并统计已用字数')
  assert.equal(withClass(mounted.root, 'ls-problems'), undefined, '单独一个文本框没有问题')

  const conflict = { ...layer, id: 'second', role: 'statement', name: '事实说明', fields: { main: '北洋水师覆灭' } }
  const two = { ...doc, layers: [layer, conflict] }
  const conflictMounted = await mountCanvasComponent(t, Style, { doc: two, layer: conflict, layerOnly: true })
  const problems = withClass(conflictMounted.root, 'ls-problems')
  assert.ok(problems, '同拍同位置区要在样式面板里直接报出来')
  assert.ok(nodeText(problems).includes('在同一位置区'), nodeText(problems))
})

test('same-size source/output canvas and legacy crop coordinates remain unchanged', async t => {
  const doc = outputDoc({ width: 1920, height: 1080, source_width: 1920, source_height: 1080 })
  const mounted = await mountCanvasComponent(t, Canvas, { doc, baseSrc: doc.base.path })
  assert.equal(withClass(mounted.root, 'lc-ui').props.viewBox, '0 0 1920 1080')
  mounted.instance.startCrop()
  await nextTick()
  const frame = withClass(mounted.root, 'lc-frame')
  assert.deepEqual([frame.props.x, frame.props.y, frame.props.width, frame.props.height], [0, 0, 1920, 1080])
})

test('比例诊断 = contain 留白（#94）：只按源图真实像素判断，量不到尺寸就不下结论', () => {
  const spec = { width: 960, height: 544 }
  assert.deepEqual(baseAspectIssue(outputDoc().base, spec), { aspect: '1:1', mode: 'contain' }, '1024² 底图在 960×544 项目里留白渲染')
  assert.deepEqual(baseAspectIssue(outputDoc({ crop: { x: .25, y: .25, w: .5, h: .5 } }).base, spec), { aspect: '1:1', mode: 'contain' })
  assert.equal(baseAspectIssue(outputDoc({ crop: { x: 0, y: .21875, w: 1, h: .5625 } }).base, spec), null, '裁到成片比例即 cover')
  assert.equal(baseAspectIssue({ width: 1920, height: 1080, source_width: 1920, source_height: 1080 }, spec), null)
  assert.equal(baseAspectIssue({ width: 1024, height: 1024 }, spec), null, '源图尺寸未知时无法判断，不误报')
  assert.equal(baseAspectIssue({}, spec), null)
})

test('rail distinguishes output, original source and crop-adjusted final-resolution ratio without mutating metadata', async t => {
  const doc = outputDoc({ source_width: undefined, source_height: undefined, crop: { x: 0, y: .21875, w: 1, h: .5625 } })
  const before = JSON.stringify(doc)
  let sourceEvents = 0
  const mounted = await mountCanvasComponent(t, Rail, {
    doc, onSourceSize: () => { sourceEvents++ },
  })
  assert.ok(nodeText(mounted.root).includes(messages.layerCanvas.base.sourceUnknown))
  assert.equal(nodeText(mounted.root).includes('Source 960×544'), false)
  assert.equal(nodeText(mounted.root).includes('Cropped source pixels:'), false)
  allNodes(mounted.root).find(node => node.type === 'img').props.onLoad({ target: { naturalWidth: 1024, naturalHeight: 1024 } })
  await nextTick()
  const text = nodeText(mounted.root)
  assert.ok(text.includes('Output canvas 960×544'))
  assert.ok(text.includes('Source 1024×1024 (original pixels)'))
  assert.ok(text.includes('Cropped source pixels: 1.1× final 960×544 (limiting axis)'))
  assert.equal(JSON.stringify(doc), before)
  assert.equal(sourceEvents, 0)
})

test('replacing a base retains output dimensions and stores candidate dimensions only as source metadata', async t => {
  let replacement
  const mounted = await mountCanvasComponent(t, Rail, {
    doc: outputDoc(), episodeId: 1, onBase: value => { replacement = value },
  })
  await nextTick()
  const picker = allNodes(mounted.root).find(node => node.type === 'asset-picker-test')
  picker.props.onChoose([picker.props.assets[0]])
  assert.equal(replacement.path, 'static/replacement.png')
  assert.deepEqual([replacement.width, replacement.height], [960, 544])
  assert.deepEqual([replacement.source_width, replacement.source_height], [2048, 2048])
})
