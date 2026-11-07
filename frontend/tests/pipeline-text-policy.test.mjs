import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { describeTextPolicy } from '../app/utils/pipelineText.js'

const messages = JSON.parse(readFileSync(new URL('../app/locales/en.json', import.meta.url), 'utf8'))
const t = key => key.split('.').reduce((node, part) => (node ? node[part] : undefined), messages) ?? key

test('added overlay text fails, the object own markings pass', () => {
  const overlay = describeTextPolicy({ present: true, overlay: true, evidence: 'caption bar' }, t)
  assert.equal(overlay.state, 'overlay')
  assert.equal(overlay.failed, true)

  const own = describeTextPolicy({ present: true, overlay: false, evidence: 'seal script on the face' }, t)
  assert.equal(own.state, 'own')
  assert.equal(own.failed, false)
  assert.notEqual(own.label, overlay.label)
})

test('old records without overlay stay honest and never claim a verdict', () => {
  const legacy = describeTextPolicy({ present: true, overlay: null, evidence: '' }, t)
  assert.equal(legacy.state, 'overlayUnrecorded')
  assert.equal(legacy.failed, false)

  const missingField = describeTextPolicy({ present: true, evidence: '' }, t)
  assert.deepEqual(missingField, legacy)
})

test('no text and undetermined text are distinct states', () => {
  const none = describeTextPolicy({ present: false, overlay: false, evidence: '' }, t)
  assert.equal(none.state, 'none')
  assert.equal(none.failed, false)

  const unknown = describeTextPolicy({ present: null, overlay: null, evidence: '' }, t)
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.failed, false)
  assert.notEqual(unknown.label, none.label)
})

test('every state resolves a real locale string', () => {
  const cases = [
    { present: true, overlay: true },
    { present: true, overlay: false },
    { present: true, overlay: null },
    { present: false, overlay: false },
    { present: null, overlay: null },
  ]
  for (const textInImage of cases) {
    const { label } = describeTextPolicy(textInImage, t)
    assert.ok(label && !label.includes('episode.documentary.pipeline.'), `missing locale for ${JSON.stringify(textInImage)}`)
  }
})
