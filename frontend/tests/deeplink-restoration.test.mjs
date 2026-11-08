import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextTick } from 'vue'
import { deeplinkRuntimeModule } from './sfc-deeplink-runtime.mjs'

test('late initial children restore until user interaction, then old popups cannot reopen in another host', async () => {
  const previousDocument = globalThis.document
  const events = new EventTarget()
  globalThis.document = events
  const runtime = await import(deeplinkRuntimeModule)
  runtime.router.currentRoute.value = { path: '/episode/17', query: { tab: 'design', lpick: '1', lpmode: 'asset' } }
  const root = runtime.deeplinkGroup('root', ['tab', 'lpick', 'lpmode'])
  root.set({ tab: 'design' })
  runtime.deeplinkHydrate()
  const first = runtime.deeplinkGroup('image', runtime.DEEPLINK_KEYS.layerPicker)
  assert.equal(first.initial('lpmode'), 'asset', 'async child retains initial location after parent hydration')
  first.set({ lpick: '1', lpmode: first.initial('lpmode') })
  assert.equal(runtime.router.currentRoute.value.query.lpmode, 'asset')
  events.dispatchEvent(new Event('click'))
  first.set({})
  first.release()
  const later = runtime.deeplinkGroup('another-image', runtime.DEEPLINK_KEYS.layerPicker)
  assert.equal(later.initial('lpick'), null, 'closing and remounting must not resurrect the old popup')
  later.set({ lpick: '1', lpmode: 'library' })
  assert.equal(runtime.router.currentRoute.value.query.lpmode, 'library', 'new user actions still publish normally')
  runtime.router.currentRoute.value = { path: '/episode/18', query: { lpick: '1', lpmode: 'source' } }
  await nextTick()
  const next = runtime.deeplinkGroup('new-route-image', runtime.DEEPLINK_KEYS.layerPicker)
  assert.equal(next.initial('lpmode'), 'source', 'new route gets a new restoration window')
  events.dispatchEvent(new Event('keydown'))
  assert.equal(next.initial('lpick'), null, 'keyboard navigation also supersedes initial restore')
  next.release(); later.release(); root.release()
  globalThis.document = previousDocument
})
