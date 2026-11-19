import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createI18n } from 'vue-i18n'

// Issue #123：DraftPanel 真实挂载——ready 态渲染 prompt 编辑框与确认按钮；
// 编辑→保存→确认→generate 的调用顺序与提交内容（mock api 层断言）。
const app = new URL('../app/', import.meta.url)
const messages = JSON.parse(readFileSync(new URL('locales/en.json', app), 'utf8'))

// mock api：记录调用顺序与参数
// vue-sonner 在 import 时注入样式（摸 document.head）：用桩替代，toast 调用记入 calls
const sonnerStubUrl = `data:text/javascript;base64,${Buffer.from(`export const toast = { success: (...a) => globalThis.__toastCalls.push(['success', ...a]), error: (...a) => globalThis.__toastCalls.push(['error', ...a]), warning: (...a) => globalThis.__toastCalls.push(['warning', ...a]) };`).toString('base64')}`
globalThis.__toastCalls = []
// runtime-dom vModelText 的 beforeUpdate 钩子读 document.activeElement：最小桩
globalThis.document = { activeElement: null }
globalThis.Document = globalThis.Document ?? class Document {}
globalThis.ShadowRoot = globalThis.ShadowRoot ?? class ShadowRoot {}
const calls = []
const draftState = {
  id: 7, task_id: 2, asset_kind: 'prop', asset_id: 273, tab: 'precision', status: 'ready',
  inputs: { source_ids: [11], research: [], notes: 'lynx', source_shas: [{ id: 11, sha256: 's1', local_path: 'static/asset-sources/one.png' }], resolved_candidates: [], resolved_texts: [{ research_id: 1, title: 'Text A', excerpt: 'x' }] },
  spec_id: null, prompt: 'initial prompt', negative_prompt: 'no watermark', error_msg: null,
  text_config_id: null, image_config_id: 7, image_model: 'gpt-image-2',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:01.000Z', spec: null,
}
const apiMock = {
  editDraft: async (id, data) => { calls.push(['editDraft', id, data]); return { ...draftState, prompt: data.prompt, negative_prompt: data.negative_prompt, updated_at: '2026-01-01T00:00:02.000Z' } },
  generateDraft: async (id, data) => { calls.push(['generateDraft', id, data]); return { run_id: 99, draft: { ...draftState, status: 'generating' } } },
  retryDraft: async id => { calls.push(['retryDraft', id]); return { ...draftState, status: 'drafting' } },
  draft: async id => { calls.push(['draft', id]); return draftState },
  cancel: async id => { calls.push(['cancel', id]) },
}
const apiModuleUrl = `data:text/javascript;base64,${Buffer.from(`export const assetStudioAPI = ${JSON.stringify(null)};`).toString('base64')}`

function loadComponent(file, replacements) {
  const { descriptor } = parse(readFileSync(new URL(file, app), 'utf8'))
  let source = compileScript(descriptor, { id: 'draft-ui-test', inlineTemplate: true, babelParserPlugins: ['typescript'] }).content
  for (const name of ['vue', 'vue-i18n', 'lucide-vue-next']) {
    source = source.replaceAll(`from '${name}'`, `from '${import.meta.resolve(name)}'`).replaceAll(`from "${name}"`, `from "${import.meta.resolve(name)}"`)
  }
  source = source.replaceAll(`from 'vue-sonner'`, `from '${sonnerStubUrl}'`).replaceAll(`from "vue-sonner"`, `from "${sonnerStubUrl}"`)
  for (const [from, to] of replacements) source = source.replaceAll(from, to)
  source = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

// 子组件桩：ConfirmDialog 渲染 open 态的确认/取消按钮；AssetFactSheet/StudioError 简化
const confirmStubUrl = `data:text/javascript;base64,${Buffer.from(`
import { h } from '${import.meta.resolve('vue')}'
export default { props: ['open', 'title', 'message', 'loading'], emits: ['confirm', 'cancel'], setup(props, { emit }) { return () => props.open ? h('div', { class: 'confirm-stub' }, [h('span', { class: 'confirm-message' }, props.message), h('button', { class: 'confirm-yes', onClick: () => emit('confirm') }, 'yes'), h('button', { class: 'confirm-no', onClick: () => emit('cancel') }, 'no')]) : null } }
`).toString('base64')}`
const factStubUrl = `data:text/javascript;base64,${Buffer.from(`
import { h } from '${import.meta.resolve('vue')}'
export default { props: ['spec', 'initiallyOpen'], setup(props) { return () => h('div', { class: 'fact-stub' }, props.spec ? 'fact-sheet' : '') } }
`).toString('base64')}`
const errorStubUrl = `data:text/javascript;base64,${Buffer.from(`
import { h } from '${import.meta.resolve('vue')}'
export default { props: ['error'], setup(props) { return () => h('div', { class: 'error-stub' }, props.error || '') } }
`).toString('base64')}`
const apiStubUrl = `data:text/javascript;base64,${Buffer.from(`export const assetStudioAPI = globalThis.__draftApiMock;`).toString('base64')}`
globalThis.__draftApiMock = apiMock

const { default: DraftPanel } = await loadComponent('asset-studio/components/DraftPanel.vue', [
  [`from '~/components/ConfirmDialog.vue'`, `from '${confirmStubUrl}'`],
  [`from './AssetFactSheet.vue'`, `from '${factStubUrl}'`],
  [`from './StudioError.vue'`, `from '${errorStubUrl}'`],
  [`from '../api'`, `from '${apiStubUrl}'`],
])

const node = (type, text = '') => ({ type, text, props: {}, dirs: [], children: [], parent: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, getRootNode() { return this }, style: {}, tagName: String(type).toUpperCase(), value: '' })
const remove = n => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null }
const renderer = createRenderer({
  createElement: type => node(type), createText: text => node('#text', text), createComment: () => node('#comment'),
  setText: (n, text) => { n.text = text }, setElementText: (n, text) => { n.text = text; n.children = [] },
  patchProp: (n, key, oldValue, value) => {
    n.props[key] = value
    if (key === 'onUpdate:modelValue') n.props.onInput = event => value(event.target.value)
    if (key === 'modelValue') n.props.value = value
  },
  insert(n, parent, anchor = null) { remove(n); const i = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(i < 0 ? parent.children.length : i, 0, n); n.parent = parent },
  remove, parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
  // vModel 编译成 withDirectives：value 在指令里，不在 props；这里把指令值同步到 node.value 供断言/编辑
  created(n, vnode) { if (vnode.dirs?.length) { n.dirs = vnode.dirs; const model = vnode.dirs.find(d => d.dir?.created || d.dir?.beforeUpdate); if (model) n.value = model.value } },
  beforeUpdate(n, vnode) { if (vnode.dirs?.length) { n.dirs = vnode.dirs; const model = vnode.dirs.find(d => d.dir?.created || d.dir?.beforeUpdate); if (model) n.value = model.value } },
})
const text = n => n.text + n.children.map(text).join('')
const all = n => [n, ...n.children.flatMap(all)]

