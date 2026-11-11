import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { createRenderer, h, nextTick, reactive, ref } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createI18n } from 'vue-i18n'
import { baseAspectIssue, baseFrameOf, clampTimelineToFrame, cropRectOf } from '../app/utils/layerQuality.js'
import { semanticEntries, semanticLayerPatch, anchorState } from '../app/utils/semanticGeometry.js'
import { deeplinkRuntimeModule } from './sfc-deeplink-runtime.mjs'

// Resolve Nuxt's compile-time aliases while executing the real Vue composables.
const app = new URL('../app/', import.meta.url)
function moduleUrl(path, aliases = {}) {
  let source = readFileSync(new URL(path, app), 'utf8')
  for (const [name, url] of Object.entries({ vue: import.meta.resolve('vue'), '~/utils/layerSvg': new URL('utils/layerSvg.js', app).href, ...aliases })) {
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

// Mount the actual SFCs with Vue's host-independent renderer. Only browser layout,
// unrelated child panels, URL configuration and API transport are test seams.
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const emptyPanel = dataModule('export default { render: () => null }')
const pickerPanel = dataModule(`import {h} from '${import.meta.resolve('vue')}';
export default {props:['assets','open'],emits:['confirm'],setup(props,{emit}) {
  return () => h('asset-picker-test',{assets:props.assets,onChoose:items=>emit('confirm',items)})
}}`)
const testApi = dataModule(`export const assetPipelineAPI = {baseCandidates:async()=>({candidates:[
  {asset_kind:'prop',asset_id:7,asset_name:'Replacement',version_task_id:9,path:'static/replacement.png',width:2048,height:2048}
]})}; export const propAPI = {semantics:async()=>({semantics:{}})};`)
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
  '~/composables/useQuerySync': deeplinkRuntimeModule,
  '~/components/AssetPicker.vue': pickerPanel,
  './LayerList.vue': emptyPanel,
  './LayerStyle.vue': emptyPanel,
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
