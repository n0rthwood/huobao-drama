import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createI18n } from 'vue-i18n'

const app = new URL('../app/', import.meta.url)
const { descriptor } = parse(readFileSync(new URL('components/AssetPipelineFactSheet.vue', app), 'utf8'))
let source = compileScript(descriptor, { id: 'fact-sheet-test', inlineTemplate: true }).content
for (const name of ['vue', 'vue-i18n', 'lucide-vue-next']) {
  source = source.replaceAll(`from '${name}'`, `from '${import.meta.resolve(name)}'`).replaceAll(`from "${name}"`, `from "${import.meta.resolve(name)}"`)
}
source = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const FactSheet = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default
const messages = JSON.parse(readFileSync(new URL('locales/en.json', app), 'utf8'))
const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
const remove = n => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null }
const renderer = createRenderer({
  createElement: type => node(type), createText: text => node('#text', text), createComment: () => node('#comment'),
  setText: (n, text) => { n.text = text }, setElementText: (n, text) => { n.text = text; n.children = [] },
  patchProp: (n, key, oldValue, value) => { n.props[key] = value },
  insert(n, parent, anchor = null) { remove(n); const i = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(i < 0 ? parent.children.length : i, 0, n); n.parent = parent },
  remove, parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
})
const text = n => n.text + n.children.map(text).join('')
const all = n => [n, ...n.children.flatMap(all)]

test('expanded approval fact sheet renders all facts and can be collapsed and reopened', async t => {
  const spec = {
    version: 3, summary: 'Historical object',
    must_have: Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, element: `required-${i}`, why: `why-${i}`, check: `check-${i}`, metric: 'shape' })),
    forbidden: Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, error: `forbidden-${i}`, why: `reason-${i}` })),
    tolerances: Array.from({ length: 7 }, (_, i) => `tolerance-${i}`),
    uncertainties: Array.from({ length: 5 }, (_, i) => `uncertain-${i}`),
  }
  const root = node('root')
  const instance = renderer.createApp({ render: () => h(FactSheet, { spec, initiallyOpen: true }) })
  instance.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  instance.mount(root)
  t.after(() => instance.unmount())
  for (const value of ['required-7', 'forbidden-6', 'tolerance-6', 'uncertain-4']) assert.ok(text(root).includes(value))
  const button = all(root).find(n => n.type === 'button')
  assert.equal(button.props['aria-expanded'], true)
  button.props.onClick()
  await nextTick()
  assert.equal(text(root).includes('required-7'), false)
  button.props.onClick()
  await nextTick()
  assert.ok(text(root).includes('required-7'))
})