function mount(draft) {
  const root = node('root')
  const emitted = []
  const instance = renderer.createApp({
    render: () => h(DraftPanel, {
      draft, taskId: 2,
      onUpdate: d => emitted.push(['update', d]),
      onGenerated: id => emitted.push(['generated', id]),
      onChanged: () => emitted.push(['changed']),
    }),
  })
  instance.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  instance.mount(root)
  return { root, emitted, unmount: () => instance.unmount() }
}

test('ready draft renders editable prompt, negative prompt and confirm button; empty-input badge is not shown here', async t => {
  calls.length = 0
  const { root, unmount } = mount({ ...draftState })
  t.after(unmount)
  await nextTick()
  const textarea = all(root).find(n => n.type === 'textarea')
  assert.ok(textarea, 'prompt textarea rendered')
  assert.equal(textarea.value, 'initial prompt')
  assert.ok(text(root).includes('Confirm & generate'))
  assert.ok(text(root).includes('gpt-image-2'))
  // 输入摘要列出参考图与检索文本
  assert.ok(text(root).includes('static/asset-sources/one.png'))
  assert.ok(text(root).includes('Text A'))
})

test('edit → save → confirm → generate call order and payload (expected_updated_at frozen)', async t => {
  calls.length = 0
  const { root, emitted, unmount } = mount({ ...draftState })
  t.after(unmount)
  await nextTick()
  const textarea = all(root).find(n => n.type === 'textarea')
  // 用户编辑 prompt
  textarea.props['onUpdate:modelValue']('edited prompt')
  await nextTick()
  // 点「确认并生图」→ 先保存（editDraft）再开确认框
  const confirmButton = all(root).find(n => n.type === 'button' && text(n).includes('Confirm & generate'))
  confirmButton.props.onClick()
  await nextTick()
  await nextTick()
  await nextTick()
  assert.deepEqual(calls[0], ['editDraft', 7, { prompt: 'edited prompt', negative_prompt: 'no watermark' }])
  const yes = all(root).find(n => n.type === 'button' && n.props.class === 'confirm-yes')
  assert.ok(yes, 'confirm dialog opened after save')
  assert.ok(text(root).includes('1 reference image'))
  yes.props.onClick()
  await nextTick()
  await nextTick()
  assert.equal(calls[1][0], 'generateDraft')
  assert.equal(calls[1][1], 7)
  // 保存返回的新 updated_at 通过 emit('update') 上报；generate 带的 expected_updated_at 必须是最新稿
  const updateEvent = emitted.find(e => e[0] === 'update')
  assert.ok(updateEvent, 'update emitted with saved draft')
  assert.deepEqual(calls[1][2], { expected_updated_at: updateEvent[1].updated_at })
  assert.ok(emitted.some(e => e[0] === 'generated' && e[1] === 99))
})

test('failed draft shows error and retry button; retry calls api', async t => {
  calls.length = 0
  const { root, unmount } = mount({ ...draftState, status: 'failed', error_msg: 'expand boom', prompt: null })
  t.after(unmount)
  await nextTick()
  assert.ok(text(root).includes('expand boom'))
  const retry = all(root).find(n => n.type === 'button' && text(n).includes('Re-expand'))
  assert.ok(retry)
  retry.props.onClick()
  await nextTick()
  assert.deepEqual(calls[0], ['retryDraft', 7])
})