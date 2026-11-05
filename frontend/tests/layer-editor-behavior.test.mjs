import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { nextTick } from 'vue'
import { clampTimelineToCrop } from '../app/utils/layerQuality.js'

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
  const result = clampTimelineToCrop(timeline, crop)
  timeline = result.timeline
  assert.equal(result.changed, true)
  assert.notEqual(JSON.stringify(timeline), original)
  editor.undo()
  assert.equal(editor.doc.value.base.crop, undefined)
  assert.equal(JSON.stringify(timeline), original)
  editor.redo()
  assert.deepEqual(editor.doc.value.base.crop, crop)
  assert.deepEqual(timeline.keyframes[0].viewport, crop)
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
