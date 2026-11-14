import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createRenderer, h, ref, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import ts from 'typescript'

const apiSource = readFileSync(new URL('../app/map-studio/api.ts', import.meta.url), 'utf8').replace("import { apiBase } from '~/utils/url'", "const apiBase = () => '/huobao/api/v1'")
const apiModule = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(apiSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`
const source = readFileSync(new URL('../app/map-studio/components/MapStylePicker.vue', import.meta.url), 'utf8')
const descriptor = parse(source).descriptor
let compiled = compileScript(descriptor, { id: 'map-theme-picker-test', inlineTemplate: true }).content
compiled = "import { ref, onMounted, onBeforeUnmount } from 'vue'\n" + compiled
for (const [name, url] of Object.entries({ vue: import.meta.resolve('vue'), 'vue-i18n': import.meta.resolve('vue-i18n'), '~/map-studio/api': apiModule })) {
  compiled = compiled.replaceAll(`from '${name}'`, `from '${url}'`).replaceAll(`from "${name}"`, `from "${url}"`)
}
const component = (await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`)).default

function node(type, text = '') { return { type, text, children: [], props: {}, parent: null } }
const renderer = createRenderer({
  createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text }, setElementText: (target, text) => { target.text = text; target.children = [] },
  patchProp: (target, key, _old, value) => { target.props[key] = value },
  parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  insert(target, parent, anchor = null) { if (target.parent) { const siblings = target.parent.children; siblings.splice(siblings.indexOf(target), 1) } target.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(target); else parent.children.splice(index, 0, target) },
  remove(target) { if (target.parent) { const siblings = target.parent.children; siblings.splice(siblings.indexOf(target), 1); target.parent = null } },
})
function all(target, predicate) { return [...(predicate(target) ? [target] : []), ...target.children.flatMap(child => all(child, predicate))] }

test('Mounted Map Studio theme cards load module data, choose a family/default, localize and respect disabled state', async () => {
  const original = globalThis.fetch
  const families = JSON.parse(readFileSync(new URL('../../backend/src/modules/map-studio/styles/families.json', import.meta.url), 'utf8')).families
  const calls = []
  globalThis.fetch = async url => { calls.push(url); return Response.json({ code: 200, data: { default_style: 'modern-clean', families: families.map(family => ({ ...family, reference: { title: 'Source', license: 'Public domain', source: 'https://example.invalid/reference' } })) } }) }
  const selected = ref(null), disabled = ref(false), root = node('root')
  const app = renderer.createApp({ setup: () => () => h(component, { modelValue: selected.value, disabled: disabled.value, 'onUpdate:modelValue': value => { selected.value = value } }) })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: JSON.parse(readFileSync(new URL('../app/locales/en.json', import.meta.url), 'utf8')) } }))
  try {
    app.mount(root)
    await new Promise(resolve => setImmediate(resolve)); await nextTick()
    assert.deepEqual(calls, ['/huobao/api/v1/map-studio/styles'])
    const buttons = all(root, item => item.type === 'button')
    const choices = buttons.filter(item => String(item.props.class).includes('style-choice'))
    assert.equal(choices.length, 5)
    assert.equal(all(root, item => item.type === 'img')[3].props.src, '/huobao/api/v1/map-studio/styles/ink-chinese/preview')
    choices[3].props.onClick(); await nextTick()
    assert.equal(selected.value, 'ink-chinese')
    assert.equal(choices[3].props['aria-pressed'], true)
    assert.equal(choices[0].props['aria-pressed'], false)
    buttons.find(item => String(item.props.class).includes('style-default')).props.onClick(); await nextTick()
    assert.equal(selected.value, null)
    disabled.value = true; await nextTick()
    assert.ok(choices.every(item => item.props.disabled === true))
    assert.equal(all(root, item => item.type === 'a').length, 5)
  } finally { app.unmount(); globalThis.fetch = original }
})
